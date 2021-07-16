import {
  CumulusMessageError,
} from '@cumulus/errors';
import Logger from '@cumulus/logger';
import { Message } from '@cumulus/types';
import { ApiPdr } from '@cumulus/types/api/pdrs';

import { getCollectionIdFromMessage } from './Collections';
import {
  getMessageExecutionArn,
  getExecutionUrlFromArn,
} from './Executions';
import {
  getMessageProviderId,
} from './Providers';
import {
  getMetaStatus,
  getMessageWorkflowStartTime,
  getWorkflowDuration,
} from './workflows';

const logger = new Logger({ sender: '@cumulus/message/PDRs' });

interface PDR {
  name: string
  PANSent: boolean
  PANmessage: string
}

interface MessageWithOptionalPayloadPdr extends Message.CumulusMessage {
  payload: {
    pdr?: PDR
    failed?: unknown[]
    running?: unknown[]
    completed?: unknown[]
  }
}

interface PdrStats {
  processing: number
  completed: number
  failed: number
  total: number
}

/**
 * Get the PDR object from a workflow message, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message object
 * @returns {undefined|Object} The PDR object
 *
 * @alias module:PDRs
 */
export const getMessagePdr = (
  message: MessageWithOptionalPayloadPdr
): PDR | undefined => message.payload?.pdr;

/**
 * Determine if message has a PDR.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message object
 * @returns {boolean} true if message has a PDR
 *
 * @alias module:PDRs
 */
export const messageHasPdr = (
  message: MessageWithOptionalPayloadPdr
): boolean => getMessagePdr(message) !== undefined;

/**
 * Get the PAN sent status from a workflow message, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {boolean} The PAN sent status
 *
 * @alias module:PDRs
 */
export const getMessagePdrPANSent = (
  message: MessageWithOptionalPayloadPdr
): boolean => getMessagePdr(message)?.PANSent ?? false;

/**
 * Get the PAN message status from a workflow message, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {string} The PAN message
 *
 * @alias module:PDRs
 */
export const getMessagePdrPANMessage = (
  message: MessageWithOptionalPayloadPdr
): string => getMessagePdr(message)?.PANmessage ?? 'N/A';

/**
 * Get the PDR name from a workflow message, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {string} The PDR name
 *
 * @alias module:PDRs
 */
export const getMessagePdrName = (
  message: MessageWithOptionalPayloadPdr
): string | undefined => getMessagePdr(message)?.name;

/**
 * Get the number of running executions for a PDR, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {number} Number of running executions
 *
 * @alias module:PDRs
 */
export const getMessagePdrRunningExecutions = (
  message: MessageWithOptionalPayloadPdr
): number => (message.payload.running ?? []).length;

/**
 * Get the number of completed executions for a PDR, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {number} Number of completed executions
 *
 * @alias module:PDRs
 */
export const getMessagePdrCompletedExecutions = (
  message: MessageWithOptionalPayloadPdr
): number => (message.payload.completed ?? []).length;

/**
 * Get the number of failed executions for a PDR, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {number} Number of failed executions
 *
 * @alias module:PDRs
 */
export const getMessagePdrFailedExecutions = (
  message: MessageWithOptionalPayloadPdr
): number => (message.payload.failed ?? []).length;

/**
 * Get the PDR stats from a workflow message, if any.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message
 * @returns {PdrStats}
 *   Object tracking the status of executions triggered by the PDR
 *
 * @alias module:PDRs
 */
export const getMessagePdrStats = (
  message: MessageWithOptionalPayloadPdr
): PdrStats => {
  const processing = getMessagePdrRunningExecutions(message);
  const completed = getMessagePdrCompletedExecutions(message);
  const failed = getMessagePdrFailedExecutions(message);
  const stats = {
    processing,
    completed,
    failed,
    total: processing + completed + failed,
  };
  return stats;
};

/**
 * Get the percent completion of PDR executions
 *
 * @param {PdrStats} stats - Stats tracking PDR executions
 * @returns {number} Percent completion of PDR executions
 *
 * @alias module:PDRs
 */
export const getPdrPercentCompletion = (
  stats: PdrStats
): number => {
  let progress = 0;
  if (stats.processing > 0 && stats.total > 0) {
    progress = ((stats.total - stats.processing) / stats.total) * 100;
  } else if (stats.processing === 0 && stats.total > 0) {
    progress = 100;
  }
  return progress;
};

/**
 * Generate a PDR record for the API from the message.
 *
 * @param {MessageWithOptionalPayloadPdr} message - A workflow message object
 * @param {string} [updatedAt] - Optional updated timestamp to apply to record
 * @returns {ExecutionRecord} An PDR API record
 *
 * @alias module:Executions
 */
export const generatePdrApiRecordFromMessage = (
  message: MessageWithOptionalPayloadPdr,
  updatedAt = Date.now()
): ApiPdr | undefined => {
  const pdr = getMessagePdr(message);

  // We got a message with no PDR (OK)
  if (!pdr) {
    logger.info('No PDRs to process on the message');
    return undefined;
  }

  // We got a message with a PDR but no name to identify it (Not OK)
  if (!pdr.name) {
    throw new CumulusMessageError(`Could not find name on PDR object ${JSON.stringify(pdr)}`);
  }

  const collectionId = getCollectionIdFromMessage(message);
  if (!collectionId) {
    throw new CumulusMessageError('meta.collection required to generate a PDR record');
  }

  const providerId = getMessageProviderId(message);
  if (!providerId) {
    throw new CumulusMessageError('meta.provider required to generate a PDR record');
  }

  const status = getMetaStatus(message);
  if (!status) {
    throw new CumulusMessageError('meta.status required to generate a PDR record');
  }

  const arn = getMessageExecutionArn(message);
  if (!arn) {
    throw new CumulusMessageError('cumulus_meta.state_machine and cumulus_meta.execution_name required to generate a PDR record');
  }
  const execution = getExecutionUrlFromArn(arn);

  const stats = getMessagePdrStats(message);
  const progress = getPdrPercentCompletion(stats);
  const now = Date.now();
  const workflowStartTime = getMessageWorkflowStartTime(message);

  const record = {
    pdrName: pdr.name,
    collectionId,
    status,
    provider: providerId,
    progress,
    execution,
    PANSent: getMessagePdrPANSent(message),
    PANmessage: getMessagePdrPANMessage(message),
    stats,
    createdAt: getMessageWorkflowStartTime(message),
    timestamp: now,
    updatedAt,
    duration: getWorkflowDuration(workflowStartTime, now),
  };

  return record;
};
