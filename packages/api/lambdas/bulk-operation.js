const elasticsearch = require('@elastic/elasticsearch');
const get = require('lodash/get');
const pMap = require('p-map');

const log = require('@cumulus/common/log');
const { RecordDoesNotExist } = require('@cumulus/errors');
const { GranulePgModel, getKnexClient } = require('@cumulus/db');

const GranuleModel = require('../models/granules');
const { deleteGranuleAndFiles } = require('../lib/granule-delete');
const { unpublishGranule } = require('../lib/granule-remove-from-cmr');

const SCROLL_SIZE = 500; // default size in Kibana

/**
 * Return a unique list of granule IDs based on the provided list or the response from the
 * query to ES using the provided query and index.
 *
 * @param {Object} payload
 * @param {Object} [payload.query] - Optional parameter of query to send to ES
 * @param {string} [payload.index] - Optional parameter of ES index to query.
 * Must exist if payload.query exists.
 * @param {Object} [payload.ids] - Optional list of granule IDs to bulk operate on
 * @returns {Promise<Array<string>>}
 */
async function getGranuleIdsForPayload(payload) {
  const granuleIds = payload.ids || [];

  // query ElasticSearch if needed
  if (granuleIds.length === 0 && payload.query) {
    log.info('No granule ids detected. Searching for granules in Elasticsearch.');

    if (!process.env.METRICS_ES_HOST
        || !process.env.METRICS_ES_USER
        || !process.env.METRICS_ES_PASS) {
      throw new Error('ELK Metrics stack not configured');
    }

    const query = payload.query;
    const index = payload.index;
    const responseQueue = [];

    const esUrl = `https://${process.env.METRICS_ES_USER}:${
      process.env.METRICS_ES_PASS}@${process.env.METRICS_ES_HOST}`;
    const client = new elasticsearch.Client({
      node: esUrl,
    });

    const searchResponse = await client.search({
      index: index,
      scroll: '30s',
      size: SCROLL_SIZE,
      _source: ['granuleId'],
      body: query,
    });

    responseQueue.push(searchResponse);

    while (responseQueue.length) {
      const { body } = responseQueue.shift();

      body.hits.hits.forEach((hit) => {
        granuleIds.push(hit._source.granuleId);
      });
      if (body.hits.total.value !== granuleIds.length) {
        responseQueue.push(
          // eslint-disable-next-line no-await-in-loop
          await client.scroll({
            scrollId: body._scroll_id,
            scroll: '30s',
          })
        );
      }
    }
  }

  // Remove duplicate Granule IDs
  // TODO: could we get unique IDs from the query directly?
  const uniqueGranuleIds = [...new Set(granuleIds)];
  return uniqueGranuleIds;
}

function applyWorkflowToGranules({
  granuleIds,
  workflowName,
  meta,
  queueName,
}) {
  const granuleModelClient = new GranuleModel();

  const applyWorkflowRequests = granuleIds.map(async (granuleId) => {
    try {
      const granule = await granuleModelClient.get({ granuleId });
      await granuleModelClient.applyWorkflow(
        granule,
        workflowName,
        meta,
        queueName,
        process.env.asyncOperationId
      );
      return granuleId;
    } catch (error) {
      return { granuleId, err: error };
    }
  });
  return Promise.all(applyWorkflowRequests);
}

// FUTURE: the Dynamo Granule is currently the primary record driving the
// "unpublish from CMR" logic.
// This should be switched to pgGranule once the postgres
// reads are implemented.

/**
 * Bulk delete granules based on either a list of granules (IDs) or the query response from
 * ES using the provided query and index.
 *
 * @param {Object} payload
 * @param {boolean} [payload.forceRemoveFromCmr]
 *   Whether published granule should be deleted from CMR before removal
 * @param {Object} [payload.query] - Optional parameter of query to send to ES
 * @param {string} [payload.index] - Optional parameter of ES index to query.
 * Must exist if payload.query exists.
 * @param {Object} [payload.ids] - Optional list of granule IDs to bulk operate on
 * @returns {Promise}
 */
async function bulkGranuleDelete(payload) {
  const granuleIds = await getGranuleIdsForPayload(payload);
  const granuleModel = new GranuleModel();
  const granulePgModel = new GranulePgModel();
  const forceRemoveFromCmr = payload.forceRemoveFromCmr === true;
  const knex = await getKnexClient({ env: process.env });
  const deletedGranules = [];
  await pMap(
    granuleIds,
    async (granuleId) => {
      let dynamoGranule;
      let pgGranule;

      // Try to get the Dynamo record. If it cannot be found, just log
      // the error and skip it.
      try {
        dynamoGranule = await granuleModel.getRecord({ granuleId });
      } catch (error) {
        if (error instanceof RecordDoesNotExist) {
          log.info(`Granule ${granuleId} does not exist or was already deleted, continuing`);
          return;
        }
        throw error;
      }

      // Try to get the PG record. If it cannot be found, ignore it and
      // move along to unpublishing and deleting only the Dynamo record.
      // If another error is thrown, throw it here.
      try {
        pgGranule = await granulePgModel.get(knex, { granule_id: granuleId });
      } catch (error) {
        if (!(error instanceof RecordDoesNotExist)) {
          throw error;
        }
      }

      // Using the Dynamo record as the primary source, unpublish it from
      // CMR if it's published and we need to force-remove it.
      let updateResponse;

      if (dynamoGranule && dynamoGranule.published && forceRemoveFromCmr) {
        updateResponse = await unpublishGranule(knex, dynamoGranule);
      }

      // Delete the Dynamo Granule, the Postgres Granule (if one was found),
      // and associated files.
      await deleteGranuleAndFiles({
        knex,
        dynamoGranule: updateResponse ? updateResponse.dynamoGranule : dynamoGranule,
        pgGranule: updateResponse ? updateResponse.pgGranule : pgGranule,
      });

      deletedGranules.push(granuleId);
    },
    {
      concurrency: 10, // is this necessary?
      stopOnError: false,
    }
  );
  return { deletedGranules };
}

/**
 * Bulk apply workflow to either a list of granules (IDs) or to a list of responses from
 * ES using the provided query and index.
 *
 * @param {Object} payload
 * @param {string} payload.workflowName - name of the workflow that will be applied to each granule.
 * @param {Object} [payload.meta] - Optional meta to add to workflow input
 * @param {string} [payload.queueName] - Optional name of queue that will be used to start workflows
 * @param {Object} [payload.query] - Optional parameter of query to send to ES
 * @param {string} [payload.index] - Optional parameter of ES index to query.
 * Must exist if payload.query exists.
 * @param {Object} [payload.ids] - Optional list of granule IDs to bulk operate on
 * @returns {Promise}
 */
async function bulkGranule(payload) {
  const { queueName, workflowName, meta } = payload;
  const granuleIds = await getGranuleIdsForPayload(payload);
  return applyWorkflowToGranules({ granuleIds, workflowName, meta, queueName });
}

async function bulkGranuleReingest(payload) {
  const granuleIds = await getGranuleIdsForPayload(payload);
  const granuleModel = new GranuleModel();
  return pMap(
    granuleIds,
    async (granuleId) => {
      try {
        const granule = await granuleModel.getRecord({ granuleId });
        await granuleModel.reingest(granule, process.env.asyncOperationId);
        return granuleId;
      } catch (error) {
        log.debug(`Granule ${granuleId} encountered an error`, error);
        return { granuleId, err: error };
      }
    },
    {
      concurrency: 10,
      stopOnError: false,
    }
  );
}

function setEnvVarsForOperation(event) {
  const envVars = get(event, 'envVars', {});
  Object.keys(envVars).forEach((envVarKey) => {
    if (!process.env[envVarKey]) {
      process.env[envVarKey] = envVars[envVarKey];
    }
  });
}

async function handler(event) {
  setEnvVarsForOperation(event);
  log.info(`bulkOperation asyncOperationId ${process.env.asyncOperationId} event type ${event.type}`);
  if (event.type === 'BULK_GRANULE') {
    return bulkGranule(event.payload);
  }
  if (event.type === 'BULK_GRANULE_DELETE') {
    return bulkGranuleDelete(event.payload);
  }
  if (event.type === 'BULK_GRANULE_REINGEST') {
    return bulkGranuleReingest(event.payload);
  }
  // throw an appropriate error here
  throw new TypeError(`Type ${event.type} could not be matched, no operation attempted.`);
}

module.exports = {
  getGranuleIdsForPayload,
  handler,
};
