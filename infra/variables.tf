# Input variables. Only one so far. A variable with a default needs no
# .tfvars file, which matters because CI applies this configuration too
# and gitignored tfvars files wouldn't reach it.

variable "alerts_email" {
  description = "Where CloudWatch alarm emails go (SNS sends a confirmation link there first)"
  type        = string
  default     = "jgarc826@ucr.edu"
}
