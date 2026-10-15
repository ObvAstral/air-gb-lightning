import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraction } from './interpret.js';
import type { ExtractedConstraints } from '../../packages/contracts/types.js';

const base: ExtractedConstraints = { schemaVersion: '1.0', status: 'parsed', feeLimit: null, excludedNodeReferences: [], priority: null, privacyRequest: null, unhandledRequests: [] };
test('schema, JSON e controlli semantici', () => {
  assert.throws(() => parseExtraction('', 'x'));
  assert.throws(() => parseExtraction('{', 'x'));
  assert.throws(() => parseExtraction(JSON.stringify({ ...base, send: true }), 'x'));
  assert.throws(() => parseExtraction(JSON.stringify({ ...base, feeLimit: { value: '10', unit: 'sat', comparison: 'lte' } }), 'massimo 5 sat'));
  assert.throws(() => parseExtraction(JSON.stringify({ ...base, excludedNodeReferences: ['Bob'] }), 'non voglio evitare Bob'));
  assert.throws(() => parseExtraction(JSON.stringify({ ...base, feeLimit: { value: '10', unit: 'sat', comparison: 'lte' } }), 'massimo 5 sat e massimo 10 sat'));
  assert.equal(parseExtraction(JSON.stringify({ ...base, feeLimit: { value: '10', unit: 'sat', comparison: 'lte' } }), 'massimo 10 sat').feeLimit?.value, '10');
});
