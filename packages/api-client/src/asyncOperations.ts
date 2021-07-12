import { ApiAsyncOperation } from '@cumulus/types/api/async_operations';
import { invokeApi } from './cumulusApiClient';
import { InvokeApiFunction, ApiGatewayLambdaHttpProxyResponse } from './types';

/**
 * Get /asyncOperations/{asyncOperationId}
 *
 * @param {Object} params              - params
 * @param {string} params.prefix       - the prefix configured for the stack
 * @param {Object} params.asyncOperationId - the async operation id
 * @param {Function} params.callback   - async function to invoke the api lambda
 *                                     that takes a prefix / user payload.  Defaults
 *                                     to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}          - the response from the callback
 */
export const getAsyncOperation = async (params: {
  prefix: string,
  asyncOperationId: string,
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, asyncOperationId, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'GET',
      resource: '/{proxy+}',
      path: `/asyncOperations/${asyncOperationId}`,
    },
  });
};

/**
 * DELETE /asyncOperations/{asyncOperationId}
 *
 * @param {Object} params              - params
 * @param {string} params.prefix       - the prefix configured for the stack
 * @param {Object} params.asyncOperationId - the async operation id
 * @param {Function} params.callback   - async function to invoke the api lambda
 *                                     that takes a prefix / user payload.  Defaults
 *                                     to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}          - the response from the callback
 */
export const deleteAsyncOperation = async (params: {
  prefix: string,
  asyncOperationId: string,
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, asyncOperationId, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'DELETE',
      resource: '/{proxy+}',
      path: `/asyncOperations/${asyncOperationId}`,
    },
  });
};

/**
 * Query  async operations stored in cumulus
 * GET /asyncOperations
 * @param {Object} params             - params
 * @param {string} [params.query]     - query to pass the API lambda
 * @param {Function} params.callback  - async function to invoke the api lambda
 *                                      that takes a prefix / user payload.  Defaults
 *                                      to cumulusApiClient.invokeApifunction to invoke the
 *                                      api lambda
 * @returns {Promise<Object>}         - the response from the callback
 */
export const listAsyncOperations = async (params: {
  prefix: string,
  query?: {
    fields?: string[],
    [key: string]: string | string[] | undefined
  },
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, query, callback = invokeApi } = params;

  return await callback({
    prefix: prefix,
    payload: {
      httpMethod: 'GET',
      resource: '/{proxy+}',
      path: '/asyncOperations',
      queryStringParameters: query,
    },
  });
};

/**
 * Create an async operation via the API
 * POST /asyncOperations
 *
 * @param {Object} params                  - params
 * @param {string} params.prefix           - the prefix configured for the stack
 * @param {Object} params.asyncOperation   - asyncOperation object
 * @param {Function} params.callback       - function to invoke the api lambda
 *                                           that takes a prefix / user payload
 * @returns {Promise<Object>}              - promise that resolves to the output of the callback
 */
export const createAsyncOperation = async (params: {
  prefix: string,
  asyncOperation: ApiAsyncOperation,
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, asyncOperation, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'POST',
      resource: '/{proxy+}',
      headers: { 'Content-Type': 'application/json' },
      path: '/asyncOperations',
      body: JSON.stringify(asyncOperation),
    },
  });
};
