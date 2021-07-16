---
id: cumulus_distribution_migration
title: Migrate from TEA deployment to Cumulus Distribution
hide_title: false
---

## Background

The Cumulus Distribution API is configured to use the AWS Cognito OAuth client. This API can be used instead of the Thin Egress App, which is the default distribution API if using the [Deployment Template](https://github.com/nasa/cumulus-template-deploy).

## Configuring a Cumulus Distribution deployment

See [these instructions](../deployment/cumulus-distribution.md) for deploying the Cumulus Distribution API.

## Important note if migrating from TEA to Cumulus Distribution

If you already have a deployment using the TEA distribution and want to switch to Cumulus Distribution, there will be an API Gateway change. This means that there will be downtime while you update your CloudFront endpoint to use
the new API gateway.