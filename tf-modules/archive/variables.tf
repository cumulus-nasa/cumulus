# Required

variable "async_operation_image" {
  description = "docker image to use for Cumulus async operations tasks"
  type = string
}

variable "background_queue_url" {
  description = "Queue URL to use for throttled background operations (e.g. granule reingest)"
  type = string
}

variable "cmr_client_id" {
  type = string
}

variable "cmr_environment" {
  type = string
}

variable "cmr_password" {
  description = "The plaintext CMR password"
  type        = string
  default     = ""
}

variable "cmr_provider" {
  type = string
}

variable "cmr_username" {
  type = string
}

variable "rds_security_group" {
  type = string
}

variable "rds_user_access_secret_arn" {
  type = string
}

variable "deploy_to_ngap" {
  description = "Whether or not this instance of Cumulus is deployed to an NGAP environment"
  type        = bool
}

variable "distribution_api_id" {
  type = string
}

variable "distribution_url" {
  type = string
}

variable "dynamo_tables" {
  type = map(object({ name = string, arn = string }))
}

variable "ecs_cluster_name" {
  type = string
}

variable "elasticsearch_domain_arn" {
  type    = string
  default = null
}

variable "elasticsearch_hostname" {
  type    = string
  default = null
}

variable "elasticsearch_security_group_id" {
  type    = string
  default = ""
}

variable "kinesis_inbound_event_logger_lambda_function_arn" {
  type = string
}

variable "kinesis_fallback_topic_arn" {
  type = string
}

variable "lambda_processing_role_arn" {
  type = string
}

variable "manual_consumer_function_arn" {
  type = string
}

variable "message_consumer_function_arn" {
  type = string
}

variable "permissions_boundary_arn" {
  type = string
}

variable "postgres_migration_count_tool_function_arn" {
  type = string
}

variable "postgres_migration_async_operation_function_arn" {
  type = string
}

variable "prefix" {
  type = string
}

variable "schedule_sf_function_arn" {
  type = string
}

variable "system_bucket" {
  type = string
}

variable "token_secret" {
  type = string
}

variable "urs_client_id" {
  type        = string
  description = "The URS app ID"
}

variable "urs_client_password" {
  type        = string
  description = "The URS app password"
}

# Optional

variable "api_gateway_stage" {
  type        = string
  default     = "dev"
  description = "The API Gateway stage to create"
}

variable "api_port" {
  type    = number
  default = null
}

variable "api_reserved_concurrency" {
  type = number
  default = 8
}

variable "api_url" {
  type        = string
  default     = null
  description = "If not specified, the value of the API Gateway endpoint is used"
}

variable "buckets" {
  type    = map(object({ name = string, type = string }))
  default = {}
}

variable "cmr_custom_host" {
  description = "Custom protocol/host to use for CMR requests (e.g. http://cmr-host.com)"
  type        = string
  default     = null
}

variable "cmr_limit" {
  type    = number
  default = 100
}

variable "cmr_oauth_provider" {
  type    = string
  default = "earthdata"
}

variable "cmr_page_size" {
  type    = number
  default = 50
}

variable "es_request_concurrency" {
  type = number
  default = 10
  description = "Maximum number of concurrent requests to send to Elasticsearch. Used in index-from-database operation"
}

variable "lambda_subnet_ids" {
  type    = list(string)
  default = []
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

variable "metrics_es_host" {
  type = string
  default = null
}

variable "metrics_es_password" {
  type = string
  default = null
}

variable "metrics_es_username" {
  type = string
  default = null
}

variable "oauth_provider" {
  type    = string
  default = "earthdata"
}

variable "oauth_user_group" {
  type    = string
  default = "N/A"
}

variable "private_archive_api_gateway" {
  type = bool
  default = true
}

variable "rds_connection_heartbeat" {
  description = "If true, send a query to verify database connection is live on connection creation and retry on initial connection timeout.  Set to false if not using serverless RDS"
  type    = bool
  default = false
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

variable "tags" {
  description = "Tags to be applied to managed resources"
  type        = map(string)
  default     = {}
}

variable "urs_url" {
  type        = string
  default     = "https://uat.urs.earthdata.nasa.gov"
  description = "The URL of the Earthdata Login site"
}

variable "users" {
  type    = list(string)
  default = []
}

variable "vpc_id" {
  type    = string
  default = null
}

## clean_executions lambda config

variable "daily_execution_payload_cleanup_schedule_expression" {
  type    = string
  default = "cron(0 4 * * ? *)"
  description = "Cloud Watch cron schedule for the execution payload cleanup lambda"
}

variable "complete_execution_payload_timeout_disable" {
  type    = bool
  default = false
  description = "Boolean flag that when set to true will disable 'complete' execution cleanup"
}

variable "complete_execution_payload_timeout" {
  type    = number
  default = 10
  description = "Number of days to retain 'complete' execution payload records in the database"
}

variable "non_complete_execution_payload_timeout_disable" {
  type    = bool
  default = false
  description = "Boolean flag that when set to true will disable 'complete' execution cleanup"

}

variable "non_complete_execution_payload_timeout" {
  description = "Number of days to retain 'non-complete' execution payload records in the database"
  type    = number
  default = 30
}

variable "log_destination_arn" {
  type = string
  default = "N/A"
  description = "A shared AWS:Log:Destination that receives logs from log_groups"
}

variable "es_index_shards" {
  description = "The number of shards for the Elasticsearch index"
  type        = number
  default     = 2
}
