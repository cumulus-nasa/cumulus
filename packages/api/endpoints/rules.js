'use strict';

const router = require('express-promise-router')();
const { RecordDoesNotExist } = require('@cumulus/errors');
const Logger = require('@cumulus/logger');

const {
  getKnexClient,
  RulePgModel,
  translateApiRuleToPostgresRule,
  translatePostgresRuleToApiRule,
} = require('@cumulus/db');
const { Search } = require('@cumulus/es-client/search');
const { indexRule, deleteRule } = require('@cumulus/es-client/indexer');

const { isBadRequestError } = require('../lib/errors');
const models = require('../models');

const log = new Logger({ sender: '@cumulus/api/rules' });

/**
 * List all rules.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function list(req, res) {
  const search = new Search(
    { queryStringParameters: req.query },
    'rule',
    process.env.ES_INDEX
  );
  const response = await search.query();
  return res.send(response);
}

/**
 * Query a single rule.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function get(req, res) {
  const name = req.params.name;

  const {
    rulePgModel = new RulePgModel(),
    knex = await getKnexClient(),
  } = req.testContext || {};
  try {
    const rule = await rulePgModel.get(knex, { name });
    const result = await translatePostgresRuleToApiRule(rule);
    return res.send(result);
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound('No record found');
    }
    throw error;
  }
}

/**
 * Creates a new rule
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function post(req, res) {
  const {
    ruleModel = new models.Rule(),
    rulePgModel = new RulePgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  let record;
  const apiRule = req.body || {};
  const name = apiRule.name;

  if (await ruleModel.exists(name)) {
    return res.boom.conflict(`A record already exists for ${name}`);
  }

  try {
    apiRule.createdAt = Date.now();
    apiRule.updatedAt = Date.now();
    const postgresRule = await translateApiRuleToPostgresRule(apiRule, knex);

    try {
      await knex.transaction(async (trx) => {
        await rulePgModel.create(trx, postgresRule);
        record = await ruleModel.create(apiRule);
        await indexRule(esClient, record, process.env.ES_INDEX);
      });
    } catch (innerError) {
      // Clean up DynamoDB record in case of any failure
      await ruleModel.delete(apiRule);
      throw innerError;
    }
    return res.send({ message: 'Record saved', record });
  } catch (error) {
    if (isBadRequestError(error)) {
      return res.boom.badRequest(error.message);
    }
    log.error('Error occurred while trying to create rule:', error);
    return res.boom.badImplementation(error.message);
  }
}

/**
 * Replaces an existing rule.
 *
 * @param {Object} req - express request object
 * @param {string} req.params.name - name of the rule to replace
 * @param {Object} req.body - complete replacement rule
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object, which
 *    is a Bad Request (400) if the rule's name property does not match the
 *    name request parameter, or a Not Found (404) if there is no existing rule
 *    with the specified name
 */
async function put(req, res) {
  const {
    ruleModel = new models.Rule(),
    rulePgModel = new RulePgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const { params: { name }, body } = req;

  const apiRule = { ...body };
  let newRule;

  if (name !== apiRule.name) {
    return res.boom.badRequest(`Expected rule name to be '${name}', but found`
      + ` '${body.name}' in payload`);
  }

  try {
    const oldRule = await ruleModel.get({ name });

    apiRule.updatedAt = Date.now();
    apiRule.createdAt = oldRule.createdAt;

    // If rule type is onetime no change is allowed unless it is a rerun
    if (apiRule.action === 'rerun') {
      return models.Rule.invoke(oldRule).then(() => res.send(oldRule));
    }

    const fieldsToDelete = Object.keys(oldRule).filter(
      (key) => !(key in apiRule) && key !== 'createdAt'
    );
    const postgresRule = await translateApiRuleToPostgresRule(apiRule, knex);

    try {
      await knex.transaction(async (trx) => {
        await rulePgModel.upsert(trx, postgresRule);
        newRule = await ruleModel.update(oldRule, apiRule, fieldsToDelete);
        await indexRule(esClient, newRule, process.env.ES_INDEX);
      });
    } catch (innerError) {
      // Revert Dynamo record update if any write fails
      await ruleModel.create(oldRule);
      throw innerError;
    }

    return res.send(newRule);
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound(`Rule '${name}' not found`);
    }

    throw error;
  }
}

/**
 * deletes a rule
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function del(req, res) {
  const {
    ruleModel = new models.Rule(),
    rulePgModel = new RulePgModel(),
    knex = await getKnexClient(),
    esClient = await Search.es(),
  } = req.testContext || {};

  const name = (req.params.name || '').replace(/%20/g, ' ');

  let apiRule;
  try {
    apiRule = await ruleModel.get({ name });
  } catch (error) {
    if (error instanceof RecordDoesNotExist) {
      return res.boom.notFound('No record found');
    }
    throw error;
  }

  try {
    await knex.transaction(async (trx) => {
      await rulePgModel.delete(trx, { name });
      await ruleModel.delete(apiRule);
      await deleteRule({
        esClient,
        name,
        index: process.env.ES_INDEX,
        ignore: [404],
      });
    });
  } catch (error) {
    // Delete is idempotent, so there may not be a DynamoDB
    // record to recreate
    if (apiRule) {
      await ruleModel.create(apiRule);
    }
    throw error;
  }

  return res.send({ message: 'Record deleted' });
}

router.get('/:name', get);
router.get('/', list);
router.put('/:name', put);
router.post('/', post);
router.delete('/:name', del);

module.exports = {
  router,
  post,
  put,
  del,
};
