'use strict';

const delay = require('delay');
const fs = require('fs-extra');
const replace = require('lodash/replace');
const pWaitFor = require('p-wait-for');

const { Granule } = require('@cumulus/api/models');
const { deleteGranule } = require('@cumulus/api-client/granules');
const { deleteExecution } = require('@cumulus/api-client/executions');
const { deleteS3Object } = require('@cumulus/aws-client/S3');
const {
  deleteQueue,
  receiveSQSMessages,
  sendSQSMessage,
  getQueueUrlByName,
  getQueueNameFromUrl,
} = require('@cumulus/aws-client/SQS');
const { s3 } = require('@cumulus/aws-client/services');
const { createSqsQueues, getSqsQueueMessageCounts } = require('@cumulus/api/lib/testUtils');
const {
  addCollections,
  addRules,
  addProviders,
  api: apiTestUtils,
  cleanupProviders,
  cleanupCollections,
  readJsonFilesFromDir,
  deleteRules,
  setProcessEnvironment,
  getExecutionInputObject,
} = require('@cumulus/integration-tests');

const { getS3KeyForArchivedMessage } = require('@cumulus/ingest/sqs');
const { randomId } = require('@cumulus/common/test-utils');

const { waitForModelStatus } = require('../../helpers/apiUtils');
const { setupTestGranuleForIngest } = require('../../helpers/granuleUtils');

const {
  loadConfig,
  uploadTestDataToBucket,
  deleteFolder,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
} = require('../../helpers/testUtils');

let config;
let inputPayload;
let testId;
let testSuffix;
let testDataFolder;
let ruleSuffix;
let ruleOverride;
let executionArn;
let pdrFilename;

const inputPayloadFilename = './spec/parallel/ingestGranule/IngestGranule.input.payload.json';
const providersDir = './data/providers/s3/';
const collectionsDir = './data/collections/s3_MOD09GQ_006';
const workflowName = 'IngestGranule';

const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';
const ruleDirectory = './spec/parallel/testAPI/data/rules/sqs';

let queues = {};

async function setupCollectionAndTestData() {
  const s3data = [
    '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
    '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
    '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg',
  ];

  // populate collections, providers and test data
  await Promise.all([
    uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
    addCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
    addProviders(config.stackName, config.bucket, providersDir, config.bucket, testSuffix),
  ]);
}

async function cleanUp() {
  setProcessEnvironment(config.stackName, config.bucket);
  console.log(`\nDeleting rule ${ruleOverride.name}`);
  const rules = await readJsonFilesFromDir(ruleDirectory);
  await deleteRules(config.stackName, config.bucket, rules, ruleSuffix);

  await apiTestUtils.deletePdr({
    prefix: config.stackName,
    pdr: pdrFilename,
  });

  // TODO there may be another execution to delete here
  await deleteExecution({ prefix: config.stackName, executionArn });
  await Promise.all(inputPayload.granules.map(
    (granule) => deleteGranule({ prefix: config.stackName, granuleId: granule.granuleId })
  ));

  await Promise.all([
    deleteFolder(config.bucket, testDataFolder),
    cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
    cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix),
    deleteQueue(queues.sourceQueueUrl),
    deleteQueue(queues.deadLetterQueueUrl),
  ]);
}

async function sendIngestGranuleMessage(queueUrl) {
  const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
  // update test data filepaths
  inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
  pdrFilename = inputPayload.pdr.name;
  const granuleId = inputPayload.granules[0].granuleId;
  await sendSQSMessage(queueUrl, inputPayload);
  return granuleId;
}

const waitForQueueMessageCount = (queueUrl, expectedCount) =>
  pWaitFor(
    async () => {
      const {
        numberOfMessagesAvailable,
        numberOfMessagesNotVisible,
      } = await getSqsQueueMessageCounts(queueUrl);
      return numberOfMessagesAvailable === expectedCount &&
        numberOfMessagesNotVisible === expectedCount;
    },
    {
      interval: 3000,
      timeout: 30 * 1000,
    }
  );

describe('The SQS rule', () => {
  let ruleList;
  let executionNamePrefix;

  beforeAll(async () => {
    config = await loadConfig();
    testId = createTimestampedTestId(config.stackName, 'sqsRule');
    testSuffix = createTestSuffix(testId);
    testDataFolder = createTestDataPath(testId);
    const collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
    const provider = { id: `s3_provider${testSuffix}` };
    ruleSuffix = replace(testSuffix, /-/g, '_');

    executionNamePrefix = randomId('prefix');

    const scheduleQueueUrl = await getQueueUrlByName(`${config.stackName}-backgroundProcessing`);

    ruleOverride = {
      name: `MOD09GQ_006_sqsRule${ruleSuffix}`,
      collection: {
        name: collection.name,
        version: collection.version,
      },
      provider: provider.id,
      workflow: workflowName,
      meta: {
        retries: 1,
      },
      executionNamePrefix,
      // use custom queue for scheduling workflows
      queueUrl: scheduleQueueUrl,
    };

    await setupCollectionAndTestData();

    // create SQS queues and add rule
    const { queueUrl, deadLetterQueueUrl } = await createSqsQueues(testId);
    queues = {
      sourceQueueUrl: queueUrl,
      deadLetterQueueUrl,
      scheduleQueueUrl,
    };
    config.queueUrl = queues.sourceQueueUrl;

    ruleList = await addRules(config, ruleDirectory, ruleOverride);
  });

  afterAll(async () => {
    await cleanUp();
  });

  it('SQS rules are added', () => {
    expect(ruleList.length).toBe(1);
    expect(ruleList[0].rule.value).toBe(queues.sourceQueueUrl);
    expect(ruleList[0].meta.visibilityTimeout).toBe(300);
    expect(ruleList[0].meta.retries).toBe(1);
  });

  describe('When posting messages to the configured SQS queue', () => {
    let granuleId;
    let messageId;
    const invalidMessage = JSON.stringify({ foo: 'bar' });

    beforeAll(async () => {
      // post a valid message for ingesting a granule
      granuleId = await sendIngestGranuleMessage(queues.sourceQueueUrl);

      // post a non-processable message
      const message = await sendSQSMessage(queues.sourceQueueUrl, invalidMessage);
      messageId = message.MessageId;
    });

    afterAll(async () => {
      const key = getS3KeyForArchivedMessage(config.stackName, messageId);
      await deleteS3Object(config.bucket, key);
      await deleteGranule({ prefix: config.stackName, granuleId });
    });

    describe('If the message is processable by the workflow', () => {
      let record;

      beforeAll(async () => {
        process.env.GranulesTable = `${config.stackName}-GranulesTable`;
        const granuleModel = new Granule();
        record = await waitForModelStatus(
          granuleModel,
          { granuleId },
          'completed'
        );
      });

      it('workflow is kicked off, and the granule from the message is successfully ingested', () => {
        expect(record.granuleId).toBe(granuleId);
        expect(record.execution).toContain(workflowName);
      });

      it('the execution name starts with the expected prefix', () => {
        const executionName = record.execution.split(':').reverse()[0];
        expect(executionName.startsWith(executionNamePrefix)).toBeTrue();
      });

      it('references the correct queue URL in the execution message', async () => {
        executionArn = record.execution.split('/').reverse()[0];
        const executionInput = await getExecutionInputObject(executionArn);
        expect(executionInput.cumulus_meta.queueUrl).toBe(queues.scheduleQueueUrl);
      });
    });

    describe('If the message is unprocessable by the workflow', () => {
      it('is moved to dead-letter queue after retries', async () => {
        const sqsOptions = { numOfMessages: 10, visibilityTimeout: ruleList[0].meta.visibilityTimeout, waitTimeSeconds: 20 };
        let messages = await receiveSQSMessages(queues.deadLetterQueueUrl, sqsOptions);

        /* eslint-disable no-await-in-loop */
        for (let i = 0; i < 10 && messages.length === 0; i += 1) {
          await delay(20 * 1000);
          console.log('wait for the message to arrive at dead-letter queue');
          messages = await receiveSQSMessages(queues.deadLetterQueueUrl, sqsOptions);
        }
        /* eslint-enable no-await-in-loop */

        expect(messages.length).toBe(1);
        // maxReceiveCount of RedrivePolicy is 3
        expect(Number.parseInt(messages[0].Attributes.ApproximateReceiveCount, 10)).toBe(4);
        expect(messages[0].Body).toEqual(invalidMessage);
      });
    });

    it('messages are picked up and removed from source queue', async () => {
      await expectAsync(waitForQueueMessageCount(queues.sourceQueueUrl, 0)).toBeResolved();
    });

    it('stores incoming messages on S3', async () => {
      const queueName = getQueueNameFromUrl(queues.sourceQueueUrl);
      const key = getS3KeyForArchivedMessage(config.stackName, messageId, queueName);
      console.log(key);
      const message = await s3().getObject({
        Bucket: config.bucket,
        Key: key,
      }).promise();
      expect(message.Body.toString()).toBe(invalidMessage);
    });
  });
});
