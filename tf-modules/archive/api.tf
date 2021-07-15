resource "aws_ssm_parameter" "dynamo_table_names" {
  name = "${var.prefix}-dynamo-table-names"
  type = "String"
  value = jsonencode({
    AccessTokensTable          = var.dynamo_tables.access_tokens.name
    AsyncOperationsTable       = var.dynamo_tables.async_operations.name
    CollectionsTable           = var.dynamo_tables.collections.name
    ExecutionsTable            = var.dynamo_tables.executions.name
    GranulesTable              = var.dynamo_tables.granules.name
    PdrsTable                  = var.dynamo_tables.pdrs.name
    ProvidersTable             = var.dynamo_tables.providers.name
    ReconciliationReportsTable = var.dynamo_tables.reconciliation_reports.name
    RulesTable                 = var.dynamo_tables.rules.name
  })
}

locals {
  api_port_substring        = var.api_port == null ? "" : ":${var.api_port}"
  api_id                    = var.deploy_to_ngap ? aws_api_gateway_rest_api.api[0].id : aws_api_gateway_rest_api.api_outside_ngap[0].id
  api_uri                   = var.api_url == null ? "https://${local.api_id}.execute-api.${data.aws_region.current.name}.amazonaws.com${local.api_port_substring}/${var.api_gateway_stage}/" : var.api_url
  api_redirect_uri          = "${local.api_uri}token"
  api_env_variables = {
      API_BASE_URL                     = local.api_uri
      ASSERT_ENDPOINT                  = var.saml_assertion_consumer_service
      AsyncOperationTaskDefinition     = aws_ecs_task_definition.async_operation.arn
      auth_mode                        = "public"
      backgroundQueueUrl               = var.background_queue_url
      BulkOperationLambda              = aws_lambda_function.bulk_operation.arn
      cmr_client_id                    = var.cmr_client_id
      CMR_ENVIRONMENT                  = var.cmr_environment
      CMR_HOST                         = var.cmr_custom_host
      cmr_oauth_provider               = var.cmr_oauth_provider
      cmr_password_secret_name         = length(var.cmr_password) == 0 ? null : aws_secretsmanager_secret.api_cmr_password.name
      cmr_provider                     = var.cmr_provider
      cmr_username                     = var.cmr_username
      databaseCredentialSecretArn      = var.rds_user_access_secret_arn
      dbHeartBeat                      = var.rds_connection_heartbeat
      DeadLetterProcessingLambda       = aws_lambda_function.process_dead_letter_archive.arn
      DISTRIBUTION_ENDPOINT            = var.distribution_url
      distributionApiId                = var.distribution_api_id
      dynamoTableNamesParameterName    = aws_ssm_parameter.dynamo_table_names.name
      EARTHDATA_BASE_URL               = replace(var.urs_url, "//*$/", "/") # Makes sure there's one and only one trailing slash
      EARTHDATA_CLIENT_ID              = var.urs_client_id
      EARTHDATA_CLIENT_PASSWORD        = var.urs_client_password
      EcsCluster                       = var.ecs_cluster_name
      ENTITY_ID                        = var.saml_entity_id
      ES_CONCURRENCY                   = var.es_request_concurrency
      ES_HOST                          = var.elasticsearch_hostname
      ES_INDEX_SHARDS                  = var.es_index_shards
      IDP_LOGIN                        = var.saml_idp_login
      IndexFromDatabaseLambda          = aws_lambda_function.index_from_database.arn
      invoke                           = var.schedule_sf_function_arn
      invokeArn                        = var.schedule_sf_function_arn
      invokeReconcileLambda            = aws_lambda_function.create_reconciliation_report.arn
      KinesisFallbackTopicArn          = var.kinesis_fallback_topic_arn
      KinesisInboundEventLogger        = var.kinesis_inbound_event_logger_lambda_function_arn
      launchpad_api                    = var.launchpad_api
      launchpad_certificate            = var.launchpad_certificate
      LAUNCHPAD_METADATA_URL           = var.saml_launchpad_metadata_url
      launchpad_passphrase_secret_name = length(var.launchpad_passphrase) == 0 ? null : aws_secretsmanager_secret.api_launchpad_passphrase.name
      log_destination_arn              = var.log_destination_arn
      ManualConsumerLambda             = var.manual_consumer_function_arn
      messageConsumer                  = var.message_consumer_function_arn
      METRICS_ES_HOST                  = var.metrics_es_host
      METRICS_ES_PASS                  = var.metrics_es_password
      METRICS_ES_USER                  = var.metrics_es_username
      MigrationCountToolLambda         = var.postgres_migration_count_tool_function_arn
      MigrationAsyncOperationLambda    = var.postgres_migration_async_operation_function_arn
      OAUTH_PROVIDER                   = var.oauth_provider
      oauth_user_group                 = var.oauth_user_group
      protected_buckets                = join(",", local.protected_buckets)
      provider_kms_key_id              = aws_kms_key.provider_kms_key.key_id
      public_buckets                   = join(",", local.public_buckets)
      ReplayArchivedS3MessagesLambda   = aws_lambda_function.replay_archived_s3_messages.arn
      stackName                        = var.prefix
      system_bucket                    = var.system_bucket
      TOKEN_REDIRECT_ENDPOINT          = local.api_redirect_uri
      TOKEN_SECRET                     = var.token_secret
    }
}

resource "aws_cloudwatch_log_group" "private_api" {
  name              = "/aws/lambda/${aws_lambda_function.private_api.function_name}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_secretsmanager_secret" "api_cmr_password" {
  name_prefix = "${var.prefix}-api-cmr-password"
  description = "CMR password for the Cumulus API's ${var.prefix} deployment"
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "api_cmr_password" {
  count         = length(var.cmr_password) == 0 ? 0 : 1
  secret_id     = aws_secretsmanager_secret.api_cmr_password.id
  secret_string = var.cmr_password
}

resource "aws_secretsmanager_secret" "api_launchpad_passphrase" {
  name_prefix = "${var.prefix}-api-launchpad-passphrase"
  description = "Launchpad passphrase for the Cumulus API's ${var.prefix} deployment"
  tags        = var.tags
}

resource "aws_secretsmanager_secret_version" "api_launchpad_passphrase" {
  count         = length(var.launchpad_passphrase) == 0 ? 0 : 1
  secret_id     = aws_secretsmanager_secret.api_launchpad_passphrase.id
  secret_string = var.launchpad_passphrase
}

resource "aws_s3_bucket_object" "authorized_oauth_users" {
  bucket  = var.system_bucket
  key     = "${var.prefix}/api/authorized_oauth_users.json"
  content = jsonencode(var.users)
  etag    = md5(jsonencode(var.users))
}

resource "aws_lambda_function" "private_api" {
  depends_on       = [aws_s3_bucket_object.authorized_oauth_users]

  function_name    = "${var.prefix}-PrivateApiLambda"
  filename         = "${path.module}/../../packages/api/dist/app/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/app/lambda.zip")
  handler          = "index.handler"
  role             = aws_iam_role.lambda_api_gateway.arn
  runtime          = "nodejs12.x"
  timeout          = 100
  environment {
    variables = merge(local.api_env_variables, {"auth_mode"="private"})
  }
  memory_size = 960
  tags        = var.tags

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids =  concat(local.lambda_security_group_ids, [var.rds_security_group])
    }
  }
}

resource "aws_lambda_function" "api" {
  depends_on       = [aws_s3_bucket_object.authorized_oauth_users]

  function_name    = "${var.prefix}-ApiEndpoints"
  filename         = "${path.module}/../../packages/api/dist/app/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/app/lambda.zip")
  handler          = "index.handler"
  role             = aws_iam_role.lambda_api_gateway.arn
  runtime          = "nodejs12.x"
  timeout          = 100
  environment {
    variables = merge(local.api_env_variables, {"auth_mode"="public"})
  }
  memory_size = 960
  tags        = var.tags

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids = concat(local.lambda_security_group_ids, [var.rds_security_group])
    }
  }
}

data "aws_iam_policy_document" "private_api_policy_document" {
  count = var.deploy_to_ngap || var.private_archive_api_gateway ? 1 : 0
  statement {
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = [ "*" ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceVpc"
      values = [var.vpc_id]
    }
  }
}

resource "aws_api_gateway_rest_api" "api" {
  count = var.deploy_to_ngap ? 1 : 0
  name = "${var.prefix}-archive"

  lifecycle {
    ignore_changes = [policy]
  }

  policy = data.aws_iam_policy_document.private_api_policy_document[0].json

  endpoint_configuration {
    types = ["PRIVATE"]
  }

  tags = var.tags
}

resource "aws_api_gateway_rest_api" "api_outside_ngap" {
  count = var.deploy_to_ngap ? 0 : 1
  name = "${var.prefix}-archive"

  policy = var.private_archive_api_gateway ? data.aws_iam_policy_document.private_api_policy_document[0].json : null

  endpoint_configuration {
    types = var.private_archive_api_gateway ? ["PRIVATE"] : ["EDGE"]
  }
}

resource "aws_lambda_permission" "api_endpoints_lambda_permission" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.arn
  principal     = "apigateway.amazonaws.com"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = var.deploy_to_ngap ? aws_api_gateway_rest_api.api[0].id: aws_api_gateway_rest_api.api_outside_ngap[0].id
  parent_id   = var.deploy_to_ngap ? aws_api_gateway_rest_api.api[0].root_resource_id : aws_api_gateway_rest_api.api_outside_ngap[0].root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "any_proxy" {
  rest_api_id   = var.deploy_to_ngap ? aws_api_gateway_rest_api.api[0].id : aws_api_gateway_rest_api.api_outside_ngap[0].id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "any_proxy" {
  rest_api_id             = var.deploy_to_ngap ? aws_api_gateway_rest_api.api[0].id : aws_api_gateway_rest_api.api_outside_ngap[0].id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.any_proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.api.invoke_arn
}

resource "aws_api_gateway_deployment" "api" {
  depends_on = [aws_api_gateway_integration.any_proxy]

  rest_api_id = var.deploy_to_ngap ? aws_api_gateway_rest_api.api[0].id : aws_api_gateway_rest_api.api_outside_ngap[0].id
  stage_name  = var.api_gateway_stage
}
