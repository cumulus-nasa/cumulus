export type RuleType = 'kinesis' | 'onetime' | 'scheduled' | 'sns' | 'sqs';

export type RuleState = 'ENABLED' | 'DISABLED';

export interface Rule {
  type: RuleType,
  arn?: string,
  logEventArn?: string
  value?: string,
}

export interface RuleMeta {
  retries?: number,
  visibility?: number,
  [key: string]: unknown
}

export interface PartialRuleRecord {
  name?: string,
  rule?: Rule,
  state?: RuleState,
  workflow?: string,
  collection?: {
    name: string,
    version: string
  },
  meta?: RuleMeta,
  payload?: unknown,
  provider?: string,
  executionNamePrefix?: string,
  queueUrl?: string,
  tags?: string[],
}

export interface NewRuleRecord extends PartialRuleRecord {
  name: string,
  workflow: string,
  rule: Rule,
  state: RuleState
}

export interface RuleRecord extends NewRuleRecord {
  createdAt: number,
  updatedAt: number
}
