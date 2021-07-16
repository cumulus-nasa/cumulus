# Required

variable "prefix" {
  description = "The unique prefix for your deployment resources"
  type        = string
}

variable "cmr_environment" {
  description = "Environment that should be used for CMR requests (e.g. 'UAT', 'SIT')"
  type        = string
}

variable "system_bucket" {
  description = "The name of the S3 bucket to be used for staging deployment files"
  type        = string
}

variable "lambda_processing_role_arn" {
  description = "Name of IAM role assumed when executing Lambda"
  type = string
}

# Optional

variable "cmr_custom_host" {
  description = "Custom protocol/host to use for CMR requests (e.g. http://cmr-host.com)"
  type        = string
  default     = null
}

variable "lambda_subnet_ids" {
  description = "Subnet IDs for Lambdas"
  type        = list(string)
  default     = null
}

variable "security_group_ids" {
  description = "Security Group IDs for Lambdas"
  type        = list(string)
  default     = null
}

variable "tags" {
  description = "Tags to be applied to Cumulus resources that support tags"
  type        = map(string)
  default     = {}
}
