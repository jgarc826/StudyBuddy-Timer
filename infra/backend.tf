# Where this configuration's STATE lives: an S3 bucket (created by the
# separate infra/bootstrap configuration) instead of a local file, so CI
# and the laptop work against one shared, versioned copy.
#
# `use_lockfile` turns on the backend's built-in locking (Terraform
# 1.10+): a lock object in the bucket stops two applies from running at
# once and corrupting the state — the database-transaction instinct,
# applied to infrastructure.
#
# Everything here must be literal text: backend config is read before
# variables or data sources exist, so the bucket name cannot be computed.

terraform {
  backend "s3" {
    bucket       = "studybuddy-timer-tfstate-719857072816"
    key          = "app/terraform.tfstate" # the state file's path inside the bucket
    region       = "us-east-1"
    use_lockfile = true
  }
}
