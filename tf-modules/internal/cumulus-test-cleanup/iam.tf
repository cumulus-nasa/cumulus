data "aws_iam_policy_document" "assume_lambda_role" {
  statement {
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "test_cleanup_lambda_role" {
  name                 = "test_cleanup_lambda_role"
  assume_role_policy   = data.aws_iam_policy_document.assume_lambda_role.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
}

data "aws_iam_policy_document" "test_cleanup_policy_document" {
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
      "kinesis:ListStreams",
      "kinesis:DeleteStream"
    ]
    resources = ["*"]
  }
  statement {
    actions = [
      "s3:ListAllMyBuckets",
      "s3:GetBucket*",
      "s3:GetObject*",
      "s3:ListBucket*",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "test_cleanup_lambda_role_policy" {
  name   = "test_cleanup_lambda_role_policy"
  role   = aws_iam_role.test_cleanup_lambda_role.id
  policy = data.aws_iam_policy_document.test_cleanup_policy_document.json
}
