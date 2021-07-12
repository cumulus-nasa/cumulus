'use strict';

const replace = require('lodash/replace');
const { getJsonS3Object } = require('@cumulus/aws-client/S3');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');
const { getWorkflowFileKey } = require('@cumulus/common/workflows');

jasmine.DEFAULT_TIMEOUT_INTERVAL = 9 * 60 * 1000;

const {
  addRulesWithPostfix,
  addProviders,
  cleanupProviders,
  addCollections,
  cleanupCollections,
  readJsonFilesFromDir,
  deleteRules,
  setProcessEnvironment,
} = require('@cumulus/integration-tests');
const { randomString } = require('@cumulus/common/test-utils');

const { updateRule } = require('@cumulus/api-client/rules');
const { deleteExecution } = require('@cumulus/api-client/executions');

const {
  loadConfig,
  uploadTestDataToBucket,
  deleteFolder,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
} = require('../../helpers/testUtils');

const {
  createOrUseTestStream,
  deleteTestStream,
  getStreamStatus,
  putRecordOnStream,
  tryCatchExit,
  waitForActiveStream,
  waitForAllTestSfForRecord,
} = require('../../helpers/kinesisHelpers');

const ruleDirectory = './spec/parallel/kinesisTests/data/lambdaEventSourceTestRules';
const s3data = ['@cumulus/test-data/granules/L2_HR_PIXC_product_0001-of-4154.h5'];

// When kinesis-type rules exist, the Cumulus lambda messageConsumer is
// configured to trigger workflows when new records arrive on a Kinesis
// stream. When a record appears on the stream, the messageConsumer lambda
// triggers workflows associated with the kinesis-type rules.
describe('When adding multiple rules that share a kinesis event stream', () => {
  const maxWaitForSFExistSecs = 60 * 4;

  const providersDir = './data/providers/PODAAC_SWOT/';
  const collectionsDir = './data/collections/L2_HR_PIXC-000/';
  const collectionsDirMOD09GQ = './data/collections/s3_MOD09GQ_006/';

  let lambdaStep;
  let rules;
  let ruleSuffix;
  let streamName;
  let testConfig;
  let testDataFolder;
  let testSuffix;
  let executionArn;

  async function cleanUp() {
    setProcessEnvironment(testConfig.stackName, testConfig.bucket);
    // delete rules
    const rulesToDelete = await readJsonFilesFromDir(ruleDirectory);
    // clean up stack state added by test
    console.log(`\nCleaning up stack & deleting test stream '${streamName}'`);
    await deleteRules(testConfig.stackName, testConfig.bucket, rulesToDelete, ruleSuffix);
    await deleteExecution({ prefix: testConfig.stackName, executionArn: executionArn });
    await Promise.all([
      deleteFolder(testConfig.bucket, testDataFolder),
      cleanupCollections(testConfig.stackName, testConfig.bucket, collectionsDir, testSuffix),
      cleanupCollections(testConfig.stackName, testConfig.bucket, collectionsDirMOD09GQ, testSuffix),
      cleanupProviders(testConfig.stackName, testConfig.bucket, providersDir, testSuffix),
      deleteTestStream(streamName),
    ]);
  }

  beforeAll(async () => {
    testConfig = await loadConfig();
    const testId = createTimestampedTestId(testConfig.stackName, 'LambdaEventSourceTest');
    testSuffix = createTestSuffix(testId);
    testDataFolder = createTestDataPath(testId);
    ruleSuffix = replace(testSuffix, /-/g, '_');
    lambdaStep = new LambdaStep();

    process.env.ExecutionsTable = `${testConfig.stackName}-ExecutionsTable`;

    streamName = `${testId}-LambdaEventSourceTestStream`;
    testConfig.streamName = streamName;

    // populate collections, providers and test data
    await Promise.all([
      uploadTestDataToBucket(testConfig.bucket, s3data, testDataFolder),
      addCollections(testConfig.stackName, testConfig.bucket, collectionsDir, testSuffix),
      addCollections(testConfig.stackName, testConfig.bucket, collectionsDirMOD09GQ, testSuffix),
      addProviders(testConfig.stackName, testConfig.bucket, providersDir, testConfig.bucket, testSuffix),
    ]);
    // create streams
    await tryCatchExit(cleanUp, async () => {
      await createOrUseTestStream(streamName);
      console.log(`\nWaiting for active stream: '${streamName}'.`);
      await waitForActiveStream(streamName);
      rules = await addRulesWithPostfix(testConfig, ruleDirectory, {}, testSuffix);
    });
  });

  afterAll(async () => {
    await cleanUp();
  });

  it('Prepares a kinesis stream for integration tests.', async () => {
    expect(await getStreamStatus(streamName)).toBe('ACTIVE');
  });

  describe('When the MOD09GQ rule is disabled and a L2_HR_PIXC record is dropped on the stream ', () => {
    let workflowExecutions;
    const recordIdentifier = randomString();

    beforeAll(async () => {
      await tryCatchExit(cleanUp, async () => {
        // Disable rule
        console.log(`Disabling rule ${rules[1].name}`);
        await updateRule({
          prefix: testConfig.stackName,
          ruleName: rules[1].name,
          updateParams: { state: 'DISABLED' },
        });

        const record = {
          provider: `SWOT_PODAAC${testSuffix}`,
          collection: `L2_HR_PIXC${testSuffix}`,
          bucket: 'random-bucket',
          identifier: recordIdentifier,
        };

        console.log(`Dropping record onto ${streamName}, recordIdentifier: ${recordIdentifier}.`);
        await putRecordOnStream(streamName, record);

        const { arn: workflowArn } = await getJsonS3Object(
          testConfig.bucket,
          getWorkflowFileKey(testConfig.stackName, rules[1].workflow)
        );

        console.log('Waiting for step function to start...');
        workflowExecutions = await waitForAllTestSfForRecord(
          recordIdentifier,
          workflowArn,
          maxWaitForSFExistSecs,
          2
        );
      });
    });

    it('runs the HelloWorldWorkflow for L2_HR_PIXC and not MOD09GQ', async () => {
      expect(workflowExecutions.length).toEqual(1);
      executionArn = workflowExecutions[0].executionArn;

      const taskInput = await lambdaStep.getStepInput(executionArn, 'HelloWorld');

      expect(taskInput.meta.collection.name).toEqual(`L2_HR_PIXC${testSuffix}`);
    });
  });
});
