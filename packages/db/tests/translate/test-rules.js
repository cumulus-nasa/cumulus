const test = require('ava');
const { translateApiRuleToPostgresRule, translatePostgresRuleToApiRule } = require('../../dist/translate/rules');

test('translateApiRuleToPostgresRule converts API rule to Postgres', async (t) => {
  const record = {
    name: 'name',
    workflow: 'workflow_name',
    provider: 'fake-provider',
    state: 'ENABLED',
    collection: {
      name: 'fake-collection',
      version: '0.0.0',
    },
    rule: { type: 'onetime', value: 'value', arn: 'arn', logEventArn: 'event_arn' },
    executionNamePrefix: 'prefix',
    meta: { key: 'value' },
    queueUrl: 'https://sqs.us-west-2.amazonaws.com/123456789012/queue_url',
    payload: { result: { key: 'value' } },
    tags: ['tag1', 'tag2'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const fakeDbClient = {};
  const fakeCollectionPgModel = {
    getRecordCumulusId: () => Promise.resolve(1),
  };
  const fakeProviderPgModel = {
    getRecordCumulusId: () => Promise.resolve(2),
  };

  const expectedPostgresRule = {
    name: record.name,
    workflow: record.workflow,
    meta: record.meta,
    payload: record.payload,
    queue_url: record.queueUrl,
    arn: record.rule.arn,
    type: record.rule.type,
    value: record.rule.value,
    log_event_arn: record.rule.logEventArn,
    enabled: true,
    tags: JSON.stringify(record.tags),
    execution_name_prefix: record.executionNamePrefix,
    created_at: new Date(record.createdAt),
    updated_at: new Date(record.updatedAt),
    collection_cumulus_id: 1,
    provider_cumulus_id: 2,
  };

  const result = await translateApiRuleToPostgresRule(
    record,
    fakeDbClient,
    fakeCollectionPgModel,
    fakeProviderPgModel
  );
  t.deepEqual(
    result,
    expectedPostgresRule
  );
});

test('translateApiRuleToPostgresRule handles optional fields', async (t) => {
  const record = {
    name: 'name',
    workflow: 'workflow_name',
    state: 'ENABLED',
    rule: { type: 'onetime' },
  };

  const fakeDbClient = {};
  const fakeCollectionPgModel = {
    getRecordCumulusId: () => Promise.resolve(1),
  };
  const fakeProviderPgModel = {
    getRecordCumulusId: () => Promise.resolve(2),
  };

  const expectedPostgresRule = {
    name: record.name,
    workflow: record.workflow,
    type: record.rule.type,
    enabled: true,
  };

  const result = await translateApiRuleToPostgresRule(
    record,
    fakeDbClient,
    fakeCollectionPgModel,
    fakeProviderPgModel
  );
  t.deepEqual(
    result,
    expectedPostgresRule
  );
});

test('translatePostgresRuleToApiRule converts Postgres rule to API rule', async (t) => {
  const pgRecord = {
    name: 'testRule',
    workflow: 'testWorkflow',
    type: 'onetime',
    enabled: true,
    collection_cumulus_id: 1,
    provider_cumulus_id: 2,
    execution_name_prefix: 'test',
    value: 'abcd',
    arn: 'arn:123',
    log_event_arn: 'arn:987',
    payload: { object: 'value' },
    meta: {
      retries: 2,
      visibility: 30,
      more: 'meta',
    },
    tags: JSON.stringify([]),
    queue_url: 'https://sqs.us-west-2.amazonaws.com/123456789012/my-queue',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const fakeDbClient = {};
  const fakeCollection = { name: 'abc', version: '123' };
  const fakeCollectionPgModel = {
    get: () => Promise.resolve(fakeCollection),
  };
  const fakeProvider = { name: 'abc' };
  const fakeProviderPgModel = {
    get: () => Promise.resolve(fakeProvider),
  };

  const expectedRule = {
    name: pgRecord.name,
    state: 'ENABLED',
    workflow: pgRecord.workflow,
    collection: fakeCollection,
    provider: fakeProvider.name,
    meta: pgRecord.meta,
    payload: pgRecord.payload,
    queueUrl: pgRecord.queue_url,
    rule: {
      type: pgRecord.type,
      arn: pgRecord.arn,
      logEventArn: pgRecord.log_event_arn,
      value: pgRecord.value,
    },
    executionNamePrefix: pgRecord.execution_name_prefix,
    tags: [],
    createdAt: pgRecord.created_at.getTime(),
    updatedAt: pgRecord.updated_at.getTime(),
  };

  t.deepEqual(
    await translatePostgresRuleToApiRule(
      pgRecord,
      fakeDbClient,
      fakeCollectionPgModel,
      fakeProviderPgModel
    ),
    expectedRule
  );
});

test('translatePostgresRuleToApiRule handles optional fields', async (t) => {
  const pgRecord = {
    name: 'testRule',
    workflow: 'testWorkflow',
    type: 'onetime',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const fakeDbClient = {};
  const fakeCollection = { name: 'abc', version: '123' };
  const fakeCollectionPgModel = {
    get: () => Promise.resolve(fakeCollection),
  };
  const fakeProvider = { name: 'abc' };
  const fakeProviderPgModel = {
    get: () => Promise.resolve(fakeProvider),
  };

  const expectedRule = {
    name: pgRecord.name,
    state: 'ENABLED',
    workflow: pgRecord.workflow,
    rule: { type: pgRecord.type },
    createdAt: pgRecord.created_at.getTime(),
    updatedAt: pgRecord.updated_at.getTime(),
  };

  t.deepEqual(
    await translatePostgresRuleToApiRule(
      pgRecord,
      fakeDbClient,
      fakeCollectionPgModel,
      fakeProviderPgModel
    ),
    expectedRule
  );
});
