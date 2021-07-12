import { RuleType, RuleMeta } from '@cumulus/types/api/rules';

export interface PostgresRule {
  name: string,
  workflow: string,
  type: RuleType,
  enabled: boolean,
  collection_cumulus_id?: number,
  provider_cumulus_id?: number,
  execution_name_prefix?: string,
  value?: string,
  arn?: string,
  log_event_arn?: string,
  payload?: object,
  meta?: RuleMeta,
  tags?: string,
  queue_url?: string,
  created_at: Date | undefined,
  updated_at: Date | undefined,
}

export interface PostgresRuleRecord extends PostgresRule {
  cumulus_id: number,
  created_at: Date,
  updated_at: Date,
}
