# API outputs

# TEA-Specific outputs.

output "distribution_bucket_map" {
  value = var.tea_internal_api_endpoint != null ? module.distribution[0].distribution_bucket_map : null
}

output "s3_credentials_redirect_uri" {
  value = var.tea_internal_api_endpoint != null ? module.distribution[0].s3_credentials_redirect_uri : null
}

# End TEA-Specific outputs.
output "archive_api_uri" {
  value = module.archive.api_uri
}

output "archive_api_redirect_uri" {
  value = module.archive.api_redirect_uri
}

output "provider_kms_key_id" {
  value = module.archive.provider_kms_key_id
}

# Reporting queue and topics

output "stepfunction_event_reporter_queue_url" {
  value = module.archive.sf_event_sqs_to_db_records_sqs_queue_url
}

output "report_collections_sns_topic_arn" {
  value = module.archive.report_collections_sns_topic_arn
}

output "report_executions_sns_topic_arn" {
  value = module.archive.report_executions_sns_topic_arn
}

output "report_granules_sns_topic_arn" {
  value = module.archive.report_granules_sns_topic_arn
}

output "report_pdrs_sns_topic_arn" {
  value = module.archive.report_pdrs_sns_topic_arn
}

# Cumulus core task outputs

output "add_missing_file_checksums_task" {
  value = module.ingest.add_missing_file_checksums_task
}

output "discover_granules_task" {
  value = module.ingest.discover_granules_task
}

output "discover_pdrs_task" {
  value = module.ingest.discover_pdrs_task
}

output "fake_processing_task" {
  value = module.ingest.fake_processing_task
}

output "files_to_granules_task" {
  value = module.ingest.files_to_granules_task
}

output "hello_world_task" {
  value = module.ingest.hello_world_task
}

output "hyrax_metadata_updates_task" {
  value = module.ingest.hyrax_metadata_updates_task
}

output "lzards_backup_task" {
  value = module.ingest.lzards_backup_task
}

output "move_granules_task" {
  value = module.ingest.move_granules_task
}

output "parse_pdr_task" {
  value = module.ingest.parse_pdr_task
}

output "pdr_status_check_task" {
  value = module.ingest.pdr_status_check_task
}

output "queue_granules_task" {
  value = module.ingest.queue_granules_task
}

output "queue_pdrs_task" {
  value = module.ingest.queue_pdrs_task
}

output "queue_workflow_task" {
  value = module.ingest.queue_workflow_task
}

output "sf_sqs_report_task" {
  value = module.ingest.sf_sqs_report_task
}

output "sync_granule_task" {
  value = module.ingest.sync_granule_task
}

output "update_cmr_access_constraints_task" {
  value = module.ingest.update_cmr_access_constraints_task
}

output "update_granules_cmr_metadata_file_links_task" {
  value = module.ingest.update_granules_cmr_metadata_file_links_task
}

# Workflow config outputs

output "workflow_config" {
  value = {
    sf_event_sqs_to_db_records_sqs_queue_arn         = module.archive.sf_event_sqs_to_db_records_sqs_queue_arn
    sf_semaphore_down_lambda_function_arn           = module.ingest.sf_semaphore_down_lambda_function_arn
    state_machine_role_arn                          = module.ingest.step_role_arn
    sqs_message_remover_lambda_function_arn         = module.ingest.sqs_message_remover_lambda_function_arn
  }
}

# Other Lambda outputs

output "post_to_cmr_task" {
  value = module.ingest.post_to_cmr_task
}

output "sqs2sfThrottle_lambda_function_arn" {
  value = module.ingest.sqs2sfThrottle_lambda_function_arn
}

# IAM outputs

output "lambda_processing_role_arn" {
  value = aws_iam_role.lambda_processing.arn
}

output "lambda_processing_role_name" {
  value = aws_iam_role.lambda_processing.name
}

output "scaling_role_arn" {
  value = module.ingest.scaling_role_arn
}

# ECS cluster

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.default.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.default.name
}

# Queues

output "start_sf_queue_url" {
  value = module.ingest.start_sf_queue_url
}
