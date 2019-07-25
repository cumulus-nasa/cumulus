data "aws_caller_identity" "current" { }

data "aws_iam_policy_document" "assume_lambda_role" {
  statement {
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions   = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "report_executions_lambda_role" {
  name                 = "${var.prefix}_report_executions_lambda_role"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda_role.json
  permissions_boundary = var.permissions_boundary
}

data "aws_iam_policy_document" "report_executions_policy_document" {
  statement {
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DeleteNetworkInterface"
    ]
    resources = [
      "*"
    ]
  }
  statement {
    actions = [
      "dynamoDb:getItem",
      "dynamoDb:putItem"
    ]
    resources = [
      "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.prefix}-ExecutionsTable"
    ]
  }
}

resource "aws_iam_role_policy" "report_executions_lambda_role_policy" {
  name   = "${var.prefix}_report_executions_lambda_role_policy"
  role   = aws_iam_role.report_executions_lambda_role.id
  policy = data.aws_iam_policy_document.report_executions_policy_document.json
}
