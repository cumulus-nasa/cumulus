'use strict';

const fs = require('fs');
const moment = require('moment');
const path = require('path');
const merge = require('lodash/merge');
const { v4: uuidv4 } = require('uuid');

const { randomId, randomString } = require('@cumulus/common/test-utils');
const { sqs } = require('@cumulus/aws-client/services');
const { s3PutObject, putJsonS3Object } = require('@cumulus/aws-client/S3');
const {
  translateApiCollectionToPostgresCollection,
  translateApiProviderToPostgresProvider,
  translateApiRuleToPostgresRule,
  translateApiPdrToPostgresPdr,
  translateApiExecutionToPostgresExecution,
  translateApiAsyncOperationToPostgresAsyncOperation,
} = require('@cumulus/db');
const {
  indexCollection,
  indexProvider,
  indexRule,
  indexPdr,
  indexAsyncOperation,
  indexExecution,
  deleteExecution,
} = require('@cumulus/es-client/indexer');
const {
  constructCollectionId,
} = require('@cumulus/message/Collections');

const { createJwtToken } = require('./token');
const { authorizedOAuthUsersKey } = require('../app/auth');

const isLocalApi = () => process.env.CUMULUS_ENV === 'local';

const dataDir = path.join(__dirname, '../app/data');
const workflowDir = path.join(dataDir, 'workflows');
const getWorkflowList = () => fs.readdirSync(workflowDir).map((f) => JSON.parse(fs.readFileSync(`${workflowDir}/${f}`).toString()));

/**
 * mocks the context object of the lambda function with
 * succeed and fail functions to facilitate testing of
 * lambda functions used as backend in ApiGateway
 *
 * Intended for use with unit tests.  Will invoke the function locally.
 *
 * @param {Function} endpoint - the lambda function used as ApiGateway backend
 * @param {Object} event - aws lambda event object
 * @param {Function} testCallback - aws lambda callback function
 * @returns {Promise<Object>} the promise returned by the lambda function
 */
function testEndpoint(endpoint, event, testCallback) {
  return new Promise((resolve, reject) => {
    endpoint(event, {
      succeed: (response) => resolve(testCallback(response)),
      fail: (e) => reject(e),
    });
  });
}

function fakeFileFactory(params = {}) {
  const fileName = randomId('name');

  return {
    bucket: randomId('bucket'),
    fileName,
    key: fileName,
    ...params,
  };
}

/**
 * Returns a fake Granule record
 *
 * @param {string} status - granule status (default to completed)
 * @returns {Object} fake granule object
 */
function fakeGranuleFactory(status = 'completed') {
  return {
    granuleId: randomId('granule'),
    dataType: randomId('datatype'),
    version: randomId('vers'),
    collectionId: 'fakeCollection___v1',
    status,
    execution: randomId('execution'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    published: true,
    cmrLink: 'example.com',
    productVolume: 100,
    duration: 0,
  };
}

/**
 * Returns a fake Granule record
 *
 * @param {Object} options - properties to set on the granule
 * @returns {Object} fake granule object
 */
function fakeGranuleFactoryV2(options = {}) {
  return Object.assign(
    fakeGranuleFactory(),
    options
  );
}

/**
 * Create a fake rule record
 *
 * @param {Object} params - overrides
 * @returns {Object} fake rule object
 */
function fakeRuleFactoryV2(params = {}) {
  const rule = {
    name: randomId('name'),
    workflow: randomId('workflow'),
    provider: randomId('provider'),
    collection: {
      name: randomId('colName'),
      version: '0.0.0',
    },
    rule: {
      type: 'onetime',
    },
    state: 'DISABLED',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return { ...rule, ...params };
}

/**
 * creates fake rule record
 *
 * @param {string} state - rule state (default to DISABLED)
 * @returns {Object} fake rule object
 */
function fakeRuleFactory(state = 'DISABLED') {
  return fakeRuleFactoryV2({ state });
}

/**
 * creates fake pdr records
 *
 * @param {string} status - pdr status (default to completed)
 * @returns {Object} fake pdr object
 */
function fakePdrFactory(status = 'completed') {
  return {
    pdrName: randomId('pdr'),
    collectionId: 'fakeCollection___v1',
    provider: 'fakeProvider',
    status,
    createdAt: Date.now(),
  };
}

/**
 * creates fake pdr records
 *
 * @param {Object} params - overrides
 * @returns {Object} fake pdr object
 */
function fakePdrFactoryV2(params = {}) {
  const pdr = {
    pdrName: randomId('pdr'),
    collectionId: 'fakeCollection___v1',
    provider: 'fakeProvider',
    status: 'completed',
    createdAt: Date.now(),
    progress: 0,
  };

  return { ...pdr, ...params };
}

/**
 * creates fake execution records
 *
 * @param {Object} params - overrides
 * @returns {Object} fake execution object
 */
function fakeExecutionFactoryV2(params = {}) {
  const execution = {
    arn: randomId('arn'),
    duration: 180.5,
    name: randomId('name'),
    execution: randomId('execution'),
    parentArn: randomId('parentArn'),
    error: { test: 'error' },
    status: 'completed',
    createdAt: Date.now() - 180.5 * 1000,
    updatedAt: Date.now(),
    timestamp: Date.now(),
    type: 'fakeWorkflow',
    originalPayload: { testInput: 'originalPayloadValue' },
    finalPayload: { testOutput: 'finalPayloadValue' },
    tasks: {},
    cumulusVersion: '1.0.0',
  };

  return { ...execution, ...params };
}

/**
 * creates fake execution records
 *
 * @param {string} status - pdr status (default to completed)
 * @param {string} type - workflow type (default to fakeWorkflow)
 * @returns {Object} fake execution object
 */
function fakeExecutionFactory(status = 'completed', type = 'fakeWorkflow') {
  return fakeExecutionFactoryV2({ status, type });
}

/**
 * creates fake async operation records
 *
 * @param {Object} params - overrides
 * @returns {Object} fake async operation object
 */
function fakeAsyncOperationFactory(params = {}) {
  const asyncOperation = {
    taskArn: randomId('arn'),
    id: uuidv4(),
    description: randomId('description'),
    operationType: 'ES Index',
    status: 'SUCCEEDED',
    createdAt: Date.now() - 180.5 * 1000,
    updatedAt: Date.now(),
    output: JSON.stringify({
      key: randomId('output'),
    }),
  };

  return { ...asyncOperation, ...params };
}

/**
 * creates fake collection records
 *
 * @param {Object} options - properties to set on the collection
 * @returns {Object} fake collection object
 */
function fakeCollectionFactory(options = {}) {
  return {
    name: randomId('collectionName'),
    version: '0.0.0',
    duplicateHandling: 'replace',
    granuleId: '^MOD09GQ\\.A[\\d]{7}\.[\\S]{6}\\.006\\.[\\d]{13}$',
    granuleIdExtraction: '(MOD09GQ\\.(.*))\\.hdf',
    sampleFileName: 'MOD09GQ.A2017025.h21v00.006.2017034065104.hdf',
    files: [],
    reportToEms: true,
    createdAt: Date.now() - 180.5 * 1000,
    updatedAt: Date.now(),
    ...options,
  };
}

/**
 * creates fake provider records
 *
 * @param {Object} options - properties to set on the provider
 * @returns {Object} fake provider object
 */
function fakeProviderFactory(options = {}) {
  return {
    id: randomId('id'),
    globalConnectionLimit: 1,
    protocol: 'http',
    host: randomId('host'),
    port: 80,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...options,
  };
}

/**
 * creates fake reconciliationReport records
 *
 * @param {Object} options - properties to set on the reconciliationReport
 * @returns {Object} fake reconciliationReport object
 */
function fakeReconciliationReportFactory(options = {}) {
  return {
    name: randomId('name'),
    type: 'Inventory',
    status: 'Generated',
    location: randomId('location'),
    createdAt: Date.now() - 180.5 * 1000,
    updatedAt: Date.now(),
    ...options,
  };
}

function fakeAccessTokenFactory(params = {}) {
  return {
    accessToken: randomId('accessToken'),
    refreshToken: randomId('refreshToken'),
    username: randomId('username'),
    expirationTime: moment().unix() + 60 * 60,
    ...params,
  };
}

function fakeCumulusMessageFactory(params = {}) {
  return merge({
    cumulus_meta: {
      workflow_start_time: 122,
      cumulus_version: '7.1.0',
      state_machine: randomId('arn:aws:states:us-east-1:1234:stateMachine:'),
      execution_name: randomId('cumulus-execution-name'),
    },
    meta: {
      status: 'completed',
      collection: {
        name: randomId('MOD', 3),
        version: '006',
      },
      provider: 'fake-provider',
    },
    payload: {
      granules: [fakeGranuleFactoryV2()],
    },
  }, params);
}

const setAuthorizedOAuthUsers = (users) =>
  putJsonS3Object(process.env.system_bucket, authorizedOAuthUsersKey(), users);

async function createFakeJwtAuthToken({ accessTokenModel, username }) {
  const {
    accessToken,
    refreshToken,
    expirationTime,
  } = fakeAccessTokenFactory();
  await accessTokenModel.create({ accessToken, refreshToken, expirationTime });

  return createJwtToken({ accessToken, expirationTime, username });
}

/**
 * create a dead-letter queue and a source queue
 *
 * @param {string} queueNamePrefix - prefix of the queue name
 * @param {number} maxReceiveCount
 *   Maximum number of times message can be removed before being sent to DLQ
 * @param {string} visibilityTimeout - visibility timeout for queue messages
 * @returns {Object} - {deadLetterQueueUrl: <url>, queueUrl: <url>} queues created
 */
async function createSqsQueues(
  queueNamePrefix,
  maxReceiveCount = 3,
  visibilityTimeout = '300'
) {
  // dead letter queue
  const deadLetterQueueName = `${queueNamePrefix}DeadLetterQueue`;
  const deadLetterQueueParms = {
    QueueName: deadLetterQueueName,
    Attributes: {
      VisibilityTimeout: visibilityTimeout,
    },
  };
  const { QueueUrl: deadLetterQueueUrl } = await sqs()
    .createQueue(deadLetterQueueParms).promise();
  const qAttrParams = {
    QueueUrl: deadLetterQueueUrl,
    AttributeNames: ['QueueArn'],
  };
  const { Attributes: { QueueArn: deadLetterQueueArn } } = await sqs()
    .getQueueAttributes(qAttrParams).promise();

  // source queue
  const queueName = `${queueNamePrefix}Queue`;
  const queueParms = {
    QueueName: queueName,
    Attributes: {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: deadLetterQueueArn,
        maxReceiveCount,
      }),
      VisibilityTimeout: visibilityTimeout,
    },
  };

  const { QueueUrl: queueUrl } = await sqs().createQueue(queueParms).promise();
  return { deadLetterQueueUrl, queueUrl };
}

/**
 * get message counts of the given SQS queue
 *
 * @param {string} queueUrl - SQS queue URL
 * @returns {Object} - message counts
 * {numberOfMessagesAvailable: <number>, numberOfMessagesNotVisible: <number>}
 */
async function getSqsQueueMessageCounts(queueUrl) {
  const qAttrParams = {
    QueueUrl: queueUrl,
    AttributeNames: ['All'],
  };
  const attributes = await sqs().getQueueAttributes(qAttrParams).promise();
  const {
    ApproximateNumberOfMessages: numberOfMessagesAvailable,
    ApproximateNumberOfMessagesNotVisible: numberOfMessagesNotVisible,
  } = attributes.Attributes;

  return {
    numberOfMessagesAvailable: Number.parseInt(numberOfMessagesAvailable, 10),
    numberOfMessagesNotVisible: Number.parseInt(numberOfMessagesNotVisible, 10),
  };
}

const createCollectionTestRecords = async (context, collectionParams) => {
  const {
    testKnex,
    collectionModel,
    collectionPgModel,
    esClient,
    esCollectionClient,
  } = context;
  const originalCollection = fakeCollectionFactory(collectionParams);

  const insertPgRecord = await translateApiCollectionToPostgresCollection(originalCollection);
  await collectionModel.create(originalCollection);
  const [collectionCumulusId] = await collectionPgModel.create(testKnex, insertPgRecord);
  const originalPgRecord = await collectionPgModel.get(
    testKnex, { cumulus_id: collectionCumulusId }
  );
  await indexCollection(esClient, originalCollection, process.env.ES_INDEX);
  const originalEsRecord = await esCollectionClient.get(
    constructCollectionId(originalCollection.name, originalCollection.version)
  );
  return {
    originalCollection,
    originalPgRecord,
    originalEsRecord,
  };
};

const createProviderTestRecords = async (context, providerParams) => {
  const {
    testKnex,
    providerModel,
    providerPgModel,
    esClient,
    esProviderClient,
  } = context;
  const originalProvider = fakeProviderFactory(providerParams);

  const insertPgRecord = await translateApiProviderToPostgresProvider(originalProvider);
  await providerModel.create(originalProvider);
  const [providerCumulusId] = await providerPgModel.create(testKnex, insertPgRecord);
  const originalPgRecord = await providerPgModel.get(
    testKnex, { cumulus_id: providerCumulusId }
  );
  await indexProvider(esClient, originalProvider, process.env.ES_INDEX);
  const originalEsRecord = await esProviderClient.get(
    originalProvider.id
  );
  return {
    originalProvider,
    originalPgRecord,
    originalEsRecord,
  };
};

const createRuleTestRecords = async (context, ruleParams) => {
  const {
    testKnex,
    ruleModel,
    rulePgModel,
    esClient,
    esRulesClient,
  } = context;
  const originalRule = fakeRuleFactoryV2(ruleParams);

  const insertPgRecord = await translateApiRuleToPostgresRule(originalRule, testKnex);
  const originalDynamoRule = await ruleModel.create(originalRule);
  const [ruleCumulusId] = await rulePgModel.create(testKnex, insertPgRecord);
  const originalPgRecord = await rulePgModel.get(
    testKnex, { cumulus_id: ruleCumulusId }
  );
  await indexRule(esClient, originalRule, process.env.ES_INDEX);
  const originalEsRecord = await esRulesClient.get(
    originalRule.name
  );
  return {
    originalDynamoRule,
    originalPgRecord,
    originalEsRecord,
  };
};

const createPdrTestRecords = async (context, pdrParams = {}) => {
  const {
    knex,
    pdrModel,
    pdrPgModel,
    esClient,
    esPdrsClient,
    testPgCollection,
    testPgProvider,
  } = context;

  const originalPdr = fakePdrFactoryV2({
    ...pdrParams,
    collectionId: constructCollectionId(testPgCollection.name, testPgCollection.version),
    provider: testPgProvider.name,
  });

  const pdrS3Key = `${process.env.stackName}/pdrs/${originalPdr.pdrName}`;
  await s3PutObject({
    Bucket: process.env.system_bucket,
    Key: pdrS3Key,
    Body: randomString(),
  });

  const insertPgRecord = await translateApiPdrToPostgresPdr(originalPdr, knex);
  const originalDynamoPdr = await pdrModel.create(originalPdr);
  const [pdrCumulusId] = await pdrPgModel.create(knex, insertPgRecord);
  const originalPgRecord = await pdrPgModel.get(
    knex, { cumulus_id: pdrCumulusId }
  );
  await indexPdr(esClient, originalPdr, process.env.ES_INDEX);
  const originalEsRecord = await esPdrsClient.get(
    originalPdr.pdrName
  );
  return {
    originalDynamoPdr,
    originalPgRecord,
    originalEsRecord,
  };
};

const createExecutionTestRecords = async (context, executionParams = {}) => {
  const {
    knex,
    executionModel,
    executionPgModel,
    esClient,
    esExecutionsClient,
  } = context;

  const originalExecution = fakeExecutionFactoryV2(executionParams);
  const insertPgRecord = await translateApiExecutionToPostgresExecution(originalExecution, knex);
  const originalDynamoExecution = await executionModel.create(originalExecution);
  const [executionCumulusId] = await executionPgModel.create(knex, insertPgRecord);
  const originalPgRecord = await executionPgModel.get(
    knex, { cumulus_id: executionCumulusId }
  );
  await indexExecution(esClient, originalExecution, process.env.ES_INDEX);
  const originalEsRecord = await esExecutionsClient.get(
    originalExecution.arn
  );
  return {
    originalDynamoExecution,
    originalPgRecord,
    originalEsRecord,
  };
};

const createAsyncOperationTestRecords = async (context) => {
  const {
    knex,
    asyncOperationModel,
    asyncOperationPgModel,
    esClient,
    esAsyncOperationClient,
  } = context;

  const originalAsyncOperation = fakeAsyncOperationFactory();
  const insertPgRecord = await translateApiAsyncOperationToPostgresAsyncOperation(
    originalAsyncOperation,
    knex
  );
  const originalDynamoAsyncOperation = await asyncOperationModel.create(originalAsyncOperation);
  const [asyncOperationCumulusId] = await asyncOperationPgModel.create(
    knex,
    insertPgRecord
  );
  const originalPgRecord = await asyncOperationPgModel.get(
    knex, { cumulus_id: asyncOperationCumulusId }
  );
  await indexAsyncOperation(esClient, originalAsyncOperation, process.env.ES_INDEX);
  const originalEsRecord = await esAsyncOperationClient.get(
    originalAsyncOperation.id
  );
  return {
    originalDynamoAsyncOperation,
    originalPgRecord,
    originalEsRecord,
  };
};

const cleanupExecutionTestRecords = async (context, { arn }) => {
  const {
    knex,
    executionModel,
    executionPgModel,
    esClient,
    esIndex,
  } = context;

  await executionModel.delete({ arn });
  await executionPgModel.delete(knex, { arn });
  await deleteExecution({
    esClient,
    arn,
    index: esIndex,
  });
};

module.exports = {
  createFakeJwtAuthToken,
  createSqsQueues,
  fakeAccessTokenFactory,
  fakeGranuleFactory,
  fakeGranuleFactoryV2,
  fakePdrFactory,
  fakePdrFactoryV2,
  fakeCollectionFactory,
  fakeCumulusMessageFactory,
  fakeExecutionFactory,
  fakeExecutionFactoryV2,
  fakeAsyncOperationFactory,
  fakeRuleFactory,
  fakeRuleFactoryV2,
  fakeFileFactory,
  fakeProviderFactory,
  fakeReconciliationReportFactory,
  getSqsQueueMessageCounts,
  getWorkflowList,
  isLocalApi,
  testEndpoint,
  setAuthorizedOAuthUsers,
  createCollectionTestRecords,
  createProviderTestRecords,
  createRuleTestRecords,
  createPdrTestRecords,
  createExecutionTestRecords,
  cleanupExecutionTestRecords,
  createAsyncOperationTestRecords,
};
