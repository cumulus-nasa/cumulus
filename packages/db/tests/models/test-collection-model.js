const test = require('ava');
const times = require('lodash/times');
const cryptoRandomString = require('crypto-random-string');

const { removeNilProperties } = require('@cumulus/common/util');

const {
  CollectionPgModel,
  fakeCollectionRecordFactory,
  generateLocalTestDb,
  destroyLocalTestDb,
} = require('../../dist');

const { migrationDir } = require('../../../../lambdas/db-migration');

const testDbName = `collection_${cryptoRandomString({ length: 10 })}`;

test.before(async (t) => {
  const { knexAdmin, knex } = await generateLocalTestDb(
    testDbName,
    migrationDir
  );
  t.context.knexAdmin = knexAdmin;
  t.context.knex = knex;

  t.context.collectionPgModel = new CollectionPgModel();
});

test.beforeEach((t) => {
  t.context.collectionRecord = fakeCollectionRecordFactory();
});

test.after.always(async (t) => {
  await destroyLocalTestDb({
    ...t.context,
    testDbName,
  });
});

test.serial('CollectionPgModel.upsert() creates new collection', async (t) => {
  const {
    knex,
    collectionPgModel,
    collectionRecord,
  } = t.context;

  await collectionPgModel.upsert(knex, collectionRecord);

  t.like(
    await collectionPgModel.get(knex, collectionRecord),
    {
      ...collectionRecord,
      files: JSON.parse(collectionRecord.files),
      meta: collectionRecord.meta,
    }
  );
});

test.serial('CollectionPgModel.upsert() overwrites a collection record', async (t) => {
  const {
    knex,
    collectionPgModel,
    collectionRecord,
  } = t.context;

  await collectionPgModel.create(knex, collectionRecord);

  const updatedCollection = {
    ...collectionRecord,
    sample_file_name: cryptoRandomString({ length: 3 }),
  };

  await collectionPgModel.upsert(knex, updatedCollection);

  t.like(
    await collectionPgModel.get(knex, {
      name: collectionRecord.name,
      version: collectionRecord.version,
    }),
    {
      ...updatedCollection,
      files: JSON.parse(updatedCollection.files),
      meta: collectionRecord.meta,
    }
  );
});

test('Collection.searchWithUpdatedAtRange() returns an array of records if no date range specified', async (t) => {
  const {
    knex,
    collectionPgModel,
  } = t.context;

  const collectionName = cryptoRandomString({ length: 10 });
  const records = times(3, (i) => fakeCollectionRecordFactory({
    name: collectionName,
    version: i,
    updated_at: new Date(),
  }));
  await Promise.all(records.map((r) => collectionPgModel.create(knex, r)));

  const searchResponse = await collectionPgModel.searchWithUpdatedAtRange(
    knex,
    { name: collectionName },
    {}
  );

  t.is(searchResponse.length, 3);
});

test('Collection.searchWithUpdatedAtRange() returns a filtered array of records if a date range is specified', async (t) => {
  const {
    knex,
    collectionPgModel,
  } = t.context;

  const collectionName = cryptoRandomString({ length: 10 });
  const records = times(3, (i) => fakeCollectionRecordFactory({
    name: collectionName,
    version: i,
    updated_at: new Date(),
  }));

  const dateValue = 5000;
  const searchRecord = fakeCollectionRecordFactory({
    name: collectionName,
    version: '4',
    updated_at: new Date(dateValue),
  });
  records.push(searchRecord);

  await Promise.all(records.map((r) => collectionPgModel.create(knex, r)));

  const searchResponse = await collectionPgModel.searchWithUpdatedAtRange(
    knex,
    {
      name: collectionName,
    },
    {
      updatedAtFrom: new Date(dateValue - 1),
      updatedAtTo: new Date(dateValue + 1),
    }
  );

  t.is(searchResponse.length, 1);
  t.like(
    removeNilProperties(searchResponse[0]),
    { ...searchRecord, files: JSON.parse(searchRecord.files), meta: searchRecord.meta }
  );
});

test('Collection.searchWithUpdatedAtRange() returns a filtered array of records if only updatedAtTo is specified', async (t) => {
  const {
    knex,
    collectionPgModel,
  } = t.context;

  const dateValue = 5000;
  const collectionName = cryptoRandomString({ length: 10 });
  const records = times(3, (i) => fakeCollectionRecordFactory({
    name: collectionName,
    version: i,
    updated_at: new Date(),
  }));

  const searchRecord = fakeCollectionRecordFactory({
    name: collectionName,
    updated_at: new Date(dateValue),
    version: '4',
  });
  records.push(searchRecord);

  await Promise.all(records.map((r) => collectionPgModel.create(knex, r)));

  const searchResponse = await collectionPgModel.searchWithUpdatedAtRange(
    knex,
    {
      name: collectionName,
    },
    {
      updatedAtTo: new Date(dateValue + 1),
    }
  );

  t.is(searchResponse.length, 1);
  t.like(
    removeNilProperties(searchResponse[0]),
    { ...searchRecord, files: JSON.parse(searchRecord.files), meta: searchRecord.meta }
  );
});

test.serial('Collection.searchWithUpdatedAtRange() returns a filtered array of records if only updatedAtFrom is specified', async (t) => {
  const {
    knex,
    collectionPgModel,
  } = t.context;

  const nowDateValue = new Date().valueOf();
  const collectionName = cryptoRandomString({ length: 10 });
  const records = times(3, (i) => fakeCollectionRecordFactory({
    name: collectionName,
    version: i,
    updated_at: new Date(nowDateValue - 10000),
  }));

  const searchRecord = fakeCollectionRecordFactory({
    updated_at: new Date(nowDateValue),
    name: collectionName,
    version: '4',
  });
  records.push(searchRecord);

  await Promise.all(records.map((r) => collectionPgModel.create(knex, r)));

  const searchResponse = await collectionPgModel.searchWithUpdatedAtRange(
    knex,
    {
      name: collectionName,
    },
    {
      updatedAtFrom: new Date(nowDateValue - 1),
    }
  );

  t.is(searchResponse.length, 1);
  t.like(
    removeNilProperties(searchResponse[0]),
    { ...searchRecord, files: JSON.parse(searchRecord.files), meta: searchRecord.meta }
  );
});
