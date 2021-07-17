const test = require('ava');
const rewire = require('rewire');
const range = require('lodash/range');

const { constructCollectionId } = require('@cumulus/message/Collections');

const sortBy = require('lodash/sortBy');
const {
  convertToDBCollectionSearchObject,
  convertToESCollectionSearchParams,
  convertToESGranuleSearchParams,
  filterCMRCollections,
  filterDBCollections,
  searchParamsForCollectionIdArray,
} = require('../../lib/reconciliationReport');
const { fakeCollectionFactory } = require('../../lib/testUtils');

const CRP = rewire('../../lib/reconciliationReport');
const dateToValue = CRP.__get__('dateToValue');

test('dateToValue converts a string representation to a primitive date.', (t) => {
  const primitiveValue = 1500000000000;
  const testStrings = [
    'Thu Jul 13 2017 20:40:00 GMT-0600',
    'Fri Jul 14 2017 02:40:00 GMT+0000',
    '2017-07-14T02:40:00.000Z',
    'Fri, 14 Jul 2017 02:40:00 GMT',
  ];
  testStrings.map((testVal) => t.is(dateToValue(testVal), primitiveValue));
});

test('dateToValue returns undefined for any string that cannot be converted to a date.', (t) => {
  const testStrings = ['startTime', '20170713 20:40:00', '20170713T204000'];
  testStrings.map((testVal) => t.is(dateToValue(testVal), undefined));
});

test('convertToESCollectionSearchParams returns correct search object.', (t) => {
  const startTimestamp = '2000-10-31T15:00:00.000Z';
  const endTimestamp = '2001-10-31T15:00:00.000Z';
  const testObj = {
    startTimestamp,
    endTimestamp,
    anotherKey: 'anything',
    anotherKey2: 'they are ignored',
  };

  const expected = {
    updatedAt__from: 973004400000,
    updatedAt__to: 1004540400000,
  };

  const actual = convertToESCollectionSearchParams(testObj);
  t.deepEqual(actual, expected);
});

test('convertToESGranuleSearchParams returns correct search object.', (t) => {
  const startTimestamp = '2010-01-01T00:00:00.000Z';
  const endTimestamp = '2011-10-01T12:00:00.000Z';
  const testObj = {
    startTimestamp,
    endTimestamp,
    anotherKey: 'anything',
    anotherKey2: 'they are ignored',
  };

  const expected = {
    updatedAt__from: 1262304000000,
    updatedAt__to: 1317470400000,
  };

  const actual = convertToESGranuleSearchParams(testObj);
  t.deepEqual(actual, expected);
});

test('convertToESCollectionSearchParams returns correct search object with collectionIds.', (t) => {
  const startTimestamp = '2000-10-31T15:00:00.000Z';
  const endTimestamp = '2001-10-31T15:00:00.000Z';
  const collectionIds = ['name___version', 'name2___version'];
  const testObj = {
    startTimestamp,
    endTimestamp,
    collectionIds,
    anotherKey: 'anything',
    anotherKey2: 'they are ignored',
  };

  const expected = {
    updatedAt__from: 973004400000,
    updatedAt__to: 1004540400000,
    _id__in: 'name___version,name2___version',
  };

  const actual = convertToESCollectionSearchParams(testObj);
  t.deepEqual(actual, expected);
});

test('convertToDBCollectionSearchParams returns correct search object with collectionIds.', (t) => {
  const startTimestamp = '2000-10-31T15:00:00.000Z';
  const endTimestamp = '2001-10-31T15:00:00.000Z';
  const collectionIds = ['name___version'];
  const testObj = {
    startTimestamp,
    endTimestamp,
    collectionIds,
    anotherKey: 'anything',
    anotherKey2: 'they are ignored',
  };

  const expected = [{
    updatedAtFrom: new Date(startTimestamp),
    updatedAtTo: new Date(endTimestamp),
  }, {
    name: 'name',
    version: 'version',
  }];

  const actual = convertToDBCollectionSearchObject(testObj);
  t.deepEqual(actual, expected);
});

test('convertToDBCollectionSearchParams ignores collectionIds when there are multiple collectionIds.', (t) => {
  const startTimestamp = '2000-10-31T15:00:00.000Z';
  const endTimestamp = '2001-10-31T15:00:00.000Z';
  const collectionIds = ['name___version', 'name2___version'];
  const testObj = {
    startTimestamp,
    endTimestamp,
    collectionIds,
    anotherKey: 'anything',
    anotherKey2: 'they are ignored',
  };

  const expected = [{
    updatedAtFrom: new Date(startTimestamp),
    updatedAtTo: new Date(endTimestamp),
  }, {}];

  const actual = convertToDBCollectionSearchObject(testObj);
  t.deepEqual(actual, expected);
});

test('filterCMRCollections returns all collections if no collectionIds on recReportParams', (t) => {
  const collections = range(25).map(() => fakeCollectionFactory());
  const expectedCollectionsIds = sortBy(collections, [
    'name',
    'version',
  ]).map((c) => constructCollectionId(c.name, c.version));

  const reportParams = {
    startTimestamp: 'any',
    endTimestamp: 'also any',
    otherUnusedParams: 'could be anything',
  };

  const cmrCollections = sortBy(collections, ['name', 'version']).map(
    (collection) => ({
      umm: { ShortName: collection.name, Version: collection.version },
    })
  );

  const actual = filterCMRCollections(cmrCollections, reportParams);

  t.deepEqual(actual, expectedCollectionsIds);
});

test("filterCMRCollections filters collections by recReportParams's collectionIds", (t) => {
  const collections = range(25).map(() => fakeCollectionFactory());

  const targetCollections = [
    collections[3],
    collections[5],
    collections[7],
    collections[9],
  ];

  const collectionIds = sortBy(targetCollections, ['name', 'version']).map((c) =>
    constructCollectionId(c.name, c.version));

  const expected = sortBy(targetCollections, 'name', 'version').map(
    (collection) => constructCollectionId(collection.name, collection.version)
  );

  const reportParams = {
    startTimestamp: 'any',
    endTimestamp: 'also any',
    otherUnusedParams: 'could be anything',
    collectionIds,
  };

  const cmrCollections = sortBy(collections, ['name', 'version']).map(
    (collection) => ({
      umm: { ShortName: collection.name, Version: collection.version },
    })
  );

  const actual = filterCMRCollections(cmrCollections, reportParams);

  t.deepEqual(actual, expected);
});

test('filterDBCollections returns all collections if no collectionIds on recReportParams', (t) => {
  let collections = range(25).map(() => fakeCollectionFactory());
  collections = sortBy(collections, 'name', 'version');
  const reportParams = {
    startTimestamp: 'any',
    endTimestamp: 'also any',
    otherUnusedParams: 'could be anything',
  };

  const actual = filterDBCollections(collections, reportParams);

  t.deepEqual(actual, collections);
});

test("filterDBCollections filters collections by recReportParams's collectionIds", (t) => {
  let collections = range(25).map(() => fakeCollectionFactory());
  collections = sortBy(collections, 'name', 'version');
  const nonDbCollection = fakeCollectionFactory();

  const targetCollections = [
    collections[7],
    collections[9],
    nonDbCollection,
    collections[3],
    collections[5],
  ];

  const collectionIds = targetCollections.map((c) => constructCollectionId(c.name, c.version));

  const expected = sortBy(targetCollections, 'name', 'version')
    .filter((c) => !(c.name === nonDbCollection.name && c.version === nonDbCollection.version));

  const reportParams = {
    startTimestamp: 'any',
    endTimestamp: 'also any',
    otherUnusedParams: 'could be anything',
    collectionIds,
  };

  const actual = filterDBCollections(collections, reportParams);

  t.deepEqual(actual, expected);
});

test('searchParamsForCollectionIdArray converts array of collectionIds to a proper object to pass to the query command.', (t) => {
  const collectionIds = ['col1___ver1', 'col1___ver2', 'col2___ver1'];

  const expectedInputQueryParams = {
    _id__in: 'col1___ver1,col1___ver2,col2___ver1',
  };

  const actualSearchParams = searchParamsForCollectionIdArray(collectionIds);
  t.deepEqual(actualSearchParams, expectedInputQueryParams);
});
