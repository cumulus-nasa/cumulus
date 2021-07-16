export type ExecutionRecordStatus = 'completed' | 'failed' | 'running' | 'unknown';

export type ExecutionProcessingTimes = {
  processingStartDateTime: string
  processingEndDateTime: string
} | {};

export interface ExecutionRecord {
  arn: string,
  createdAt: number,
  name: string
  status: ExecutionRecordStatus,
  asyncOperationId?: string,
  collectionId?: string,
  duration?: number,
  error?: object,
  execution?: string,
  finalPayload?: object,
  originalPayload?: object,
  parentArn?: string,
  tasks?: object,
  timestamp?: number,
  type?: string,
  updatedAt: number,
  cumulusVersion?: string,
}
