'use strict';

module.exports = {
  extends: '../../nyc.config.js',
  exclude: [
    'dist',
    'tests'
  ]
};
