'use strict';

/**
 * Utility functions for parsing granule information from a Cumulus message
 * @module Granules
 *
 * @example
 * const Granules = require('@cumulus/message/Granules');
 */

import isInteger from 'lodash/isInteger';
import isNil from 'lodash/isNil';
import omitBy from 'lodash/omitBy';

import { CumulusMessageError } from '@cumulus/errors';
import { Message } from '@cumulus/types';
import { ExecutionProcessingTimes } from '@cumulus/types/api/executions';
import { ApiGranule, GranuleStatus, MessageGranule } from '@cumulus/types/api/granules';
import { ApiFile } from '@cumulus/types/api/files';

import {
  getWorkflowDuration,
} from './workflows';
import { CmrUtilsClass } from './types';

interface MetaWithGranuleQueryFields extends Message.Meta {
  granule?: {
    queryFields?: unknown
  }
}

interface MessageWithGranules extends Message.CumulusMessage {
  meta: MetaWithGranuleQueryFields,
  payload: {
    granules?: object[]
  }
}

/**
 * Get granules from payload?.granules of a workflow message.
 *
 * @param {MessageWithGranules} message - A workflow message
 * @returns {Array<Object>|undefined} An array of granule objects, or
 *   undefined if `message.payload.granules` is not set
 *
 * @alias module:Granules
 */
export const getMessageGranules = (
  message: MessageWithGranules
): unknown[] => message.payload?.granules ?? [];

/**
 * Determine if message has a granules object.
 *
 * @param {MessageWithOptionalGranules} message - A workflow message object
 * @returns {boolean} true if message has a granules object
 *
 * @alias module:Granules
 */
export const messageHasGranules = (
  message: MessageWithGranules
): boolean => getMessageGranules(message).length !== 0;

/**
 * Determine the status of a granule.
 *
 * @param {string} workflowStatus - The workflow status
 * @param {MessageGranule} granule - A granule record
 * @returns {string} The granule status
 *
 * @alias module:Granules
 */
export const getGranuleStatus = (
  workflowStatus: Message.WorkflowStatus,
  granule: MessageGranule
): Message.WorkflowStatus | GranuleStatus => workflowStatus || granule.status;

/**
 * Get the query fields of a granule, if any
 *
 * @param {MessageWithGranules} message - A workflow message
 * @returns {unknown|undefined} The granule query fields, if any
 *
 * @alias module:Granules
 */
export const getGranuleQueryFields = (
  message: MessageWithGranules
) => message.meta?.granule?.queryFields;

/**
 * Calculate granule product volume, which is the sum of the file
 * sizes in bytes
 *
 * @param {Array<Object>} granuleFiles - array of granule files
 * @returns {Integer} - sum of granule file sizes in bytes
 */
export const getGranuleProductVolume = (granuleFiles: ApiFile[] = []): number => {
  if (granuleFiles.length === 0) return 0;
  return granuleFiles
    .map((f) => f.size ?? 0)
    .filter(isInteger)
    .reduce((x, y) => x + y, 0);
};

/* eslint-disable @typescript-eslint/camelcase */
export const getGranuleTimeToPreprocess = ({
  sync_granule_duration = 0,
} = {}) => sync_granule_duration / 1000;

export const getGranuleTimeToArchive = ({
  post_to_cmr_duration = 0,
} = {}) => post_to_cmr_duration / 1000;
/* eslint-enable @typescript-eslint/camelcase */

/**
 * Generate an API granule record
 *
 * @param {MessageWithGranules} message - A workflow message
 * @returns {Promise<ApiGranule>} The granule API record
 *
 * @alias module:Granules
 */
export const generateGranuleApiRecord = async ({
  granule,
  executionUrl,
  collectionId,
  provider,
  workflowStartTime,
  error,
  pdrName,
  workflowStatus,
  queryFields,
  updatedAt,
  granuleFiles,
  processingTimeInfo = {},
  cmrUtils,
}: {
  granule: MessageGranule,
  executionUrl?: string,
  collectionId: string,
  provider?: {
    id: string,
  },
  workflowStartTime: number,
  error?: Object,
  pdrName?: string,
  workflowStatus: GranuleStatus,
  queryFields?: Object,
  updatedAt?: string,
  processingTimeInfo?: ExecutionProcessingTimes,
  granuleFiles?: ApiFile[],
  cmrUtils: CmrUtilsClass
}): Promise<ApiGranule> => {
  if (!granule.granuleId) throw new CumulusMessageError(`Could not create granule record, invalid granuleId: ${granule.granuleId}`);

  if (!collectionId) {
    throw new CumulusMessageError('collectionId required to generate a granule record');
  }

  const {
    granuleId,
    cmrLink,
    published = false,
  } = granule;

  const now = Date.now();
  const temporalInfo = await cmrUtils.getGranuleTemporalInfo(granule);

  const record = {
    granuleId,
    pdrName,
    collectionId,
    status: getGranuleStatus(workflowStatus, granule),
    provider: provider?.id,
    execution: executionUrl,
    cmrLink,
    files: granuleFiles,
    error,
    published,
    createdAt: workflowStartTime,
    timestamp: now,
    updatedAt: updatedAt || now,
    duration: getWorkflowDuration(workflowStartTime, now),
    productVolume: getGranuleProductVolume(granuleFiles),
    timeToPreprocess: getGranuleTimeToPreprocess(granule),
    timeToArchive: getGranuleTimeToArchive(granule),
    ...processingTimeInfo,
    ...temporalInfo,
    queryFields,
  };

  return <ApiGranule>omitBy(record, isNil);
};
