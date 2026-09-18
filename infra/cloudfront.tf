# CloudFront: AWS's CDN (content delivery network). Visitors connect to a
# nearby "edge" server (hundreds worldwide), which serves cached copies of
# our files and only fetches from the S3 bucket on a cache miss. It also
# gives us HTTPS and a public URL — the bucket itself stays sealed.

# Origin Access Control: the cryptographic identity CloudFront uses when
# it fetches from S3. CloudFront signs each request to the bucket; the
# bucket policy (s3.tf) only accepts requests signed this way, from our
# distribution. This is what makes "private bucket, public site" work.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "studybuddy-timer-site"
  description                       = "Lets the StudyBuddy Timer distribution read the private site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS ships ready-made cache policies; "CachingOptimized" is their
# recommended one for static sites (long cache, compression-aware).
# A data block looks it up by name so no magic UUID appears in our code.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "StudyBuddy Timer static site"
  default_root_object = "index.html" # "/" means "/index.html"

  # Cheapest tier: edges in North America + Europe only. A visitor from
  # elsewhere still gets the site, just from a farther edge.
  price_class = "PriceClass_100"

  # Where the real files live.
  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-site" # local nickname, referenced below
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # How to serve them.
  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https" # http visitors get bounced to https
    allowed_methods        = ["GET", "HEAD"]     # static site: read-only methods
    cached_methods         = ["GET", "HEAD"]
    compress               = true # gzip/brotli on the wire
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  # No country blocking.
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # Use CloudFront's own certificate for the *.cloudfront.net domain.
  # (A custom domain later would need a certificate in us-east-1 — one of
  # the reasons this whole project lives in that region.)
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
