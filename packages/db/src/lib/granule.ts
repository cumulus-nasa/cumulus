import Knex from 'knex';

import { PostgresGranule } from '../types/granule';
import { CollectionPgModel } from '../models/collection';
import { GranulePgModel } from '../models/granule';
import { GranulesExecutionsPgModel } from '../models/granules-executions';

const { deconstructCollectionId } = require('@cumulus/message/Collections');

/**
 * Upsert a granule and a record in the granules/executions join table.
 *
 * @param {Knex.Transaction} knexTransaction - A Knex client transaction
 * @param {PostgresGranule} granule - Granule data
 * @param {number} [executionCumulusId] - Execution record cumulus_id value
 * @param {Object} [granulePgModel] - Granule PG model class instance
 * @param {Object} [granulesExecutionsPgModel]
 *   Granules/executions PG model class instance
 * @returns {Promise<number[]>}
 */
export const upsertGranuleWithExecutionJoinRecord = async (
  knexTransaction: Knex.Transaction,
  granule: PostgresGranule,
  executionCumulusId?: number,
  granulePgModel = new GranulePgModel(),
  granulesExecutionsPgModel = new GranulesExecutionsPgModel()
): Promise<number[]> => {
  const [granuleCumulusId] = await granulePgModel.upsert(
    knexTransaction,
    granule,
    executionCumulusId
  );
  // granuleCumulusId could be undefined if the upsert affected no rows due to its
  // conditional logic. In that case, we assume that the execution history for the
  // granule was already written and return early. Execution history cannot be written
  // without granuleCumulusId regardless.
  if (!granuleCumulusId) {
    return [];
  }
  if (executionCumulusId) {
    await granulesExecutionsPgModel.upsert(
      knexTransaction,
      {
        granule_cumulus_id: granuleCumulusId,
        execution_cumulus_id: executionCumulusId,
      }
    );
  }
  return [granuleCumulusId];
};

/**
 * Get cumulus IDs for list of granules
 *
 * @param {Knex | Knex.Transaction} knexOrTransaction -
 *  DB client or transaction
 * @param {Array<Object>} granules - array of granules with collectionId and granuleId
 * @param {Object} [collectionPgModel] - Collection PG model class instance
 * @param {Object} [granulePgModel] - Granule PG model class instance
 * @returns {Promise<number[]>}
 */
export const getApiGranuleCumulusIds = async (
  knexOrTransaction: Knex | Knex.Transaction,
  granules: Array<{ collectionId: string, granuleId: string }>,
  collectionPgModel = new CollectionPgModel(),
  granulePgModel = new GranulePgModel()
) => {
  const collectionMap: {[key: string]: number} = {};

  const granuleCumulusIds: Array<number> = await Promise.all(granules.map(async (granule) => {
    const { collectionId } = granule;
    let collectionCumulusId = collectionMap[collectionId];

    if (!collectionCumulusId) {
      const { name, version } = deconstructCollectionId(collectionId);
      collectionCumulusId = await collectionPgModel.getRecordCumulusId(
        knexOrTransaction,
        { name, version }
      );
      collectionMap[collectionId] = collectionCumulusId;
    }

    return await granulePgModel.getRecordCumulusId(knexOrTransaction, {
      granule_id: granule.granuleId,
      collection_cumulus_id: collectionCumulusId,
    });
  }));
  return granuleCumulusIds;
};

/**
 * Get cumulus IDs for all executions associated to a set of granules
 *
 * @param {Knex | Knex.Transaction} knexOrTransaction -
 *  DB client or transaction
 * @param {Array<Object>} granules - array of granules with collectionId and granuleId
 * @param {Object} [collectionPgModel] - Collection PG model class instance
 * @param {Object} [granulePgModel] - Granule PG model class instance
 * @param {Object} [granulesExecutionsPgModel]
 *   Granules/executions PG model class instance
 * @returns {Promise<number[]>}
 */
export const getApiGranuleExecutionCumulusIds = async (
  knexOrTransaction: Knex | Knex.Transaction,
  granules: Array<{ collectionId: string, granuleId: string }>,
  collectionPgModel = new CollectionPgModel(),
  granulePgModel = new GranulePgModel(),
  granulesExecutionsPgModel = new GranulesExecutionsPgModel()
): Promise<Array<number>> => {
  const granuleCumulusIds = await getApiGranuleCumulusIds(
    knexOrTransaction, granules, collectionPgModel, granulePgModel
  );
  const executionCumulusIds = await granulesExecutionsPgModel
    .searchByGranuleCumulusIds(knexOrTransaction, granuleCumulusIds);

  return executionCumulusIds;
};
