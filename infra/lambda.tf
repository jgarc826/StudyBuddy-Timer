# The Lambda function: our API's compute. AWS runs backend/src on demand,
# per request; no server exists between requests.

# Zip backend/src at plan time. Terraform tracks the archive's hash, so
# editing the code makes the next plan say "function will be updated".
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/src"
  output_path = "${path.module}/dist/lambda.zip"
}

# The log group is created BY US, not automatically by Lambda, for one
# reason: the 14-day retention rule (project hard rule 5). Auto-created
# groups default to keeping logs forever, which quietly costs money.
resource "aws_cloudwatch_log_group" "api_lambda" {
  name              = "/aws/lambda/studybuddy-timer-api"
  retention_in_days = 14
}

# --- The function's IAM role: what the CODE may do -----------------------
# Least privilege, per project hard rule 7: this role can write to THIS
# log group and use two DynamoDB actions on THIS table. Nothing else. A
# bug (or an attacker reaching the code) inherits only these powers.

# Trust policy: only the Lambda service may wear this role.
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_lambda" {
  name               = "studybuddy-timer-api-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Permission policy: the two table operations the store module performs,
# plus writing its own logs.
data "aws_iam_policy_document" "lambda_permissions" {
  statement {
    sid       = "SessionsTableAccess"
    actions   = ["dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.sessions.arn]
  }

  statement {
    sid     = "WriteOwnLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    # The :* covers the log STREAMS inside our one log group.
    resources = ["${aws_cloudwatch_log_group.api_lambda.arn}:*"]
  }
}

resource "aws_iam_role_policy" "api_lambda" {
  name   = "studybuddy-timer-api-lambda"
  role   = aws_iam_role.api_lambda.id
  policy = data.aws_iam_policy_document.lambda_permissions.json
}

# --- The function itself -------------------------------------------------

resource "aws_lambda_function" "api" {
  function_name = "studybuddy-timer-api"
  role          = aws_iam_role.api_lambda.arn

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  # Newest GA Node.js runtime per AWS's runtime table (checked Sep 2026;
  # nodejs26.x exists but is preview-only). The AWS SDK ships inside it.
  runtime = "nodejs24.x"
  handler = "index.handler" # file index.mjs, exported function `handler`

  # Graviton (ARM) is the cheaper architecture; our JS is arch-agnostic.
  architectures = ["arm64"]

  memory_size = 128 # MB — plenty for a JSON-and-DynamoDB function
  timeout     = 10  # seconds — DynamoDB answers in milliseconds

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.sessions.name
    }
  }

  # Make sure the group exists before the function can log into it.
  depends_on = [aws_cloudwatch_log_group.api_lambda]
}
