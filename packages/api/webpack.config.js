'use strict';

const CopyPlugin = require('copy-webpack-plugin');
const path = require('path');
const { IgnorePlugin } = require('webpack');

const ignoredPackages = [
  'mssql',
  'mssql/lib/base',
  'mssql/package.json',
  'mysql',
  'mysql2',
  'oracledb',
  'pg-native',
  'pg-query-stream',
  'sqlite3',
  'tedious'
];

const root = path.resolve(__dirname);

module.exports = {
  mode: process.env.PRODUCTION ? 'production' : 'development',
  entry: {
    app: './app/index.js',
    bootstrap: './lambdas/bootstrap.js',
    bulkOperation: './lambdas/bulk-operation.js',
    cleanExecutions: './lambdas/cleanExecutions.js',
    createReconciliationReport: './lambdas/create-reconciliation-report.js',
    dbIndexer: './lambdas/db-indexer.js',
    distribution: './app/distribution.js',
    executeMigrations: './lambdas/executeMigrations.js',
    granuleFilesCacheUpdater: './lambdas/granuleFilesCacheUpdater.js',
    indexFromDatabase: './lambdas/index-from-database.js',
    manualConsumer: './lambdas/manual-consumer.js',
    messageConsumer: './lambdas/message-consumer.js',
    payloadLogger: './lambdas/payload-logger.js',
    processDeadLetterArchive: './lambdas/process-s3-dead-letter-archive.js',
    publishCollections: './lambdas/publish-collections.js',
    publishExecutions: './lambdas/publish-executions.js',
    publishGranules: './lambdas/publish-granules.js',
    publishPdrs: './lambdas/publish-pdrs.js',
    replayArchivedS3Messages: './lambdas/replay-archived-s3-messages.js',
    sfEventSqsToDbRecords: './lambdas/sf-event-sqs-to-db-records/index.js',
    sfScheduler: './lambdas/sf-scheduler.js',
    sfSemaphoreDown: './lambdas/sf-semaphore-down.js',
    sfStarter: './lambdas/sf-starter.js',
    sqsMessageConsumer: './lambdas/sqs-message-consumer.js',
    writeDbDlqRecordstoS3: './lambdas/write-db-dlq-records-to-s3.js',
  },
  devtool: 'inline-source-map',
  resolve: {
    alias: {
      'saml2-js': 'saml2-js/lib-js/saml2.js',
      ejs: 'ejs/ejs.min.js',
      underscore: 'underscore/underscore.js',
      handlebars: 'handlebars/dist/handlebars.js'
    }
  },
  plugins: [
    // templates to use saml2.js, dependency problem with xml-encryption package
    new CopyPlugin({
      patterns: [
        {
          from: 'node_modules/xml-encryption/lib/templates',
          to: 'app/templates'
        },
        {
          from: 'app/data/distribution/templates',
          to: 'distribution/templates'
        }
      ]
    }),
    new IgnorePlugin(new RegExp(`^(${ignoredPackages.join('|')})$`)),
  ],
  output: {
    libraryTarget: 'commonjs2',
    filename: '[name]/index.js',
    devtoolModuleFilenameTemplate: (info) => {
      const relativePath = path.relative(root, info.absoluteResourcePath);
      return `webpack://${relativePath}`;
    }
  },
  externals: [
    'aws-sdk',
    'electron',
    { formidable: 'url' },
    { fsevents: "require('fsevents')" }
  ],
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'babel-loader',
            options: {
              cacheDirectory: true
            },
          },
        ],
      },
      {
        test: /\.html$/i,
        loader: 'html-loader',
      },
    ],
  },
  target: 'node',
  node: {
    __dirname: false,
    __filename: false
  },
  optimization: {
    nodeEnv: false
  }
};
