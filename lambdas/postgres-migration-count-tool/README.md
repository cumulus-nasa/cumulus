# Postgres Migration Count Tool Lambda

This lambda runs a script that does the following:

1) Scans DynamoDB AsyncOperations, Rules, Executions and Collections and compares their record count with the configured Postgres database.
2) Builds a mapping of collections in the DynamoDb `collections` databases to `collections` in the Postgres database, notes any that are missing from Postgres and then compares the counts of `granules`, `executions` and `pdrs` for each available collection between the Elasticsearch database replication and the Postgres database.
3) Returns a report containing:

```text
collectionsNotMapped: {collectionFailures[]},
records_in_dynamo_not_in_postgres: {aggregateReportObj},
pdr_granule_and_execution_records_not_in_postgres_by_collection: {CollectionReportObject},
s3Uri: 's3://uri'
```

Where

* `collectionFailures` -- an Error object with a serialized .collection attached
* `records_in_dynamo_not_in_postgres` -- an object containing total Dynamo record counts, and the delta vs Postgres:
 {
    collectionsDelta: number;
    totalDynamoCollections: number;
    providersDelta: number;
    totalDynamoProviders: number;
    rulesDelta: number;
    totalDynamoRules: number;
    asyncOperationsDelta: number;
    totalDynamoAsyncOperations: number;
}
* `pdr_granule_and_execution_records_not_in_postgres_by_collection` -- an object containing a set of collection keys containing count deltas and the dynamo totals for each collection:
{
  <collection> {
        pdrsDelta: number;
        totalPdrs: number;
        granulesDelta: number;
        totalGranules: number;
        executionsDelta: number;
        totalExecutions: number;
    };
}
* s3Uri -- If the `reportBucket` and `reportKey` params are provided to the Lambda/API endpoint, the storage location on S3 of the output report.

## Running the Report

This tool can be invoked one of two ways:

### Direct lambda invocation

```bash
aws lambda invoke --function-name $PREFIX-postgres-migration-count-tool --payload $PAYLOAD $OUTFILE
```

This will invoke the lambda synchronously.  Please note that depending on your data holdings, this may exceed the 15 minute AWS Lambda limit, if this occurs, you will need to invoke the tool via the API as an asynchronous operation.

Where:

* PAYLOAD - base64 encoded JSON object.   For example:

```bash
--payload $(echo '{"reportBucket": "someBucket", "reportPath": "somePath", "cutoffSeconds": 60, "dbConcurrency": 20, "dbMaxPool": 20}' | base64)
```

* OUTFILE - The filepath to store the output from the lambda at.

* PREFIX - Your Cumulus deployment prefix

### API Invocation

```bash
curl -X POST https://$API_URL/dev/migrationCounts -d 'reportBucket=someBucket&reportPath=someReportPath&cutoffSeconds=60&dbConcurrency=20&dbMaxPool=20' --header 'Authorization: Bearer $TOKEN'
```

In this instance, the API will trigger an Async Operation and return an id:

```json
{"id":"7ccaed31-756b-40bb-855d-e5e6d00dc4b3","status":"RUNNING","taskArn":"arn:aws:ecs:us-east-1:AWSID:task/$PREFIX-CumulusECSCluster/123456789","description":"Migration Count Tool ECS Run","operationType":"Migration Count Report"}
```

Which you can than query the Async Operations [api endpoint](https://nasa.github.io/cumulus-api/#retrieve-async-operation) for the output/status of your request.

### Payload parameters

The following optional parameters are used by this tool:

* reportBucket (string) -- Sets the bucket used for reporting.  If this argument is used a `reportPath` must be set to generate a report
* reportPath (string) -- Sets the path location for the tool to write a copy of the lambda payload to S3
* cutoffSeconds (number) -- Number of seconds prior to this execution to 'cutoff' reconciliation queries.  This allows in-progress/other in-flight operations time to complete and propagate to Elasticsearch/Dynamo/postgres.  Default is 3600
* dbConcurrency (number) -- Sets max number of parallel collections reports  the script will run at a time.  Default 20
* dbMaxPool (number) -- Sets the maximum number of connections the database pool has available.   Modifying this may result in unexpected failures.    Default is 20
