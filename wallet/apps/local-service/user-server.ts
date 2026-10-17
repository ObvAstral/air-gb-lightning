import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PaymentStore } from './payments.js';
import { UserRgbWallet } from './user-wallet.js';
import { WalletError } from './wallet.js';
import { VaultError } from './vault.js';

const port = Number(process.env.PORT ?? 8789);
const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
if (bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0') throw new Error('BIND_HOST deve essere 127.0.0.1 oppure 0.0.0.0');
if (!process.env.ENABLE_REGTEST_SEND) process.env.ENABLE_REGTEST_SEND = '1';
const token = randomBytes(32).toString('hex');
const wallet = new UserRgbWallet();
const payments = new PaymentStore(wallet.dataDir, wallet);
const json = (res: import('node:http').ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
};
const webPort = Number(process.env.AIRGB_WEB_PORT ?? 5173);
const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]);
const applyCors = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'content-type, x-session-token');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('vary', 'Origin');
};
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  applyCors(req, res);
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { code: 'BAD_HOST' });
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return json(res, 403, { code: 'BAD_ORIGIN' });
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const path = new URL(req.url ?? '/', `http://${host}`).pathname;
  if (req.method === 'GET' && path === '/api/health') return json(res, 200, { api: 'ready', rln: wallet.ready ? 'ready' : 'locked', wallet: 'wdk-rgb-lightning', network: 'regtest' });
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
      if (path === '/api/payments') return json(res, 200, wallet.ready ? await payments.listReconciled() : payments.list());
      if (path.startsWith('/api/payments/')) {
        const id = path.slice('/api/payments/'.length);
        const record = wallet.ready ? await payments.reconcile(id) : payments.get(id);
        return record ? json(res, 200, record) : json(res, 404, { code: 'INTENT_NOT_FOUND' });
      }
      return json(res, 404, { code: 'NOT_FOUND', message: 'Operazione non disponibile sul wallet utente WDK' });
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
    if (path === '/api/wallet/rgb/issue') {
      if (typeof body.ticker !== 'string' || typeof body.name !== 'string' || typeof body.precision !== 'number' || !Array.isArray(body.amounts) || body.amounts.some(amount => typeof amount !== 'number')) return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.issueNia({ ticker: body.ticker, name: body.name, precision: body.precision, amounts: body.amounts as number[] }));
    }
    if (path === '/api/wallet/rgb/utxos') {
      if (typeof body.count !== 'number' || typeof body.sizeSat !== 'string' || typeof body.feeRateSatPerVbyte !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.prepareRgbUtxos({ count: body.count, sizeSat: body.sizeSat, feeRateSatPerVbyte: body.feeRateSatPerVbyte }));
    }
    if (path === '/api/wallet/receive/lightning') {
      if (typeof body.amountMsat !== 'string' || typeof body.expirySec !== 'number') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await wallet.createLightningInvoice({ amountMsat: body.amountMsat, expirySec: body.expirySec, assetId: typeof body.assetId === 'string' ? body.assetId : undefined, assetAmount: typeof body.assetAmount === 'string' ? body.assetAmount : undefined }));
    }
    if (path === '/api/wallet/receive/lightning/status') {
      if (typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, { source: 'wdk-lightning', data: await wallet.invoiceStatus(body.invoice) });
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
    if (path === '/api/payments/prepare') {
      if (typeof body.id !== 'string' || typeof body.invoice !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await payments.prepare({ id: body.id, invoice: body.invoice, amountMsat: typeof body.amountMsat === 'string' ? body.amountMsat : undefined, constraints: body.constraints, routing: body.routing ?? { algorithm: 'ldk_dijkstra' } }));
    }
    if (path === '/api/payments/confirm') {
      if (typeof body.id !== 'string') return json(res, 400, { code: 'INVALID_INPUT' });
      return json(res, 200, await payments.confirm(body.id));
    }
    return json(res, 404, { code: 'NOT_FOUND', message: 'Operazione non disponibile sul wallet utente WDK. I planner MPP restano sui nodi della fork.' });
  } catch (error) {
    if (error instanceof WalletError || error instanceof VaultError) return json(res, 422, { code: error.code, message: error.message });
    if (error instanceof SyntaxError) return json(res, 400, { code: 'INVALID_JSON' });
    return json(res, 503, { code: 'WDK_UNAVAILABLE', message: error instanceof Error ? error.message : 'Operazione WDK non disponibile' });
  }
});
server.listen(port, bindHost, () => console.log(`AIR-GB user wallet: http://127.0.0.1:${port}`));
const stop = () => { wallet.shutdown(); server.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
