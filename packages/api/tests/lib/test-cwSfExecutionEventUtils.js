'use strict';

const test = require('ava');
const rewire = require('rewire');
const cwSfExecutionEventUtils = rewire('../../lib/cwSfExecutionEventUtils');
const {
  getCumulusMessageFromExecutionEvent,
  getFailedExecutionMessage
} = cwSfExecutionEventUtils;

test('getFailedExecutionMessage() returns the Cumulus message from the output of the last failed step', async (t) => {
  const inputMessage = {
    cumulus_meta: {
      state_machine: 'arn:aws:states:us-east-1:111122223333:stateMachine:HelloWorld-StateMachine',
      execution_name: 'my-execution-name'
    }
  };

  const failedTaskOutput = { a: 1 };

  const result = await cwSfExecutionEventUtils.__with__({
    StepFunctions: {
      getExecutionHistory: ({ executionArn }) => {
        if (executionArn !== 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name') {
          throw new Error(`Expected executionArn === 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name' but got ${executionArn}`);
        }
        return {
          events: [
            {
              // lastStepFailedEvent
              type: 'LambdaFunctionFailed',
              id: 1
            },
            {
              // failedStepExitedEvent
              type: 'TaskStateExited',
              previousEventId: 1,
              stateExitedEventDetails: {
                output: JSON.stringify(failedTaskOutput)
              },
              resource: 'x'
            }
          ]
        };
      }
    }
  })(() => getFailedExecutionMessage(inputMessage));

  t.deepEqual(result, failedTaskOutput);
});

test('getFailedExecutionMessage() returns the input message if there is an error fetching the output of the last failed step', async (t) => {
  const inputMessage = { a: 1 };

  const actualResult = await getFailedExecutionMessage(inputMessage);

  t.deepEqual(actualResult, inputMessage);
});

test.todo('getFailedExecutionMessage() does ?something? when no ActivityFailed or LambdaFunctionFailed events are found in the execution history');

test('getFailedExecutionMessage() returns the input message with the details from the last failed step event in the exception field if the failed step exited event cannot be found', async (t) => {
  const inputMessage = {
    cumulus_meta: {
      state_machine: 'arn:aws:states:us-east-1:111122223333:stateMachine:HelloWorld-StateMachine',
      execution_name: 'my-execution-name'
    }
  };

  const actualResult = await cwSfExecutionEventUtils.__with__({
    StepFunctions: {
      getExecutionHistory: ({ executionArn }) => {
        if (executionArn !== 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name') {
          throw new Error(`Expected executionArn === 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name' but got ${executionArn}`);
        }
        return {
          events: [
            {
              // lastStepFailedEvent
              type: 'LambdaFunctionFailed',
              id: 1,
              lambdaFunctionFailedEventDetails: 'my-details'
            }
          ]
        };
      }
    }
  })(() => getFailedExecutionMessage(inputMessage));

  const expectedResult = {
    ...inputMessage,
    exception: 'my-details'
  };

  t.deepEqual(actualResult, expectedResult);
});

test('getFailedExecutionMessage() returns the input message with the details from the last failed lambda step event in the exception field if the failed step exited event cannot be found', async (t) => {
  const inputMessage = {
    cumulus_meta: {
      state_machine: 'arn:aws:states:us-east-1:111122223333:stateMachine:HelloWorld-StateMachine',
      execution_name: 'my-execution-name'
    }
  };

  const actualResult = await cwSfExecutionEventUtils.__with__({
    StepFunctions: {
      getExecutionHistory: ({ executionArn }) => {
        if (executionArn !== 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name') {
          throw new Error(`Expected executionArn === 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name' but got ${executionArn}`);
        }
        return {
          events: [
            {
              // lastStepFailedEvent
              type: 'LambdaFunctionFailed',
              id: 1,
              lambdaFunctionFailedEventDetails: 'my-details'
            }
          ]
        };
      }
    }
  })(() => getFailedExecutionMessage(inputMessage));

  const expectedResult = {
    ...inputMessage,
    exception: 'my-details'
  };

  t.deepEqual(actualResult, expectedResult);
});

test('getFailedExecutionMessage() returns the input message with the details from the last failed activity step event in the exception field if the failed step exited event cannot be found', async (t) => {
  const inputMessage = {
    cumulus_meta: {
      state_machine: 'arn:aws:states:us-east-1:111122223333:stateMachine:HelloWorld-StateMachine',
      execution_name: 'my-execution-name'
    }
  };

  const actualResult = await cwSfExecutionEventUtils.__with__({
    StepFunctions: {
      getExecutionHistory: ({ executionArn }) => {
        if (executionArn !== 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name') {
          throw new Error(`Expected executionArn === 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name' but got ${executionArn}`);
        }
        return {
          events: [
            {
              // lastStepFailedEvent
              type: 'ActivityFailed',
              id: 1,
              activityFailedEventDetails: 'my-details'
            }
          ]
        };
      }
    }
  })(() => getFailedExecutionMessage(inputMessage));

  const expectedResult = {
    ...inputMessage,
    exception: 'my-details'
  };

  t.deepEqual(actualResult, expectedResult);
});

test('getCumulusMessageFromExecutionEvent() returns the event input for a RUNNING event', async (t) => {
  const event = {
    detail: {
      status: 'RUNNING',
      input: JSON.stringify({ a: 1 })
    }
  };

  const message = await getCumulusMessageFromExecutionEvent(event);

  const expectedMessage = {
    meta: {
      status: 'running'
    },
    a: 1
  };

  t.deepEqual(message, expectedMessage);
});

test('getCumulusMessageFromExecutionEvent() returns the event output for a SUCCEEDED event', async (t) => {
  const event = {
    detail: {
      status: 'SUCCEEDED',
      output: JSON.stringify({ a: 1 })
    }
  };

  const message = await getCumulusMessageFromExecutionEvent(event);

  const expectedMessage = {
    meta: {
      status: 'completed'
    },
    a: 1
  };

  t.deepEqual(message, expectedMessage);
});

test('getCumulusMessageFromExecutionEvent() returns the failed execution message for a failed event', async (t) => {
  const input = {
    cumulus_meta: {
      state_machine: 'arn:aws:states:us-east-1:111122223333:stateMachine:HelloWorld-StateMachine',
      execution_name: 'my-execution-name'
    }
  };

  const event = {
    detail: {
      status: 'FAILED',
      input: JSON.stringify(input)
    }
  };

  const failedTaskOutput = { a: 1 };

  const message = await cwSfExecutionEventUtils.__with__({
    StepFunctions: {
      getExecutionHistory: ({ executionArn }) => {
        if (executionArn !== 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name') {
          throw new Error(`Expected executionArn === 'arn:aws:states:us-east-1:111122223333:execution:HelloWorld-StateMachine:my-execution-name' but got ${executionArn}`);
        }
        return {
          events: [
            {
              // lastStepFailedEvent
              type: 'LambdaFunctionFailed',
              id: 1
            },
            {
              // failedStepExitedEvent
              type: 'TaskStateExited',
              previousEventId: 1,
              stateExitedEventDetails: {
                output: JSON.stringify(failedTaskOutput)
              },
              resource: 'x'
            }
          ]
        };
      }
    }
  })(() => getCumulusMessageFromExecutionEvent(event));

  const expectedMessage = {
    meta: {
      status: 'failed'
    },
    a: 1
  };

  t.deepEqual(message, expectedMessage);
});
