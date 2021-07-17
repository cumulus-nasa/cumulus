'use strict';

const get = require('lodash/get');
const sinon = require('sinon');
const test = require('ava');
const proxyquire = require('proxyquire');

const { randomString } = require('@cumulus/common/test-utils');
const Rule = require('../../models/rules');
const testCollectionName = 'test-collection';

const sandbox = sinon.createSandbox();
const queueMessageStub = sandbox.stub().resolves(true);
const { handler } = proxyquire('../../lambdas/message-consumer', {
  '../lib/rulesHelpers': {
    queueMessageForRule: queueMessageStub,
  },
});

/**
 * Callback used for testing
 *
 * @param {*} err - error
 * @param {Object} object - object
 * @returns {Object} object, if no error is thrown
 */
function testCallback(err, object) {
  if (err) throw err;
  return object;
}

const snsArn = 'test-SnsArn';
const messageBody = '{"Data":{}}';

const event = {
  Records: [
    {
      EventSource: 'aws:sns',
      EventVersion: '1.0',
      EventSubscriptionArn: 'arn:aws:sns:us-east-1:00000000000:gdelt-csv:111111-111',
      Sns: {
        Type: 'Notification',
        MessageId: '4f411981',
        TopicArn: snsArn,
        Subject: 'Amazon S3 Notification',
        Message: messageBody,
        MessageAttributes: {},
      },
    },
  ],
};

const collection = {
  name: testCollectionName,
  version: '0.0.0',
};
const provider = { id: 'PROV1' };

let ruleModel;

test.before(async () => {
  process.env.RulesTable = randomString();
  process.env.stackName = randomString();
  process.env.system_bucket = randomString();
  process.env.messageConsumer = randomString();

  ruleModel = new Rule();
  await ruleModel.createTable();

  sandbox.stub(ruleModel, 'addSnsTrigger');
  sandbox.stub(ruleModel, 'deleteSnsTrigger');

  const workflow = randomString();
  const stateMachineArn = randomString();
  const messageTemplate = {};
  const workflowDefinition = {
    name: workflow,
    arn: stateMachineArn,
  };

  sandbox.stub(Rule, 'buildPayload').callsFake((item) => Promise.resolve({
    template: messageTemplate,
    provider: item.provider,
    collection: item.collection,
    meta: get(item, 'meta', {}),
    payload: get(item, 'payload', {}),
    definition: workflowDefinition,
  }));
});

test.afterEach.always(() => {
  queueMessageStub.resetHistory();
});

test.after.always(async () => {
  await ruleModel.deleteTable();
  sandbox.restore();
});

// handler tests
test.serial('it should enqueue a message for each SNS rule', async (t) => {
  const rule1 = {
    name: 'testRule1',
    collection,
    provider: provider.id,
    rule: {
      type: 'sns',
      value: snsArn,
    },
    state: 'ENABLED',
    workflow: 'test-workflow-1',
  };

  const createdRule = await ruleModel.create(rule1);
  const expectedRule = {
    ...createdRule,
    meta: {
      snsSourceArn: snsArn,
    },
  };
  await handler(event, {}, testCallback);

  t.is(queueMessageStub.callCount, 1);
  t.deepEqual(queueMessageStub.getCall(0).args[0], expectedRule);
  t.deepEqual(queueMessageStub.getCall(0).args[1], JSON.parse(messageBody));
});
