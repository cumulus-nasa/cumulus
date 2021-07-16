# Required

variable "cmr_client_id" {
  type = string
}

variable "cmr_environment" {
  type = string
}

variable "cmr_password" {
  type = string
}

variable "cmr_provider" {
  type = string
}

variable "cmr_username" {
  type = string
}

variable "bucket_map_key" {
  type    = string
  default = null
}

variable "cumulus_message_adapter_lambda_layer_version_arn" {
  type        = string
  description = "Layer version ARN of the Lambda layer for the Cumulus Message Adapter"
}

variable "cmr_oauth_provider" {
  type    = string
  default = "earthdata"
}

variable "csdap_client_id" {
  type        = string
  description = "The csdap client id"
}

variable "csdap_client_password" {
  type        = string
  description = "The csdap client password"
}

variable "csdap_host_url" {
  type        = string
  description = "The csdap host url"
}

variable "launchpad_api" {
  type    = string
  default = "launchpadApi"
}

variable "launchpad_certificate" {
  type    = string
  default = "launchpad.pfx"
}

variable "launchpad_passphrase" {
  type    = string
  default = ""
}
variable "lzards_launchpad_certificate" {
  type    = string
  default = "launchpad.pfx"
}

variable "lzards_launchpad_passphrase" {
  type    = string
  default = ""
}

variable "lzards_api" {
  description = "LZARDS API endpoint"
  type        = string
  default     = "https://lzards.sit.earthdata.nasa.gov/api/backups"
}

variable "lzards_provider" {
  description = "LZARDS provider name"
  type        = string
  default     = "CUMULUS_INTEGRATION_TESTS"
}

variable "lzards_s3_link_timeout" {
  description = "LZARDS S3 access link timeout (seconds)"
  type        = string
  default     = ""
}

variable "oauth_provider" {
  type    = string
  default = "earthdata"
}

variable "oauth_user_group" {
  type    = string
  default = "N/A"
}

variable "data_persistence_remote_state_config" {
  type = object({ bucket = string, key = string, region = string })
}

variable "s3_replicator_config" {
  type        = object({ source_bucket = string, source_prefix = string, target_bucket = string, target_prefix = string })
  default     = null
  description = "Configuration for the s3-replicator module. Items with prefix of source_prefix in the source_bucket will be replicated to the target_bucket with target_prefix."
}

variable "prefix" {
  type = string
}

variable "saml_entity_id" {
  type    = string
  default = "N/A"
}

variable "saml_assertion_consumer_service" {
  type    = string
  default = "N/A"
}

variable "saml_idp_login" {
  type    = string
  default = "N/A"
}

variable "saml_launchpad_metadata_url" {
  type    = string
  default = "N/A"
}

variable "system_bucket" {
  type = string
}

variable "token_secret" {
  type = string
}

variable "urs_client_id" {
  type = string
}

variable "urs_client_password" {
  type = string
}

variable "vpc_id" {
  type = string
}

# Optional

variable "api_gateway_stage" {
  type        = string
  default     = "dev"
  description = "The archive API Gateway stage to create"
}

variable "api_reserved_concurrency" {
  type = number
  default = 2
  description = "Archive API Lambda reserved concurrency"
}

variable "buckets" {
  type    = map(object({ name = string, type = string }))
  default = {}
}

variable "cumulus_distribution_url" {
  type        = string
  default     = null
  description = "The url of cumulus distribution API Gateway endpoint"
}

variable "distribution_url" {
  type    = string
  default = null
}

variable "ecs_cluster_instance_subnet_ids" {
  type = list(string)
  default = []
}

variable "ecs_include_docker_cleanup_cronjob" {
  type    = bool
  default = false
}

variable "es_request_concurrency" {
  type = number
  default = 10
  description = "Maximum number of concurrent requests to send to Elasticsearch. Used in index-from-database operation"
}

variable "key_name" {
  type    = string
  default = null
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "permissions_boundary_arn" {
  type    = string
  default = null
}

variable "aws_profile" {
  type    = string
  default = null
}

variable "lambda_subnet_ids" {
  type = list(string)
  default = []
}

variable "log_api_gateway_to_cloudwatch" {
  type        = bool
  default     = false
  description = "Enable logging of API Gateway activity to CloudWatch."
}

variable "log_destination_arn" {
  type        = string
  default     = null
  description = "Remote kinesis/destination arn for delivering logs."
}

variable "archive_api_port" {
  type    = number
  default = null
}

variable "archive_api_url" {
  type        = string
  default     = null
  description = "If not specified, the value of the Backend (Archive) API Gateway endpoint is used"
}

variable "private_archive_api_gateway" {
  type    = bool
  default = true
}

variable "thin_egress_jwt_secret_name" {
  type        = string
  description = "Name of AWS secret where keys for the Thin Egress App JWT encode/decode are stored"
  default     = "cumulus_sandbox_jwt_tea_secret"
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

variable "additional_log_groups_to_elk" {
  type    = map(string)
  default = {}
}

variable "tags" {
  description = "Tags to be applied to Cumulus resources that support tags"
  type        = map(string)
  default     = {}
}

variable "es_index_shards" {
  description = "The number of shards for the Elasticsearch index"
  type        = number
  default     = 2
}

variable "pdr_node_name_provider_bucket" {
  type = string
  description = "The name of the common bucket used as an S3 provider for PDR NODE_NAME tests"
  default = "cumulus-sandbox-pdr-node-name-provider"
}

variable "rds_connection_heartbeat" {
  description = "If true, send a query to verify database connection is live on connection creation and retry on initial connection timeout.  Set to false if not using serverless RDS"
  type        = bool
  default     = false
}

variable "async_operation_image_version" {
  description = "docker image version to use for Cumulus async operations tasks"
  type = string
  default = "32"
}

variable "cumulus_process_activity_version" {
    description = "docker image version to use for python processing service"
    type = string
    default = "1"
}

variable "ecs_task_image_version" {
  description = "docker image version to use for Cumulus hello world task"
    type = string
    default = "1.7.0"
}

variable "cumulus_test_ingest_image_version" {
    description = "docker image version to use for python test ingest processing service"
    type = string
    default = "12"
}
variable "ecs_custom_sg_ids" {
  description = "User defined security groups to add to the Core ECS cluster"
  type = list(string)
  default = []
}

## ORCA Variables Definitions

variable "include_orca" {
  type    = bool
  default = true
}

variable "platform" {
  default = "AWS"
  type = string
  description = "Indicates if running locally (onprem) or in AWS (AWS)."
}

variable "database_name" {
  default = "disaster_recovery"
  type = string
  description = "Name of the ORCA database that contains state information."
}

variable "database_port" {
  default = "5432"
  type = string
  description = "Port the database listens on."
}

variable "postgres_user_pw" {
  type = string
  description = "postgres database user password."
}

variable "database_app_user" {
  default = "druser"
  type = string
  description = "ORCA application database user name."
}

variable "database_app_user_pw" {
  type = string
  description = "ORCA application database user password."
}

variable "orca_drop_database" {
  default = "False"
  type = string
  description = "Tells ORCA to drop the database on deployments."
}

variable "ddl_dir" {
  default = "ddl/"
  type = string
  description = "The location of the ddl dir that contains the sql to create the application database."
}

variable "lambda_timeout" {
  default = 300
  type = number
  description = "Lambda max time before a timeout error is thrown."
}

variable "restore_complete_filter_prefix" {
  default = ""
  type = string
  description = ""
}

variable "copy_retry_sleep_secs" {
  default = 0
  type = number
  description = "How many seconds to wait between retry calls to `copy_object`."
}

variable "default_tags" {
  type = object({ team = string, application = string })
  default = {
    team : "DR",
    application : "disaster-recovery"
  }
}

variable "optional_dynamo_tables" {
  type = map(object({ name = string, arn = string }))
  default = {}
  description = "A map of objects with the `arn` and `name` of every additional DynamoDB table your Cumulus deployment can reference."
}

variable "cmr_custom_host" {
  description = "Custom protocol/host to use for CMR requests (e.g. http://cmr-host.com)"
  type        = string
  default     = null
}
