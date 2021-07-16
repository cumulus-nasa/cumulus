module "distribution" {
  count = var.tea_internal_api_endpoint != null ? 1 : 0
  source = "../distribution"

  tea_api_gateway_stage         = var.tea_api_gateway_stage
  tea_external_api_endpoint     = var.tea_external_api_endpoint
  tea_internal_api_endpoint     = var.tea_internal_api_endpoint
  tea_rest_api_id               = var.tea_rest_api_id
  tea_rest_api_root_resource_id = var.tea_rest_api_root_resource_id

  cmr_environment                                = var.cmr_environment
  cmr_provider                                   = var.cmr_provider
  deploy_s3_credentials_endpoint                 = var.deploy_distribution_s3_credentials_endpoint
  lambda_processing_role_arn                     = aws_iam_role.lambda_processing.arn
  log_destination_arn                            = var.log_destination_arn
  permissions_boundary_arn                       = var.permissions_boundary_arn
  prefix                                         = var.prefix
  protected_buckets                              = local.protected_bucket_names
  public_buckets                                 = local.public_bucket_names
  sts_credentials_lambda_function_arn            = var.sts_credentials_lambda_function_arn
  sts_policy_helper_lambda_function_arn          = var.sts_policy_helper_lambda_function_arn
  subnet_ids                                     = var.lambda_subnet_ids
  system_bucket                                  = var.system_bucket
  urs_client_id                                  = var.urs_client_id
  urs_client_password                            = var.urs_client_password
  urs_url                                        = var.urs_url
  cmr_acl_based_credentials                      = var.cmr_acl_based_credentials
  vpc_id                                         = var.vpc_id
  deploy_to_ngap                                 = var.deploy_to_ngap

  tags = var.tags
}
