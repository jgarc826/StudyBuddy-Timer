# GitHub Actions -> AWS, with no stored keys anywhere.
#
# How OIDC deployment auth works, in one paragraph: GitHub signs a short-
# lived identity token for each workflow run, stating exactly which repo
# and branch it runs for. AWS is told to trust GitHub's token signer (the
# "OIDC provider" below), and a role's trust policy says WHICH tokens may
# wear it — ours only accepts this repository's main branch and its pull
# requests. The workflow trades its token for temporary AWS credentials
# that evaporate when the job ends. Nothing to leak, nothing to rotate —
# the same reason `aws login` beats access keys locally (hard rule 6).

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # Fingerprints of GitHub's token-signing certificate authorities.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

locals {
  github_repo = "jgarc826/StudyBuddy-Timer"
  # GitHub's stable numeric ids for the owner and repo (visible in the
  # OIDC sub claim, or via the GitHub API). Unlike the names, these
  # survive account and repository renames.
  github_repo_ids  = "jgarc826@117320647/StudyBuddy-Timer@1376436134"
  state_bucket_arn = "arn:aws:s3:::studybuddy-timer-tfstate-${data.aws_caller_identity.current.account_id}"
  account_id       = data.aws_caller_identity.current.account_id
}

data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The heart of the trust: only workflow runs FOR THIS REPO, and only
    # on main or as a pull-request check, may assume the role.
    #
    # Two formats per case, learned the hard way: GitHub embeds stable
    # numeric ids in the sub claim ("owner@id/repo@id"), which CloudTrail
    # revealed after the name-only form was refused on the first deploys.
    # The id-bearing entries are the ones matching today — and they keep
    # working across renames; the name-only entries are kept in case the
    # claim format ever reverts.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${local.github_repo_ids}:ref:refs/heads/main",
        "repo:${local.github_repo_ids}:pull_request",
        "repo:${local.github_repo}:ref:refs/heads/main",
        "repo:${local.github_repo}:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "studybuddy-timer-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
}

# What CI may do. This role must manage every resource in this
# configuration (it runs terraform apply), so it is necessarily broader
# than the Lambda's two-action role — but each grant is fenced to this
# project's named resources wherever AWS allows. The two wildcard-ish
# grants that AWS forces on us are called out in NOTES.md (hard rule 7).
data "aws_iam_policy_document" "github_actions_permissions" {
  # Read/write the shared Terraform state and its lock object.
  statement {
    sid       = "TerraformState"
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
  }

  # Manage + deploy into the site bucket (sync needs object CRUD; apply
  # needs bucket-level config like policy and public-access-block).
  statement {
    sid       = "SiteBucket"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
  }

  # CloudFront: several control-plane actions don't support resource-level
  # scoping, so the resource is "*" — documented wildcard #1. The account
  # contains only this project's distribution.
  statement {
    sid       = "CloudFront"
    actions   = ["cloudfront:*"]
    resources = ["*"]
  }

  # API Gateway's control plane uses path-style ARNs without a stable id
  # at create time — documented wildcard #2, region-fenced.
  statement {
    sid       = "ApiGateway"
    actions   = ["apigateway:*"]
    resources = ["arn:aws:apigateway:us-east-1::/*"]
  }

  statement {
    sid       = "SessionsTable"
    actions   = ["dynamodb:*"]
    resources = [aws_dynamodb_table.sessions.arn]
  }

  statement {
    sid       = "ApiLambda"
    actions   = ["lambda:*"]
    resources = [aws_lambda_function.api.arn]
  }

  # Manage exactly this project's IAM pieces (and re-create them after a
  # destroy). Includes iam:PassRole so CI may hand the Lambda its role.
  statement {
    sid     = "ProjectIam"
    actions = ["iam:*"]
    resources = [
      aws_iam_role.api_lambda.arn,
      "arn:aws:iam::${local.account_id}:role/studybuddy-timer-github-actions",
      aws_iam_openid_connect_provider.github.arn,
    ]
  }

  statement {
    sid     = "ProjectLogGroups"
    actions = ["logs:*"]
    resources = [
      "arn:aws:logs:us-east-1:${local.account_id}:log-group:/aws/lambda/studybuddy-timer-*",
      "arn:aws:logs:us-east-1:${local.account_id}:log-group:/aws/lambda/studybuddy-timer-*:*",
    ]
  }

  # Listing log groups is an account-level read AWS only grants broadly.
  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:us-east-1:${local.account_id}:log-group:*"]
  }

  statement {
    sid     = "Monitoring"
    actions = ["cloudwatch:*", "sns:*"]
    resources = [
      "arn:aws:cloudwatch:us-east-1:${local.account_id}:alarm:studybuddy-timer-*",
      "arn:aws:cloudwatch::${local.account_id}:dashboard/studybuddy-timer*",
      "arn:aws:sns:us-east-1:${local.account_id}:studybuddy-timer-*",
    ]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "studybuddy-timer-github-actions"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions_permissions.json
}

output "github_actions_role_arn" {
  description = "Goes into the workflows' role-to-assume"
  value       = aws_iam_role.github_actions.arn
}
