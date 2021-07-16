'use strict';

const get = require('lodash/get');
const pAll = require('p-all');
const pick = require('lodash/pick');
const { randomId } = require('@cumulus/common/test-utils');

const { createCollection } = require('@cumulus/integration-tests/Collections');
const {
  findExecutionArn,
  getExecutionWithStatus,
} = require('@cumulus/integration-tests/Executions');
const { getGranuleWithStatus } = require('@cumulus/integration-tests/Granules');
const { createProvider } = require('@cumulus/integration-tests/Providers');
const { createOneTimeRule } = require('@cumulus/integration-tests/Rules');

const { deleteCollection } = require('@cumulus/api-client/collections');
const { deleteGranule } = require('@cumulus/api-client/granules');
const { deleteProvider } = require('@cumulus/api-client/providers');
const { deleteRule } = require('@cumulus/api-client/rules');
const { deleteExecution } = require('@cumulus/api-client/executions');

const { deleteS3Object, s3PutObject } = require('@cumulus/aws-client/S3');

const { loadConfig } = require('../../helpers/testUtils');

describe('The DiscoverGranules workflow with an existing granule and duplicateHandling="error"', () => {
  let beforeAllFailed = false;
  let collection;
  let discoverGranulesExecutionArn;
  let discoverGranulesRule;
  let existingGranuleId;
  let existingGranuleKey;
  let ingestGranuleExecutionArn;
  let ingestGranuleRule;
  let prefix;
  let provider;
  let sourceBucket;

  beforeAll(async () => {
    try {
      const config = await loadConfig();
      prefix = config.stackName;
      sourceBucket = config.bucket;

      // The S3 path where granules will be ingested from
      const sourcePath = `${prefix}/tmp/${randomId('test-')}`;

      // Create the collection
      collection = await createCollection(
        prefix,
        {
          duplicateHandling: 'error',
        }
      );

      // Create the S3 provider
      provider = await createProvider(prefix, { host: sourceBucket });

      // Stage the existing granule file to S3
      existingGranuleId = randomId('existing-granule-');
      existingGranuleKey = `${sourcePath}/${existingGranuleId}.txt`;
      await s3PutObject({
        Bucket: sourceBucket,
        Key: existingGranuleKey,
        Body: 'asdf',
      });

      const ingestTime = Date.now() - 1000 * 30;

      // Ingest the existing granule
      ingestGranuleRule = await createOneTimeRule(
        prefix,
        {
          workflow: 'IngestGranule',
          collection: pick(collection, ['name', 'version']),
          provider: provider.id,
          payload: {
            testExecutionId: randomId('test-execution-'),
            granules: [
              {
                granuleId: existingGranuleId,
                dataType: collection.name,
                version: collection.version,
                files: [
                  {
                    name: `${existingGranuleId}.txt`,
                    path: sourcePath,
                  },
                ],
              },
            ],
          },
        }
      );

      // Find the "IngestGranule" execution ARN
      console.log('ingestGranuleRule.payload.testExecutionId', ingestGranuleRule.payload.testExecutionId);
      ingestGranuleExecutionArn = await findExecutionArn(
        prefix,
        (execution) =>
          get(execution, 'originalPayload.testExecutionId') === ingestGranuleRule.payload.testExecutionId,
        {
          timestamp__from: ingestTime,
          'originalPayload.testExecutionId': ingestGranuleRule.payload.testExecutionId,
        },
        { timeout: 30 }
      );

      // Wait for the "IngestGranule" execution to be completed
      await getExecutionWithStatus({
        prefix,
        arn: ingestGranuleExecutionArn,
        status: 'completed',
      });

      // Wait for the existing granule to be fully ingested
      await getGranuleWithStatus({ prefix, granuleId: existingGranuleId, status: 'completed' });

      // Run DiscoverGranules
      discoverGranulesRule = await createOneTimeRule(
        prefix,
        {
          workflow: 'DiscoverGranules',
          collection: {
            name: collection.name,
            version: collection.version,
          },
          provider: provider.id,
          meta: {
            provider_path: `${sourcePath}/`,
          },
          payload: {
            testExecutionId: randomId('test-execution-'),
          },
        }
      );

      // Find the "DiscoverGranules" execution ARN
      console.log('discoverGranulesRule.payload.testExecutionId', discoverGranulesRule.payload.testExecutionId);
      discoverGranulesExecutionArn = await findExecutionArn(
        prefix,
        (execution) =>
          get(execution, 'originalPayload.testExecutionId') === discoverGranulesRule.payload.testExecutionId,
        {
          timestamp__from: ingestTime,
          'originalPayload.testExecutionId': discoverGranulesRule.payload.testExecutionId,
        },
        { timeout: 30 }
      );
    } catch (error) {
      beforeAllFailed = true;
      throw error;
    }
  });

  it('fails the DiscoverGranules workflow', async () => {
    if (beforeAllFailed) fail('beforeAll() failed');
    else {
      const execution = await getExecutionWithStatus({
        prefix,
        arn: discoverGranulesExecutionArn,
        status: 'failed',
      });

      const errorCause = JSON.parse(get(execution, 'error.Cause', {}));
      expect(errorCause.errorMessage)
        .toBe(`Duplicate granule found for ${existingGranuleId} with duplicate configuration set to error`);
    }
  });

  afterAll(async () => {
    // Must delete rules before deleting associated collection and provider
    await pAll(
      [
        () => deleteRule({ prefix, ruleName: get(ingestGranuleRule, 'name') }),
        () => deleteRule({ prefix, ruleName: get(discoverGranulesRule, 'name') }),
      ],
      { stopOnError: false }
    ).catch(console.error);

    await deleteGranule({ prefix, granuleId: existingGranuleId });
    await Promise.all([
      deleteExecution({ prefix, executionArn: discoverGranulesExecutionArn }),
      deleteExecution({ prefix, executionArn: ingestGranuleExecutionArn }),
    ]);

    await pAll(
      [
        () => deleteS3Object(sourceBucket, existingGranuleKey),
        () => deleteProvider({ prefix, providerId: get(provider, 'id') }),
        () => deleteCollection({
          prefix,
          collectionName: get(collection, 'name'),
          collectionVersion: get(collection, 'version'),
        }),
      ],
      { stopOnError: false }
    ).catch(console.error);
  });
});
