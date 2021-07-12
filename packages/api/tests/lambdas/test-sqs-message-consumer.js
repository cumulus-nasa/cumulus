'use strict';

const delay = require('delay');
const sinon = require('sinon');
const test = require('ava');
const range = require('lodash/range');

const SQS = require('@cumulus/aws-client/SQS');
const { s3 } = require('@cumulus/aws-client/services');
const {
  createBucket,
  putJsonS3Object,
  recursivelyDeleteS3Bucket,
  s3ObjectExists,
} = require('@cumulus/aws-client/S3');
const {
  destroyLocalTestDb,
  generateLocalTestDb,
  RulePgModel,
  translateApiRuleToPostgresRule,
} = require('@cumulus/db');
const { randomId, randomString } = require('@cumulus/common/test-utils');
const { getS3KeyForArchivedMessage } = require('@cumulus/ingest/sqs');
const { fakeRuleFactoryV2, createSqsQueues, getSqsQueueMessageCounts } = require('../../lib/testUtils');
const rulesHelpers = require('../../lib/rulesHelpers');

const { migrationDir } = require('../../../../lambdas/db-migration');

const {
  handler,
} = require('../../lambdas/sqs-message-consumer');

const testDbName = randomString(12);
process.env.stackName = randomString();
process.env.system_bucket = randomString();

const workflow = randomString();
const workflowfile = `${process.env.stackName}/workflows/${workflow}.json`;
const messageTemplateKey = `${process.env.stackName}/workflow_template.json`;

let dbClient;
let rulePgModel;
const event = { messageLimit: 10, timeLimit: 100 };

const fakePgRuleFactory = (params) => {
  const rule = fakeRuleFactoryV2(params);
  delete rule.provider;
  delete rule.collection;
  translateApiRuleToPostgresRule(rule);
};

async function createRulesAndQueues(ruleMeta, queueMaxReceiveCount) {
  const queues = await Promise.all(range(2).map(
    () => createSqsQueues(randomString(), queueMaxReceiveCount)
  ));
  let rules = [
    fakePgRuleFactory({
      workflow,
      rule: {
        type: 'onetime',
      },
      state: 'ENABLED',
    }),
    fakePgRuleFactory({
      workflow,
      rule: {
        type: 'sqs',
        value: queues[0].queueUrl,
      },
      meta: {
        visibilityTimeout: 120,
        ...ruleMeta,
      },
      state: 'ENABLED',
    }),
    fakePgRuleFactory({
      workflow,
      rule: {
        type: 'sqs',
        value: queues[1].queueUrl,
      },
      meta: {
        visibilityTimeout: 120,
        ...ruleMeta,
      },
      state: 'DISABLED',
    }),
  ];
  rules = await Promise.all(
    rules.map((rule) => rulePgModel.create(dbClient, rule))
  );
  return { rules, queues };
}

async function cleanupRulesAndQueues(rules, queues) {
  await Promise.all(
    rules.map((rule) => rulePgModel.delete(dbClient, rule))
  );

  const queueUrls = queues.reduce(
    (accumulator, currentValue) => accumulator.concat(Object.values(currentValue)), []
  );

  await Promise.all(
    queueUrls.map((queueUrl) => SQS.deleteQueue(queueUrl))
  );
}

test.before(async (t) => {
  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
  dbClient = knex;
  rulePgModel = new RulePgModel();
  await createBucket(process.env.system_bucket);

  await Promise.all([
    putJsonS3Object(
      process.env.system_bucket,
      messageTemplateKey,
      { meta: 'testmeta' }
    ),
    putJsonS3Object(
      process.env.system_bucket,
      workflowfile,
      { testworkflow: 'workflowconfig' }
    ),
  ]);
});

test.after.always(async (t) => {
  // cleanup table
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName,
  });
});

test.beforeEach((t) => {
  t.context.queueMessageStub = sinon.stub(rulesHelpers, 'queueMessageForRule');
});

test.afterEach.always((t) => {
  t.context.queueMessageStub.restore();
});

test.serial('processQueues does nothing when there is no message', async (t) => {
  const { queueMessageStub } = t.context;
  await createRulesAndQueues();
  await handler(event, dbClient);
  t.is(queueMessageStub.notCalled, true);
});

test.serial('processQueues does nothing when queue does not exist', async (t) => {
  const { queueMessageStub } = t.context;
  await rulePgModel.create(dbClient, fakePgRuleFactory({
    workflow,
    rule: {
      type: 'sqs',
      value: 'non-existent-queue',
    },
    state: 'ENABLED',
  }));
  await handler(event, dbClient);
  t.is(queueMessageStub.notCalled, true);
});

test.serial('processQueues does nothing when no rule matches collection in message', async (t) => {
  const { queueMessageStub } = t.context;

  const queue = await createSqsQueues(randomId('queue'));
  const collection = {
    name: randomId('col'),
    version: '1.0.0',
  };
  const rule = await rulePgModel.create(dbClient, fakePgRuleFactory({
    collection: {
      name: 'different-collection',
      version: '1.2.3',
    },
    workflow,
    rule: {
      type: 'sqs',
      value: queue.queueUrl,
    },
    state: 'ENABLED',
  }));

  await SQS.sendSQSMessage(
    queue.queueUrl,
    { collection }
  );
  await handler(event, dbClient);

  t.is(queueMessageStub.notCalled, true);
  t.teardown(async () => {
    await cleanupRulesAndQueues([rule], [queue]);
  });
});

test.serial('processQueues processes messages from the ENABLED sqs rule', async (t) => {
  const { queueMessageStub } = t.context;
  const { rules, queues } = await createRulesAndQueues();
  const queueMessageFromEnabledRuleStub = queueMessageStub
    .withArgs(rules[1], sinon.match.any, sinon.match.any);

  // send two messages to the queue of the ENABLED sqs rule
  await Promise.all(
    range(2).map(() =>
      SQS.sendSQSMessage(
        queues[0].queueUrl,
        { testdata: randomString() }
      ))
  );

  // send three messages to the queue of the DISABLED sqs rule
  await Promise.all(
    range(3).map(() =>
      SQS.sendSQSMessage(
        queues[1].queueUrl,
        { testdata: randomString() }
      ))
  );
  await handler(event, dbClient);

  // verify only messages from ENABLED rule are processed
  t.is(queueMessageStub.calledTwice, true);
  t.is(queueMessageFromEnabledRuleStub.calledTwice, true);
  queueMessageStub.resetHistory();

  // messages are not processed multiple times in parallel
  // given the visibilityTimeout is long enough
  await handler(event, dbClient);
  t.is(queueMessageStub.notCalled, true);
  t.is(queueMessageFromEnabledRuleStub.notCalled, true);

  // messages are picked up from the correct queue
  const numberOfMessages = await getSqsQueueMessageCounts(queues[0].queueUrl);
  t.is(numberOfMessages.numberOfMessagesAvailable, 0);

  const numberOfMessagesQueue1 = await getSqsQueueMessageCounts(queues[1].queueUrl);
  t.is(numberOfMessagesQueue1.numberOfMessagesAvailable, 3);

  // processed messages stay in queue until workflow execution succeeds
  // in this test, workflow executions are stubbed
  t.is(numberOfMessages.numberOfMessagesNotVisible, 2);
  t.teardown(async () => {
    await cleanupRulesAndQueues(rules, queues);
  });
});

test.serial('messages are retried the correct number of times based on the rule configuration', async (t) => {
  const { queueMessageStub } = t.context;
  // set visibilityTimeout to 5s so the message is available 5s after retrieval
  const visibilityTimeout = 5;
  const queueMaxReceiveCount = 3;

  const { rules, queues } = await createRulesAndQueues(
    { visibilityTimeout, retries: 1 },
    queueMaxReceiveCount
  );

  const queueMessageFromEnabledRuleStub = queueMessageStub
    .withArgs(rules[1], sinon.match.any, sinon.match.any);

  // send two messages to the queue of the ENABLED sqs rule
  await Promise.all(
    range(2).map(() =>
      SQS.sendSQSMessage(
        queues[0].queueUrl,
        { testdata: randomString() }
      ))
  );

  await handler(event, dbClient);

  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < queueMaxReceiveCount; i += 1) {
    await delay(visibilityTimeout * 1000);
    await handler(event, dbClient);
  }
  /* eslint-enable no-await-in-loop */

  // the retries is 1, so each message can only be scheduled for workflow execution twice
  t.is(queueMessageStub.callCount, 4);
  t.is(queueMessageFromEnabledRuleStub.callCount, 4);

  // messages are picked up from the source queue
  const numberOfMessages = await getSqsQueueMessageCounts(queues[0].queueUrl);
  t.is(numberOfMessages.numberOfMessagesAvailable, 0);

  // messages are moved to dead-letter queue after `queueMaxReceiveCount` retries
  const numberOfMessagesDLQ = await getSqsQueueMessageCounts(queues[0].deadLetterQueueUrl);
  t.is(numberOfMessagesDLQ.numberOfMessagesAvailable, 2);

  t.teardown(async () => {
    await cleanupRulesAndQueues(rules, queues);
  });
});

test.serial('SQS message consumer queues workflow for rule when there is no event collection', async (t) => {
  const { queueMessageStub } = t.context;

  const queue = await createSqsQueues(randomId('queue'));
  const rule = fakePgRuleFactory({
    name: randomId('matchingRule'),
    rule: {
      type: 'sqs',
      value: queue.queueUrl,
    },
    state: 'ENABLED',
    workflow,
  });

  const createdRule = await rulePgModel.create(dbClient, rule);
  await SQS.sendSQSMessage(
    queue.queueUrl,
    { foo: 'bar' }
  );

  await handler(event, dbClient);

  // Should queue message for enabled rule
  t.is(queueMessageStub.callCount, 1);

  t.teardown(async () => {
    await cleanupRulesAndQueues([createdRule], [queue]);
  });
});

test.serial('SQS message consumer queues correct number of workflows for rules matching the event collection', async (t) => {
  const { queueMessageStub } = t.context;

  const queue = await createSqsQueues(randomId('queue'));
  const collection = {
    name: randomId('collection'),
    version: '1.0.0',
  };
  // Set visibility timeout to 0 for testing to ensure that message is
  // read when processing all rules
  const visibilityTimeout = 0;
  const rules = [
    fakePgRuleFactory({
      name: randomId('matchingRule'),
      collection,
      rule: {
        type: 'sqs',
        value: queue.queueUrl,
      },
      meta: {
        visibilityTimeout,
      },
      state: 'ENABLED',
      workflow,
    }),
    fakePgRuleFactory({
      rule: {
        type: 'sqs',
        value: queue.queueUrl,
      },
      meta: {
        visibilityTimeout,
      },
      state: 'ENABLED',
      workflow,
    }),
  ];

  await Promise.all(rules.map((rule) => rulePgModel.create(dbClient, rule)));
  await SQS.sendSQSMessage(
    queue.queueUrl,
    { collection } // include collection in message
  );

  await handler(event, dbClient);

  // Should only queue message for the workflow on the rule matching the collection in the event
  t.is(queueMessageStub.callCount, 1);

  t.teardown(async () => {
    await cleanupRulesAndQueues(rules, [queue]);
  });
});

test.serial('processQueues archives messages from the ENABLED sqs rule only', async (t) => {
  const { stackName } = process.env;
  const { rules, queues } = await createRulesAndQueues();
  const message = { testdata: randomString() };

  // Send message to ENABLED queue
  const firstMessage = await SQS.sendSQSMessage(
    queues[0].queueUrl,
    message
  );

  // Send message to DISABLED queue
  const secondMessage = await SQS.sendSQSMessage(
    queues[1].queueUrl,
    { testdata: randomString() }
  );
  const enabledQueueKey = getS3KeyForArchivedMessage(stackName, firstMessage.MessageId);
  const deadLetterKey = getS3KeyForArchivedMessage(stackName, secondMessage.MessageId);

  await handler(event, dbClient);

  const item = await s3().getObject({
    Bucket: process.env.system_bucket,
    Key: enabledQueueKey,
  }).promise();

  t.deepEqual(message, JSON.parse(item.Body));

  t.false(await s3ObjectExists({
    Bucket: process.env.system_bucket,
    Key: deadLetterKey,
  }));

  t.teardown(async () => {
    await cleanupRulesAndQueues(rules, queues);
  });
});

test.serial('processQueues archives multiple messages', async (t) => {
  const { stackName } = process.env;
  const { rules, queues } = await createRulesAndQueues();

  // Send message to ENABLED queue
  const messages = await Promise.all(
    range(4).map(() =>
      SQS.sendSQSMessage(
        queues[0].queueUrl,
        { testdata: randomString() }
      ))
  );
  const deriveKey = (m) => getS3KeyForArchivedMessage(stackName, m.MessageId);
  const keys = messages.map((m) => deriveKey(m));

  await handler(event, dbClient);

  const items = await Promise.all(keys.map((k) =>
    s3ObjectExists({
      Bucket: process.env.system_bucket,
      Key: k,
    })));

  const itemExists = (i) => t.true(i);

  items.every(itemExists);

  t.teardown(async () => {
    await cleanupRulesAndQueues(rules, queues);
  });
});
