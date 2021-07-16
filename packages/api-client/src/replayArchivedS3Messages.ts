import { invokeApi } from './cumulusApiClient';
import { ApiGatewayLambdaHttpProxyResponse, InvokeApiFunction } from './types';

/**
 * POST a request to start replaying archived S3 Messages
 *
 * @param {Object} params              - params
 * @param {string} params.prefix       - the prefix configured for the stack
 * @param {string} params.queueName    - name of queue to queue archived messages
 * @param {Function} params.callback   - async function to invoke the api lambda
 *                                       that takes a prefix / user payload.  Defaults
 *                                       to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}          - promise that resolves to the output
 *                                       of the API lambda
 */
export const postReplayArchivedMessages = async (params: {
  prefix: string,
  queueName: string,
  callback?: InvokeApiFunction,
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, queueName, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'POST',
      resource: '/{proxy+}',
      headers: {
        'Content-Type': 'application/json',
      },
      path: `/replayArchivedS3Messages/${queueName}`,
    },
  });
};
