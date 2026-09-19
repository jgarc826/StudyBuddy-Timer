# Which Terraform version and which providers this configuration expects.
#
# Terraform is DECLARATIVE: these .tf files describe the end state we want
# ("a bucket exists, configured like so"), and Terraform computes the diff
# between that and reality, then makes only the needed API calls. Think of
# it as a build system for infrastructure: the .tf files are the source,
# the real AWS resources are the build output, and the state file is the
# build cache that remembers what was already made.

terraform {
  # We installed 1.16.3; anything from 1.13 up is fine for these features.
  required_version = ">= 1.13.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # any 6.x, but never a future 7.x — like a semver cap
    }
    # Zips backend/src into the Lambda deployment package (lambda.tf).
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
