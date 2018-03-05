'use strict';

const test = require('ava');

// TODO(aimee): Dry this setup for all api package tests.
process.env.CollectionsTable = 'Test_CollectionsTable';
process.env.stackName = 'test-stack';
process.env.internal = 'test-bucket';

const models = require('../models');
const aws = require('@cumulus/common/aws');
const collectionsEndpoint = require('../endpoints/collections');
const collections = new models.Collection();
const { testEndpoint } = require('./testUtils');

const testCollection = {
  "name": "collection-125",
  "version": "0.0.0",
  "provider_path": "/",
  "duplicateHandling": "replace",
  "granuleId": "^MOD09GQ\\.A[\\d]{7}\\.[\\S]{6}\\.006.[\\d]{13}$",
  "granuleIdExtraction": "(MOD09GQ\\.(.*))\\.hdf",
  "sampleFileName": "MOD09GQ.A2017025.h21v00.006.2017034065104.hdf",
  "files": []
};

const hash = { name: 'name', type: 'S' };
async function setup() {
  await aws.s3().createBucket({ Bucket: process.env.internal }).promise();
  await models.Manager.createTable(process.env.CollectionsTable, hash);
  await collections.create(testCollection);
}

async function teardown() {
  models.Manager.deleteTable(process.env.CollectionsTable);
  await aws.recursivelyDeleteS3Bucket(process.env.internal);
}

test.before(async () => setup());
test.after.always(async () => teardown());

test('default returns list of collections', t => {
  const listEvent = { httpMethod: 'list' };
  return testEndpoint(collectionsEndpoint, listEvent, response => {
    t.is(JSON.parse(response.body).Items.length, 1);
  });
});

test('GET returns an existing collection', t => {
  const getEvent = {
    httpMethod: 'GET',
    pathParameters: {
      collectionName: testCollection.name,
      version: testCollection.version
    }
  };
  return testEndpoint(collectionsEndpoint, getEvent, response => {
    const collection = JSON.parse(response.body);
    t.is(collection.name, testCollection.name);
  });
});

test('POST creates a new collection', t => {
  const newCollection = Object.assign({}, testCollection, {name: 'collection-post'});
  const postEvent = {
    httpMethod: 'POST',
    body: JSON.stringify(newCollection)
  };
  return testEndpoint(collectionsEndpoint, postEvent, response => {
    const { message, record } = JSON.parse(response.body);
    t.is(message, 'Record saved');
    t.is(record.name, newCollection.name);
  });
});

test('PUT updates an existing collection', t => {
  const newPath = '/new_path';
  const updateEvent = {
    body: JSON.stringify({
      name: testCollection.name,
      version: testCollection.version,
      provider_path: newPath
    }),
    pathParameters: {
      collectionName: testCollection.name,
      version: testCollection.version,
    },
    httpMethod: 'PUT'
  };
  return testEndpoint(collectionsEndpoint, updateEvent, response => {
    const record = JSON.parse(response.body);
    t.is(record.provider_path, newPath);
  });
});

test('DELETE deletes an existing collection', t => {
  const deleteEvent = {
    httpMethod: 'DELETE',
    pathParameters: {
      collectionName: testCollection.name,
      version: testCollection.version,
    }
  };
  return testEndpoint(collectionsEndpoint, deleteEvent, response => {
    const { message } = JSON.parse(response.body);
    t.is(message, 'Record deleted');
  });
});

test.todo('GET returns existing collection');
test.todo('POST without name and version returns error message');
test.todo('PUT with invalid name and version returns error message');
// Multiple tests
test.todo('Test methods return not found');
