---
id: cumulus_distribution
title: Using the Cumulus Distribution API
hide_title: false
---

The Cumulus Distribution API is a set of endpoints that can be used to enable AWS Cognito authentication when downloading data from S3.

## Configuring a Cumulus Distribution deployment

The Cumulus Distribution API is included in the main [Cumulus](https://github.com/nasa/cumulus/tree/master/tf-modules/cumulus_distribution) repo.

To configure a deployment to use Cumulus Distribution, remove or comment the "Thin Egress App Settings" in [the Cumulus Template Deploy](https://github.com/nasa/cumulus-template-deploy/blob/master/cumulus-tf/main.tf) and enable the Cumulus Distribution settings.

If you are deploying from the [cumulus-template-deploy](https://github.com/nasa/cumulus-template-deploy) repo, also rename `cumulus-template-deploy/cumulus-tf/cumulus_distribution.tf.example` to `cumulus-template-deploy/cumulus-tf/cumulus_distribution.tf`.

## S3 Bucket Mapping

The Cumulus Distribution API uses a `bucket_map.yaml` or `bucket_map.yaml.tmpl` file to determine which buckets to
serve. [See the examples](https://github.com/nasa/cumulus/tree/master/example/cumulus-tf/cumulus_distribution).

The default Cumulus module generates a file at `s3://${system_bucket}/distribution_bucket_map.json`.

The configuration file is a simple json mapping of the form:

```json
{
  "daac-public-data-bucket": "/path/to/this/kind/of/data"
}
```

> Note: Cumulus only supports a one-to-one mapping of bucket->Cumulus Distribution path for 'distribution' buckets.

> Note: The bucket map **must include mappings for all of the `protected` and `public` buckets specified in the `buckets` variable in `cumulus-tf/terraform.tfvars`**, otherwise Cumulus may not be able to determine the correct distribution URL for ingested files and you may encounter errors.

## Switching from the Thin Egress App to Cumulus Distribution

If you have previously deployed the Thin Egress App (TEA) as your distribution app, you can switch to Cumulus Distribution by changing the `cumulus-tf/main.tf` variables linked above and renaming `cumulus-template-deploy/cumulus-tf/cumulus_distribution.tf.example` to `cumulus-template-deploy/cumulus-tf/cumulus_distribution.tf`.

Note, however, that the `cumulus_distribution` module will generate a bucket map cache and overwrite any existing bucket map caches created by TEA.

