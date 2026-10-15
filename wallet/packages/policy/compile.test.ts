import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileConstraints, feeToMsat, validNodeId, fingerprint } from './compile.js';
import type { ExtractedConstraints, RoutingCapabilities } from '../contracts/types.js';

const caps: RoutingCapabilities = { backendVersion: 'none', revision: '0', hardFeeCap: false, hardNodeExclusion: false, hardChannelExclusion: false, perPaymentScoringProfile: false, avoidExtraProbing: false, canInspectFullRoute: false, canGuaranteeConstraintsAcrossRetries: false };
const payment = { invoice: 'lntb-test', amount: '1000', assetId: 'BTC', network: 'regtest' as const };
const base: ExtractedConstraints = { schemaVersion: '1.0', status: 'parsed', feeLimit: null, excludedNodeReferences: [], priority: null, privacyRequest: null, unhandledRequests: [] };

test('conversione fee esatta e comparatori', () => {
  assert.equal(feeToMsat({ value: '10', unit: 'sat', comparison: 'lte' }), '10000');
  assert.equal(feeToMsat({ value: '10', unit: 'sat', comparison: 'lt' }), '9999');
  assert.equal(feeToMsat({ value: '1.5', unit: 'sat', comparison: 'lte' }), '1500');
  assert.equal(feeToMsat({ value: '0', unit: 'sat', comparison: 'lte' }), '0');
  assert.equal(feeToMsat({ value: '1.000', unit: 'msat', comparison: 'lte' }), '1');
  assert.throws(() => feeToMsat({ value: '1.0001', unit: 'sat', comparison: 'lte' }));
  assert.throws(() => feeToMsat({ value: '0', unit: 'sat', comparison: 'lt' }));
});

test('capability gate conserva budget e blocca invio', () => {
  const result = compileConstraints({ extracted: { ...base, feeLimit: { value: '10', unit: 'sat', comparison: 'lte' }, priority: 'reliability' }, payment, capabilities: caps });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.normalized?.maxRoutingFeeMsat, '10000');
  assert.equal(result.normalized?.priority, 'reliability');
  assert.equal(result.policy, null);
  assert.ok(result.issues.some(x => x.includes('retry')));
});

test('zero non diventa assenza di limite', () => {
  const result = compileConstraints({ extracted: { ...base, feeLimit: { value: '0', unit: 'sat', comparison: 'lte' } }, payment, capabilities: caps });
  assert.equal(result.normalized?.maxRoutingFeeMsat, '0');
  assert.equal(result.status, 'unsupported');
});

test('alias duplicato e nodo inesistente richiedono chiarimento', () => {
  const pubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  assert.equal(validNodeId(pubkey), true);
  assert.equal(validNodeId('02' + '00'.repeat(32)), false);
  const knownNodes = [{ alias: 'Bob', pubkey }, { alias: 'Bob', pubkey }];
  assert.equal(compileConstraints({ extracted: { ...base, excludedNodeReferences: ['Bob'] }, payment, capabilities: caps, knownNodes }).code, 'NODE_UNRESOLVED');
  assert.equal(compileConstraints({ extracted: { ...base, excludedNodeReferences: ['Unknown'] }, payment, capabilities: caps }).code, 'NODE_UNRESOLVED');
});

test('invoice e importo cambiano fingerprint', () => {
  assert.notEqual(fingerprint(payment), fingerprint({ ...payment, invoice: 'lntb-other' }));
  assert.notEqual(fingerprint(payment), fingerprint({ ...payment, amount: '1001' }));
});

test('richiesta non gestita impedisce una policy parziale', () => {
  const result = compileConstraints({ extracted: { ...base, feeLimit: { value: '10', unit: 'sat', comparison: 'lte' }, unhandledRequests: ['pagamento garantito'] }, payment, capabilities: caps });
  assert.equal(result.code, 'INVALID_EXTRACTION');
  assert.equal(result.policy, null);
});
