const test = require('ava');

const {
  fakeAsyncOperationRecordFactory,
} = require('../../dist/test-utils');
const { randomString } = require('../../../api/node_modules/@cumulus/common/test-utils');
const {
  translateApiAsyncOperationToPostgresAsyncOperation,
  translatePostgresAsyncOperationToApiAsyncOperation,
} = require('../../dist/translate/async_operations');
test('translateApiAsyncOperationToPostgresAsyncOperation converts a camelCase record to snake_case', (t) => {
  const apiAsyncOperation = {
    id: '1234567890',
    status: 'RUNNING',
    taskArn: 'aws:arn:ecs:task:someTask',
    description: 'dummy operation',
    operationType: 'ES Index',
  };

  const expected = {
    id: apiAsyncOperation.id,
    status: apiAsyncOperation.status,
    task_arn: apiAsyncOperation.taskArn,
    description: apiAsyncOperation.description,
    operation_type: apiAsyncOperation.operationType,
  };

  t.deepEqual(translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation), expected);
});

test('translateApiAsyncOperationToPostgresAsyncOperation parses output from JSON stringified object to object', (t) => {
  const operationOutput = {
    esIndex: 'test-index',
    operationStatus: 'complete',
  };
  const apiAsyncOperation = {
    id: '1234567890',
    status: 'SUCCEEDED',
    taskArn: 'aws:arn:ecs:task:someTask',
    description: 'dummy operation',
    operationType: 'ES Index',
    output: JSON.stringify(operationOutput),
  };

  const expected = {
    id: apiAsyncOperation.id,
    status: apiAsyncOperation.status,
    task_arn: apiAsyncOperation.taskArn,
    description: apiAsyncOperation.description,
    operation_type: apiAsyncOperation.operationType,
    output: operationOutput,
  };
  t.deepEqual(translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation), expected);
});

test('translateApiAsyncOperationToPostgresAsyncOperation parses output from JSON stringified string to object', (t) => {
  const operationOutput = '\"Index from database complete\"';
  const apiAsyncOperation = {
    id: '1234567890',
    status: 'SUCCEEDED',
    taskArn: 'aws:arn:ecs:task:someTask',
    description: 'dummy operation',
    operationType: 'ES Index',
    output: operationOutput,
  };

  const expected = {
    id: apiAsyncOperation.id,
    status: apiAsyncOperation.status,
    task_arn: apiAsyncOperation.taskArn,
    description: apiAsyncOperation.description,
    operation_type: apiAsyncOperation.operationType,
    output: { output: JSON.parse(operationOutput) },
  };

  t.deepEqual(translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation), expected);
});

test('translateApiAsyncOperationToPostgresAsyncOperation parses output from string to object', (t) => {
  const operationOutput = 'some-string';
  const apiAsyncOperation = {
    id: '1234567890',
    status: 'SUCCEEDED',
    taskArn: 'aws:arn:ecs:task:someTask',
    description: 'dummy operation',
    operationType: 'ES Index',
    output: operationOutput,
  };

  const expected = {
    id: apiAsyncOperation.id,
    status: apiAsyncOperation.status,
    task_arn: apiAsyncOperation.taskArn,
    description: apiAsyncOperation.description,
    operation_type: apiAsyncOperation.operationType,
    output: { output: operationOutput },
  };
  const translatedAsyncOp = translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation);
  t.deepEqual(translatedAsyncOp, expected);
});

test('translateApiAsyncOperationToPostgresAsyncOperation parses output from JSON stringified array to object', (t) => {
  const operationOutput = JSON.stringify(['some-string', 'other-string']);
  const apiAsyncOperation = {
    id: '1234567890',
    status: 'SUCCEEDED',
    taskArn: 'aws:arn:ecs:task:someTask',
    description: 'dummy operation',
    operationType: 'ES Index',
    output: operationOutput,
  };

  const expected = {
    id: apiAsyncOperation.id,
    status: apiAsyncOperation.status,
    task_arn: apiAsyncOperation.taskArn,
    description: apiAsyncOperation.description,
    operation_type: apiAsyncOperation.operationType,
    output: { output: JSON.parse(operationOutput) },
  };
  const translatedAsyncOp = translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation);
  t.deepEqual(translatedAsyncOp, expected);
});
test('translateApiAsyncOperationToPostgresAsyncOperation discards \'none\' output', (t) => {
  const apiAsyncOperation = {
    id: '1234567890',
    status: 'SUCCEEDED',
    taskArn: 'aws:arn:ecs:task:someTask',
    description: 'dummy operation',
    operationType: 'ES Index',
    output: 'none',
  };

  const expected = {
    id: apiAsyncOperation.id,
    status: apiAsyncOperation.status,
    task_arn: apiAsyncOperation.taskArn,
    description: apiAsyncOperation.description,
    operation_type: apiAsyncOperation.operationType,
  };

  t.deepEqual(translateApiAsyncOperationToPostgresAsyncOperation(apiAsyncOperation), expected);
});

test('translatePostgresAsyncOperationToApiAsyncOperation translates PostgreSQL record to async operation API record', async (t) => {
  const id = randomString();
  const taskArn = randomString();
  const createdAt = new Date();
  const updatedAt = new Date();
  const description = 'Some async run';
  const pgAsyncOperation = fakeAsyncOperationRecordFactory({
    id,
    task_arn: taskArn,
    created_at: createdAt,
    updated_at: updatedAt,
    description,
  });

  const expectedAsyncOperation = {
    id,
    status: 'RUNNING',
    taskArn,
    description,
    operationType: 'ES Index',
    output: JSON.stringify({ test: 'output' }),
    createdAt: createdAt.getTime(),
    updatedAt: updatedAt.getTime(),
  };
  const translation = await translatePostgresAsyncOperationToApiAsyncOperation(pgAsyncOperation);
  t.deepEqual(translation, expectedAsyncOperation);
});
