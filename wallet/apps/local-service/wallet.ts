import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import WalletManagerRgbLightning, { type WalletAccountRgbLightning } from '@utexo/wdk-rgb-lightning';
import { validNodeId } from '../../packages/policy/compile.js';
import { VaultStore } from './vault.js';
import { PersistentSignerError, PersistentWalletManager, prepareSignerStorage } from './persistent-signer.js';

export class WalletError extends Error { constructor(public code: string, message: string) { super(message); } }
export type DecodedLightning = {
  invoice: string; network: 'regtest'; paymentHash: string; payeePubkey: string | null;
  amountMsat: string | null; assetId: string | null; assetAmount: string | null; expiresAt: number;
  description: string | null;
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positiveInteger = (value: unknown): bigint | null => {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
};
const safeNumber = (value: string, name: string): number => {
  const parsed = positiveInteger(value);
  if (parsed === null || parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError('INVALID_AMOUNT', `${name} deve essere un intero positivo rappresentabile`);
  return Number(parsed);
};
const records = (value: unknown, key: string): Record<string, unknown>[] => {
  const list = Array.isArray(value) ? value : object(value)[key];
  if (!Array.isArray(list)) throw new WalletError('WDK_SHAPE', `Risposta WDK ${key} non riconosciuta`);
  return list.map(object);
};
const stringField = (row: Record<string, unknown>, key: string): string | null => typeof row[key] === 'string' ? row[key] as string : null;
const peerPort = (): number => {
  const value = Number(process.env.AIRGB_LDK_PEER_PORT ?? '0');
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new WalletError('INVALID_PEER_PORT', 'Porta LDK non valida');
  return value;
};
const announceHost = (): string => {
  const host = process.env.AIRGB_ANNOUNCE_HOST ?? '127.0.0.1';
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new WalletError('INVALID_ANNOUNCE_HOST', 'Host di announce non valido');
  return host;
};
const NIA_TICKER = /^[A-Z][A-Z0-9]{1,7}$/;
const MAX_NIA_NAME_LENGTH = 64;
const MAX_NIA_PRECISION = 6;
const MAX_NIA_ALLOCATIONS = 4;
type NiaIssueRequest = { ticker: string; name: string; precision: number; amounts: number[] };
type IssuingAccount = WalletAccountRgbLightning & {
  issueAssetNia(request: NiaIssueRequest): Promise<unknown>;
};

export class WdkWallet {
  readonly dataDir: string;
  readonly vault: VaultStore;
  readonly listeningPort: number;
  private manager: WalletManagerRgbLightning | null = null;
  private account: WalletAccountRgbLightning | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;
  private lease: FileHandle | null = null;
  constructor(directory = process.env.AIRGB_DATA_DIR ?? join(import.meta.dirname, '../../native-data/wallet')) {
    this.dataDir = resolve(directory);
    this.vault = new VaultStore(this.dataDir);
    this.listeningPort = peerPort();
  }
  get ready(): boolean { return this.account !== null; }
  get canSend(): boolean { return this.ready && process.env.ENABLE_REGTEST_SEND === '1'; }
  // beta.15 shuts the binding before the generic WDK dispose reads account.keyPair.
  // That getter calls bootstrap on the already destroyed signer. The RGB Lightning
  // account has no local secrets and its dispose is a no-op, so detach it first.
  private disposeManager(manager: WalletManagerRgbLightning) {
    (manager as unknown as { _accounts: Record<string, unknown> })._accounts = {};
    manager.dispose();
  }
  async state() { return { keystoreExists: await this.vault.exists(), node: this.ready ? 'ready' : 'locked', network: 'regtest', sendEnabled: this.canSend }; }
  async create(password: string, mnemonic?: string) { return { recoveryPhrase: await this.vault.create(password, mnemonic), state: await this.state() }; }

  async unlock(password: string): Promise<void> {
    if (this.stopped) throw new WalletError('STOPPED', 'Servizio wallet arrestato');
    if (this.account) return;
    if (this.starting) return this.starting;
    this.starting = this.start(password);
    try { await this.starting; } finally { this.starting = null; }
  }
  private async start(password: string) {
    const required = ['BITCOIND_RPC_USER', 'BITCOIND_RPC_PASSWORD', 'INDEXER_URL', 'RGB_PROXY_ENDPOINT'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length) throw new WalletError('REGTEST_CONFIG_MISSING', `Configurazione mancante: ${missing.join(', ')}`);
    const mnemonic = await this.vault.unlockMnemonic(password);
    await mkdir(join(this.dataDir, 'wdk-rgb-lightning'), { recursive: true, mode: 0o700 });
    const lockPath = join(this.dataDir, 'wdk-rgb-lightning.owner');
    let lease: FileHandle;
    try { lease = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WalletError('NODE_ALREADY_OWNED', 'La directory del nodo è già aperta o richiede verifica dopo un arresto anomalo');
      throw error;
    }
    let manager: WalletManagerRgbLightning | null = null;
    try {
      await lease.writeFile(String(process.pid));
      const listeningPort = this.listeningPort;
      await prepareSignerStorage(join(this.dataDir, 'wdk-rgb-lightning'));
      manager = new PersistentWalletManager(mnemonic, { network: 'regtest', dataDir: join(this.dataDir, 'wdk-rgb-lightning'), nodeSeedDerivation: 'wdk-seed-v2', ldkPeerListeningPort: listeningPort });
      const account = await manager.getAccount(0);
      await account.unlock({
        bitcoind_rpc_username: process.env.BITCOIND_RPC_USER,
        bitcoind_rpc_password: process.env.BITCOIND_RPC_PASSWORD,
        bitcoind_rpc_host: process.env.BITCOIND_RPC_HOST ?? '127.0.0.1',
        bitcoind_rpc_port: Number(process.env.BITCOIND_RPC_PORT ?? 18443),
        indexer_url: process.env.INDEXER_URL,
        proxy_endpoint: process.env.RGB_PROXY_ENDPOINT,
        announce_addresses: listeningPort ? [`${announceHost()}:${listeningPort}`] : [], announce_alias: 'AIR-GB-regtest',
      });
      const address = await account.getAddressState();
      if (address.status !== 'ready') throw new WalletError('NODE_LOCKED', 'Il nodo non è pronto');
      this.manager = manager; this.account = account; this.lease = lease;
    } catch (error) {
      try { if (manager) this.disposeManager(manager); } finally { await lease.close(); await unlink(lockPath).catch(() => undefined); }
      if (error instanceof PersistentSignerError) throw new WalletError(error.code, error.message);
      throw error;
    }
  }
  private requireAccount(): WalletAccountRgbLightning {
    if (!this.account) throw new WalletError('WALLET_LOCKED', 'Sbloccare il wallet locale');
    return this.account;
  }
  async summary() {
    const account = this.requireAccount();
    const address = await account.getAddressState();
    if (address.status !== 'ready') throw new WalletError('WALLET_LOCKED', 'Account bloccato');
    const [btc, node, network] = await Promise.all([account.getBalance(), account.getNodeInfo(), account.getNetworkInfo()]);
    const nodeId = Buffer.from(account.keyPair.publicKey).toString('hex');
    const port = this.listeningPort;
    const host = announceHost();
    return { network: 'regtest', address: address.address, nodeId, peerUri: port ? `${nodeId}@${host}:${port}` : null, btcSpendableSat: btc.toString(), nodeInfo: object(node), networkInfo: object(network) };
  }
  async sync() { await this.requireAccount().sync(); }
  async refresh() {
    await this.sync();
    await this.requireAccount().refreshTransfers({ filter: [], skip_sync: false });
  }
  async prepareRgbUtxos(input: { count: number; sizeSat: string; feeRateSatPerVbyte: string }) {
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 8) throw new WalletError('INVALID_UTXO_COUNT', 'Numero UTXO compreso tra 1 e 8');
    const size = safeNumber(input.sizeSat, 'Dimensione UTXO in sat');
    const feeRate = safeNumber(input.feeRateSatPerVbyte, 'Fee in sat/vB');
    if (size < 10000 || size > 1000000 || feeRate > 100) throw new WalletError('INVALID_UTXO_PARAMETERS', 'Dimensione UTXO: 10000–1000000 sat; fee: 1–100 sat/vB');
    try {
      await this.requireAccount().createUtxos({ up_to: true, num: input.count, size, fee_rate: feeRate, skip_sync: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Allocations already available')) return { status: 'ready', confirmationRequired: false };
      throw error;
    }
    return { status: 'requested', confirmationRequired: true };
  }
  async issueNia(input: NiaIssueRequest) {
    const name = input.name.trim();
    if (!NIA_TICKER.test(input.ticker)) throw new WalletError('INVALID_ASSET', 'Ticker NIA: 2–8 caratteri, inizia con una lettera maiuscola');
    if (name.length < 1 || name.length > MAX_NIA_NAME_LENGTH || /[\r\n]/.test(name)) throw new WalletError('INVALID_ASSET', 'Nome NIA: 1–64 caratteri, una sola riga');
    if (!Number.isSafeInteger(input.precision) || input.precision < 0 || input.precision > MAX_NIA_PRECISION) throw new WalletError('INVALID_ASSET', 'Precisione NIA: intero da 0 a 6');
    if (!Array.isArray(input.amounts) || input.amounts.length < 1 || input.amounts.length > MAX_NIA_ALLOCATIONS) throw new WalletError('INVALID_AMOUNT', 'Servono da 1 a 4 allocazioni');
    const amounts = input.amounts.map(amount => safeNumber(String(amount), 'Allocazione NIA'));
    const account = this.requireAccount() as IssuingAccount;
    let response: Record<string, unknown>;
    try {
      response = object(await account.issueAssetNia({ ticker: input.ticker, name, precision: input.precision, amounts }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('UnsupportedInExternalSignerMode')) throw new WalletError('ISSUANCE_UNSUPPORTED', 'RLN non emette NIA con il signer esterno usato da questo nodo');
      throw error;
    }
    const asset = object(response.asset);
    const assetId = stringField(asset, 'asset_id');
    if (!assetId?.startsWith('rgb:')) throw new WalletError('ISSUE_SHAPE', 'Risposta di emissione NIA non riconosciuta');
    const issuedSupply = positiveInteger(asset.issued_supply);
    if (issuedSupply === null) throw new WalletError('ISSUE_SHAPE', 'Supply emessa non riconosciuta');
    await this.refresh();
    return { assetId, ticker: input.ticker, name, precision: input.precision, issuedSupply: issuedSupply.toString() };
  }
  async channels() {
    const source = await this.requireAccount().listChannels();
    return records(source, 'channels').map(row => ({
      channelId: stringField(row, 'channel_id'), peerNodeId: stringField(row, 'peer_pubkey') ?? stringField(row, 'peer_node_id'),
      assetId: stringField(row, 'asset_id'), capacitySat: positiveInteger(row.capacity_sat)?.toString() ?? null,
      outboundMsat: positiveInteger(row.outbound_balance_msat ?? row.outbound_capacity_msat)?.toString() ?? null,
      inboundMsat: positiveInteger(row.inbound_balance_msat)?.toString() ?? null,
      assetLocalAmount: positiveInteger(row.asset_local_amount)?.toString() ?? null,
      assetRemoteAmount: positiveInteger(row.asset_remote_amount)?.toString() ?? null,
      isUsable: typeof row.is_usable === 'boolean' ? row.is_usable : null,
      fundingTxid: stringField(row, 'funding_txid'),
      public: typeof row.public === 'boolean' ? row.public : null,
    }));
  }
  async peers() {
    return records(await this.requireAccount().listPeers(), 'peers').map(row => ({ nodeId: stringField(row, 'pubkey') ?? stringField(row, 'node_id'), connected: typeof row.is_connected === 'boolean' ? row.is_connected : null }));
  }
  async assets() {
    const source = await this.requireAccount().listAssets();
    const grouped = object(source);
    const rows = ['nia', 'uda', 'cfa', 'ifa'].every(key => Array.isArray(grouped[key]))
      ? ['nia', 'uda', 'cfa', 'ifa'].flatMap(kind => (grouped[kind] as unknown[]).map(value => ({ ...object(value), kind })))
      : records(source, 'assets');
    return rows.map(row => ({ assetId: stringField(row, 'asset_id') ?? stringField(row, 'id'), ticker: stringField(row, 'ticker'), name: stringField(row, 'name'), kind: stringField(row, 'kind') }));
  }
  async assetBalance(assetId: string) {
    if (!assetId || assetId.length > 200) throw new WalletError('INVALID_ASSET', 'Asset ID non valido');
    const row = object(await this.requireAccount().getAssetBalance(assetId));
    return { assetId, settled: positiveInteger(row.settled)?.toString() ?? null, spendable: positiveInteger(row.spendable)?.toString() ?? null, future: positiveInteger(row.future)?.toString() ?? null };
  }
  async history() {
    return records(await this.requireAccount().listPayments(), 'payments').map(row => ({
      paymentHash: stringField(row, 'payment_hash'), status: stringField(row, 'status') ?? 'unknown',
      amountMsat: positiveInteger(row.amt_msat)?.toString() ?? null,
      assetId: stringField(row, 'asset_id'), assetAmount: positiveInteger(row.asset_amount)?.toString() ?? null,
    }));
  }
  async bitcoinHistory() { return await this.requireAccount().getTransactions(); }
  async rgbTransfers(assetId: string) {
    if (!assetId || assetId.length > 200) throw new WalletError('INVALID_ASSET', 'Asset ID non valido');
    return await this.requireAccount().listTransfers(assetId);
  }
  async invoiceStatus(invoice: string) {
    if (!/^lnbcrt[0-9a-z]{10,4096}$/i.test(invoice)) throw new WalletError('INVALID_INVOICE', 'Serve una invoice Lightning regtest');
    return await this.requireAccount().getInvoiceStatus(invoice);
  }
  async createLightningInvoice(input: { amountMsat: string; expirySec: number; assetId?: string; assetAmount?: string }) {
    const amountMsat = safeNumber(input.amountMsat, 'Importo Lightning');
    if (!Number.isSafeInteger(input.expirySec) || input.expirySec < 60 || input.expirySec > 86400) throw new WalletError('INVALID_EXPIRY', 'Scadenza tra 60 e 86400 secondi');
    if (!!input.assetId !== !!input.assetAmount) throw new WalletError('INVALID_ASSET', 'Asset ID e importo RGB devono essere presenti insieme');
    if (input.assetId && amountMsat < 3_000_000) throw new WalletError('RGB_HTLC_MINIMUM', 'RGB Lightning richiede almeno 3000000 msat in questa versione');
    const request: { amountMsat: number; expirySec: number; assetId?: string; assetAmount?: number } = { amountMsat, expirySec: input.expirySec };
    if (input.assetId) { request.assetId = input.assetId; request.assetAmount = safeNumber(input.assetAmount!, 'Importo RGB'); }
    const response = object(await this.requireAccount().createLightningInvoice(request));
    if (typeof response.invoice !== 'string' || !response.invoice.toLowerCase().startsWith('lnbcrt')) throw new WalletError('INVOICE_SHAPE', 'Risposta invoice nativa non riconosciuta');
    return { invoice: response.invoice, kind: input.assetId ? 'rgb-lightning' : 'btc-lightning', expirySec: input.expirySec };
  }
  async createRgbInvoice(input: { assetId: string | null; amount: string | null; expirySec: number }) {
    if (!Number.isSafeInteger(input.expirySec) || input.expirySec < 60 || input.expirySec > 86400) throw new WalletError('INVALID_EXPIRY', 'Scadenza RGB non valida');
    const request: Record<string, unknown> = { min_confirmations: 1, witness: false, duration_seconds: input.expirySec };
    if (input.assetId !== null || input.amount !== null) {
      if (!input.assetId?.startsWith('rgb:') || input.amount === null) throw new WalletError('INVALID_ASSET', 'Specificare contract ID e importo oppure scegliere una invoice generica');
      Object.assign(request, { asset_id: input.assetId, assignment_kind: 'Fungible', assignment_amount: safeNumber(input.amount, 'Importo RGB') });
    }
    const response = object(await this.requireAccount().createRgbInvoice(request));
    const invoice = stringField(response, 'invoice');
    if (!invoice) throw new WalletError('INVOICE_SHAPE', 'Risposta RGB nativa non riconosciuta');
    return { invoice, kind: 'rgb-onchain' };
  }
  async decodeLightning(invoice: string): Promise<DecodedLightning> {
    if (!/^lnbcrt[0-9a-z]{10,4096}$/i.test(invoice)) throw new WalletError('INVALID_INVOICE', 'Serve una invoice Lightning regtest');
    const row = object(await this.requireAccount().decodeInvoice(invoice));
    const network = stringField(row, 'network')?.toLowerCase();
    const hash = stringField(row, 'payment_hash');
    const timestamp = positiveInteger(row.timestamp);
    const expiry = positiveInteger(row.expiry_sec);
    if (network !== 'regtest' || !hash || !/^[0-9a-f]{64}$/i.test(hash) || timestamp === null || expiry === null) throw new WalletError('DECODE_SHAPE', 'Risposta di decodifica non verificabile');
    const expiresAt = Number(timestamp + expiry) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new WalletError('INVOICE_EXPIRED', 'Invoice scaduta');
    const amount = row.amt_msat === null || row.amt_msat === undefined ? null : positiveInteger(row.amt_msat)?.toString();
    if (row.amt_msat != null && amount === undefined) throw new WalletError('DECODE_SHAPE', 'Importo invoice non valido');
    const assetId = stringField(row, 'asset_id');
    const assetAmount = row.asset_amount == null ? null : positiveInteger(row.asset_amount)?.toString() ?? null;
    if (assetId && !assetAmount) throw new WalletError('DECODE_SHAPE', 'Importo RGB mancante');
    return { invoice, network: 'regtest', paymentHash: hash.toLowerCase(), payeePubkey: stringField(row, 'payee_pubkey'), amountMsat: amount ?? null, assetId, assetAmount, expiresAt, description: stringField(row, 'description') };
  }
  async connectPeer(peer: string) {
    const match = /^([0-9a-fA-F]{66})@([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(peer);
    if (!match || !validNodeId(match[1]) || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new WalletError('INVALID_PEER', 'Usare pubkey@host:porta');
    await this.requireAccount().connectPeer(peer);
    return { connected: true };
  }
  async openChannel(input: { peer: string; capacitySat: string; public?: boolean; assetId?: string; assetAmount?: string }) {
    const match = /^([0-9a-fA-F]{66})@([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(input.peer);
    if (!match || !validNodeId(match[1])) throw new WalletError('INVALID_PEER', 'Peer non valido');
    const capacity = safeNumber(input.capacitySat, 'Capacità canale');
    if (!!input.assetId !== !!input.assetAmount) throw new WalletError('INVALID_ASSET', 'Asset ID e importo richiesti insieme');
    const request: { peer_pubkey_and_opt_addr: string; capacity_sat: number; push_msat: number; public: boolean; with_anchors: boolean; asset_id?: string; asset_amount?: number } = { peer_pubkey_and_opt_addr: input.peer, capacity_sat: capacity, push_msat: 0, public: input.public ?? false, with_anchors: true };
    if (input.assetId) { request.asset_id = input.assetId; request.asset_amount = safeNumber(input.assetAmount!, 'Importo asset'); }
    return object(await this.requireAccount().openChannel(request));
  }
  async sendLightning(decoded: DecodedLightning, amountMsat: string): Promise<Record<string, unknown>> {
    if (!this.canSend) throw new WalletError('SEND_DISABLED', 'Invio regtest non abilitato');
    const amount = safeNumber(amountMsat, 'Importo Lightning');
    if (decoded.amountMsat !== null && decoded.amountMsat !== amountMsat) throw new WalletError('AMOUNT_MISMATCH', 'Importo diverso dalla invoice');
    const request: Record<string, unknown> = { invoice: decoded.invoice };
    if (decoded.amountMsat === null) request.amt_msat = amount;
    if (decoded.assetId) { request.asset_id = decoded.assetId; request.asset_amount = safeNumber(decoded.assetAmount!, 'Importo RGB'); }
    return object(await this.requireAccount().sendPayment(request));
  }
  async paymentStatus(hash: string) { return object(await this.requireAccount().getPayment(hash, 'Outbound')); }
  async shutdown() {
    this.stopped = true;
    if (this.starting) await this.starting.catch(() => undefined);
    const lease = this.lease;
    try { if (this.manager) this.disposeManager(this.manager); }
    finally {
      this.manager = null; this.account = null; this.lease = null;
      if (lease) { await lease.close(); await unlink(join(this.dataDir, 'wdk-rgb-lightning.owner')); }
    }
  }
}
