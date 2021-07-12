'use strict';

const router = require('express-promise-router')();
const pick = require('lodash/pick');

const {
  AsyncOperationPgModel,
  getKnexClient,
  translateApiAsyncOperationToPostgresAsyncOperation,
  translatePostgresAsyncOperationToApiAsyncOperation,
} = require('@cumulus/db');
const {
  RecordDoesNotExist,
  ValidationError,
} = require('@cumulus/errors');
const {
  indexAsyncOperation,
} = require('@cumulus/es-client/indexer');

const Logger = require('@cumulus/logger');

const { Search } = require('@cumulus/es-client/search');
const { deleteAsyncOperation } = require('@cumulus/es-client/indexer');
const { AsyncOperation: AsyncOperationModel } = require('../models');
const { isBadRequestError } = require('../lib/errors');

const logger = new Logger({ sender: '@cumulus/api/asyncOperations' });

async function list(req, res) {
  const search = new Search(
    { queryStringParameters: req.query },
    'asyncOperation',
    process.env.ES_INDEX
  );

  const response = await search.query();
  return res.send(response);
}

/**
 * Returns an express response containing the requested AsyncOperation
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function getAsyncOperation(req, res) {
  const knex = await getKnexClient();
  const asyncOperationPgModel = new AsyncOperationPgModel();
  let asyncOperationRecord;

  try {
    asyncOperationRecord = await asyncOperationPgModel.get(knex, { id: req.params.id });
  } catch (error) {
    if (error instanceof RecordDoesNotExist) return res.boom.notFound(`Async Operation Record ${req.params.id} Not Found`);
    throw error;
  }
  const asyncOperation = translatePostgresAsyncOperationToApiAsyncOperation(asyncOperationRecord);

  return res.send(pick(asyncOperation, ['id', 'status', 'taskArn', 'description', 'operationType', 'output']));
}

/**
 * Delete an async operation
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function del(req, res) {
  const {
    asyncOperationModel = new AsyncOperationModel(),
    asyncOperationPgModel = new AsyncOperationPgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const { id } = req.params || {};

  if (!id) {
    return res.boom.badRequest('id parameter is missing');
  }

  let existingAsyncOperation;
  try {
    existingAsyncOperation = await asyncOperationModel.get({ id });
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound('No record found');
    }
    throw error;
  }

  try {
    await knex.transaction(async (trx) => {
      await asyncOperationPgModel.delete(trx, { id });
      await asyncOperationModel.delete({ id });
      await deleteAsyncOperation({
        esClient,
        id,
        index: process.env.ES_INDEX,
        ignore: [404],
      });
    });
  } catch (error) {
    // Delete is idempotent, so there may not be a DynamoDB
    // record to recreate
    if (existingAsyncOperation) {
      await asyncOperationModel.create(existingAsyncOperation);
    }
    throw error;
  }

  return res.send({ message: 'Record deleted' });
}

/**
 * Creates a new async operation
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function post(req, res) {
  const {
    asyncOperationModel = new AsyncOperationModel({
      stackName: process.env.stackName,
      systemBucket: process.env.system_bucket,
      tableName: process.env.AsyncOperationsTable,
    }),
    asyncOperationPgModel = new AsyncOperationPgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const apiAsyncOperation = req.body;

  apiAsyncOperation.createdAt = Date.now();
  apiAsyncOperation.updatedAt = Date.now();

  try {
    if (!apiAsyncOperation.id) {
      throw new ValidationError('Async Operations require an ID');
    }
    if (await asyncOperationModel.exists({ id: apiAsyncOperation.id })) {
      return res.boom.conflict(`A DynamoDb record already exists for async operation ID ${apiAsyncOperation.id}`);
    }
    const dbRecord = translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation);
    let dynamoDbRecord;

    try {
      logger.debug(`Attempting to create async operation ${dbRecord.id}`);
      await knex.transaction(async (trx) => {
        await asyncOperationPgModel.create(trx, dbRecord);
        dynamoDbRecord = await asyncOperationModel.create(apiAsyncOperation);
        await indexAsyncOperation(esClient, dynamoDbRecord, process.env.ES_INDEX);
      });
    } catch (innerError) {
      // Clean up DynamoDB async operation record in case of any failure
      await asyncOperationModel.delete({ id: apiAsyncOperation.id });
      throw innerError;
    }
    logger.info(`Successfully created async operation ${dbRecord.id}:`);
    return res.send({
      message: 'Record saved',
      record: dynamoDbRecord,
    });
  } catch (error) {
    if (isBadRequestError(error)) {
      return res.boom.badRequest(error.message);
    }

    logger.error('Error occurred while trying to create async operation:', error);
    return res.boom.badImplementation(error.message);
  }
}

router.get('/', list);
router.get('/:id', getAsyncOperation);
router.delete('/:id', del);
router.post('/', post);

module.exports = {
  del,
  post,
  router,
};
