resource "aws_sqs_queue" "db_indexer_dead_letter_queue" {
  name                       = "${var.prefix}-dbIndexerDeadLetterQueue"
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 60
  tags                       = var.tags
}

resource "aws_lambda_function" "db_indexer" {
  function_name    = "${var.prefix}-dbIndexer"
  filename         = "${path.module}/../../packages/api/dist/dbIndexer/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/dbIndexer/lambda.zip")
  handler          = "index.handler"
  role             = var.lambda_processing_role_arn
  runtime          = "nodejs12.x"
  timeout          = 300
  memory_size      = 320
  dead_letter_config {
    target_arn = aws_sqs_queue.db_indexer_dead_letter_queue.arn
  }
  environment {
    variables = {
      CMR_ENVIRONMENT            = var.cmr_environment
      CMR_HOST                   = var.cmr_custom_host
      ExecutionsTable            = var.dynamo_tables.executions.name
      AsyncOperationsTable       = var.dynamo_tables.async_operations.name
      FilesTable                 = var.dynamo_tables.files.name
      GranulesTable              = var.dynamo_tables.granules.name
      PdrsTable                  = var.dynamo_tables.pdrs.name
      ProvidersTable             = var.dynamo_tables.providers.name
      ReconciliationReportsTable = var.dynamo_tables.reconciliation_reports.name
      RulesTable                 = var.dynamo_tables.rules.name
      ES_HOST                    = var.elasticsearch_hostname
      stackName                  = var.prefix
      system_bucket              = var.system_bucket
    }
  }
  tags = var.tags

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids = local.lambda_security_group_ids
    }
  }
}

data "aws_dynamodb_table" "executions" {
  name = var.dynamo_tables.executions.name
}

data "aws_dynamodb_table" "granules" {
  name = var.dynamo_tables.granules.name
}

data "aws_dynamodb_table" "reconciliation_reports" {
  name = var.dynamo_tables.reconciliation_reports.name
}

resource "aws_lambda_event_source_mapping" "reconciliation_reports_table_db_indexer" {
  event_source_arn  = data.aws_dynamodb_table.reconciliation_reports.stream_arn
  function_name     = aws_lambda_function.db_indexer.arn
  starting_position = "TRIM_HORIZON"
  batch_size        = 10
}
