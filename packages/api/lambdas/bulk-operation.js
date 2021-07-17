const get = require('lodash/get');
const pMap = require('p-map');

const log = require('@cumulus/common/log');
const { RecordDoesNotExist } = require('@cumulus/errors');
const { CollectionPgModel, GranulePgModel, getKnexClient } = require('@cumulus/db');
const { Search } = require('@cumulus/es-client/search');

const { deconstructCollectionId } = require('../lib/utils');
const GranuleModel = require('../models/granules');
const { deleteGranuleAndFiles } = require('../src/lib/granule-delete');
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

    const query = payload.query;
    const index = payload.index;
    const responseQueue = [];

    const client = await Search.es(undefined, true);
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

async function applyWorkflowToGranules({
  granuleIds,
  workflowName,
  meta,
  queueUrl,
  granuleModel = new GranuleModel(),
}) {
  const applyWorkflowRequests = granuleIds.map(async (granuleId) => {
    try {
      const granule = await granuleModel.get({ granuleId });
      await granuleModel.applyWorkflow(
        granule,
        workflowName,
        meta,
        queueUrl,
        process.env.asyncOperationId
      );
      return granuleId;
    } catch (error) {
      return { granuleId, err: error };
    }
  });
  return await Promise.all(applyWorkflowRequests);
}

/**
 * Fetch a Postgres Granule by granule and collection IDs
 *
 * @param {Knex } knex - DB client
 * @param {string} granuleId - Granule ID
 * @param {string} collectionId - Collection ID in "name___version" format
 * @returns {Promise<PostgresGranuleRecord|undefined>}
 *   The fetched Postgres Granule, if any exists
 * @private
 */
async function _getPgGranuleByCollection(knex, granuleId, collectionId) {
  const granulePgModel = new GranulePgModel();
  const collectionPgModel = new CollectionPgModel();

  let pgGranule;

  try {
    const collectionCumulusId = await collectionPgModel.getRecordCumulusId(
      knex,
      deconstructCollectionId(collectionId)
    );

    pgGranule = granulePgModel.get(
      knex,
      {
        granule_id: granuleId,
        collection_cumulus_id: collectionCumulusId,
      }
    );
  } catch (error) {
    if (!(error instanceof RecordDoesNotExist)) {
      throw error;
    }
  }

  return pgGranule;
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
 * @param {Function} [unpublishGranuleFunc] - Optional function to delete the
 * granule from CMR. Useful for testing.
 * @returns {Promise}
 */
async function bulkGranuleDelete(
  payload,
  unpublishGranuleFunc = unpublishGranule
) {
  const deletedGranules = [];
  const forceRemoveFromCmr = payload.forceRemoveFromCmr === true;
  const granuleIds = await getGranuleIdsForPayload(payload);
  const granuleModel = new GranuleModel();
  const knex = await getKnexClient({ env: process.env });

  await pMap(
    granuleIds,
    async (granuleId) => {
      let dynamoGranule;
      let pgGranule;

      try {
        dynamoGranule = await granuleModel.getRecord({ granuleId });
      } catch (error) {
        if (error instanceof RecordDoesNotExist) {
          log.info(`Granule ${granuleId} does not exist or was already deleted, continuing`);
          return;
        }
        throw error;
      }

      if (dynamoGranule && dynamoGranule.published && forceRemoveFromCmr) {
        ({ pgGranule, dynamoGranule } = await unpublishGranuleFunc(knex, dynamoGranule));
      }

      await deleteGranuleAndFiles({
        knex,
        dynamoGranule,
        pgGranule: pgGranule || await _getPgGranuleByCollection(
          knex, granuleId, dynamoGranule.collectionId
        ),
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
 * @param {string} [payload.queueUrl] - Optional name of queue that will be used to start workflows
 * @param {Object} [payload.query] - Optional parameter of query to send to ES
 * @param {string} [payload.index] - Optional parameter of ES index to query.
 * Must exist if payload.query exists.
 * @param {Object} [payload.ids] - Optional list of granule IDs to bulk operate on
 * @returns {Promise}
 */
async function bulkGranule(payload) {
  const { queueUrl, workflowName, meta } = payload;
  const granuleIds = await getGranuleIdsForPayload(payload);
  return await applyWorkflowToGranules({ granuleIds, workflowName, meta, queueUrl });
}

async function bulkGranuleReingest(payload) {
  const granuleIds = await getGranuleIdsForPayload(payload);
  log.info(`Starting bulkGranuleReingest for ${JSON.stringify(granuleIds)}`);

  const granuleModel = new GranuleModel();
  return await pMap(
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
    return await bulkGranule(event.payload);
  }
  if (event.type === 'BULK_GRANULE_DELETE') {
    return await bulkGranuleDelete(event.payload);
  }
  if (event.type === 'BULK_GRANULE_REINGEST') {
    return await bulkGranuleReingest(event.payload);
  }
  // throw an appropriate error here
  throw new TypeError(`Type ${event.type} could not be matched, no operation attempted.`);
}

module.exports = {
  applyWorkflowToGranules,
  bulkGranuleDelete,
  getGranuleIdsForPayload,
  handler,
};
