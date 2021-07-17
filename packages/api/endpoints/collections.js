'use strict';

const omit = require('lodash/omit');
const router = require('express-promise-router')();
const {
  InvalidRegexError,
  UnmatchedRegexError,
  RecordDoesNotExist,
} = require('@cumulus/errors');
const Logger = require('@cumulus/logger');
const { constructCollectionId } = require('@cumulus/message/Collections');

const {
  CollectionPgModel,
  getKnexClient,
  translateApiCollectionToPostgresCollection,
  translatePostgresCollectionToApiCollection,
} = require('@cumulus/db');
const { Search } = require('@cumulus/es-client/search');
const {
  indexCollection,
  deleteCollection,
} = require('@cumulus/es-client/indexer');
const Collection = require('@cumulus/es-client/collections');
const models = require('../models');
const { AssociatedRulesError, isBadRequestError } = require('../lib/errors');
const insertMMTLinks = require('../lib/mmt');

const log = new Logger({ sender: '@cumulus/api/collections' });

/**
 * List all collections.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function list(req, res) {
  const { getMMT, includeStats, ...queryStringParameters } = req.query;
  const collection = new Collection(
    { queryStringParameters },
    undefined,
    process.env.ES_INDEX,
    includeStats === 'true'
  );
  let result = await collection.query();
  if (getMMT === 'true') {
    result = await insertMMTLinks(result);
  }
  return res.send(result);
}

/**
 * List all collections with active granules
 * If time params are specified the query will return collections
 * that have granules that have been updated in that time frame.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function activeList(req, res) {
  const { getMMT, includeStats, ...queryStringParameters } = req.query;

  const collection = new Collection(
    { queryStringParameters },
    undefined,
    process.env.ES_INDEX,
    includeStats === 'true'
  );
  let result = await collection.queryCollectionsWithActiveGranules();
  if (getMMT === 'true') {
    result = await insertMMTLinks(result);
  }
  return res.send(result);
}

/**
 * Query a single collection.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function get(req, res) {
  const name = req.params.name;
  const version = req.params.version;

  try {
    const collectionPgModel = new CollectionPgModel();
    const knex = await getKnexClient();
    const result = await collectionPgModel.get(knex, { name, version });
    return res.send(translatePostgresCollectionToApiCollection(result));
  } catch (error) {
    return res.boom.notFound(error.message);
  }
}

/**
 * Creates a new collection
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function post(req, res) {
  const {
    collectionsModel = new models.Collection(),
    collectionPgModel = new CollectionPgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const collection = req.body || {};
  const { name, version } = collection;

  if (!name || !version) {
    return res.boom.badRequest('Field name and/or version is missing');
  }

  if (await collectionsModel.exists(name, version)) {
    return res.boom.conflict(`A record already exists for ${name} version: ${version}`);
  }

  collection.updatedAt = Date.now();
  collection.createdAt = Date.now();

  try {
    let dynamoRecord;
    const dbRecord = translateApiCollectionToPostgresCollection(collection);

    try {
      await knex.transaction(async (trx) => {
        await collectionPgModel.create(trx, dbRecord);
        dynamoRecord = await collectionsModel.create(
          omit(collection, 'dataType')
        );
        // process.env.ES_INDEX is only used to isolate the index for
        // each unit test suite
        await indexCollection(esClient, dynamoRecord, process.env.ES_INDEX);
      });
    } catch (innerError) {
      // Clean up DynamoDB collection record in case of any failure
      await collectionsModel.delete(collection);
      throw innerError;
    }

    return res.send({
      message: 'Record saved',
      record: dynamoRecord,
    });
  } catch (error) {
    if (
      isBadRequestError(error)
      || error instanceof InvalidRegexError
      || error instanceof UnmatchedRegexError
    ) {
      return res.boom.badRequest(error.message);
    }
    log.error('Error occurred while trying to create collection:', error);
    return res.boom.badImplementation(error.message);
  }
}

/**
 * Updates an existing collection
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function put(req, res) {
  const {
    collectionsModel = new models.Collection(),
    collectionPgModel = new CollectionPgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const { name, version } = req.params;
  const collection = req.body;
  let dynamoRecord;
  let oldCollection;

  if (name !== collection.name || version !== collection.version) {
    return res.boom.badRequest('Expected collection name and version to be'
      + ` '${name}' and '${version}', respectively, but found '${collection.name}'`
      + ` and '${collection.version}' in payload`);
  }

  try {
    oldCollection = await collectionsModel.get({ name, version });
  } catch (error) {
    if (error.name !== 'RecordDoesNotExist') {
      throw error;
    }
    return res.boom.notFound(`Collection '${name}' version '${version}' not found`);
  }

  collection.updatedAt = Date.now();
  collection.createdAt = oldCollection.createdAt;

  const postgresCollection = translateApiCollectionToPostgresCollection(collection);

  try {
    await knex.transaction(async (trx) => {
      await collectionPgModel.upsert(trx, postgresCollection);
      dynamoRecord = await collectionsModel.create(collection);
      // process.env.ES_INDEX is only used to isolate the index for
      // each unit test suite
      await indexCollection(esClient, dynamoRecord, process.env.ES_INDEX);
    });
  } catch (error) {
    // Revert Dynamo record update if any write fails
    await collectionsModel.create(oldCollection);
    throw error;
  }

  return res.send(dynamoRecord);
}

/**
 * Delete a collection record
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function del(req, res) {
  const {
    collectionsModel = new models.Collection(),
    collectionPgModel = new CollectionPgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const { name, version } = req.params;

  let existingCollection;
  try {
    existingCollection = await collectionsModel.get({ name, version });
  } catch (error) {
    if (!(error instanceof RecordDoesNotExist)) {
      throw error;
    }
  }

  try {
    try {
      await knex.transaction(async (trx) => {
        await collectionPgModel.delete(trx, { name, version });
        await collectionsModel.delete({ name, version });
        const collectionId = constructCollectionId(name, version);
        await deleteCollection({
          esClient,
          collectionId,
          index: process.env.ES_INDEX,
          ignore: [404],
        });
      });
    } catch (innerError) {
      // Delete is idempotent, so there may not be a DynamoDB
      // record to recreate
      if (existingCollection) {
        await collectionsModel.create(existingCollection);
      }
      throw innerError;
    }
    return res.send({ message: 'Record deleted' });
  } catch (error) {
    log.debug(`Failed to delete collection with name ${name} and version ${version}. Error: ${JSON.stringify(error)}`);
    if (error instanceof AssociatedRulesError) {
      const message = `Cannot delete collection with associated rules: ${error.rules.join(', ')}`;
      return res.boom.conflict(message);
    }
    throw error;
  }
}

// express routes
router.get('/:name/:version', get);
router.put('/:name/:version', put);
router.delete('/:name/:version', del);
router.post('/', post);
router.get('/', list);
router.get('/active', activeList);

module.exports = {
  del,
  post,
  put,
  router,
};
