import { check, normalizeStatus } from './common.mjs';

class Http {
  constructor(topology, config, native = false) {
    Object.assign(this, { topology, config, native }); this.tokens = new Map();
  }
  base(node) {
    const entry = this.topology.nodes.find(n => n.id === node);
    const value = this.config.nodes?.[node]?.url ?? (!this.native ? `http://127.0.0.1:${entry.apiPort}` : null);
    check(value, `Configure nodes.${node}.url for the stock daemon REST API`);
    const url = new URL(value);
    check(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Benchmark APIs must be local HTTP');
    return url.origin;
  }
  async request(node, path, body) {
    const base = this.base(node);
    const headers = { 'content-type': 'application/json' };
    if (!this.native) {
      if (!this.tokens.has(node)) {
        const response = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
        check(response.ok, `Session HTTP ${response.status}: ${node}`);
        const session = await response.json(); check(typeof session.token === 'string', 'Missing session token');
        this.tokens.set(node, session.token);
      }
      headers['x-session-token'] = this.tokens.get(node); headers.origin = base;
    } else {
      const variable = this.config.nodes?.[node]?.authorizationEnv;
      if (variable) { check(process.env[variable], `Missing ${variable}`); headers.authorization = process.env[variable]; }
    }
    // No retries for mutations. A lost HTTP response does not imply failure.
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 120000) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${node} ${path}: HTTP ${response.status}, ${data.code ?? data.name ?? data.error ?? 'request failed'}`);
    return data;
  }
}

export function createAirgbAdapter({ topology, config }) {
  const http = new Http(topology, config);
  return {
    name: 'airgb-service',
    async metadata() {
      const capabilities = await http.request(topology.nodes[0].id, '/api/routing/capabilities');
      return { capabilities, backend: capabilities.backendVersion, mode: 'ai' };
    },
    async snapshot() {
      const result = {};
      for (const { id } of topology.nodes) {
        const health = await http.request(id, '/api/health');
        check(health.network === 'regtest' && health.rln === 'ready', `Unlock regtest node ${id} before running`);
        const summary = await http.request(id, '/api/wallet/summary');
        result[id] = { nodeId: summary.nodeId, channels: await http.request(id, '/api/wallet/channels') };
      }
      return result;
    },
    async history() {
      const result = {};
      for (const { id } of topology.nodes) {
        const history = await http.request(id, '/api/routing/telemetry');
        check(!history.activeFixture, `Synthetic history is active on ${id}`);
        result[id] = history;
      }
      return result;
    },
    async invoice(c) {
      return (await http.request(c.recipient, '/api/wallet/receive/lightning', {
        amountMsat: c.amountMsat, expirySec: 3600,
        ...(c.asset ? { assetId: config.assets[c.asset], assetAmount: c.assetAmount } : {}),
      })).invoice;
    },
    async select(c, invoice, snapshot) {
      const telemetry = await http.request(c.sender, '/api/routing/telemetry');
      check(!telemetry.activeFixture, `Synthetic history is active on sender ${c.sender}`);
      const decision = await http.request(c.sender, '/api/routing/select-algorithm', { invoice,
        userPreference: c.userPreference, requireModelDecision: true,
        // Supplying actual channels prevents the service's synthetic-fixture fallback.
        channels: snapshot[c.sender].channels,
        knownNodes: Object.entries(snapshot).map(([alias, row]) => ({ alias, pubkey: row.nodeId })),
      });
      check(decision.selectionSource === 'qvac_with_guardrails' && decision.modelDecision,
        'Valid QVAC algorithm inference required; update the service before benchmarking');
      check(Number.isInteger(decision.recommendedRouting?.max_paths) && decision.recommendedRouting.max_paths >= 1,
        'QVAC did not produce a valid path limit');
      return decision;
    },
    async prepare(c, invoice, decision, id) {
      return http.request(c.sender, '/api/payments/prepare', { id, invoice, routing: decision.recommendedRouting });
    },
    async send(c, handle) { return http.request(c.sender, '/api/payments/confirm', { id: handle.id }); },
    async status(c, handle) {
      const sender = await http.request(c.sender, `/api/payments/${encodeURIComponent(handle.id)}`);
      const receiver = await http.request(c.recipient, '/api/wallet/receive/lightning/status', { invoice: handle.invoice });
      return { sender: normalizeStatus(sender.status), receiver: normalizeStatus(receiver.data?.status),
        nativePaymentId: sender.nativePaymentId, paymentHash: sender.paymentHash };
    },
  };
}

// REST adapter for an independently deployed, UNMODIFIED RGB Lightning node.
// It never passes the fork-specific `routing` object to /sendpayment.
// Nodes and local log directories must be mapped in config for that repository.
export function createStockAdapter({ topology, config }) {
  check(config.baseline?.mpp === false && config.baseline?.routing === 'stock', 'Baseline must declare stock routing without MPP');
  check(/^[0-9a-f]{40}$/.test(config.baseline?.repositoryCommit ?? ''), 'Pin the actual stock repository commit in baseline.repositoryCommit');
  const http = new Http(topology, config, true);
  const str = value => value === null || value === undefined ? null : String(value);
  return {
    name: 'rgb-lightning-stock-rest',
    async metadata() { return { mode: 'baseline', backend: config.baseline.repositoryCommit, mpp: false, routing: 'stock' }; },
    async snapshot() {
      const result = {};
      for (const { id } of topology.nodes) {
        const info = await http.request(id, '/nodeinfo');
        const network = await http.request(id, '/networkinfo');
        check(String(network.network).toLowerCase() === 'regtest', `Stock node ${id} is not regtest`);
        const { channels } = await http.request(id, '/listchannels');
        check(Array.isArray(channels), `Missing channels for ${id}`);
        result[id] = { nodeId: info.pubkey, channels: channels.map(ch => ({
          channelId: ch.channel_id, peerNodeId: ch.peer_pubkey ?? ch.peer_node_id,
          capacitySat: str(ch.capacity_sat), outboundMsat: str(ch.outbound_balance_msat ?? ch.outbound_capacity_msat),
          inboundMsat: str(ch.inbound_balance_msat), assetId: ch.asset_id ?? null,
          assetLocalAmount: str(ch.asset_local_amount), assetRemoteAmount: str(ch.asset_remote_amount), isUsable: ch.is_usable,
        })) };
      }
      return result;
    },
    async invoice(c) {
      return (await http.request(c.recipient, '/lninvoice', { amt_msat: Number(c.amountMsat), expiry_sec: 3600,
        ...(c.asset ? { asset_id: config.assets[c.asset], asset_amount: Number(c.assetAmount) } : {}),
      })).invoice;
    },
    async select() { return { selectionSource: 'stock', recommendedRouting: null }; },
    async prepare(c, invoice, _decision, id) {
      const decoded = await http.request(c.sender, '/decodelninvoice', { invoice });
      check(decoded.network?.toLowerCase() === 'regtest' && /^[0-9a-f]{64}$/.test(decoded.payment_hash), 'Invalid regtest invoice');
      check(String(decoded.amt_msat) === c.amountMsat && (decoded.asset_id ?? null) === (c.asset ? config.assets[c.asset] : null), 'Invoice mismatch');
      if (c.asset) check(String(decoded.asset_amount) === c.assetAmount, 'RGB invoice amount mismatch');
      return { id, invoice, paymentHash: decoded.payment_hash };
    },
    async send(c, handle) {
      return http.request(c.sender, '/sendpayment', { invoice: handle.invoice,
        ...(c.asset ? { asset_id: config.assets[c.asset], asset_amount: Number(c.assetAmount) } : {}),
      });
    },
    async status(c, handle) {
      const sender = await http.request(c.sender, '/getpayment', { payment_hash: handle.paymentHash });
      const receiver = await http.request(c.recipient, '/invoicestatus', { invoice: handle.invoice });
      return { sender: normalizeStatus(sender.payment?.status), receiver: normalizeStatus(receiver.status), paymentHash: handle.paymentHash };
    },
  };
}
