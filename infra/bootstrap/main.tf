# Bootstrap: the S3 bucket that stores the MAIN configuration's Terraform
# state, so CI and this machine share one source of truth with locking.
#
# Why a separate configuration: if the state bucket lived in the main
# config, `terraform destroy` over there would try to delete the very
# bucket holding the state that describes the destroy — a snake eating
# its tail. This config is applied once, by hand, and its own (tiny,
# secretless) state stays local on purpose.

terraform {
  required_version = ">= 1.13.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "studybuddy-timer"
      ManagedBy = "terraform-bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "tfstate" {
  bucket = "studybuddy-timer-tfstate-${data.aws_caller_identity.current.account_id}"

  # NO force_destroy here, unlike the site bucket: losing state means
  # Terraform forgets what exists in AWS. This bucket must resist
  # accidental deletion, not enable it.
}

# Versioning keeps every previous copy of the state file — the undo
# button if a state file is ever corrupted or clobbered.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

# State can contain resource details and secrets; same four public-access
# locks as every other bucket in this project.
resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket_name" {
  description = "Paste into infra/backend.tf (backend blocks cannot read variables)"
  value       = aws_s3_bucket.tfstate.bucket
}
