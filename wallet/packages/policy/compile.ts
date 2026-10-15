import { createHash, ECDH, randomUUID } from 'node:crypto';
import type { CompileResult, ExtractedConstraints, FeeLimit, PaymentDraft, RoutingCapabilities } from '../contracts/types.js';

export function feeToMsat(limit: FeeLimit): string {
  const { value, unit, comparison } = limit;
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 32) throw new Error('Importo fee non valido');
  const [whole, fraction = ''] = value.split('.');
  const decimals = unit === 'sat' ? 3 : 0;
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error('Precisione non rappresentabile in msat');
  const base = BigInt(whole) * (unit === 'sat' ? 1000n : 1n);
  const sub = decimals ? BigInt((fraction.slice(0, decimals) + '0'.repeat(decimals)).slice(0, decimals)) : 0n;
  const inclusive = base + sub;
  if (comparison === 'lt' && inclusive === 0n) throw new Error('Nessuna fee non negativa è inferiore a zero');
  return (comparison === 'lt' ? inclusive - 1n : inclusive).toString();
}

export function validNodeId(value: string): boolean {
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return false;
  try { ECDH.convertKey(value, 'secp256k1', 'hex', 'hex', 'compressed'); return true; }
  catch { return false; }
}

export function fingerprint(payment: PaymentDraft): string {
  return createHash('sha256').update(JSON.stringify(payment)).digest('hex');
}

export function compileConstraints(args: {
  extracted: ExtractedConstraints;
  payment: PaymentDraft;
  capabilities: RoutingCapabilities;
  knownNodes?: { alias: string; pubkey: string }[];
  payeePubkey?: string | null;
}): CompileResult {
  const { extracted, payment, capabilities, knownNodes = [], payeePubkey = null } = args;
  const fail = (status: CompileResult['status'], code: CompileResult['code'], issues: string[], normalized: CompileResult['normalized'] = null): CompileResult => ({ status, code, issues, normalized, policy: null });
  if (extracted.status !== 'parsed' || extracted.unhandledRequests.length) return fail('needs_clarification', 'INVALID_EXTRACTION', [...extracted.unhandledRequests, ...(extracted.status === 'parsed' ? [] : [extracted.status])]);
  if (!payment.invoice.trim() || payment.invoice.length > 4096 || !/^[0-9]+$/.test(payment.amount) || !payment.assetId.trim() || payment.network !== 'regtest') return fail('needs_clarification', 'INVALID_EXTRACTION', ['Dati del pagamento incompleti o non validi']);

  let fee: string | null = null;
  try { if (extracted.feeLimit) fee = feeToMsat(extracted.feeLimit); }
  catch (error) { return fail('needs_clarification', 'INVALID_EXTRACTION', [(error as Error).message]); }
  const nodes: string[] = [];
  for (const ref of extracted.excludedNodeReferences) {
    if (validNodeId(ref)) { nodes.push(ref.toLowerCase()); continue; }
    const matches = knownNodes.filter(n => n.alias.toLocaleLowerCase() === ref.toLocaleLowerCase() && validNodeId(n.pubkey));
    if (matches.length !== 1) return fail('needs_clarification', 'NODE_UNRESOLVED', [`Nodo «${ref}»: ${matches.length ? 'alias ambiguo' : 'non trovato nel grafo verificato'}`]);
    nodes.push(matches[0].pubkey.toLowerCase());
  }
  if (payeePubkey && nodes.includes(payeePubkey.toLowerCase())) return fail('conflict', 'CONSTRAINT_CONFLICT', ['Il destinatario della invoice è tra i nodi esclusi']);
  const normalized: NonNullable<CompileResult['normalized']> = {
    maxRoutingFeeMsat: fee,
    excludedNodeIds: [...new Set(nodes)],
    priority: extracted.priority ?? 'balanced',
    privacyPreference: extracted.privacyRequest === 'avoid_extra_probing' ? 'avoid_extra_probing' : 'standard',
  };
  if (extracted.privacyRequest === 'unspecified') return fail('needs_clarification', 'INVALID_EXTRACTION', ['Precisare quale misura di privacy si desidera'], normalized);
  const missing: string[] = [];
  if (capabilities.backendVersion === 'not-connected') missing.push('decodifica canonica e verifica del pagamento WDK');
  const retries = capabilities.canGuaranteeConstraintsAcrossRetries;
  if (fee !== null && (!capabilities.hardFeeCap || !retries)) missing.push('budget fee garantito anche nei retry');
  if (nodes.length && (!capabilities.hardNodeExclusion || !retries)) missing.push('esclusione nodi garantita anche nei retry');
  if (extracted.priority && extracted.priority !== 'balanced' && !capabilities.perPaymentScoringProfile) missing.push('profilo scorer per pagamento');
  if (normalized.privacyPreference === 'avoid_extra_probing' && !capabilities.avoidExtraProbing) missing.push('assenza di probing aggiuntivo');
  if (missing.length) return fail('unsupported', 'CONSTRAINT_UNSUPPORTED', missing, normalized);
  const paymentId = fingerprint(payment);
  return { status: 'validated', code: 'OK', issues: [], normalized, policy: {
    schemaVersion: '1.0', policyId: randomUUID(), paymentId, paymentFingerprint: paymentId,
    capabilityRevision: capabilities.revision,
    hard: { maxRoutingFeeMsat: fee, excludedNodeIds: normalized.excludedNodeIds, excludedChannels: [] },
    soft: { priority: normalized.priority, privacyPreference: normalized.privacyPreference }, status: 'validated',
  }};
}
