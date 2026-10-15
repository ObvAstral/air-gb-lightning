import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DecodedLightning } from './wallet.js';
import { WalletError } from './wallet.js';

export type PaymentRecord = {
  id: string; paymentHash: string; invoice: string; amountMsat: string; assetId: string | null;
  assetAmount: string | null; status: 'prepared' | 'unknown' | 'pending' | 'succeeded' | 'failed';
  createdAt: number; updatedAt: number; nativePaymentId: string | null;
};
type WalletPort = {
  canSend: boolean;
  decodeLightning(invoice: string): Promise<DecodedLightning>;
  sendLightning(decoded: DecodedLightning, amountMsat: string): Promise<Record<string, unknown>>;
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

export class PaymentStore {
  private db: DatabaseSync;
  constructor(directory: string, private wallet: WalletPort) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'payments.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, payment_hash TEXT UNIQUE NOT NULL, invoice TEXT NOT NULL, amount_msat TEXT NOT NULL, asset_id TEXT, asset_amount TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, native_payment_id TEXT)');
    this.db.exec("UPDATE intents SET status='unknown', updated_at=strftime('%s','now')*1000 WHERE status='pending'");
  }
  private row(id: string): PaymentRecord | null {
    const row = this.db.prepare('SELECT * FROM intents WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: String(row.id), paymentHash: String(row.payment_hash), invoice: String(row.invoice), amountMsat: String(row.amount_msat), assetId: row.asset_id as string | null, assetAmount: row.asset_amount as string | null, status: row.status as PaymentRecord['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), nativePaymentId: row.native_payment_id as string | null };
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
  async prepare(input: { id: string; invoice: string; amountMsat?: string; constraints?: unknown }): Promise<PaymentRecord> {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(input.id)) throw new WalletError('INVALID_INTENT_ID', 'ID intento non valido');
    if (!blankConstraints(input.constraints)) throw new WalletError('CONSTRAINT_UNSUPPORTED', 'Il pagamento vincolato non è ancora supportato');
    const existing = this.row(input.id);
    if (existing) {
      if (existing.invoice !== input.invoice || (input.amountMsat && existing.amountMsat !== input.amountMsat)) throw new WalletError('INTENT_CONFLICT', 'ID già associato a un altro pagamento');
      return existing;
    }
    const decoded = await this.wallet.decodeLightning(input.invoice);
    const amount = decoded.amountMsat ?? input.amountMsat;
    if (!amount || !/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError('INVALID_AMOUNT', 'Importo esplicito richiesto per invoice senza importo');
    if (decoded.amountMsat && input.amountMsat && decoded.amountMsat !== input.amountMsat) throw new WalletError('AMOUNT_MISMATCH', 'Importo diverso dalla invoice');
    if (decoded.assetId && !decoded.assetAmount) throw new WalletError('INVALID_ASSET', 'Invoice RGB priva di importo asset');
    if (decoded.assetId && BigInt(amount) < 3_000_000n) throw new WalletError('RGB_HTLC_MINIMUM', 'RGB Lightning richiede almeno 3000000 msat in questa versione');
    const now = Date.now();
    try {
      this.db.prepare('INSERT INTO intents (id,payment_hash,invoice,amount_msat,asset_id,asset_amount,status,created_at,updated_at,native_payment_id) VALUES (?,?,?,?,?,?,?, ?,?,NULL)').run(input.id, decoded.paymentHash, input.invoice, amount, decoded.assetId, decoded.assetAmount, 'prepared', now, now);
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
      const native = await this.wallet.sendLightning(decoded, record.amountMsat);
      const status = normalizeStatus(native.status);
      const nativeId = typeof native.payment_id === 'string' ? native.payment_id : null;
      this.db.prepare('UPDATE intents SET status=?,native_payment_id=?,updated_at=? WHERE id=?').run(status, nativeId, Date.now(), id);
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
      if (status !== 'unknown') this.db.prepare('UPDATE intents SET status=?,updated_at=? WHERE id=?').run(status, Date.now(), id);
    } catch { /* Keep unknown until the node is queryable. */ }
    return this.row(id)!;
  }
  close() { this.db.close(); }
}
