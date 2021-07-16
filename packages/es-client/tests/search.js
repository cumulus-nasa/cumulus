'use strict';

const test = require('ava');
const rewire = require('rewire');

const { randomString } = require('@cumulus/common/test-utils');

const {
  createTestIndex,
  cleanupTestIndex,
} = require('../testUtils');
const esSearch = rewire('../search');

const { Search } = esSearch;

const localEsHost = process.env.LOCAL_ES_HOST;

test.before(async (t) => {
  const { esIndex, esClient } = await createTestIndex();
  t.context.esIndex = esIndex;
  t.context.esClient = esClient;

  const awsMock = {
    config: {
      credentials: {
        user: 'test',
        password: 'testPassword',
      },
    },
  };
  esSearch.__set__('aws', awsMock);
});

test.after.always(async (t) => {
  await cleanupTestIndex(t.context);
});

test.serial('Configured with Metrics host when metrics propety is set', async (t) => {
  process.env.METRICS_ES_HOST = 'example.com';
  process.env.METRICS_ES_USER = 'test';
  process.env.METRICS_ES_PASS = 'password';
  delete process.env.LOCAL_ES_HOST;

  const revertTestModeStub = esSearch.__set__('inTestMode', () => false);

  t.teardown(() => {
    delete process.env.METRICS_ES_HOST;
    delete process.env.METRICS_ES_USER;
    delete process.env.METRICS_ES_PASS;
    process.env.LOCAL_ES_HOST = localEsHost;
    revertTestModeStub();
  });

  const esClient = await Search.es(undefined, true);
  const connection = esClient.connectionPool;
  t.assert(connection);
  t.is(connection.connections.get('https://example.com/').url.origin, 'https://example.com');
  t.is(connection._auth.username, 'test');
  t.is(connection._auth.password, 'password');
});

test.serial('Configured with default host when no metrics property is set', async (t) => {
  process.env.ES_HOST = 'example.com';
  delete process.env.LOCAL_ES_HOST;

  const revertTestModeStub = esSearch.__set__('inTestMode', () => false);

  t.teardown(() => {
    delete process.env.ES_HOST;
    process.env.LOCAL_ES_HOST = localEsHost;
    revertTestModeStub();
  });

  const esClient = await Search.es();
  const connection = esClient.connectionPool;
  t.assert(connection);
  t.is(connection.connections.get('https://example.com/').url.origin, 'https://example.com');
});

test('Search.get() returns record', async (t) => {
  const record = { foo: 'bar' };
  const id = randomString();
  const type = 'record';
  await t.context.esClient.index({
    body: record,
    id,
    index: t.context.esIndex,
    type,
    refresh: true,
  });
  const searchClient = new Search(
    {},
    type,
    t.context.esIndex
  );
  const result = await searchClient.get(id);
  t.like(result, record);
});

test('Search.exists() returns true if record exists', async (t) => {
  const record = { foo: 'bar' };
  const id = randomString();
  const type = 'record';
  await t.context.esClient.index({
    body: record,
    id,
    index: t.context.esIndex,
    type,
    refresh: true,
  });
  const searchClient = new Search(
    {},
    type,
    t.context.esIndex
  );
  t.true(await searchClient.exists(id));
});

test('Search.exists() returns false if record does not exist', async (t) => {
  const id = randomString();
  const type = 'record';
  const searchClient = new Search(
    {},
    type,
    t.context.esIndex
  );
  t.false(await searchClient.exists(id));
});

test('Search.get() returns record by parentId', async (t) => {
  const record = { foo: 'bar' };
  const id = randomString();
  const parentId = randomString();
  const type = 'record';
  const parentType = 'parent';

  await t.context.esClient.indices.putMapping({
    index: t.context.esIndex,
    type,
    body: {
      [type]: {
        _parent: {
          type: parentType,
        },
      },
    },
  });

  await t.context.esClient.index({
    body: record,
    id,
    index: t.context.esIndex,
    parent: parentId,
    type,
    refresh: true,
  });

  const searchClient = new Search(
    {},
    type,
    t.context.esIndex
  );
  const result = await searchClient.get(id, parentId);
  t.like(result, record);
});
