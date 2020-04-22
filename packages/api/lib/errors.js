'use strict';

const { createErrorType } = require('@cumulus/errors');

module.exports.TokenUnauthorizedUserError = createErrorType('TokenUnauthorizedUserError');
module.exports.IndexExistsError = createErrorType('IndexExistsError');

class AssociatedRulesError extends Error {
  constructor(message, rules = []) {
    super(message);
    this.rules = rules;
    this.name = this.constructor.name;
  }
}
exports.AssociatedRulesError = AssociatedRulesError;
