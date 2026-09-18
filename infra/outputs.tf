# Outputs: values Terraform prints after an apply, and that scripts can
# read with `terraform output`. The deploy script uses these so bucket and
# distribution names are never hardcoded anywhere.

output "site_url" {
  description = "The public HTTPS address of the site"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "s3_bucket_name" {
  description = "Bucket the deploy script syncs site/ into"
  value       = aws_s3_bucket.site.bucket
}

output "cloudfront_distribution_id" {
  description = "Distribution the deploy script sends cache invalidations to"
  value       = aws_cloudfront_distribution.site.id
}
