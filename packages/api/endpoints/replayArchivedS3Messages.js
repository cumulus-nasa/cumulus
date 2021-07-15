'use strict';

const asyncOperations = require('@cumulus/async-operations');
const Logger = require('@cumulus/logger');
const router = require('express-promise-router')();

const AsyncOperation = require('../models/async-operation');
const { asyncOperationEndpointErrorHandler } = require('../app/middleware');

const logger = new Logger({ sender: '@cumulus/api/replay-archived-messages' });
async function startArchivedMessagesReplay(req, res) {
  const stackName = process.env.stackName;
  const systemBucket = process.env.system_bucket;

  const asyncOperationModel = new AsyncOperation({ stackName, systemBucket });

  const payload = req.body;
  logger.debug(`Payload is ${JSON.stringify(payload)}`);

  if (!payload.type) {
    return res.boom.badRequest('replay type is required');
  }

  if (payload.type === 'sqs' && !payload.queueName) {
    return res.boom.badRequest('queueName is required for archived S3 messages replay');
  }
  logger.debug('Starting async operation');
  const asyncOperation = await asyncOperations.startAsyncOperation({
    asyncOperationTaskDefinition: process.env.AsyncOperationTaskDefinition,
    cluster: process.env.EcsCluster,
    description: 'Archived Messages Replay',
    dynamoTableName: asyncOperationModel.tableName,
    knexConfig: process.env,
    lambdaName: process.env.ReplayArchivedS3MessagesLambda,
    operationType: 'Archived S3 Messages Replay',
    payload,
    stackName,
    systemBucket,
    useLambdaEnvironmentVariables: true,
  }, AsyncOperation);
  return res.status(202).send({ asyncOperationId: asyncOperation.id });
}

router.post('/', startArchivedMessagesReplay, asyncOperationEndpointErrorHandler);

module.exports = router;
