terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 3.14.1"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 2.1"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "tags" {
  description = "Tags to be applied to managed resources"
  type        = map(string)
  default     = {}
}

locals {
  security_group_ids_set = var.security_group_ids != null
}

resource "aws_security_group" "test_cleanup_lambda" {
  count  = local.security_group_ids_set ? 0 : 1
  vpc_id = var.vpc_id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = var.tags
}

resource "aws_lambda_function" "cumulus_test_cleanup" {
  filename      = "${path.module}/dist/lambda.zip"
  function_name = "cumulus-test-cleanup"
  role          = aws_iam_role.test_cleanup_lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs12.x"
  timeout       = 900

  source_code_hash = filebase64sha256("${path.module}/dist/lambda.zip")

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = local.security_group_ids_set ? var.security_group_ids : [aws_security_group.test_cleanup_lambda[0].id]
  }

  tags = var.tags
}

resource "aws_cloudwatch_event_rule" "cumulus_test_cleanup" {
  name                = "cumulus_test_cleanup"
  schedule_expression = "cron(0 1 * * ? *)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "cumulus_test_cleanup" {
  target_id = "cleanup_lambda_target"
  rule      = aws_cloudwatch_event_rule.cumulus_test_cleanup.name
  arn       = aws_lambda_function.cumulus_test_cleanup.arn
}

resource "aws_lambda_permission" "cumulus_test_cleanup" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cumulus_test_cleanup.arn
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cumulus_test_cleanup.arn
}
