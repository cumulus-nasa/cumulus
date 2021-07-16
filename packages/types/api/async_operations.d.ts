export type AsyncOperationStatus = 'RUNNING' | 'SUCCEEDED' | 'RUNNER_FAILED' | 'TASK_FAILED';

export type AsyncOperationType = 'Migration Count Report' | 'Dead-Letter Processing' | 'ES Index' | 'Bulk Granules' | 'Bulk Granule Reingest' | 'Bulk Granule Delete' | 'Kinesis Replay' | 'Reconciliation Report' | 'Archived S3 Messages Replay';

export interface ApiAsyncOperation {
  id: string
  description: string
  operationType: AsyncOperationType
  status: AsyncOperationStatus
  taskArn?: string
  output?: string
  createdAt?: number
  updatedAt?: number
}
