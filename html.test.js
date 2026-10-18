// Run with: node --test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml } = require('./html.js');

test('escapeHtml escapes the five characters that matter', () => {
  assert.equal(escapeHtml('<b a="1" b=\'2\'>&</b>'), '&lt;b a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;&lt;/b&gt;');
});

test('escapeHtml leaves ordinary text alone and handles non-strings', () => {
  assert.equal(escapeHtml('Dune: Part Two'), 'Dune: Part Two');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(4.5), '4.5');
});

test('escapeHtml does not double-escape on a second pass the way people expect', () => {
  assert.equal(escapeHtml(escapeHtml('&')), '&amp;amp;');
});
