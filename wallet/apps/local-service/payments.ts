import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTING_ALGORITHMS, type CompiledPolicy, type PaymentRouting, type RoutingConstraintsPatch } from '../../packages/contracts/types.js';
import { fingerprint, validNodeId } from '../../packages/policy/compile.js';
import type { DecodedLightning } from './wallet.js';
import { WalletError } from './wallet.js';

export type PaymentRecord = {
  id: string; paymentHash: string; invoice: string; amountMsat: string; assetId: string | null;
  assetAmount: string | null; status: 'prepared' | 'unknown' | 'pending' | 'succeeded' | 'failed';
  createdAt: number; updatedAt: number; nativePaymentId: string | null; routing: PaymentRouting;
};
type WalletPort = {
  canSend: boolean;
  decodeLightning(invoice: string): Promise<DecodedLightning>;
  sendLightning(decoded: DecodedLightning, amountMsat: string, routing: PaymentRouting): Promise<Record<string, unknown>>;
  paymentStatus(hash: string): Promise<Record<string, unknown>>;
};
const normalizeStatus = (value: unknown): PaymentRecord['status'] => {
  if (typeof value !== 'string') return 'unknown';
  const status = value.toLowerCase();
  if (['succeeded', 'success', 'settled', 'complete'].includes(status)) return 'succeeded';
  if (['failed', 'failure'].includes(status)) return 'failed';
  if (['pending', 'inflight', 'in_flight'].includes(status)) return 'pending';
  return 'unknown';
};
const blankConstraints = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 0;
};
export const parseCompiledPolicy = (value: unknown): CompiledPolicy | null => {
  if (blankConstraints(value)) return null;
  const unsupported = () => new WalletError('CONSTRAINT_UNSUPPORTED', 'Il pagamento vincolato richiede una policy compilata e validata');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsupported();
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== '1.0' || row.status !== 'validated' || typeof row.policyId !== 'string' || !row.policyId || typeof row.paymentFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.paymentFingerprint)) throw unsupported();
  if (!row.hard || typeof row.hard !== 'object' || Array.isArray(row.hard) || !row.soft || typeof row.soft !== 'object' || Array.isArray(row.soft)) throw unsupported();
  const hard = row.hard as Record<string, unknown>;
  const soft = row.soft as Record<string, unknown>;
  if (hard.maxRoutingFeeMsat !== null && (typeof hard.maxRoutingFeeMsat !== 'string' || !/^(0|[1-9][0-9]*)$/.test(hard.maxRoutingFeeMsat) || BigInt(hard.maxRoutingFeeMsat) > BigInt(Number.MAX_SAFE_INTEGER))) throw unsupported();
  if (!Array.isArray(hard.excludedNodeIds) || hard.excludedNodeIds.length > 256 || !hard.excludedNodeIds.every(id => typeof id === 'string' && validNodeId(id))) throw unsupported();
  if (!Array.isArray(hard.excludedChannels) || hard.excludedChannels.length > 0) throw unsupported();
  if (!['balanced', 'lowest_fee', 'reliability'].includes(String(soft.priority)) || !['standard', 'avoid_extra_probing'].includes(String(soft.privacyPreference))) throw unsupported();
  return {
    schemaVersion: '1.0',
    policyId: row.policyId,
    paymentId: typeof row.paymentId === 'string' ? row.paymentId : row.paymentFingerprint,
    paymentFingerprint: row.paymentFingerprint,
    capabilityRevision: typeof row.capabilityRevision === 'string' ? row.capabilityRevision : 'rgb-mpp-1',
    hard: {
      maxRoutingFeeMsat: hard.maxRoutingFeeMsat as string | null,
      excludedNodeIds: (hard.excludedNodeIds as string[]).map(id => id.toLowerCase()),
      excludedChannels: [],
    },
    soft: {
      priority: soft.priority as CompiledPolicy['soft']['priority'],
      privacyPreference: soft.privacyPreference as CompiledPolicy['soft']['privacyPreference'],
    },
    status: 'validated',
  };
};
const applyPolicyToRouting = (base: PaymentRouting, policy: CompiledPolicy | null): PaymentRouting => {
  if (!policy) return base;
  const patch: RoutingConstraintsPatch = {};
  if (policy.hard.maxRoutingFeeMsat !== null) patch.max_fee_msat = Number(policy.hard.maxRoutingFeeMsat);
  const mergedExclusions = [...new Set([...(base.excluded_nodes ?? []), ...policy.hard.excludedNodeIds])];
  if (mergedExclusions.length > 0) patch.excluded_nodes = mergedExclusions;
  if (policy.soft.privacyPreference === 'avoid_extra_probing' || base.max_paths === 1) patch.max_paths = 1;
  return { ...base, ...patch };
};
const parseRouting = (value: unknown, allowConstraints = false): PaymentRouting => {
  const invalid = () => new WalletError('INVALID_ROUTING', 'Scegliere un algoritmo valido; multi_objective richiede pesi fee, reliability, cltv e hops interi tra 0 e 1000000, almeno uno positivo');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  const allowedKeys = allowConstraints
    ? ['algorithm', 'weights', 'max_fee_msat', 'excluded_nodes', 'max_paths']
    : ['algorithm', 'weights', 'excluded_nodes', 'max_paths'];
  if (!ROUTING_ALGORITHMS.some(algorithm => algorithm === row.algorithm) || Object.keys(row).some(key => !allowedKeys.includes(key))) throw invalid();
  const patch: RoutingConstraintsPatch = {};
  if (allowConstraints && Object.hasOwn(row, 'max_fee_msat')) {
    if (typeof row.max_fee_msat !== 'number' || !Number.isSafeInteger(row.max_fee_msat) || row.max_fee_msat < 0) throw invalid();
    patch.max_fee_msat = row.max_fee_msat;
  }
  if (Object.hasOwn(row, 'excluded_nodes')) {
    if (!Array.isArray(row.excluded_nodes) || !row.excluded_nodes.every(id => typeof id === 'string' && validNodeId(id))) throw invalid();
    patch.excluded_nodes = row.excluded_nodes.map(id => id.toLowerCase());
  }
  if (Object.hasOwn(row, 'max_paths')) {
    if (typeof row.max_paths !== 'number' || !Number.isInteger(row.max_paths) || row.max_paths < 1 || row.max_paths > 32) throw invalid();
    patch.max_paths = row.max_paths;
  }
  if (row.algorithm !== 'multi_objective') {
    if (Object.hasOwn(row, 'weights')) throw invalid();
    return { algorithm: row.algorithm as Exclude<PaymentRouting['algorithm'], 'multi_objective'>, ...patch };
  }
  if (!row.weights || typeof row.weights !== 'object' || Array.isArray(row.weights)) throw invalid();
  const weights = row.weights as Record<string, unknown>;
  const keys = ['fee', 'reliability', 'cltv', 'hops'] as const;
  if (Object.keys(weights).length !== keys.length || !keys.every(key => typeof weights[key] === 'number' && Number.isInteger(weights[key]) && weights[key] >= 0 && weights[key] <= 1_000_000) || !keys.some(key => Number(weights[key]) > 0)) throw invalid();
  return { algorithm: 'multi_objective', weights: { fee: Number(weights.fee), reliability: Number(weights.reliability), cltv: Number(weights.cltv), hops: Number(weights.hops) }, ...patch };
};

export class PaymentStore {
  private db: DatabaseSync;
  constructor(
    directory: string,
    private wallet: WalletPort,
    private onTerminalOutcome?: (record: PaymentRecord) => void | Promise<void>,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'payments.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, payment_hash TEXT UNIQUE NOT NULL, invoice TEXT NOT NULL, amount_msat TEXT NOT NULL, asset_id TEXT, asset_amount TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, native_payment_id TEXT)');
    const columns = this.db.prepare('PRAGMA table_info(intents)').all();
    // Existing intents used the old daemon's fixed LDK algorithm.
    if (!columns.some(column => column.name === 'routing')) this.db.exec(`ALTER TABLE intents ADD COLUMN routing TEXT NOT NULL DEFAULT '{"algorithm":"ldk_dijkstra"}'`);
    this.db.exec("UPDATE intents SET status='unknown', updated_at=strftime('%s','now')*1000 WHERE status='pending'");
  }
  private row(id: string): PaymentRecord | null {
    const row = this.db.prepare('SELECT * FROM intents WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), paymentHash: String(row.payment_hash), invoice: String(row.invoice), amountMsat: String(row.amount_msat), assetId: row.asset_id as string | null, assetAmount: row.asset_amount as string | null, status: row.status as PaymentRecord['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), nativePaymentId: row.native_payment_id as string | null, routing: parseRouting(JSON.parse(String(row.routing)), true) };
  }
  get(id: string): PaymentRecord | null { return this.row(id); }
  list(): PaymentRecord[] {
    const ids = this.db.prepare('SELECT id FROM intents ORDER BY created_at DESC LIMIT 100').all() as { id: string }[];
    return ids.map(({ id }) => this.row(id)!).filter(Boolean);
  }
  async listReconciled(): Promise<PaymentRecord[]> {
    const records = this.list();
    // Keep the intent database as the idempotency ledger, but refresh every
    // nonterminal state from the node before presenting it as payment history.
    const refreshed: PaymentRecord[] = [];
    for (const record of records) {
      refreshed.push(record.status === 'pending' || record.status === 'unknown'
        ? await this.reconcile(record.id) : record);
    }
    return refreshed;
  }
  async prepare(input: { id: string; invoice: string; amountMsat?: string; constraints?: unknown; routing?: unknown }): Promise<PaymentRecord> {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(input.id)) throw new WalletError('INVALID_INTENT_ID', 'ID intento non valido');
    const policy = parseCompiledPolicy(input.constraints);
    const baseRouting = parseRouting(input.routing, false);
    const routing = applyPolicyToRouting(baseRouting, policy);
    const existing = this.row(input.id);
    if (existing) {
      if (existing.invoice !== input.invoice || (input.amountMsat && existing.amountMsat !== input.amountMsat) || JSON.stringify(existing.routing) !== JSON.stringify(routing)) throw new WalletError('INTENT_CONFLICT', 'ID già associato a un altro pagamento o algoritmo');
      return existing;
    }
    const decoded = await this.wallet.decodeLightning(input.invoice);
    const amount = decoded.amountMsat ?? input.amountMsat;
    if (!amount || !/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError('INVALID_AMOUNT', 'Importo esplicito richiesto per invoice senza importo');
    if (decoded.amountMsat && input.amountMsat && decoded.amountMsat !== input.amountMsat) throw new WalletError('AMOUNT_MISMATCH', 'Importo diverso dalla invoice');
    if (decoded.assetId && !decoded.assetAmount) throw new WalletError('INVALID_ASSET', 'Invoice RGB priva di importo asset');
    if (decoded.assetId && BigInt(amount) < 3_000_000n) throw new WalletError('RGB_HTLC_MINIMUM', 'RGB Lightning richiede almeno 3000000 msat in questa versione');
    if (policy) {
      const expectedFingerprint = fingerprint({ invoice: decoded.invoice, amount, assetId: decoded.assetId ?? 'BTC', network: decoded.network });
      if (policy.paymentFingerprint !== expectedFingerprint) throw new WalletError('CONSTRAINT_MISMATCH', 'Policy compilata per un pagamento diverso');
    }
    if (decoded.payeePubkey && routing.excluded_nodes?.some(id => id.toLowerCase() === decoded.payeePubkey!.toLowerCase())) {
      throw new WalletError('CONSTRAINT_CONFLICT', 'Il destinatario della invoice è tra i nodi esclusi');
    }
    const now = Date.now();
    try {
      this.db.prepare('INSERT INTO intents (id,payment_hash,invoice,amount_msat,asset_id,asset_amount,status,created_at,updated_at,native_payment_id,routing) VALUES (?,?,?,?,?,?,?, ?,?,NULL,?)').run(input.id, decoded.paymentHash, input.invoice, amount, decoded.assetId, decoded.assetAmount, 'prepared', now, now, JSON.stringify(routing));
    } catch { throw new WalletError('DUPLICATE_INVOICE', 'Questa invoice appartiene già a un intento'); }
    return this.row(input.id)!;
  }
  async confirm(id: string): Promise<PaymentRecord> {
    if (!this.wallet.canSend) throw new WalletError('SEND_DISABLED', 'Invio regtest non abilitato');
    const record = this.row(id);
    if (!record) throw new WalletError('INTENT_NOT_FOUND', 'Intento assente');
    if (record.status !== 'prepared') return record;
    const decoded = await this.wallet.decodeLightning(record.invoice);
    if (decoded.paymentHash !== record.paymentHash || decoded.amountMsat && decoded.amountMsat !== record.amountMsat || decoded.assetId !== record.assetId || decoded.assetAmount !== record.assetAmount) throw new WalletError('PAYMENT_CHANGED', 'Invoice cambiata dopo la preparazione');
    // Advance durably before the external call. A transport error remains unknown.
    const updated = this.db.prepare("UPDATE intents SET status='unknown',updated_at=? WHERE id=? AND status='prepared'").run(Date.now(), id);
    if (updated.changes !== 1) return this.row(id)!;
    try {
      const native = await this.wallet.sendLightning(decoded, record.amountMsat, record.routing);
      const status = normalizeStatus(native.status);
      const nativeId = typeof native.payment_id === 'string' ? native.payment_id : null;
      this.db.prepare('UPDATE intents SET status=?,native_payment_id=?,updated_at=? WHERE id=?').run(status, nativeId, Date.now(), id);
      const updatedRecord = this.row(id)!;
      if ((status === 'succeeded' || status === 'failed') && this.onTerminalOutcome) {
        void Promise.resolve(this.onTerminalOutcome(updatedRecord)).catch(() => undefined);
      }
      return updatedRecord;
    } catch {
      // The native operation may still complete after a transport error.
    }
    return this.row(id)!;
  }
  async reconcile(id: string): Promise<PaymentRecord> {
    const record = this.row(id);
    if (!record) throw new WalletError('INTENT_NOT_FOUND', 'Intento assente');
    if (record.status === 'prepared' || record.status === 'succeeded' || record.status === 'failed') return record;
    try {
      const native = await this.wallet.paymentStatus(record.paymentHash);
      const status = normalizeStatus(native.status);
      if (status !== 'unknown') {
        this.db.prepare('UPDATE intents SET status=?,updated_at=? WHERE id=?').run(status, Date.now(), id);
        const updatedRecord = this.row(id)!;
        if ((status === 'succeeded' || status === 'failed') && this.onTerminalOutcome) {
          void Promise.resolve(this.onTerminalOutcome(updatedRecord)).catch(() => undefined);
        }
        return updatedRecord;
      }
    } catch { /* Keep unknown until the node is queryable. */ }
    return this.row(id)!;
  }
  close() { this.db.close(); }
}
