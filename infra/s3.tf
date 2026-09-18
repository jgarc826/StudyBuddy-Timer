# The S3 bucket that stores the site's files (index.html, style.css, ...).
# Nobody talks to this bucket directly except CloudFront — see the policy
# at the bottom of this file.

resource "aws_s3_bucket" "site" {
  # S3 bucket names are GLOBALLY unique (across every AWS customer), so we
  # append our account id to avoid collisions with anyone else's bucket.
  bucket = "studybuddy-timer-site-${data.aws_caller_identity.current.account_id}"

  # Let `terraform destroy` delete the bucket even when it has files in it.
  # Safe here: the contents are just copies of site/ that redeploy in
  # seconds. (Stage 4 requires destroy -> apply to rebuild cleanly.)
  force_destroy = true
}

# Belt AND suspenders: block every form of public access at the bucket
# level. Even a mistaken future "make it public" policy would be refused.
resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The bucket policy: WHO may do WHAT to this bucket. Written as a data
# block (Terraform composes the JSON for us). It grants exactly one
# outsider — the CloudFront service — exactly two rights, and only when
# the request comes from OUR distribution (the SourceArn condition, so no
# other AWS customer's CloudFront can be pointed at our bucket).
data "aws_iam_policy_document" "site_bucket" {
  # Right 1: read individual files.
  statement {
    sid = "AllowCloudFrontGetObject"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"] # every object in the bucket

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  # Right 2: check whether a file exists. Without this, S3 answers
  # "403 Forbidden" for a missing file (it won't even admit the file isn't
  # there); with it, a bad URL gets an honest "404 Not Found".
  statement {
    sid = "AllowCloudFrontListBucket"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.site.arn] # ListBucket applies to the bucket itself

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_bucket.json
}
