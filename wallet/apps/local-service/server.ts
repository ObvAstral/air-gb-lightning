import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import Ajv from 'ajv';
import schema from '../../packages/contracts/extracted.schema.json' with { type: 'json' };
import type { ExtractedConstraints, PaymentDraft, RoutingCapabilities } from '../../packages/contracts/types.js';
import { compileConstraints } from '../../packages/policy/compile.js';
import { interpretWithQvac, InterpretationError } from './interpret.js';
import { WdkWallet, WalletError } from './wallet.js';
import { PaymentStore } from './payments.js';
import { VaultError } from './vault.js';

const port = Number(process.env.PORT ?? 8787);
const token = randomBytes(32).toString('hex');
const wallet = new WdkWallet();
const payments = new PaymentStore(wallet.dataDir, wallet);
const capabilities: RoutingCapabilities = Object.freeze({
  backendVersion: 'wdk-rgb-lightning-beta.15/native-beta.16+signer-0fb005e', revision: 'native-routing-unverified-1', hardFeeCap: false,
  hardNodeExclusion: false, hardChannelExclusion: false, perPaymentScoringProfile: false,
  avoidExtraProbing: false, canInspectFullRoute: false, canGuaranteeConstraintsAcrossRetries: false,
});
const validate = new Ajv({ allErrors: true, strict: true }).compile<ExtractedConstraints>(schema);
const json = (res: import('node:http').ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
};
const webPort = Number(process.env.AIRGB_WEB_PORT ?? 5173);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]);
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { code: 'BAD_HOST' });
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return json(res, 403, { code: 'BAD_ORIGIN' });
  const path = new URL(req.url ?? '/', `http://${host}`).pathname;
  if (req.method === 'GET' && path === '/api/health') return json(res, 200, { api: 'ready', wdk: wallet.ready ? 'ready' : 'locked', qvac: process.env.QVAC_MODEL ? 'configured_unverified' : 'not_configured', network: 'regtest' });
  if (req.method === 'GET' && path === '/api/routing/capabilities') return json(res, 200, capabilities);
  if (req.method === 'GET' && path === '/api/session') return json(res, 200, { token });
  if (req.headers['x-session-token'] !== token || (req.headers.origin && !allowedOrigins.has(req.headers.origin)) || (req.method === 'POST' && !req.headers.origin)) return json(res, 403, { code: 'SESSION_REQUIRED' });
  let raw = '';
  try {
    if (req.method === 'GET') {
      if (path === '/api/wallet/state') return json(res, 200, await wallet.state());
      if (path === '/api/wallet/summary') return json(res, 200, await wallet.summary());
      if (path === '/api/wallet/channels') return json(res, 200, await wallet.channels());
      if (path === '/api/wallet/peers') return json(res, 200, await wallet.peers());
      if (path === '/api/wallet/assets') return json(res, 200, await wallet.assets());
      if (path === '/api/wallet/asset-balance') {
        const assetId = new URL(req.url ?? '/', `http://${host}`).searchParams.get('assetId');
        return assetId ? json(res, 200, await wallet.assetBalance(assetId)) : json(res, 400, { code: 'INVALID_ASSET' });
      }
      if (path === '/api/wallet/history') return json(res, 200, await wallet.history());
      if (path === '/api/wallet/history/bitcoin') return json(res, 200, { source: 'wdk-bitcoin', data: await wallet.bitcoinHistory() });
      if (path === '/api/wallet/history/rgb') {
        const assetId = new URL(req.url ?? '/', `http://${host}`).searchParams.get('assetId');
        return assetId ? json(res, 200, { source: 'wdk-rgb', assetId, data: await wallet.rgbTransfers(assetId) }) : json(res, 400, { code: 'INVALID_ASSET' });
      }
      if (path === '/api/payments') return json(res, 200, wallet.ready ? await payments.listReconciled() : payments.list());
      if (path.startsWith('/api/payments/')) {
        const id = path.slice('/api/payments/'.length);
        const record = wallet.ready ? await payments.reconcile(id) : payments.get(id);
        return record ? json(res, 200, record) : json(res, 404, { code: 'INTENT_NOT_FOUND' });
      }
      return json(res, 404, { code: 'NOT_FOUND' });
    }
    if (req.method !== 'POST') return json(res, 404, { code: 'NOT_FOUND' });
    for await (const chunk of req) { raw += chunk; if (raw.length > 12000) return json(res, 413, { code: 'TOO_LARGE' }); }
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { code: 'INVALID_JSON_OBJECT' });
    if (path === '/api/wallet/create' || path === '/api/wallet/import') {
      if (typeof body.password !== 'string' || (path.endsWith('/import') && typeof body.mnemonic !== 'string')) return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.create(body.password, path.endsWith('/import') ? body.mnemonic as string : undefined));
    }
    if (path === '/api/wallet/unlock') {
      if (typeof body.password !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      await wallet.unlock(body.password);
      return json(res, 200, await wallet.state());
    }
    if (path === '/api/wallet/sync') {
      await wallet.refresh();
      return json(res, 200, { synced: true });
    }
    if (path === '/api/wallet/rgb/utxos') {
      if (typeof body.count !== 'number' || typeof body.sizeSat !== 'string' || typeof body.feeRateSatPerVbyte !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.prepareRgbUtxos({ count: body.count, sizeSat: body.sizeSat, feeRateSatPerVbyte: body.feeRateSatPerVbyte }));
    }
    if (path === '/api/wallet/receive/lightning') {
      if (typeof body.amountMsat !== 'string' || typeof body.expirySec !== 'number') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.createLightningInvoice({ amountMsat: body.amountMsat, expirySec: body.expirySec, assetId: typeof body.assetId === 'string' ? body.assetId : undefined, assetAmount: typeof body.assetAmount === 'string' ? body.assetAmount : undefined }));
    }
    if (path === '/api/wallet/receive/rgb') {
      if ((body.assetId !== null && typeof body.assetId !== 'string') || (body.amount !== null && typeof body.amount !== 'string') || typeof body.expirySec !== 'number') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.createRgbInvoice({ assetId: body.assetId, amount: body.amount, expirySec: body.expirySec }));
    }
    if (path === '/api/wallet/peers/connect') {
      if (typeof body.peer !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.connectPeer(body.peer));
    }
    if (path === '/api/wallet/channels/open') {
      if (typeof body.peer !== 'string' || typeof body.capacitySat !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.openChannel({ peer: body.peer, capacitySat: body.capacitySat, public: body.public === true, assetId: typeof body.assetId === 'string' ? body.assetId : undefined, assetAmount: typeof body.assetAmount === 'string' ? body.assetAmount : undefined }));
    }
    if (path === '/api/payments/decode') {
      if (typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.decodeLightning(body.invoice));
    }
    if (path === '/api/wallet/receive/lightning/status') {
      if (typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, { source: 'wdk-lightning', data: await wallet.invoiceStatus(body.invoice) });
    }
    if (path === '/api/payments/prepare') {
      if (typeof body.id !== 'string' || typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await payments.prepare({ id: body.id, invoice: body.invoice, amountMsat: typeof body.amountMsat === 'string' ? body.amountMsat : undefined, constraints: body.constraints }));
    }
    if (path === '/api/payments/confirm') {
      if (typeof body.id !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await payments.confirm(body.id));
    }
    if (path === '/api/constraints/interpret') {
      if (typeof body.text !== 'string') return json(res, 400, { code: 'INVALID_TEXT' });
      return json(res, 200, await interpretWithQvac(body.text));
    }
    if (path !== '/api/constraints/compile') return json(res, 404, { code: 'NOT_FOUND' });
    if (!validate(body.extracted)) return json(res, 400, { code: 'INVALID_SCHEMA' });
    const payment = body.payment as PaymentDraft;
    if (!payment || typeof payment !== 'object' || typeof payment.invoice !== 'string' || typeof payment.amount !== 'string' || typeof payment.assetId !== 'string') return json(res, 400, { code: 'INVALID_PAYMENT' });
    if (!/^[1-9][0-9]*$/.test(payment.amount) || BigInt(payment.amount) > BigInt(Number.MAX_SAFE_INTEGER)) return json(res, 422, { code: 'INVALID_AMOUNT', message: 'Importo Lightning in msat non valido' });
    const decoded = await wallet.decodeLightning(payment.invoice);
    const amount = BigInt(payment.amount).toString();
    if (decoded.amountMsat !== null && decoded.amountMsat !== amount) return json(res, 422, { code: 'AMOUNT_MISMATCH', message: 'Importo diverso dalla invoice' });
    if ((decoded.assetId ?? 'BTC') !== payment.assetId) return json(res, 422, { code: 'ASSET_MISMATCH', message: 'Asset diverso dalla invoice' });
    const canonical: PaymentDraft = { invoice: decoded.invoice, amount, assetId: decoded.assetId ?? 'BTC', network: decoded.network };
    return json(res, 200, compileConstraints({ extracted: body.extracted, payment: canonical, capabilities, payeePubkey: decoded.payeePubkey }));
  } catch (error) {
    if (error instanceof WalletError || error instanceof VaultError) return json(res, 422, { code: error.code, message: error.message });
    if (error instanceof InterpretationError) return json(res, 422, { code: error.code, message: error.message });
    if (error instanceof SyntaxError) return json(res, 400, { code: 'INVALID_JSON' });
    return json(res, 503, { code: 'WDK_UNAVAILABLE', message: 'Operazione WDK non disponibile; verificare i servizi regtest e il log locale' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`AIR-GB local service: http://127.0.0.1:${port}`));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void wallet.shutdown().catch(error => {
    console.error('Shutdown WDK non riuscito:', error instanceof Error ? error.message : 'errore sconosciuto');
    process.exitCode = 1;
  }).finally(() => { payments.close(); server.close(); });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
