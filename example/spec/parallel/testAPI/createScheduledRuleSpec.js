'use strict';

const {
  addCollections,
  cleanupCollections,
  waitForTestExecutionStart,
} = require('@cumulus/integration-tests');

const rulesApi = require('@cumulus/api-client/rules');
const { deleteExecution, getExecution } = require('@cumulus/api-client/executions');

const {
  waitForApiStatus,
} = require('../../helpers/apiUtils');
const {
  createTestSuffix,
  createTimestampedTestId,
  loadConfig,
  timestampedName,
} = require('../../helpers/testUtils');

const SetupError = new Error('Test setup failed');

describe('When I create a scheduled rule via the Cumulus API', () => {
  let config;
  let execution;
  let scheduledRuleName;
  let scheduledHelloWorldRule;
  let testSuffix;
  let executionArn;
  let beforeAllError;

  const collectionsDir = './data/collections/s3_MOD09GQ_006';

  beforeAll(async () => {
    try {
      config = await loadConfig();
      process.env.stackName = config.stackName;

      const testId = createTimestampedTestId(config.stackName, 'Rule');
      testSuffix = createTestSuffix(testId);
      scheduledRuleName = timestampedName('SchedHelloWorldTest');
      scheduledHelloWorldRule = {
        name: scheduledRuleName,
        collection: { name: `MOD09GQ${testSuffix}`, version: '006' },
        workflow: 'HelloWorldWorkflow',
        rule: {
          type: 'scheduled',
          value: 'rate(2 minutes)',
        },
        meta: {
          triggerRule: scheduledRuleName,
        },
      };

      await addCollections(config.stackName, config.bucket, collectionsDir,
        testSuffix, testId);
      // Create a scheduled rule
      console.log(`creating rule ${scheduledRuleName}`);
      await rulesApi.postRule({
        prefix: config.stackName,
        rule: scheduledHelloWorldRule,
      });
    } catch (error) {
      beforeAllError = error;
    }
  });

  afterAll(async () => {
    await waitForApiStatus(
      getExecution,
      { prefix: config.stackName, arn: executionArn },
      'completed'
    );
    await deleteExecution({ prefix: config.stackName, executionArn });
    await cleanupCollections(config.stackName, config.bucket, collectionsDir,
      testSuffix);
  });

  beforeEach(() => {
    if (beforeAllError) fail(beforeAllError);
  });

  describe('The scheduled rule kicks off a workflow', () => {
    beforeAll(async () => {
      execution = await waitForTestExecutionStart({
        workflowName: scheduledHelloWorldRule.workflow,
        stackName: config.stackName,
        bucket: config.bucket,
        findExecutionFn: (taskInput, params) =>
          taskInput.meta.triggerRule && (taskInput.meta.triggerRule === params.ruleName),
        findExecutionFnParams: { ruleName: scheduledRuleName },
        startTask: 'HelloWorld',
      });

      executionArn = execution.executionArn;

      console.log(`Scheduled Execution ARN: ${execution.executionArn}`);
    });

    it('an execution record exists', () => {
      if (beforeAllError) throw SetupError;
      expect(execution).toBeDefined();
    });
  });

  describe('When the scheduled rule is deleted', () => {
    let subTestSetupError;

    beforeAll(async () => {
      try {
        console.log(`deleting rule ${scheduledHelloWorldRule.name}`);

        await rulesApi.deleteRule({
          prefix: config.stackName,
          ruleName: scheduledHelloWorldRule.name,
        });
      } catch (error) {
        subTestSetupError = error;
        throw error;
      }
    });

    beforeEach(() => {
      if (beforeAllError) fail(beforeAllError);
      if (subTestSetupError) fail(subTestSetupError);
    });

    it('does not kick off a scheduled workflow', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;

      waitForTestExecutionStart({
        workflowName: scheduledHelloWorldRule.workflow,
        stackName: config.stackName,
        bucket: config.bucket,
        findExecutionFn: (taskInput, params) =>
          taskInput.meta.triggerRule &&
          (taskInput.meta.triggerRule === params.ruleName) &&
          (taskInput.cumulus_meta.execution_name !== params.execution.name),
        findExecutionFnParams: { ruleName: scheduledRuleName, execution },
        startTask: 'HelloWorld',
      }).catch((error) =>
        expect(error.message).toEqual('Never found started workflow.'));
    });
  });
});
