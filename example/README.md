# Cumulus Deployment Example

We use this deployment example for running the Cumulus integration tests. This
example is tested with the latest release of the Cumulus project.

The Cumulus deployment is broken into two
[Terraform root modules](https://www.terraform.io/docs/configuration/modules.html),
`data-persistence-tf` and `cumulus-tf`. The `data-persistence-tf` module should
be deployed first, and creates the Elasticsearch domain and Dynamo tables. The
`cumulus-tf` module deploys the rest of Cumulus: distribution, API, ingest,
workflows, etc. The `cumulus-tf` module depends on the resources created in the
`data-persistence-tf` deployment.

The following instructions will walk you through installing Terraform,
configuring Terraform, deploying the two root modules, and running your tests.

## Install Terraform

In order to manage your installed Terraform versions, we recommend using [`tfenv`](https://github.com/tfutils/tfenv).

If you are using a Mac and [Homebrew](https://brew.sh), installing `tfenv` is
as follows:

```shell
brew update
brew install tfenv
```

In order to prevent state corruption and other issues, you **should only install and use the version of Terraform specified in the `example/.tfversion` file**:

```shell
tfenv install $(cat example/.tfversion)
```

Verify that the correct version of Terraform is installed (version number should match `example/.tfversion`):

```shell
$ terraform --version
Terraform v0.13.6
```

If you want to install Terraform manually,
[installation instructions](https://learn.hashicorp.com/terraform/getting-started/install.html)
are available.

## Clone and build Cumulus

Clone the `nasa/cumulus` repo from <https://github.com/nasa/cumulus.git>

In the top-level repo directory:

```bash
nvm use
npm install
npm run bootstrap
```

## Configure the Terraform backend

The state of the Terraform deployment is stored in S3. In the following
examples, it will be assumed that state is being stored in a bucket called
`my-tf-state`. You can also use an existing bucket, if desired.

Create the state bucket:

```shell
aws s3api create-bucket --bucket my-tf-state
```

In order to help prevent loss of state information, it is recommended that
versioning be enabled on the state bucket:

```shell
$ aws s3api put-bucket-versioning \
    --bucket my-tf-state \
    --versioning-configuration Status=Enabled
```

Terraform uses a lock stored in DynamoDB in order to prevent multiple
simultaneous updates. In the following examples, that table will be called
`my-tf-locks`.

Create the locks table:

⚠️ **Note:** The `--billing-mode` option was recently added to the AWS CLI. You
may need to upgrade your version of the AWS CLI if you get an error about
provisioned throughput when creating the table.

```shell
$ aws dynamodb create-table \
    --table-name my-tf-locks \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
```

## Configure and deploy the `data-persistence-tf` root module

These steps should be executed in the `example/data-persistence-tf` directory.

Create a `terraform.tf` file, substituting the appropriate values for `bucket`,
`dynamodb_table`, and `<stack>`. This tells Terraform where to store its
remote state.

**terraform.tf:**

```hcl
terraform {
  backend "s3" {
    region         = "us-east-1"
    bucket         = "PREFIX-state"
    key            = "PREFIX/data-persistence/terraform.tfstate"
    dynamodb_table = "PREFIX-tf-locks"
  }
}
```

Copy the `terraform.tfvars.example` file to `terraform.tfvars`, and fill in
appropriate values. For additional information about the variables, see the [variable definitions for the `data-persistence` module](../tf-modules/data-persistence/variables.tf).

Run `terraform init`.

Run `terraform apply`.

This will deploy your data persistence resources.

## Configure and deploy the `db-migration-tf` root module

These steps should be executed in the `example/db-migration-tf` directory.

Create a `terraform.tf` file, substituting the appropriate values for `bucket`,
`dynamodb_table`, and `<stack>`. This tells Terraform where to store its
remote state.

**terraform.tf:**

```hcl
terraform {
  backend "s3" {
    region         = "us-east-1"
    bucket         = "PREFIX-state"
    key            = "PREFIX/db-migration/terraform.tfstate"
    dynamodb_table = "PREFIX-tf-locks"
  }
}
```

Copy the `terraform.tfvars.example` file to `terraform.tfvars`, and fill in
appropriate values. For additional information about the variables, see the
[variable definitions for the `db-migration` module](../db-migration-tf/variables.tf).

Run `terraform init`.

Run `terraform apply`.

This will deploy your data-migration resources.

## Enable a distribution API

The steps below assume you will be using the [Cumulus Distribution API](./cumulus-tf/cumulus_distribution.tf) and no additional changes are required unless you want to use the Thin Egress App instead. If you would prefer
to use the Thin Egress App (TEA), uncomment the TEA-specific variables in the "cumulus" module in [example/cumulus-tf/main.tf](./cumulus-tf/main.tf).

**Note:** Both TEA and the Cumulus Distribution API are deployed by default but if you make the above change in [example/cumulus-tf/main.tf](./cumulus-tf/main.tf), only TEA will be enabled for use. If you wish to use TEA and don't want to deploy both, comment or delete the following:

1. All of the contents in [cumulus_distribution.tf](./cumulus-tf/cumulus_distribution.tf)
2. The outputs using `module.cumulus_distribution` in [outputs.tf](./cumulus-tf/outputs.tf)

## Configure and deploy the `cumulus-tf` root module

These steps should be executed in the `example/cumulus-tf` directory.

Create a `terraform.tf` file, substituting the appropriate values for `bucket`,
`dynamodb_table`, and `<stack>`. This tells Terraform where to store its
remote state.

**terraform.tf:**

```hcl
terraform {
  backend "s3" {
    region         = "us-east-1"
    bucket         = "PREFIX-state"
    key            = "PREFIX/cumulus/terraform.tfstate"
    dynamodb_table = "PREFIX-tf-locks"
  }
}
```

Copy the `terraform.tfvars.example` file to `terraform.tfvars`, and fill in
appropriate values. For additional information about the variables, see the [variable definitions for the `cumulus` module](../tf-modules/cumulus/variables.tf).

**Note:** The `data_persistence_remote_state_config` section should contain the
remote state values that you configured in
`example/data-persistence-tf/terraform.tf`. These settings allow `cumulus-tf` to
determine the names of the resources created in `data-persistence-tf`.

Run `terraform init`.

Run `terraform apply`.

## Configure the tests

These steps should be performed in the `example` directory.

Copy `.env.sample` to `.env`, filling in approriate values for your deployment.

Set the `DEPLOYMENT` environment variable to match the `prefix` that you
configured in your `terraform.tfvars` files.

If you are deploying outside of NGAP, you may need to update `example/config.yml` to override custom settings for your deployment such as the default bucket, your Earth Data Login username for login tests, or the value of `pdrNodeNameProviderBucket`.

Run `npm test`.

## Run all tests

Tests are written and run with [jasmine](https://jasmine.github.io/setup/nodejs.html).

Tests are separated into standalone and parallel directories. The `standalone` directory is for tests that cannot be run in parallel with any other tests and should be run in a separate job, for example, the redeployment tests that are only run by Bamboo on master.

The `parallel` directory holds tests that can be run in parallel.

All other tests in the spec directory will be located in the `serial` directory and will be run in serial.

To run all tests outside of standalone, run `DEPLOYMENT=<name-of-your-deployment> npm test` in this directory. The parallel tests will be run in parallel locally and on CI.

To run all of the tests, including standalone, run `DEPLOYMENT=<name-of-your-deployment> npm run all-tests` in this directory.

### Run tests for an individual test file

To run an individual test file, include a path to the spec file, i.e. `DEPLOYMENT=<name-of-your-deployment> ../node_modules/.bin/jasmine spec/parallel/helloWorld/HelloWorldEcsSpec.js`.

Jasmine supports wildcard expressions for running tests, so an entire test directory can be run using `DEPLOYMENT=<name-of-your-deployment> ../node_modules/.bin/jasmine spec/standalone/*`

### Running Tests on SIT

In the event that you are running the tests outside of the Cumulus sandbox environment you will need to follow the [directions](#fake-data-server) to update your fake data server providers. Alternatively, you can set the environment variable `PROVIDER_HOST` to point to the private IP address of your FakeProvider EC2 instance.

## Adding tests

### Adding tests for an existing workflow

Workflow tests are located in the `/spec/parallel` or `/spec/serial` directory depending on whether or not they can run in parallel or not. Any tests and supporting JSON files can go in there.

### Adding a new test workflow

The workflow should be configured as it would be for a normal Cumulus deployment in a workflows terraform file. It must be deployed to the current deployment if testing locally.

The workflows terraform files are located in the `/example/cumulus-tf` directory and are split up to make the workflows easier to find and understand.

A new directory should be added in the `/spec/parallel` directory if the test workflow can be run in parallel. The tests should go in the newly created directory along with any necessary input JSON files. Otherwise, the new test workflow should be added to the `/spec/serial` directory. Only if the test should be run outside of the test suite should it go in the `standalone` directory.

## Fake data server

A fake server is required for tests testing FTP/HTTP/HTTPS discover and downloads. The fake server should be set up once per account.

The Cloudformation template for the fake data server is in `fake-provider-cf.yml`. To setup the fake server, you can use the AWS CLI or AWS Console.

If you want to use the AWS CLI, run:

```bash
aws cloudformation deploy --template-file fake-provider-cf.yml --stack-name <stack-name> --parameter-overrides VpcId=<vpc-XXXXX> Subnet=<subnet-XXXXXX> PermissionsBoundary=<permissions-boundary> NGAPProtAppInstanceMinimalPolicyName=<policy-name> LatestAmiId=<ami-id> FtpPassword=<ftp-password> Bucket=<bucket-name> Prefix=<prefix> --capabilities CAPABILITY_NAMED_IAM
```

with the following parameters:

- stack-name - Stack name for the fake server
- VpcId - VPC ID
- Subnet - Subnet ID
- PermissionsBoundary - A permissions boundary from NGAP.
- NGAPProtAppInstanceMinimalPolicyName - Will be included in the list of Amazon Resource Names (ARNs) of the IAM managed policies we want to attach to the user.
- LatestAmiId - An SSM parameter value that resolves to an Amazon Machine Image ID value. When deploying within NGAP, the SSM parameter is provided by NGAP.
- FtpPassword - Password for the FTP server created by the stack
- Bucket -  S3 bucket name
- Prefix - Any string, generally a DAAC's name

Alternatively, you can use the AWS Console. Navigate to `CloudFormation > Create Stack with new resources > Create template in designer` and paste the contents of `fake-provider-cf.yml` into the template box. Be sure to choose `YAML` as the template language.
