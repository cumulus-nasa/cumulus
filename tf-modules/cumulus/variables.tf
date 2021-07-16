# Required

variable "async_operation_image" {
  description = "docker image to use for Cumulus async operations tasks"
  type = string
  default = "cumuluss/async-operation:32"
}

variable "cmr_client_id" {
  description = "Client ID that you want to use for requests to CMR (https://cmr.earthdata.nasa.gov/search/site/docs/search/api.html)"
  type        = string
}

variable "cmr_environment" {
  description = "Environment that should be used for CMR requests ('UAT', 'SIT', or 'PROD')"
  type        = string
}

variable "cmr_password" {
  description = "Password to use (in combination with `cmr_username`) for authorizing CMR requests"
  type        = string
}

variable "cmr_provider" {
  description = "The provider name should be used when storing metadata in CMR"
  type        = string
}

variable "cmr_username" {
  description = "Username to use (in combination with `cmr_password`) for authorizing CMR requests"
  type        = string
}

variable "cumulus_message_adapter_lambda_layer_version_arn" {
  description = "Layer version ARN of the Lambda layer for the Cumulus Message Adapter"
  type        = string
  default     = null
}
variable "rds_security_group" {
  description = "RDS Security Group used for access to RDS cluster"
  type        = string
  default     = null
}

variable "rds_user_access_secret_arn" {
  description = "RDS User Database Login Credential Secret ARN"
  type        = string
}

variable "deploy_to_ngap" {
  description = "Whether or not this instance of Cumulus is deployed to an NGAP environment"
  type        = bool
}

variable "dynamo_tables" {
  description = "A map of objects with the `arn` and `name` of every DynamoDB table for your Cumulus deployment."
  type        = map(object({ name = string, arn = string }))
}

variable "ecs_cluster_desired_size" {
  description = "The desired maximum number of instances for your ECS autoscaling group"
  type        = number
}

variable "ecs_cluster_instance_image_id" {
  type        = string
  description = "AMI ID of ECS instances"
}

variable "ecs_cluster_instance_subnet_ids" {
  description = "The Subnet IDs to use for your ECS cluster instances"
  type        = list(string)
}

variable "ecs_cluster_max_size" {
  description = "The maximum number of instances for your ECS cluster"
  type        = number
}

variable "ecs_cluster_min_size" {
  description = "The minimum number of instances for your ECS cluster"
  type        = number
}

variable "elasticsearch_domain_arn" {
  description = "The ARN of an Elasticsearch domain to use for storing data"
  type        = string
  default     = null
}

variable "elasticsearch_hostname" {
  description = "The hostname of an Elasticsearch domain to use for storing data"
  type        = string
  default     = null
}

variable "elasticsearch_security_group_id" {
  description = "The ID of the security group for the Elasticsearch domain specified by `elasticsearch_domain_arn`"
  type        = string
  default     = ""
}

variable "prefix" {
  description = "The unique prefix for your deployment resources"
  type        = string
}

variable "sts_credentials_lambda_function_arn" {
  type        = string
  default     = null
  description = "ARN of lambda function that provides app owners with keys that can be passed on to their app users."
}

variable "sts_policy_helper_lambda_function_arn" {
  type        = string
  default     = null
  description = "ARN of lambda function that outputs session policies to be passed to the sts key lambda."
}

variable "system_bucket" {
  description = "The name of the S3 bucket to be used for staging deployment files"
  type        = string
}

variable "tea_external_api_endpoint" {
  description = "Thin Egress App external endpoint URL"
  type        = string
}

variable "tea_internal_api_endpoint" {
  description = "Thin Egress App internal endpoint URL"
  type        = string
}

variable "token_secret" {
  description = "A string value used for signing and verifying JSON Web Tokens (JWTs) issued by the archive API. Should be a 32-character string for security"
  type        = string
}

variable "urs_client_id" {
  type        = string
  description = "The client ID for your Earthdata login (URS) application"
}

variable "urs_client_password" {
  type        = string
  description = "The client password for your Earthdata login (URS) application"
}

# Optional

variable "api_gateway_stage" {
  type        = string
  default     = "dev"
  description = "The archive API Gateway stage to create"
}

variable "archive_api_port" {
  description = "Port number that should be used for archive API requests"
  type        = number
  default     = null
}

variable "archive_api_reserved_concurrency" {
  description = "Reserved Concurrency for the API lambda function"
  type = number
  default = 8
}

variable "archive_api_users" {
  description = "Earthdata (URS) usernames that should be allowed to access the archive API"
  type        = list(string)
  default     = []
}

variable "buckets" {
  description = "Map identifying the buckets for the deployment"
  type        = map(object({ name = string, type = string }))
  default     = {}
}

variable "bucket_map_key" {
  description = "Optional S3 Key for TEA bucket map object to override default Cumulus configuration"
  type        = string
  default     = null
}

variable "cmr_custom_host" {
  description = "Custom protocol/host to use for CMR requests (e.g. http://cmr-host.com)"
  type        = string
  default     = null
}

variable "cmr_limit" {
  description = "Limit of the number of results to return from CMR"
  type        = number
  default     = 100
}

variable "cmr_oauth_provider" {
  description = "Oauth provider to use for authorizing requests to CMR"
  type        = string
  default     = "earthdata"
}

variable "cmr_page_size" {
  description = "Default number of results to return per page when searching CMR for collections/granules"
  type        = number
  default     = 50
}

variable "custom_queues" {
  description = "Map of SQS queue identifiers to queue URLs"
  type        = list(object({ id = string, url = string }))
  default     = []
}

variable "deploy_distribution_s3_credentials_endpoint" {
  description = "Whether or not to include the S3 credentials endpoint in the Thin Egress App"
  type        = bool
  default     = true
}

variable "ecs_container_stop_timeout" {
  description = "Time duration to wait from when a task is stopped before its containers are forcefully killed if they do not exit normally on their own"
  type        = string
  default     = "2m"
}

variable "ecs_cluster_instance_docker_volume_size" {
  type        = number
  description = "Size (in GB) of the volume that Docker uses for image and metadata storage"
  default     = 50
}

variable "ecs_cluster_instance_type" {
  type        = string
  description = "EC2 instance type for cluster instances"
  default     = "t3.medium"
}

variable "ecs_cluster_scale_in_adjustment_percent" {
  type    = number
  default = -5
}

variable "ecs_cluster_scale_in_threshold_percent" {
  type    = number
  default = 25
}

variable "ecs_cluster_scale_out_adjustment_percent" {
  type    = number
  default = 10
}

variable "ecs_cluster_scale_out_threshold_percent" {
  type    = number
  default = 75
}

variable "ecs_docker_hub_config" {
  description = "Credentials for integrating ECS with containers hosted on Docker Hu"
  type        = object({ username = string, password = string, email = string })
  default     = null
}

variable "ecs_docker_storage_driver" {
  description = "Storage driver for ECS tasks"
  type        = string
  default     = "devicemapper"
}

variable "ecs_efs_config" {
  description = "Config for using EFS with ECS instances"
  type        = object({ mount_target_id = string, mount_point = string })
  default     = null
}

variable "ecs_include_docker_cleanup_cronjob" {
  description = "*Experimental* flag to configure a cron to run fstrim on all active container root filesystems"
  type        = bool
  default     = false
}

variable "ecs_service_alarms" {
  description = "List of Cloudwatch alarms monitoring ECS instances"
  type        = list(object({ name = string, arn = string }))
  default     = []
}

variable "elasticsearch_alarms" {
  description = "List of Cloudwatch alarms monitoring Elasticsearch domain"
  type        = list(object({ name = string, arn = string }))
  default     = []
}

variable "es_request_concurrency" {
  type = number
  default = 10
  description = "Maximum number of concurrent requests to send to Elasticsearch. Used in index-from-database operation"
}

variable "key_name" {
  description = "Name of EC2 key pair for accessing EC2 instances"
  type        = string
  default     = null
}

variable "lambda_subnet_ids" {
  description = "Subnet IDs for Lambdas"
  type        = list(string)
  default     = null
}

variable "launchpad_api" {
  description = "URL of Launchpad API. Required if using lzards-backup task or  `cmr_oauth_provider = 'launchpad'`."
  type        = string
  default     = "launchpadApi"
}

variable "launchpad_certificate" {
  description = "Name of the Launchpad certificate uploaded to the 'crypto' directory of the `system_bucket`. Required if using `cmr_oauth_provider = 'launchpad'`"
  type        = string
  default     = "launchpad.pfx"
}

variable "launchpad_passphrase" {
  description = "Passphrase of Launchpad certificate. Required if using `cmr_oauth_provider = 'launchpad'`."
  type        = string
  default     = ""
}
variable "lzards_launchpad_certificate" {
  description = "Name of the Launchpad certificate uploaded to the 'crypto' directory of the `system_bucket` for use with the lzards-backup task`."
  type        = string
  default     = "lzards_launchpad.pfx"
}

variable "lzards_launchpad_passphrase" {
  description = "Passphrase for use with lzards_launchpad_certificate."
  type        = string
  default     = ""
}

variable "lzards_provider" {
  description = "LZARDS provider name"
  type        = string
  default     = ""
}

variable "lzards_api" {
  description = "LZARDS backup API endpoint"
  type = string
  default = ""
}

variable "lzards_s3_link_timeout" {
  description = "LZARDS S3 access link timeout (seconds)"
  type        = string
  default     = ""
}

variable "log_destination_arn" {
  type        = string
  default     = null
  description = "shared AWS:Log:Destination value. Requires log_api_gateway_to_cloudwatch set to true for TEA module."
}

variable "metrics_es_host" {
  type    = string
  default = null
}

variable "metrics_es_password" {
  type    = string
  default = null
}

variable "metrics_es_username" {
  type    = string
  default = null
}

variable "oauth_provider" {
  description = "Oauth provider to use for authorizing requests to the archive API. Also accepts 'launchhpad'"
  type        = string
  default     = "earthdata"
}

variable "oauth_user_group" {
  description = "Oauth user group to validate the user against when using `oauth_provider = 'launchpad'`."
  type        = string
  default     = "N/A"
}

variable "permissions_boundary_arn" {
  description = "The ARN of an IAM permissions boundary to use when creating IAM policies"
  type        = string
  default     = null
}

variable "private_archive_api_gateway" {
  description = "Whether to deploy the archive API as a private API gateway"
  type        = bool
  default     = true
}

variable "rds_connection_heartbeat" {
  description = "If true, send a query to verify database connection is live on connection creation and retry on initial connection timeout.  Set to false if not using serverless RDS"
  type        = bool
  default     = false
}

variable "saml_entity_id" {
  description = "The endpoint EntityID from the Launchpad Integration Request"
  type        = string
  default     = "N/A"
}

variable "saml_assertion_consumer_service" {
  description = "The URL Bindings Assertion Point from the Launchpad Integration Request"
  type        = string
  default     = "N/A"
}

variable "saml_idp_login" {
  description = "The SAML Identity Provider's saml2sso endpoint"
  type        = string
  default     = "N/A"
}

variable "saml_launchpad_metadata_url" {
  description = "The url of the Identity Provider public metadata xml file"
  type        = string
  default     = "N/A"
}

variable "tags" {
  description = "Tags to be applied to Cumulus resources that support tags"
  type        = map(string)
  default     = {}
}

variable "tea_api_gateway_stage" {
  description = "The name of the API Gateway stage to create for the Thin Egress App"
  type        = string
  default     = "DEV"
}

variable "tea_rest_api_id" {
  description = "Thin Egress App API gateway ID"
  type        = string
  default     = null
}

variable "tea_rest_api_root_resource_id" {
  description = "Thin Egress App API gateway root resource ID"
  type        = string
  default     = null
}

variable "throttled_queues" {
  description = "Array of configuration for custom queues with execution limits"
  type        = list(object({
    url = string,
    execution_limit = number
  }))
  default     = []
}

variable "urs_url" {
  description = "The URL of the Earthdata login (URS) site"
  type        = string
  default     = "https://uat.urs.earthdata.nasa.gov"
}

variable "cmr_acl_based_credentials" {
  type = bool
  default = false
  description = "Option to enable/disable user based CMR ACLs to derive permission for s3 credential access tokens"
}

variable "vpc_id" {
  description = "VPC used by Lambda functions"
  type        = string
  default     = null
}

# archive module clean_executions lambda configuration

variable "daily_execution_payload_cleanup_schedule_expression" {
  type        = string
  default     = "cron(0 4 * * ? *)"
  description = "Cloud Watch cron schedule for the execution payload cleanup lambda"
}

variable "complete_execution_payload_timeout_disable" {
  type        = bool
  default     = false
  description = "Boolean flag that when set to true will disable 'complete' execution cleanup"
}

variable "complete_execution_payload_timeout" {
  type        = number
  default     = 10
  description = "Number of days to retain 'complete' execution payload records in the database"
}

variable "non_complete_execution_payload_timeout_disable" {
  type        = bool
  default     = false
  description = "Boolean flag that when set to true will disable 'complete' execution cleanup"

}

variable "non_complete_execution_payload_timeout" {
  description = "Number of days to retain 'non-complete' execution payload records in the database"
  type        = number
  default     = 30
}

variable "archive_api_url" {
  type        = string
  default     = null
  description = "If not specified, the value of the Backend (Archive) API Gateway endpoint is used"
}

variable "additional_log_groups_to_elk" {
  description = "Map of Cloudwatch Log Groups. The key is a descriptor and the value is the log group"
  type = map(string)
  default = {}
}

variable "es_index_shards" {
  description = "The number of shards for the Elasticsearch index"
  type        = number
  default     = 2
}

variable "ecs_custom_sg_ids" {
  description = "User defined security groups to add to the Core ECS cluster"
  type = list(string)
  default = []
}
