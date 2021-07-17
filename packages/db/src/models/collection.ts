import Knex from 'knex';

import { BasePgModel } from './base';
import { tableNames } from '../tables';

import { PostgresCollection, PostgresCollectionRecord } from '../types/collection';
import { updatedAtRange } from '../types/record';

class CollectionPgModel extends BasePgModel<PostgresCollection, PostgresCollectionRecord> {
  constructor() {
    super({
      tableName: tableNames.collections,
    });
  }

  /**
   * Fetches multiple items from Postgres
   *
   * @param {Knex | Knex.Transaction} knexOrTransaction - DB client or transaction
   * @param {Partial<RecordType>} params - An object or any portion of an object of type RecordType
   * @param {updatedAtRange} updatedAtParams - An object with Date search bounds for updatedAt
   * @returns {Promise<PostgresCollectionRecord[]>} List of returned records
   */
  async searchWithUpdatedAtRange(
    knexOrTransaction: Knex | Knex.Transaction,
    params: Partial<PostgresCollection>,
    updatedAtParams: updatedAtRange
  ): Promise<PostgresCollectionRecord[]> {
    const records: Array<PostgresCollectionRecord> = await knexOrTransaction(this.tableName)
      .where((builder) => {
        builder.where(params);
        if (updatedAtParams.updatedAtFrom || updatedAtParams.updatedAtTo) {
          builder.whereBetween('updated_at', [
            updatedAtParams?.updatedAtFrom ?? new Date(0),
            updatedAtParams?.updatedAtTo ?? new Date(),
          ]);
        }
      });
    return records;
  }

  upsert(
    knexOrTransaction: Knex | Knex.Transaction,
    collection: PostgresCollection
  ) {
    return knexOrTransaction(this.tableName)
      .insert(collection)
      .onConflict(['name', 'version'])
      .merge()
      .returning('cumulus_id');
  }
}

export { CollectionPgModel };
