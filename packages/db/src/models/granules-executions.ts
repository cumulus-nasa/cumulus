import Knex from 'knex';

import { isRecordDefined } from '../database';
import { tableNames } from '../tables';

import { PostgresGranuleExecution } from '../types/granule-execution';

export default class GranulesExecutionsPgModel {
  readonly tableName: tableNames;

  // can't extend base class because type for this data doesn't contain
  // a cumulus_id property
  constructor() {
    this.tableName = tableNames.granulesExecutions;
  }

  async create(
    knexTransaction: Knex.Transaction,
    item: PostgresGranuleExecution
  ) {
    return await knexTransaction(this.tableName).insert(item);
  }

  async exists(
    knexTransaction: Knex.Transaction,
    item: PostgresGranuleExecution
  ) {
    return isRecordDefined(await knexTransaction(this.tableName).where(item).first());
  }

  async upsert(
    knexTransaction: Knex.Transaction,
    item: PostgresGranuleExecution
  ) {
    return await knexTransaction(this.tableName)
      .insert(item)
      .onConflict(['granule_cumulus_id', 'execution_cumulus_id'])
      .merge();
  }

  /**
   * Get execution_cumulus_id column values from the granule_cumulus_id
   *
   * @param {Knex | Knex.Transaction} knexOrTransaction -
   *  DB client or transaction
   * @param {number | Array<number>} granuleCumulusIds -
   * single granule_cumulus_id or array of granule_cumulus_ids
   * @returns {Promise<Array<number>>} An array of execution_cumulus_ids
   */
  async searchByGranuleCumulusIds(
    knexOrTransaction: Knex | Knex.Transaction,
    granuleCumulusIds: Array<number> | number
  ): Promise<Array<number>> {
    const granuleCumulusIdsArray = [granuleCumulusIds].flat();
    const granuleExecutions = await knexOrTransaction(this.tableName)
      .select('execution_cumulus_id')
      .whereIn('granule_cumulus_id', granuleCumulusIdsArray)
      .groupBy('execution_cumulus_id');
    return granuleExecutions.map((granuleExecution) => granuleExecution.execution_cumulus_id);
  }

  async getWorkflowNameJoin(
    knexOrTransaction: Knex | Knex.Transaction,
    granuleCumulusIds: Array<number> | number
  ): Promise<Array<Object>> {
    const granuleCumulusIdsArray = [granuleCumulusIds].flat();
    const numberOfGranules = granuleCumulusIdsArray.length;
    const { executions: executionsTable, granules: granulesTable } = tableNames;

    const aggregatedWorkflowCounts = await knexOrTransaction(this.tableName)
      .select('workflow_name')
      .count('*')
      .innerJoin(executionsTable, `${this.tableName}.execution_cumulus_id`, `${executionsTable}.cumulus_id`)
      .innerJoin(granulesTable, `${this.tableName}.granule_cumulus_id`, `${granulesTable}.cumulus_id`)
      .whereIn('granule_cumulus_id', granuleCumulusIdsArray)
      .groupBy('workflow_name');
    return aggregatedWorkflowCounts
      .filter((workflowCounts) => Number(workflowCounts.count) === numberOfGranules)
      .map((workflowCounts) => workflowCounts.workflow_name);
  }

  search(
    knexTransaction: Knex | Knex.Transaction,
    query: Partial<PostgresGranuleExecution>
  ) {
    return knexTransaction<PostgresGranuleExecution>(this.tableName)
      .where(query);
  }
}

export { GranulesExecutionsPgModel };
