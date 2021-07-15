data "aws_iam_policy_document" "process_dead_letter_archive_policy" {
  statement {
    actions = ["dynamodb:UpdateItem"]
    resources = [
      var.dynamo_tables.executions.arn,
      var.dynamo_tables.granules.arn,
      var.dynamo_tables.pdrs.arn
    ]
  }

  statement {
    actions = [
      "states:DescribeExecution",
      "states:GetExecutionHistory"
    ]
    resources = ["*"]
  }

  statement {
    actions   = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]
    resources = ["arn:aws:s3:::${var.system_bucket}/*"]
  }

  statement {
    actions   = [
      "s3:ListBucket"
    ]
    resources = ["arn:aws:s3:::${var.system_bucket}"]
  }

  statement {
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface"
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents"
    ]
    resources = ["*"]
  }

  statement {
    actions = [
      "s3:GetObject*",
    ]
    resources = [for b in local.allowed_buckets: "arn:aws:s3:::${b}/*"]
  }

  statement {
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = [var.rds_user_access_secret_arn]
  }
}

resource "aws_iam_role" "process_dead_letter_archive_role" {
  name                 = "${var.prefix}_process_dead_letter_archive_role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role_policy.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

resource "aws_iam_role_policy" "process_dead_letter_archive_role_policy" {
  name   = "${var.prefix}_process_dead_letter_archive_lambda_role_policy"
  role   = aws_iam_role.process_dead_letter_archive_role.id
  policy = data.aws_iam_policy_document.process_dead_letter_archive_policy.json
}

resource "aws_lambda_function" "process_dead_letter_archive" {
  filename         = "${path.module}/../../packages/api/dist/processDeadLetterArchive/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/processDeadLetterArchive/lambda.zip")
  function_name    = "${var.prefix}-processDeadLetterArchive"
  role             = aws_iam_role.process_dead_letter_archive_role.arn
  handler          = "index.handler"
  runtime          = "nodejs12.x"
  timeout          = 300
  memory_size      = 512

  environment {
    variables = {
      system_bucket   = var.system_bucket
      stackName       = var.prefix
      ExecutionsTable = var.dynamo_tables.executions.name
      GranulesTable   = var.dynamo_tables.granules.name
      PdrsTable       = var.dynamo_tables.pdrs.name
      dbHeartBeat     = var.rds_connection_heartbeat
      databaseCredentialSecretArn    = var.rds_user_access_secret_arn
      RDS_DEPLOYMENT_CUMULUS_VERSION = "9.0.0"
    }
  }

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids = compact([
        aws_security_group.no_ingress_all_egress[0].id,
        var.rds_security_group
      ])
    }
  }

  tags = var.tags
}
