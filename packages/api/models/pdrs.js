'use strict';

const {
  getMessageExecutionArn,
} = require('@cumulus/message/Executions');
const Logger = require('@cumulus/logger');
const pvl = require('@cumulus/pvl');

const Manager = require('./base');
const pdrSchema = require('./schemas').pdr;

const logger = new Logger({ sender: '@cumulus/api/models/pdrs' });

class Pdr extends Manager {
  constructor() {
    super({
      tableName: process.env.PdrsTable,
      tableHash: { name: 'pdrName', type: 'S' },
      schema: pdrSchema,
    });
  }

  /**
   * Generate PAN message
   *
   * @returns {string} the PAN message
   */
  static generatePAN() {
    return pvl.jsToPVL(
      new pvl.models.PVLRoot()
        .add('MESSAGE_TYPE', new pvl.models.PVLTextString('SHORTPAN'))
        .add('DISPOSITION', new pvl.models.PVLTextString('SUCCESSFUL'))
        .add('TIME_STAMP', new pvl.models.PVLDateTime(new Date()))
    );
  }

  /**
   * Generate a PDRD message with a given err
   *
   * @param {Object} err - the error object
   * @returns {string} the PDRD message
   */
  static generatePDRD(err) {
    return pvl.jsToPVL(
      new pvl.models.PVLRoot()
        .add('MESSAGE_TYPE', new pvl.models.PVLTextString('SHORTPDRD'))
        .add('DISPOSITION', new pvl.models.PVLTextString(err.message))
    );
  }

  /**
   * Try to store a PDR record.
   *
   * If the record already exists, only update if the execution is different (re-run case).
   *
   * @param {Object} pdrRecord - PDR record
   * @param {Object} cumulusMessage - Cumulus workflow message
   */
  async storePdr(pdrRecord, cumulusMessage) {
    if (!pdrRecord) return undefined;
    this.constructor.recordIsValid(pdrRecord, this.schema);

    logger.info(`About to write PDR ${pdrRecord.pdrName} to DynamoDB`);

    const updateParams = this.generatePdrUpdateParamsFromRecord(pdrRecord);

    // createdAt comes from cumulus_meta.workflow_start_time
    // records should *not* be updating from createdAt times that are *older* start
    // times than the existing record, whatever the status
    updateParams.ConditionExpression = '(attribute_not_exists(createdAt) or :createdAt >= #createdAt)';
    if (pdrRecord.status === 'running') {
      updateParams.ConditionExpression += ' and (execution <> :execution OR progress < :progress)';
    }
    try {
      const updateResponse = await this.dynamodbDocClient.update(updateParams).promise();
      logger.info(`Successfully wrote PDR ${pdrRecord.pdrName} to DynamoDB`);
      return updateResponse;
    } catch (error) {
      if (error.name && error.name.includes('ConditionalCheckFailedException')) {
        const executionArn = getMessageExecutionArn(cumulusMessage);
        logger.info(`Did not process delayed event for PDR: ${pdrRecord.pdrName} (execution: ${executionArn})`);
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Generate DynamoDB update parameters.
   *
   * @param {Object} pdrRecord - the PDR record
   * @returns {Object} DynamoDB update parameters
   */
  generatePdrUpdateParamsFromRecord(pdrRecord) {
    const mutableFieldNames = Object.keys(pdrRecord);
    const updateParams = this._buildDocClientUpdateParams({
      item: pdrRecord,
      itemKey: { pdrName: pdrRecord.pdrName },
      mutableFieldNames,
    });
    return updateParams;
  }

  /**
   * Only used for testing
   */
  async deletePdrs() {
    const pdrs = await this.scan();
    return await Promise.all(pdrs.Items.map((pdr) => super.delete({ pdrName: pdr.pdrName })));
  }
}

module.exports = Pdr;
