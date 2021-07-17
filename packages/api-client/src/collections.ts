import {
  CollectionRecord,
  NewCollectionRecord,
} from '@cumulus/types/api/collections';
import { invokeApi } from './cumulusApiClient';
import { ApiGatewayLambdaHttpProxyResponse, InvokeApiFunction } from './types';

/**
 * POST /collections
 *
 * @param {Object} params              - params
 * @param {string} params.prefix       - the prefix configured for the stack
 * @param {Object} params.collection   - collection object to add to the database
 * @param {Function} params.callback   - async function to invoke the api lambda
 *                                     that takes a prefix / user payload.  Defaults
 *                                     to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}          - the response from the callback
 */
export const createCollection = async (params: {
  prefix: string,
  collection: NewCollectionRecord,
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, collection, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'POST',
      resource: '/{proxy+}',
      headers: { 'Content-Type': 'application/json' },
      path: '/collections',
      body: JSON.stringify(collection),
    },
  });
};

/**
 * DELETE /collections/{collectionName}/{collectionVersion}
 *
 * @param {Object} params                     - params
 * @param {string} params.prefix              - the prefix configured for the stack
 * @param {Object} params.collectionVersion   - name of collection to delete
 * @param {Object} params.collectionName      - version of collection to delete
 * @param {Function} params.callback          - async function to invoke the api lambda
 *                                            that takes a prefix / user payload.  Defaults
 *                                            to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}                 - the response from the callback
 */
export const deleteCollection = async (params: {
  prefix: string,
  collectionName: string,
  collectionVersion: string,
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const {
    prefix,
    collectionName,
    collectionVersion,
    callback = invokeApi,
  } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'DELETE',
      resource: '/{proxy+}',
      path: `/collections/${collectionName}/${collectionVersion}`,
    },
  });
};

/**
 * Get a collection from Cumulus via the API lambda
 * GET /collections/{vollectionName}/{collectionVersion}
 *
 * @param {Object} params                     - params
 * @param {string} params.prefix              - the prefix configured for the stack
 * @param {Object} params.collectionVersion   - name of collection to get
 * @param {Object} params.collectionName      - version of collection to get
 * @param {Function} params.callback          - async function to invoke the api lambda
 *                                              that takes a prefix / user payload.  Defaults
 *                                              to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}                 - the response from the callback
 */
export const getCollection = async (params: {
  prefix: string,
  collectionName: string,
  collectionVersion: string,
  callback?: InvokeApiFunction
}): Promise<CollectionRecord> => {
  const {
    prefix,
    collectionName,
    collectionVersion,
    callback = invokeApi,
  } = params;

  const returnedCollection = await callback({
    prefix,
    payload: {
      httpMethod: 'GET',
      resource: '/{proxy+}',
      path: `/collections/${collectionName}/${collectionVersion}`,
    },
  });

  return JSON.parse(returnedCollection.body);
};

/**
 * Get a list of collections from Cumulus via the API lambda
 * GET /collections
 *
 * @param {Object} params                     - params
 * @param {string} params.prefix              - the prefix configured for the stack
 * @param {Function} params.callback          - async function to invoke the api lambda
 *                                              that takes a prefix / user payload.  Defaults
 *                                              to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}                 - the response from the callback
 */
export const getCollections = async (params: {
  prefix: string,
  query?: { [key: string]: string },
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, query, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'GET',
      resource: '/{proxy+}',
      path: '/collections/',
      queryStringParameters: query,
    },
  });
};
