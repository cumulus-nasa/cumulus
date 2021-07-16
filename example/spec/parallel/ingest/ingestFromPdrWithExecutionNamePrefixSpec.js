'use strict';

/**
 * End to end ingest from discovering a PDR
 *
 * Kick off discover and queue pdrs which:
 * Discovers 1 PDR
 * Queues that PDR
 * Kicks off the ParsePDR workflow
 *
 * Parse PDR workflow:
 * parses pdr
 * queues a granule
 * pdr status check
 * This will kick off the ingest workflow
 *
 * Ingest workflow:
 * runs sync granule - saves file to file staging location
 * performs the fake processing step - generates CMR metadata
 * Moves the file to the final location
 * Does not post to CMR (that is in a separate test)
 */
const cryptoRandomString = require('crypto-random-string');
const flatten = require('lodash/flatten');
const { deleteS3Object } = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');

const {
  addCollections,
  addProviders,
  cleanupProviders,
  cleanupCollections,
  waitForCompletedExecution,
  waitForStartedExecution,
} = require('@cumulus/integration-tests');

const { waitForExecutionAndDelete } = require('../../helpers/executionUtils');
const { waitForGranuleAndDelete } = require('../../helpers/granuleUtils');
const { waitAndDeletePdr } = require('../../helpers/pdrUtils');
const { buildAndExecuteWorkflow } = require('../../helpers/workflowUtils');
const {
  createTestDataPath,
  createTestSuffix,
  createTimestampedTestId,
  deleteFolder,
  loadConfig,
  updateAndUploadTestDataToBucket,
  updateAndUploadTestFileToBucket,
} = require('../../helpers/testUtils');

const lambdaStep = new LambdaStep();
const workflowName = 'DiscoverAndQueuePdrsExecutionPrefix';
const origPdrFilename = 'MOD09GQ_1granule_v3.PDR';
const granuleDateString = '2016360104606';
const granuleIdReplacement = cryptoRandomString({ length: 13, type: 'numeric' });
const testDataGranuleId = 'MOD09GQ.A2016358.h13v04.006.2016360104606'.replace(granuleDateString, granuleIdReplacement);

const s3data = [
  '@cumulus/test-data/pdrs/MOD09GQ_1granule_v3.PDR',
];

const unmodifiedS3Data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
];

describe('The DiscoverAndQueuePdrsExecutionPrefix workflow', () => {
  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006';

  let addedCollections;
  let beforeAllFailed;
  let config;
  let executionNamePrefix;
  let discoverPdrsExecutionArn;
  let ingestGranuleExecutionArn;
  let parsePdrExecutionArn;
  let ingestWorkflowExecution;
  let pdrFilename;
  let provider;
  let queuePdrsOutput;
  let testDataFolder;
  let testSuffix;
  let workflowExecution;

  beforeAll(async () => {
    try {
      config = await loadConfig();

      process.env.PdrsTable = `${config.stackName}-PdrsTable`;

      const testId = createTimestampedTestId(config.stackName, 'IngestFromPdrWithExecutionNamePrefix');
      testSuffix = createTestSuffix(testId);
      testDataFolder = createTestDataPath(testId);

      pdrFilename = `${testSuffix.slice(1)}_${origPdrFilename}`;

      provider = { id: `s3_provider${testSuffix}` };

      // populate collections, providers and test data
      [addedCollections] = await Promise.all(
        flatten([
          addCollections(
            config.stackName,
            config.bucket,
            collectionsDir,
            testSuffix,
            testId
          ),
          updateAndUploadTestDataToBucket(
            config.bucket,
            s3data,
            testDataFolder,
            [
              { old: 'cumulus-test-data/pdrs', new: testDataFolder },
              {
                old: 'DATA_TYPE = MOD09GQ;',
                new: `DATA_TYPE = MOD09GQ${testSuffix};`,
              },
              { old: granuleDateString, new: granuleIdReplacement },
            ]
          ),
          unmodifiedS3Data.map((file) => updateAndUploadTestFileToBucket({
            file,
            bucket: config.bucket,
            prefix: testDataFolder,
            targetReplacementRegex: granuleDateString,
            targetReplacementString: granuleIdReplacement,
          })),
          addProviders(
            config.stackName,
            config.bucket,
            providersDir,
            config.bucket,
            testSuffix
          ),
        ])
      );

      // Rename the PDR to avoid race conditions
      await s3().copyObject({
        Bucket: config.bucket,
        CopySource: `${config.bucket}/${testDataFolder}/${origPdrFilename}`,
        Key: `${testDataFolder}/${pdrFilename}`,
      }).promise();

      await deleteS3Object(config.bucket, `${testDataFolder}/${origPdrFilename}`);

      executionNamePrefix = cryptoRandomString({
        length: 3,
        type: 'alphanumeric',
      });

      workflowExecution = await buildAndExecuteWorkflow(
        config.stackName,
        config.bucket,
        workflowName,
        { name: addedCollections[0].name, version: addedCollections[0].version },
        provider,
        undefined,
        {
          provider_path: testDataFolder,
          executionNamePrefix,
        }
      );

      discoverPdrsExecutionArn = workflowExecution.executionArn;

      queuePdrsOutput = await lambdaStep.getStepOutput(
        discoverPdrsExecutionArn,
        'QueuePdrs'
      );
      parsePdrExecutionArn = queuePdrsOutput.payload.running[0];

      await waitForCompletedExecution(parsePdrExecutionArn);
      const queueGranulesOutput = await lambdaStep.getStepOutput(
        parsePdrExecutionArn,
        'QueueGranules'
      );
      ingestGranuleExecutionArn = queueGranulesOutput.payload.running[0];
    } catch (error) {
      beforeAllFailed = error;
      throw error;
    }
  });

  afterAll(async () => {
    await waitForGranuleAndDelete(
      config.stackName,
      testDataGranuleId,
      'completed'
    );
    // clean up stack state added by test
    await waitAndDeletePdr(
      config.stackName,
      pdrFilename,
      'completed'
    );

    // The order of execution deletes matters. Children must be deleted before parents.
    await waitForExecutionAndDelete(config.stackName, ingestGranuleExecutionArn, 'completed');
    await waitForExecutionAndDelete(config.stackName, parsePdrExecutionArn, 'completed');
    await waitForExecutionAndDelete(config.stackName, discoverPdrsExecutionArn, 'completed');

    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix),
    ]);
  });

  it('executes successfully', () => {
    if (beforeAllFailed) fail(beforeAllFailed);
    else {
      expect(workflowExecution.status).toEqual('completed');
    }
  });

  it('properly sets the name of the queued execution', () => {
    if (beforeAllFailed) fail(beforeAllFailed);
    else {
      const executionName = parsePdrExecutionArn.split(':').reverse()[0];

      expect(executionName.startsWith(executionNamePrefix)).toBeTrue();
    }
  });

  it('results in an IngestGranule workflow execution', async () => {
    if (beforeAllFailed) fail(beforeAllFailed);
    else {
      ingestWorkflowExecution = waitForStartedExecution(ingestGranuleExecutionArn);
      await expectAsync(ingestWorkflowExecution).toBeResolved();
    }
  });
});
