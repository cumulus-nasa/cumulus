import { Message } from '@cumulus/types';
import { GranuleTemporalInfo, MessageGranule } from '@cumulus/types/api/granules';

export interface WorkflowMessageTemplateCumulusMeta {
  queueExecutionLimits: Message.QueueExecutionLimits
}

// Minimal type to define the shape of the template
// used to prepare workflow messages
export interface WorkflowMessageTemplate {
  cumulus_meta: WorkflowMessageTemplateCumulusMeta
  meta: object
}

export interface Workflow {
  arn: string
  name: string
}

export interface CmrUtilsClass {
  getGranuleTemporalInfo(granule: MessageGranule): Promise<GranuleTemporalInfo>
}
