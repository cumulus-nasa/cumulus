'use strict';

import { Context } from 'aws-lambda';

const awsServerlessExpress = require('aws-serverless-express');
const express = require('express');

const app = express();

export interface HandlerEvent {
  env?: NodeJS.ProcessEnv
}

exports.handler = async (event: HandlerEvent, context: Context) => {
  await awsServerlessExpress.proxy(
    awsServerlessExpress.createServer(app),
    event,
    context,
    'PROMISE'
  ).promise;
};
