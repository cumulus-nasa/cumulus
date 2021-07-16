---
id: deployment-readme
title: How to Deploy Cumulus
hide_title: false
---

## Overview

This is a guide for deploying a new instance of Cumulus.

This document assumes familiarity with Terraform. If you are not comfortable
working with Terraform, the following links should bring you up to speed:

- [Introduction to Terraform](https://www.terraform.io/intro/index.html)
- [Getting Started with Terraform and AWS](https://learn.hashicorp.com/terraform/?track=getting-started#getting-started)
- [Terraform Configuration Language](https://www.terraform.io/docs/configuration/index.html)

The process involves:

- Creating [AWS S3 Buckets](https://docs.aws.amazon.com/AmazonS3/latest/dev/UsingBucket.html)
- Configuring a VPC, if necessary
- Configuring an Earthdata application, if necessary
- Creating/configuring a [PostgreSQL 10.2 compatible database](../deployment/postgres_database_deployment), and an AWS Secrets Manager secret to allow database access
- Creating a Lambda layer for the [Cumulus Message Adapter](./../workflows/input_output.md#cumulus-message-adapter)
- Creating resources for your Terraform backend
- Using [Terraform](https://www.terraform.io) to deploy resources to AWS

---

## Requirements

### Linux/MacOS software requirements

- git
- zip
- AWS CLI - [AWS command line interface](https://aws.amazon.com/cli/)
- [Terraform](https://www.terraform.io)

#### Install Terraform

It is recommended to keep a consistent version of Terraform as you deploy. Once your state files are migrated to a higher version, they are not always backwards compatible so integrators should pin their Terraform version. This is easily accomplished using the Terraform Version Manager [tfenv](https://github.com/tfutils/tfenv). If you have a CI environment (or any other machine) that you are using to deploy the same stack, **you should pin your version across those machines as well**, otherwise you will run into errors trying to re-deploy from your local machine.

If you are using a Mac and [Homebrew](https://brew.sh), installing tfenv is
as simple as:

```shell
brew update
brew install tfenv
```

For other cases,
[installation instructions](https://github.com/tfutils/tfenv#installation)
are available.

```shell
 $ tfenv install 0.13.6
[INFO] Installing Terraform v0.13.6
...
[INFO] Switching completed

$ tfenv use 0.13.6
[INFO] Switching to v0.13.6
...
[INFO] Switching completed
```

It is recommended to stay on the Cumulus Core TF version which can be found [here](https://github.com/nasa/cumulus/blob/master/example/.tfversion). Any changes to that will be noted in the release notes.

To verify your Terraform version run:

```shell
$ terraform --version
Terraform v0.13.6
```

### Credentials

- [CMR](https://earthdata.nasa.gov/about/science-system-description/eosdis-components/common-metadata-repository) username and password. CMR credentials must be provided if you are exporting metadata to CMR with Earthdata Login authentication.
- [NASA Launchpad](https://launchpad.nasa.gov). Launchpad credentials must be provided if you are using Launchpad authentication to export metadata to CMR or to authenticate with the Cumulus API.
- [Earthdata Login](https://earthdata.nasa.gov/about/science-system-description/eosdis-components/earthdata-login) username and password. User must have the ability to administer and/or create applications in URS. It's recommended to obtain an account in the test environment (UAT).

### Needed Git Repositories

- [Deployment Template](https://github.com/nasa/cumulus-template-deploy)
- [Cumulus Dashboard](https://github.com/nasa/cumulus-dashboard)

---

## Prepare deployment repository

 > _If you already are working with an existing repository that is configured appropriately for the version of Cumulus you intend to deploy or update, skip to [Prepare AWS configuration.](deployment-readme#prepare-aws-configuration)_

Clone the [`cumulus-template-deploy`](https://github.com/nasa/cumulus-template-deploy) repo and name appropriately for your organization:

```bash
  git clone https://github.com/nasa/cumulus-template-deploy <repository-name>
```

We will return to [configuring this repo and using it for deployment below](#deploying-the-cumulus-instance).

<details>
  <summary>Optional: Create a new repository</summary>

  [Create a new repository](https://help.github.com/articles/creating-a-new-repository/) on Github so that you can add your workflows and other modules to source control:

```bash
  git remote set-url origin https://github.com/nasa/<repository-name>
  git push origin master
```

You can then [add/commit](https://help.github.com/articles/adding-a-file-to-a-repository-using-the-command-line/) changes as needed.

> **Note**: If you are pushing your deployment code to a git repo, make sure to add `terraform.tf` and `terraform.tfvars` to `.gitignore`, **as these files will contain sensitive data related to your AWS account**.

</details>

---

## Prepare AWS configuration

### Set Access Keys

You need to make some AWS information available to your environment. If you don't already have the access key and secret access key of an AWS user with IAM Create-User permissions, you must [Create Access Keys](https://docs.aws.amazon.com/general/latest/gr/managing-aws-access-keys.html) for such a user with IAM Create-User permissions, then export the access keys:

```bash
  export AWS_ACCESS_KEY_ID=<AWS access key>
  export AWS_SECRET_ACCESS_KEY=<AWS secret key>
  export AWS_REGION=<region>
```

If you don't want to set environment variables, [access keys can be stored locally via the AWS CLI.](http://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html)

### Create S3 Buckets

See [creating s3 buckets](deployment/create_bucket.md) for more information on how to create a bucket.

The following s3 bucket should be created (replacing `<prefix>` with whatever you'd like, generally your organization/DAAC's name):

- `<prefix>-internal`

You can create additional s3 buckets based on the needs of your workflows.

These buckets do not need any non-default permissions to function with Cumulus, however your local security requirements may vary.

**Note**: S3 bucket object names are global and must be unique across all accounts/locations/etc.

### VPC, Subnets and Security Group

Cumulus supports operation within a VPC, but you will need to separately create:

- VPC
- Subnet
- Security group
- VPC endpoints for the various services used by Cumulus if you wish to route traffic through the VPC

These resources only need to be created once per AWS account and their ids will be used to configure your Terraform deployment.

#### Elasticsearch in a VPC

Amazon Elasticsearch Service does not use a VPC Endpoint. To use ES within a VPC, before deploying run:

```shell
aws iam create-service-linked-role --aws-service-name es.amazonaws.com
```

This operation only needs to be done once per account, but it must be done for both NGAP and regular AWS environments.

### Look up ECS-optimized AMI

Look up the recommended machine image ID for the Linux version and AWS region of your deployment. See [Linux Amazon ECS-optimized AMIs docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-optimized_AMI.html#ecs-optimized-ami-linux). The image ID, beginning with `ami-`, will be assigned to the `ecs_cluster_instance_image_id` variable for the [cumulus-tf module](https://github.com/nasa/cumulus/blob/master/tf-modules/cumulus/variables.tf).

### Set up EC2 key pair (optional)

The key pair will be used to SSH into your EC2 instance(s). It is recommended to [create or import a key pair](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-key-pairs.html) and specify it in your Cumulus deployment.

This can also be done post-deployment by redeploying your Cumulus instance.

---

## Configure EarthData application

The Cumulus stack can authenticate with [Earthdata Login](https://urs.earthdata.nasa.gov/documentation). If you want to use this functionality, you must create and register a new Earthdata application. Use the [User Acceptance Tools (UAT) site](https://uat.urs.earthdata.nasa.gov) unless you intend use a different URS environment (which will require updating the `urs_url` value shown below).

Follow the directions on [how to register an application](https://wiki.earthdata.nasa.gov/display/EL/How+To+Register+An+Application). Use any url for the `Redirect URL`, it will be deleted in a later step. Also note the password in step 3 and client ID in step 4 use these to replace `urs_client_id` and `urs_client_password` in the `terraform.tfvars` for the `cumulus-tf` module shown below.

---

## Create resources for Terraform state

> _If you're re-deploying an existing Cumulus configuration you should skip to [Deploy the Cumulus instance](deployment-readme#deploy-the-cumulus-instance), as these values should already be configured._

The state of the Terraform deployment is stored in S3. In the following examples, it will be assumed that state is being stored in a bucket called `my-tf-state`. You can also use an existing bucket, if desired.

### Create the state bucket

```shell
aws s3api create-bucket --bucket my-tf-state
```

In order to help prevent loss of state information, **it is strongly recommended that versioning be enabled on the state bucket**.

```shell
aws s3api put-bucket-versioning \
    --bucket my-tf-state \
    --versioning-configuration Status=Enabled
```

⚠️ **Note:** If your state information does become lost or corrupt, then deployment (via `terraform apply`) will have unpredictable results, including possible loss of data and loss of deployed resources. In order to reduce your risk of the corruption or loss of your Terraform state file, or otherwise corrupt your Cumulus deployment, please see the [Terraform Best Practices](terraform-best-practices.md) guide.

### Create the locks table

Terraform uses a lock stored in DynamoDB in order to prevent multiple simultaneous updates. In the following examples, that table will be called `my-tf-locks`.

```shell
$ aws dynamodb create-table \
    --table-name my-tf-locks \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region us-east-1
```

---

## Configure the PostgreSQL database

Cumulus requires a PostgreSQL 10.2 compatible database cluster deployed to AWS.    We suggest utilizing [RDS](https://docs.aws.amazon.com/rds/index.html), and have provided a default [template and RDS cluster module](PostgreSQL_database_deployment) utilizing Aurora Serverless. However, Core intentionally provides a "bring your own" approach, and any well-planned cluster setup should work, given the following:

- Appropriate testing/evaluation is given to ensure the database capacity will scale and the database deployment will allow access to Cumulus's internal components.   Core provides for security-group oriented permissions management via the `rds_security_group` configuration parameter.
- The database is configured such that its endpoint is accessible from the VPC and subnets configured for the Core deployment.
- An AWS Secrets Manager secret exists that has the following format:

```json
{
  "database": "databaseName",
  "host": "xxx",
  "password": "defaultPassword",
  "port": 5432,
  "username": "xxx"
}
```

- `database` -- the PostgreSQL database used by the configured user
- `host` -- the RDS service host for the database in the form (dbClusterIdentifier)-(AWS ID string).(region).rds.amazonaws.com
- `password` -- the database password
- `port` -- The database connection port, should always be 5432
- `username` -- the database username

This secret should provide access to a PostgreSQL database provisioned on the cluster.

To configure Cumulus you will need:

- The AWS Secrets Manager ARN for the *user* Core will write with (e.g. `arn:aws:secretsmanager:AWS-REGION:xxxxx:secret:xxxxxxxxxx20210407182709367700000002-dpmpXA` ) for use in configuring `rds_user_access_secret_arn`.
- (Optionally) The security group ID that provides access to the cluster to configure `rds_security_group`.

---

## Deploy the Cumulus instance

A typical Cumulus deployment is broken into two
[Terraform root modules](https://www.terraform.io/docs/configuration/modules.html):
[`data-persistence`](https://github.com/nasa/cumulus/tree/master/tf-modules/data-persistence) and [`cumulus`](https://github.com/nasa/cumulus/tree/master/tf-modules/cumulus).

The `data-persistence` module should be deployed first, and creates the Elasticsearch domain and DynamoDB tables. The `cumulus` module deploys the rest of Cumulus: distribution, API, ingest, workflows, etc. The `cumulus` module depends on the resources created in the `data-persistence` deployment.

Each of these modules have to be deployed independently and require their own Terraform backend, variable, and output settings. The template deploy repo that was cloned previously already contains the scaffolding of the necessary files for the deployment of each module: `data-persistence-tf` deploys the `data-persistence` module and `cumulus-tf` deploys the `cumulus` module. For reference on the files that are included, see the [documentation on adding components to a Terraform deployment](components.md#adding-components-to-your-terraform-deployment).

### Troubleshooting

Please see our [troubleshooting documentation for any issues with your deployment](../troubleshooting/troubleshooting-deployment) when performing the upcoming steps.

### Configure and deploy the `data-persistence-tf` root module

These steps should be executed in the `data-persistence-tf` directory of the template deploy repo that you previously cloned. Run the following to copy the example files.

```shell
cd data-persistence-tf/
cp terraform.tf.example terraform.tf
cp terraform.tfvars.example terraform.tfvars
```

In `terraform.tf`, configure the remote state settings by substituting the appropriate values for:

- `bucket`
- `dynamodb_table`
- `PREFIX` (whatever prefix you've chosen for your deployment)

Fill in the appropriate values in `terraform.tfvars`. See the [data-persistence module variable definitions](https://github.com/nasa/cumulus/blob/master/tf-modules/data-persistence/variables.tf) for more detail on each variable.

Consider [the size of your Elasticsearch cluster](#elasticsearch) when configuring data-persistence.

**Reminder:** _Elasticsearch is optional and can be disabled using `include_elasticsearch = false` in your `terraform.tfvars`. Your Cumulus dashboard will not work without Elasticsearch._

**Reminder:** _If you are including `subnet_ids` in your `terraform.tfvars`, Elasticsearch will need a service-linked role to deploy successfully. Follow the [instructions above](#elasticsearch-in-a-vpc) to create the service-linked role if you haven't already._

#### Initialize Terraform

Run `terraform init`[^3]

You should see output like:

```shell
* provider.aws: version = "~> 2.32"

Terraform has been successfully initialized!
```

<details>
  <summary>Optional: Import existing AWS resources to Terraform</summary>

#### Import existing resources

If you have an existing Cumulus deployment, you can import your existing DynamoDB tables and Elasticsearch instance to be used with your new Terraform deployment.

To import a DynamoDB table from your existing deployment:

```bash
terraform import module.data_persistence.aws_dynamodb_table.access_tokens_table PREFIX-AccessTokensTable
```

Repeat this command for every DynamoDB table included in the [`data-persistence` module](https://github.com/nasa/cumulus/blob/master/tf-modules/data-persistence/README.md), replacing `PREFIX` with the correct value for your existing deployment.

To import the Elasticsearch instance from your existing deployment, run this command and replace `PREFIX-es5vpc` with the existing domain name:

```bash
terraform import module.data_persistence.aws_elasticsearch_domain.es_vpc PREFIX-es5vpc
```

You will also need to make sure to set these variables in your `terraform.tfvars` file:

```hcl
prefix = "PREFIX"     # must match prefix of existing deployment
custom_domain_name = "PREFIX-es5vpc"  # must match existing Elasticsearch domain name
```

> **Note:** If you are importing data resources from a previous version of Cumulus deployed using Cloudformation, then make sure [`DeletionPolicy: Retain`](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html) is set on the data resources in the Cloudformation stack before deleting that stack. Otherwise, the imported data resources will be destroyed when you delete that stack. As of Cumulus version 1.15.0, `DeletionPolicy: Retain` is set by default for the data resources in the Cloudformation stack.

</details>

#### Deploy

Run `terraform apply` to deploy your data persistence resources. Type `yes` when prompted to confirm that you want to create the resources. Assuming the operation is successful, you should see output like:

```shell
Apply complete! Resources: 16 added, 0 changed, 0 destroyed.

Outputs:

dynamo_tables = {
  "access_tokens" = {
    "arn" = "arn:aws:dynamodb:us-east-1:12345:table/prefix-AccessTokensTable"
    "name" = "prefix-AccessTokensTable"
  }
  # ... more tables ...
}
elasticsearch_alarms = [
  {
    "arn" = "arn:aws:cloudwatch:us-east-1:12345:alarm:prefix-es-vpc-NodesLowAlarm"
    "name" = "prefix-es-vpc-NodesLowAlarm"
  },
  # ... more alarms ...
]
elasticsearch_domain_arn = arn:aws:es:us-east-1:12345:domain/prefix-es-vpc
elasticsearch_hostname = vpc-prefix-es-vpc-abcdef.us-east-1.es.amazonaws.com
elasticsearch_security_group_id = sg-12345
```

Your data persistence resources are now deployed.

### Deploy the Cumulus Message Adapter layer

The [Cumulus Message Adapter (CMA)](./../workflows/input_output.md#cumulus-message-adapter) is necessary for interpreting the input and output of Cumulus workflow steps. The CMA is now integrated with Cumulus workflow steps as a Lambda layer.

To deploy a CMA layer to your account:

1. Go to the [CMA releases page](https://github.com/nasa/cumulus-message-adapter/releases) and download the `cumulus-message-adapter.zip` for the desired release
2. Use the AWS CLI to publish your layer:

```shell
$ aws lambda publish-layer-version \
  --layer-name prefix-CMA-layer \
  --region us-east-1 \
  --zip-file fileb:///path/to/cumulus-message-adapter.zip

{
  ... more output ...
  "LayerVersionArn": "arn:aws:lambda:us-east-1:1234567890:layer:prefix-CMA-layer:1",
  ... more output ...
}
```

Make sure to copy the `LayerVersionArn` of the deployed layer, as it will be used to configure the `cumulus-tf` deployment in the next step.

### Configure and deploy the `cumulus-tf` root module

These steps should be executed in the `cumulus-tf` directory of the template repo that was cloned previously.

```shell
cd cumulus-tf/
cp terraform.tf.example terraform.tf
cp terraform.tfvars.example terraform.tfvars
```

In `terraform.tf`, configure the remote state settings by substituting the appropriate values for:

- `bucket`
- `dynamodb_table`
- `PREFIX` (whatever prefix you've chosen for your deployment)

Fill in the appropriate values in `terraform.tfvars`. See the [Cumulus module variable definitions](https://github.com/nasa/cumulus/blob/master/tf-modules/cumulus/variables.tf) for more detail on each variable.

Notes on specific variables:

- **`deploy_to_ngap`**: This variable controls the provisioning of certain resources and policies that are specific to an NGAP environment. **If you are deploying to NGAP, you must set this variable to `true`.**
- **`prefix`**: The value should be the same as the `prefix` from the data-persistence deployment.
- **`token_secret`**: A string value used for signing and verifying [JSON Web Tokens (JWTs)](https://jwt.io/) issued by the API. For security purposes, it is **strongly recommended that this value be a 32-character string**.
- **`data_persistence_remote_state_config`**: This object should contain the remote state values that you configured in `data-persistence-tf/terraform.tf`. These settings allow `cumulus-tf` to determine the names of the resources created in `data-persistence-tf`.
- **`key_name` (optional)**: The name of your key pair from [setting up your key pair](#set-up-ec2-key-pair-optional)
- **`rds_security_group`**: The ID of the security group used to allow access to the PostgreSQL database
- **`rds_user_access_secret_arn`**: The ARN for the Secrets Manager secret that provides database access information
- **`rds_connection_heartbeat`**:  When using RDS/Aurora Serverless as a database backend, this should be set to `true`, this tells Core to always use a 'heartbeat' query when establishing a database connection to avoid spin-up timeout failures.

Consider [the sizing of your Cumulus instance](#cumulus-instance-sizing) when configuring your variables.

#### Choose a distribution API

Cumulus can be configured to use either the Thin Egress App (TEA) or the Cumulus Distribution API. The default selection is the Thin Egress App if you're using the [Deployment Template](https://github.com/nasa/cumulus-template-deploy).

**IMPORTANT** If you already have a deployment using the TEA distribution and want to switch to Cumulus Distribution, there will be an API Gateway change. This means that there will be downtime while you update your CloudFront endpoint to use
the new API gateway.

## Configure the Thin Egress App

The Thin Egress App can be used for Cumulus distribution and is the default selection. It allows authentication using Earthdata Login. Follow the steps [in the documentation](./thin_egress_app) to configure distribution in your `cumulus-tf` deployment.

## Configure the Cumulus Distribution API (optional)

If you would prefer to use the Cumulus Distribution API, which supports [AWS Cognito authentication](https://aws.amazon.com/cognito/), follow [these steps](./cumulus_distribution) to configure distribution in your `cumulus-tf` deployment.

#### Initialize Terraform

Follow the [above instructions to initialize Terraform](#initialize-terraform) using `terraform init`[^3].

#### Deploy

Run `terraform apply` to deploy the resources. Type `yes` when prompted to confirm that you want to create the resources. Assuming the operation is successful, you should see output like this:

```shell
Apply complete! Resources: 292 added, 0 changed, 0 destroyed.

Outputs:

archive_api_redirect_uri = https://abc123.execute-api.us-east-1.amazonaws.com/dev/token
archive_api_uri = https://abc123.execute-api.us-east-1.amazonaws.com/dev/
distribution_redirect_uri = https://abc123.execute-api.us-east-1.amazonaws.com/DEV/login
distribution_url = https://abc123.execute-api.us-east-1.amazonaws.com/DEV/
```

**Note:** Be sure to copy the redirect URLs, as you will use them to update your Earthdata application.

### Update Earthdata Application

You will need to add two redirect URLs to your EarthData login application.

1. Login to URS.
2. Under My Applications -> Application Administration -> use the edit icon of your application.
3. Under Manage -> redirect URIs, add the Archive API url returned from the stack deployment
   - e.g. `archive_api_redirect_uri = https://<czbbkscuy6>.execute-api.us-east-1.amazonaws.com/dev/token`.
4. Also add the Distribution url
   - e.g. `distribution_redirect_uri = https://<kido2r7kji>.execute-api.us-east-1.amazonaws.com/dev/login`[^1].
5. You may delete the placeholder url you used to create the application.

If you've lost track of the needed redirect URIs, they can be located on the [API Gateway](https://console.aws.amazon.com/apigateway). Once there, select `<prefix>-archive` and/or `<prefix>-thin-egress-app-EgressGateway`, `Dashboard` and utilizing the base URL at the top of the page that is accompanied by the text `Invoke this API at:`. Make sure to append `/token` for the archive URL and `/login` to the thin egress app URL.

---

## Deploy Cumulus dashboard

### Dashboard Requirements

Please note that the requirements are similar to the [Cumulus stack deployment requirements](deployment-readme#requirements). The installation instructions below include a step that will install/use the required node version referenced in the `.nvmrc` file in the dashboard repository.

- git
- [node 12.18](https://nodejs.org/en/) (use [nvm](https://github.com/creationix/nvm) to upgrade/downgrade)
- [npm](https://www.npmjs.com/get-npm)
- zip
- AWS CLI - [AWS command line interface](https://aws.amazon.com/cli/)
- python

### Prepare AWS

**Create S3 bucket for dashboard:**

- Create it, e.g. `<prefix>-dashboard`. Use the command line or console as you did when [preparing AWS configuration](deployment-readme#prepare-aws-configuration).
- Configure the bucket to host a website:
  - AWS S3 console: Select `<prefix>-dashboard` bucket then, "Properties" -> "Static Website Hosting", point to `index.html`
  - CLI: `aws s3 website s3://<prefix>-dashboard --index-document index.html`
- The bucket's url will be `http://<prefix>-dashboard.s3-website-<region>.amazonaws.com` or you can find it on the AWS console via "Properties" -> "Static website hosting" -> "Endpoint"
- Ensure the bucket's access permissions allow your deployment user access to write to the bucket

### Install dashboard

To install the dashboard, clone the [Cumulus dashboard](https://github.com/nasa/cumulus-dashboard) repository into the root deploy directory and install dependencies with `npm install`:

```bash
  git clone https://github.com/nasa/cumulus-dashboard
  cd cumulus-dashboard
  nvm use
  npm install
```

If you do not have the correct version of node installed, replace `nvm use` with `nvm install $(cat .nvmrc)` in the above example.

#### Dashboard versioning

By default, the `master` branch will be used for dashboard deployments. The `master` branch of the dashboard repo contains the most recent stable release of the dashboard.

If you want to test unreleased changes to the dashboard, use the `develop` branch.

Each [release/version of the dashboard](https://github.com/nasa/cumulus-dashboard/releases) will have [a tag in the dashboard repo](https://github.com/nasa/cumulus-dashboard/tags). Release/version numbers will use semantic versioning (major/minor/patch).

To checkout and install a specific version of the dashboard:

```bash
  git fetch --tags
  git checkout <version-number> # e.g. v1.2.0
  nvm use
  npm install
```

If you do not have the correct version of node installed, replace `nvm use` with `nvm install $(cat .nvmrc)` in the above example.

### Building the dashboard

**Note**: These environment variables are available during the build: `APIROOT`, `DAAC_NAME`, `STAGE`, `HIDE_PDR`. Any of these can be set on the command line to override the values contained in `config.js` when running the build below.

To configure your dashboard for deployment, set the `APIROOT` environment variable to your app's API root.[^2]

Build the dashboard from the dashboard repository root directory, `cumulus-dashboard`:

```bash
  APIROOT=<your_api_root> npm run build
```

### Dashboard deployment

Deploy dashboard to s3 bucket from the `cumulus-dashboard` directory:

Using AWS CLI:

```bash
  aws s3 sync dist s3://<prefix>-dashboard --acl public-read
```

From the S3 Console:

- Open the `<prefix>-dashboard` bucket, click 'upload'. Add the contents of the 'dist' subdirectory to the upload. Then select 'Next'. On the permissions window allow the public to view. Select 'Upload'.

You should be able to visit the dashboard website at `http://<prefix>-dashboard.s3-website-<region>.amazonaws.com` or find the url
`<prefix>-dashboard` -> "Properties" -> "Static website hosting" -> "Endpoint" and login with a user that you configured for access in the [Configure and Deploy the Cumulus Stack](deployment-readme#configure-and-deploy-the-cumulus-stack) step.

---

## Cumulus Instance Sizing

The Cumulus deployment default sizing for Elasticsearch instances, EC2 instances, and Autoscaling Groups are small and designed for testing and cost savings. The default settings are likely not suitable for production workloads. Sizing is highly individual and dependent on expected load and archive size.

> Please be cognizant of costs as any change in size will affect your AWS bill. AWS provides a [pricing calculator](https://calculator.aws/#/) for estimating costs.

### Elasticsearch

The [mappings file](https://github.com/nasa/cumulus/blob/master/packages/api/models/mappings.json) contains all of the data types that will be indexed into Elasticsearch. Elasticsearch sizing is tied to your archive size, including your collections, granules, and workflow executions that will be stored.

AWS provides [documentation](https://docs.aws.amazon.com/elasticsearch-service/latest/developerguide/sizing-domains.html) on calculating and configuring for sizing.

In addition to size you'll want to consider the [number of nodes](https://docs.aws.amazon.com/elasticsearch-service/latest/developerguide/es-managedomains-dedicatedmasternodes.html) which determine how the system reacts in the event of a failure.

Configuration can be done in the [data persistence module](https://github.com/nasa/cumulus/blob/master/tf-modules/data-persistence/variables.tf#L16) in `elasticsearch_config` and the [cumulus module](https://github.com/nasa/cumulus/blob/master/tf-modules/cumulus/variables.tf#L541) in `es_index_shards`.

> If you make changes to your Elasticsearch configuration you will need to [reindex](../troubleshooting/reindex-elasticsearch) for those changes to take effect.

### EC2 instances and autoscaling groups

EC2 instances are used for long-running operations (i.e. generating a reconciliation report) and long-running workflow tasks. Configuration for your ECS cluster is achieved via [Cumulus deployment variables](https://github.com/nasa/cumulus/blob/master/tf-modules/cumulus/variables.tf).

When configuring your ECS cluster consider:

- The [EC2 instance type](https://aws.amazon.com/ec2/instance-types/) and [EBS volume size](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/volume_constraints.html) needed to accommodate your workloads. Configured as `ecs_cluster_instance_type` and `ecs_cluster_instance_docker_volume_size`.
- The minimum and desired number of instances on hand to accommodate your workloads. Configured as `ecs_cluster_min_size` and `ecs_cluster_desired_size`.
- The maximum number of instances you will need and are willing to pay for to accommodate your heaviest workloads. Configured as `ecs_cluster_max_size`.
- Your autoscaling parameters: `ecs_cluster_scale_in_adjustment_percent`, `ecs_cluster_scale_out_adjustment_percent`, `ecs_cluster_scale_in_threshold_percent`, and `ecs_cluster_scale_out_threshold_percent`.

---

## Footnotes

[^1]: To add another redirect URIs to your application. On Earthdata home page, select "My Applications". Scroll down to "Application Administration" and use the edit icon for your application. Then Manage -> Redirect URIs.
[^2]: The API root can be found a number of ways. The easiest is to note it in the output of the app deployment step. But you can also find it from the `AWS console -> Amazon API Gateway -> APIs -> <prefix>-archive -> Dashboard`, and reading the URL at the top after "Invoke this API at"
[^3]: Run `terraform init` if:
      - This is the first time deploying the module
      - You have added any additional child modules, including [Cumulus components](./components.md#available-cumulus-components)
      - You have updated the `source` for any of the child modules
