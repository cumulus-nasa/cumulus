terraform {
  required_providers {
    aws  = ">= 3.5.0"
  }
}

provider "aws" {
  ignore_tags {
    key_prefixes = ["gsfc-ngap"]
  }
}

data "terraform_remote_state" "data_persistence" {
  backend   = "s3"
  config    = var.data_persistence_remote_state_config
  workspace = terraform.workspace
}

# data "aws_lambda_function" "api_lambda" {
#   function_name = "${var.prefix}-ApiEndpoints"
# }

module "data_migration1" {
  source = "../../lambdas/data-migration1"

  prefix = var.prefix

  permissions_boundary_arn = var.permissions_boundary_arn

  vpc_id            = var.vpc_id
  lambda_subnet_ids = var.subnet_ids

  dynamo_tables = data.terraform_remote_state.data_persistence.outputs.dynamo_tables

  rds_security_group_id = data.terraform_remote_state.data_persistence.outputs.rds_security_group
  rds_user_access_secret_arn = data.terraform_remote_state.data_persistence.outputs.database_credentials_secret_arn

  provider_kms_key_id = var.provider_kms_key_id
  # provider_kms_key_id = data.aws_lambda_function.api_lambda.environment.provider_kms_key_id

  tags = merge(var.tags, { Deployment = var.prefix })
}
