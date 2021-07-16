data "aws_iam_policy_document" "replay_archived_s3_messages_policy" {

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

    statement {
      actions = [
        "sqs:SendMessage",
      ]
      resources = ["arn:aws:sqs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:${var.prefix}-*"]
  }
}

resource "aws_iam_role" "replay_archived_s3_messages_role" {
  name                 = "${var.prefix}_replay_archived_s3_messages_role"
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume_role_policy.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

resource "aws_iam_role_policy" "replay_archived_s3_messages_role_policy" {
  name   = "${var.prefix}_replay_archived_s3_messages_lambda_role_policy"
  role   = aws_iam_role.replay_archived_s3_messages_role.id
  policy = data.aws_iam_policy_document.replay_archived_s3_messages_policy.json
}

resource "aws_lambda_function" "replay_archived_s3_messages" {
  filename         = "${path.module}/../../packages/api/dist/replayArchivedS3Messages/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../packages/api/dist/replayArchivedS3Messages/lambda.zip")
  function_name    = "${var.prefix}-replayArchivedS3Messages"
  role             = aws_iam_role.replay_archived_s3_messages_role.arn
  handler          = "index.handler"
  runtime          = "nodejs12.x"
  timeout          = 300
  memory_size      = 512

  environment {
    variables = {
      system_bucket   = var.system_bucket
      stackName       = var.prefix
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
