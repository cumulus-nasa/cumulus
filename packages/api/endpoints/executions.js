'use strict';

const router = require('express-promise-router')();
const { RecordDoesNotExist } = require('@cumulus/errors');
const {
  getKnexClient,
  getApiGranuleExecutionCumulusIds,
  getApiGranuleCumulusIds,
  ExecutionPgModel,
  GranulesExecutionsPgModel,
  translatePostgresExecutionToApiExecution,
} = require('@cumulus/db');
const Search = require('@cumulus/es-client/search').Search;
const models = require('../models');
const { getGranulesForPayload } = require('../lib/granules');
const { validateGranuleExecutionRequest } = require('../lib/request');

/**
 * List and search executions
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function list(req, res) {
  const search = new Search(
    { queryStringParameters: req.query },
    'execution',
    process.env.ES_INDEX
  );
  const response = await search.query();
  return res.send(response);
}

/**
 * get a single execution
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function get(req, res) {
  const arn = req.params.arn;

  const e = new models.Execution();

  try {
    const response = await e.get({ arn });
    return res.send(response);
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound(`No record found for ${arn}`);
    }
    throw error;
  }
}

/**
 * Delete an execution
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function del(req, res) {
  const {
    executionModel = new models.Execution(),
    executionPgModel = new ExecutionPgModel(),
    knex = await getKnexClient(),
  } = req.testContext || {};

  const { arn } = req.params;

  try {
    await executionModel.get({ arn });
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound('No record found');
    }
    throw error;
  }

  await knex.transaction(async (trx) => {
    await executionPgModel.delete(trx, { arn });
    await executionModel.delete({ arn });
  });

  return res.send({ message: 'Record deleted' });
}

/**
 * Get execution history for a single granule or multiple granules
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function searchByGranules(req, res) {
  const payload = req.body;
  const knex = await getKnexClient();
  const granules = await getGranulesForPayload(payload, knex);
  const { page = 1, limit = 1, ...sortParams } = req.query;

  const offset = page < 1 ? 0 : (page - 1) * limit;

  const executionPgModel = new ExecutionPgModel();

  const executionCumulusIds = await getApiGranuleExecutionCumulusIds(knex, granules);

  const executions = await executionPgModel
    .searchByCumulusIds(knex, executionCumulusIds, { limit, offset, ...sortParams });

  const apiExecutions = await Promise.all(executions
    .map((execution) => translatePostgresExecutionToApiExecution(execution)));

  return res.send(apiExecutions);
}

/**
 * Get workflows for a single granule or intersection of workflows for multiple granules
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function workflowsByGranules(req, res) {
  const payload = req.body;
  const knex = await getKnexClient();
  const granules = await getGranulesForPayload(payload, knex);

  const granulesExecutionsPgModel = new GranulesExecutionsPgModel();

  const granuleCumulusIds = await getApiGranuleCumulusIds(knex, granules);

  const workflowNames = await granulesExecutionsPgModel
    .getWorkflowNameJoin(knex, granuleCumulusIds);

  return res.send(workflowNames);
}

router.post('/search-by-granules', validateGranuleExecutionRequest, searchByGranules);
router.post('/workflows-by-granules', validateGranuleExecutionRequest, workflowsByGranules);
router.get('/:arn', get);
router.get('/', list);
router.delete('/:arn', del);

module.exports = router;
