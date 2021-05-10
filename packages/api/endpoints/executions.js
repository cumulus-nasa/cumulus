'use strict';

const router = require('express-promise-router')();
const { RecordDoesNotExist } = require('@cumulus/errors');
const {
  getKnexClient,
  ExecutionPgModel,
} = require('@cumulus/db');

const Search = require('../es/search').Search;

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

  const knex = await getKnexClient({ env: process.env });
  const executionPgModel = new ExecutionPgModel();
  try {
    const response = await executionPgModel.get(knex, { arn });
    return res.send(response);
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound(`No record found for ${arn}`);
    }
    throw error;
  }
}

router.get('/:arn', get);
router.get('/', list);

module.exports = router;
