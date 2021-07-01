'use strict';

const path = require('path');
const { IgnorePlugin } = require('webpack');
// path to module root
const root = path.resolve(__dirname);

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
  'tedious',
];

module.exports = {
  mode: process.env.PRODUCTION ? 'production' : 'development',
  entry: './index.js',
  output: {
    libraryTarget: 'commonjs2',
    filename: 'index.js',
    devtoolModuleFilenameTemplate: (info) => {
      const relativePath = path.relative(root, info.absoluteResourcePath);
      return `webpack://${relativePath}`;
    },
  },
  externals: [
    'aws-sdk',
    'electron',
    { formidable: 'url' },
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
              cacheDirectory: true,
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
  devtool: 'inline-source-map',
  target: 'node',
  node: {
    __dirname: false,
  },
  // https://github.com/webpack/webpack/issues/196#issuecomment-620227719
  stats: {
    warningsFilter: [
      /critical dependency:/i,
    ],
  },
  plugins: [
    new IgnorePlugin(new RegExp(`^(${ignoredPackages.join('|')})$`)),
  ],
  optimization: {
    nodeEnv: false,
  },
};
