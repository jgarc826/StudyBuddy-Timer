# The AWS "provider" is the plugin that turns our resource declarations
# into real AWS API calls. It finds credentials on its own from the
# environment — the short-lived session created by `aws login`. No keys or
# secrets ever appear in these files (project hard rule).

provider "aws" {
  region = "us-east-1"

  # Stamp every resource this configuration creates with the same tags,
  # so anything we make is identifiable in the AWS console at a glance.
  default_tags {
    tags = {
      Project   = "studybuddy-timer"
      ManagedBy = "terraform"
    }
  }
}

# A "data" block READS something that already exists instead of creating
# anything. This one asks "which AWS account am I?" — used below to make
# the bucket name globally unique without inventing random strings.
data "aws_caller_identity" "current" {}
