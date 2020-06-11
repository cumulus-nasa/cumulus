'use strict';

const test = require('ava');

const { randomId } = require('@cumulus/common/test-utils');

const indexer = require('../../es/indexer');
const { Search } = require('../../es/search');
const { fakeGranuleFactoryV2 } = require('../../lib/testUtils');
const { bootstrapElasticSearch } = require('../../lambdas/bootstrap');

const granules = [
  fakeGranuleFactoryV2(),
  fakeGranuleFactoryV2({ granuleId: randomId('granprefix') }),
  fakeGranuleFactoryV2({ granuleId: randomId('granprefix'), status: 'failed' }),
  fakeGranuleFactoryV2({ status: 'failed' })
];

let esClient;
const esIndex = randomId('esindex');
const esAlias = randomId('esalias');
process.env.ES_INDEX = esAlias;

test.before(async () => {
  // create the elasticsearch index and add mapping
  await bootstrapElasticSearch('fakehost', esIndex, esAlias);
  esClient = await Search.es();

  await Promise.all(
    granules.map((granule) => indexer.indexGranule(esClient, granule, esAlias))
  );
});

test.after.always(async () => {
  await esClient.indices.delete({ index: esIndex });
});

test('Search with prefix returns correct granules', async (t) => {
  const prefix = 'granprefix';
  const params = {
    limit: 50,
    page: 1,
    order: 'desc',
    sort_by: 'timestamp',
    prefix
  };

  const es = new Search(
    { queryStringParameters: params },
    'granule',
    process.env.ES_INDEX
  );

  const queryResult = await es.query();

  t.is(queryResult.meta.count, 2);
  t.is(queryResult.results.length, 2);
  queryResult.results.map((granule) =>
    t.true([granules[1].granuleId, granules[2].granuleId].includes(granule.granuleId)));
});

test('Search with infix returns correct granules', async (t) => {
  const granuleId = granules[2].granuleId;
  const _infix = granuleId.substring(4, 14);
  const params = {
    limit: 50,
    page: 1,
    order: 'desc',
    sort_by: 'timestamp',
    status: 'failed',
    infix: _infix
  };

  const es = new Search(
    { queryStringParameters: params },
    'granule',
    process.env.ES_INDEX
  );

  const queryResult = await es.query();

  t.is(queryResult.meta.count, 1);
  t.is(queryResult.results.length, 1);
  t.is(queryResult.results[0].granuleId, granuleId);
});
