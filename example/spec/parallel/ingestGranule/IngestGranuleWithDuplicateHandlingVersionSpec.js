'use strict';

const get = require('lodash/get');
const pAll = require('p-all');
const pick = require('lodash/pick');
const { randomId } = require('@cumulus/common/test-utils');

const { createCollection } = require('@cumulus/integration-tests/Collections');
const {
  findExecutionArn, getExecutionWithStatus,
} = require('@cumulus/integration-tests/Executions');
const { getGranuleWithStatus } = require('@cumulus/integration-tests/Granules');
const { createProvider } = require('@cumulus/integration-tests/Providers');
const { createOneTimeRule } = require('@cumulus/integration-tests/Rules');

const { deleteCollection } = require('@cumulus/api-client/collections');
const { deleteExecution } = require('@cumulus/api-client/executions');
const { deleteGranule } = require('@cumulus/api-client/granules');
const { deleteProvider } = require('@cumulus/api-client/providers');
const { deleteRule } = require('@cumulus/api-client/rules');

const { deleteS3Object, s3PutObject } = require('@cumulus/aws-client/S3');

const { loadConfig } = require('../../helpers/testUtils');

describe('The IngestGranule workflow with DuplicateHandling="version" and a granule re-ingested with one new file, one unchanged existing file, and one modified file', () => {
  let beforeAllError;
  let collection;
  let config;
  let differentChecksumFilename;
  let differentChecksumKey;
  let granuleId;
  let ingestGranuleExecution1Arn;
  let ingestGranuleExecution2;
  let ingestGranuleExecution2Arn;
  let ingestGranuleRule1;
  let ingestGranuleRule2;
  let newFileFilename;
  let newFileKey;
  let prefix;
  let provider;
  let sameChecksumFilename;
  let sameChecksumKey;
  let sourceBucket;

  beforeAll(async () => {
    try {
      config = await loadConfig();
      prefix = config.stackName;
      sourceBucket = config.bucket;

      // The S3 path where granules will be ingested from
      const sourcePath = `${prefix}/tmp/${randomId('test-')}`;

      // Create the collection
      collection = await createCollection(
        prefix,
        {
          duplicateHandling: 'version',
          process: 'modis',
        }
      );

      // Create the S3 provider
      provider = await createProvider(prefix, { host: sourceBucket });

      // Stage the granule files to S3
      sameChecksumFilename = `${randomId('file-with-same-checksum-')}.txt`;
      sameChecksumKey = `${sourcePath}/${sameChecksumFilename}`;
      await s3PutObject({
        Bucket: sourceBucket,
        Key: sameChecksumKey,
        Body: 'asdf',
      });

      differentChecksumFilename = `${randomId('file-with-different-checksum-')}.txt`;
      differentChecksumKey = `${sourcePath}/${differentChecksumFilename}`;
      await s3PutObject({
        Bucket: sourceBucket,
        Key: differentChecksumKey,
        Body: 'original contents',
      });

      granuleId = randomId('granule-id-');

      const ingestTime = Date.now() - 1000 * 30;

      // Ingest the granule the first time
      ingestGranuleRule1 = await createOneTimeRule(
        prefix,
        {
          workflow: 'IngestGranule',
          collection: pick(collection, ['name', 'version']),
          provider: provider.id,
          payload: {
            testExecutionId: randomId('test-execution-'),
            granules: [
              {
                granuleId,
                dataType: collection.name,
                version: collection.version,
                files: [
                  {
                    name: sameChecksumFilename,
                    path: sourcePath,
                  },
                  {
                    name: differentChecksumFilename,
                    path: sourcePath,
                  },
                ],
              },
            ],
          },
        }
      );

      // Find the execution ARN
      console.log('ingestGranuleRule1.payload.testExecutionId', ingestGranuleRule1.payload.testExecutionId);
      ingestGranuleExecution1Arn = await findExecutionArn(
        prefix,
        (execution) => {
          const executionId = get(execution, 'originalPayload.testExecutionId');
          return executionId === ingestGranuleRule1.payload.testExecutionId;
        },
        {
          timestamp__from: ingestTime,
          'ingestGranuleRule1.payload.testExecutionId': ingestGranuleRule1.payload.testExecutionId,
        },
        { timeout: 30 }
      );

      // Wait for the execution to be completed
      await getExecutionWithStatus({
        prefix,
        arn: ingestGranuleExecution1Arn,
        status: 'completed',
      });

      // Wait for the granule to be fully ingested
      await getGranuleWithStatus({ prefix, granuleId, status: 'completed' });

      // Modify the contents of the updated granule file
      await s3PutObject({
        Bucket: sourceBucket,
        Key: differentChecksumKey,
        Body: 'new contents',
      });

      // Create a new granule file
      newFileFilename = `${randomId('new-file-')}.txt`;
      newFileKey = `${sourcePath}/${newFileFilename}`;
      await s3PutObject({
        Bucket: sourceBucket,
        Key: newFileKey,
        Body: 'asdf',
      });

      // Re-ingest the updated granule
      ingestGranuleRule2 = await createOneTimeRule(
        prefix,
        {
          workflow: 'IngestGranule',
          collection: pick(collection, ['name', 'version']),
          provider: provider.id,
          payload: {
            testExecutionId: randomId('test-execution-'),
            granules: [
              {
                granuleId,
                dataType: collection.name,
                version: collection.version,
                files: [
                  {
                    name: sameChecksumFilename,
                    path: sourcePath,
                  },
                  {
                    name: differentChecksumFilename,
                    path: sourcePath,
                  },
                  {
                    name: newFileFilename,
                    path: sourcePath,
                  },
                ],
              },
            ],
          },
        }
      );

      // Find the execution ARN
      console.log('ingestGranuleRule2.payload.testExecutionId', ingestGranuleRule2.payload.testExecutionId);
      ingestGranuleExecution2Arn = await findExecutionArn(
        prefix,
        (execution) => {
          const executionId = get(execution, 'originalPayload.testExecutionId');
          return executionId === ingestGranuleRule2.payload.testExecutionId;
        },
        { timestamp__from: ingestTime },
        { timeout: 30 }
      );

      // Wait for the execution to be completed
      ingestGranuleExecution2 = await getExecutionWithStatus({
        prefix,
        arn: ingestGranuleExecution2Arn,
        status: 'completed',
      });
    } catch (error) {
      beforeAllError = error;
      throw error;
    }
  });

  it('returns the expected files', () => {
    if (beforeAllError) fail(beforeAllError);
    else {
      const files = ingestGranuleExecution2.finalPayload.granules[0].files;

      // Make sure we got the expected number of files
      expect(files.length).toBe(5);

      // Make sure the three ingested files are present
      expect(files.find((file) => file.name === sameChecksumFilename)).toBeDefined();
      expect(files.find((file) => file.name === differentChecksumFilename)).toBeDefined();
      expect(files.find((file) => file.name === newFileFilename)).toBeDefined();

      // Make sure the generated CMR file is present
      expect(files.find((file) => file.name === `${granuleId}.cmr.xml`)).toBeDefined();

      // Make sure that the modified file resulted in a versioned file
      expect(
        files.find((file) => file.name.startsWith(`${differentChecksumFilename}.v`))
      ).toBeDefined();
    }
  });

  afterAll(async () => {
    // Must delete rules before deleting associated collection and provider
    await pAll(
      [
        () => deleteRule({ prefix, ruleName: get(ingestGranuleRule1, 'name') }),
        () => deleteRule({ prefix, ruleName: get(ingestGranuleRule2, 'name') }),
      ],
      { stopOnError: false }
    ).catch(console.error);

    await deleteGranule({ prefix, granuleId });
    await Promise.all([
      deleteExecution({ prefix: config.stackName, executionArn: ingestGranuleExecution2Arn }),
      deleteExecution({ prefix: config.stackName, executionArn: ingestGranuleExecution1Arn }),
    ]);

    await pAll(
      [
        () => deleteS3Object(sourceBucket, differentChecksumKey),
        () => deleteS3Object(sourceBucket, newFileKey),
        () => deleteS3Object(sourceBucket, sameChecksumKey),
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
