'use strict';

const test = require('ava');

const {
  getMessagePdr,
  messageHasPdr,
  getPdrPANSent,
  getPdrPANMessage,
} = require('../PDRs');

test('getMessagePdr returns correct PDR object', (t) => {
  const pdr = {
    foo: 'bar',
  };
  t.deepEqual(getMessagePdr({
    payload: {
      pdr,
    },
  }), pdr);
});

test('getMessagePdr returns undefined if there is no PDR', (t) => {
  t.is(getMessagePdr({
    payload: {},
  }), undefined);
});

test('messageHasPdr correctly returns true if there is a PDR', (t) => {
  const pdr = {
    foo: 'bar',
  };
  t.true(messageHasPdr({
    payload: {
      pdr,
    },
  }));
});

test('messageHasPdr correct returns false if there is no PDR', (t) => {
  t.false(messageHasPdr({
    payload: {},
  }));
});

test('getPdrPANSent returns correct value', (t) => {
  t.true(getPdrPANSent({
    PANSent: true,
  }));
  t.false(getPdrPANSent({
    PANSent: false,
  }));
});

test('getPdrPANSent returns false if there is no PANsent value', (t) => {
  t.false(getPdrPANSent({}));
});

test('getPdrPANMessage returns correct value', (t) => {
  const PANmessage = 'message';
  t.is(getPdrPANMessage({
    PANmessage,
  }), PANmessage);
});

test('getPdrPANMessage returns "N/A" if there is no PANMessage value', (t) => {
  t.is(getPdrPANMessage({}), 'N/A');
});
