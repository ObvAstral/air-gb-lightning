import React, { useState } from 'react';
import type { PaymentRouting } from '../../../../packages/contracts/types.js';
import type { NodeWalletState } from './LeftServiceSidebar.js';

export type NodeSummaryInfo = {
  network?: string;
  address: string;
  nodeId: string;
  peerUri: string | null;
  btcSpendableSat: string;
  nodeInfo?: Record<string, unknown>;
  networkInfo?: Record<string, unknown>;
};

export type NodeChannelRow = {
  channelId: string | null;
  peerNodeId: string | null;
  assetId: string | null;
  capacitySat: string | null;
  outboundMsat: string | null;
  inboundMsat: string | null;
  assetLocalAmount: string | null;
  assetRemoteAmount: string | null;
  isUsable: boolean | null;
  fundingTxid: string | null;
  public: boolean | null;
};

export type NodeAssetRow = {
  assetId: string | null;
  ticker: string | null;
  name: string | null;
  kind: string | null;
};

export type NodeAssetBalance = {
  assetId: string;
  settled: string | null;
  spendable: string | null;
  future: string | null;
};

export type NodePaymentHistoryRow = {
  paymentHash: string | null;
  status: string;
  amountMsat: string | null;
  assetId: string | null;
  assetAmount: string | null;
};

export type NodePaymentIntentRecord = {
  id: string;
  paymentHash: string;
  invoice: string;
  amountMsat: string;
  assetId: string | null;
  assetAmount: string | null;
  status: 'prepared' | 'unknown' | 'pending' | 'succeeded' | 'failed' | string;
  createdAt: number;
  updatedAt: number;
  nativePaymentId: string | null;
  routing: PaymentRouting;
};

export type RegtestNodeSnapshot = {
  id: string;
  label: string;
  port: number;
  p2pPort: number;
  baseUrl: string;
  directUrl: string;
  accent: 'purple' | 'blue' | 'emerald';
  offline: boolean;
  busy: boolean;
  error: string;
  notice: string;
  state: NodeWalletState | null;
  summary: NodeSummaryInfo | null;
  channels: NodeChannelRow[];
  assets: NodeAssetRow[];
  assetBalances: Record<string, NodeAssetBalance>;
  history: NodePaymentHistoryRow[];
  intents: NodePaymentIntentRecord[];
  bitcoinTxs: unknown[];
  lastInvoice: string;
};

export type CopyableChipProps = {
  label: string;
  value: string | null | undefined;
  truncate?: boolean;
};

export function CopyableChip({ label, value, truncate = true }: CopyableChipProps) {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return (
      <div className="copy-chip copy-chip-empty">
        <span className="chip-key">{label}</span>
        <span className="chip-val muted-text">n/a</span>
      </div>
    );
  }

  const displayValue =
    truncate && value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;

  async function handleCopy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Ignore clipboard errors */
    }
  }

  return (
    <div className="copy-chip">
      <div className="chip-meta">
        <span className="chip-key">{label}</span>
        <code className="chip-val" title={value}>
          {displayValue}
        </code>
      </div>
      <button
        type="button"
        className={`chip-copy-btn ${copied ? 'copied' : ''}`}
        onClick={() => void handleCopy()}
        title={`Copy ${label}`}
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

export type RightNodesInspectorProps = {
  nodes: RegtestNodeSnapshot[];
  activeNodeId: string;
  inspectedNodeId: string;
  onSelectInspectedNode: (nodeId: string) => void;
  onSelectActiveNode: (nodeId: string) => void;
  onSyncNode: (nodeId: string) => Promise<void>;
  onQuickGenerateInvoice: (nodeId: string) => Promise<void>;
  onUseInvoiceForPayment: (invoice: string, targetPayerNodeId?: string) => void;
  onOpenTerminalTab: (filterNodeId?: string) => void;
};

function formatSats(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === '') return '0';
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString('en-US') : String(val);
}

function computeLiquidityPct(localStr: string | null, remoteStr: string | null): number {
  const local = Number(localStr ?? 0);
  const remote = Number(remoteStr ?? 0);
  if (!Number.isFinite(local) || !Number.isFinite(remote) || local + remote <= 0) return 50;
  return Math.max(4, Math.min(96, Math.round((local / (local + remote)) * 100)));
}

export function RightNodesInspector({
  nodes,
  activeNodeId,
  inspectedNodeId,
  onSelectInspectedNode,
  onSelectActiveNode,
  onSyncNode,
  onQuickGenerateInvoice,
  onUseInvoiceForPayment,
  onOpenTerminalTab,
}: RightNodesInspectorProps) {
  const node = nodes.find(n => n.id === inspectedNodeId) ?? nodes[0];
  const isOperator = node.id === activeNodeId;
  const isReady = node.state?.node === 'ready';

  // Resolve peer alias from pubkey
  const pubkeyToAlias = new Map<string, string>();
  for (const n of nodes) {
    if (n.summary?.nodeId) {
      pubkeyToAlias.set(n.summary.nodeId.toLowerCase(), n.label);
    }
  }

  return (
    <aside className="right-inspector" aria-label="Node Inspector and Transactions">
      <div className="inspector-top-header">
        <div>
          <span className="eyebrow">NODE EXPLORER · LIVE STATE</span>
          <h2>Node Info &amp; TXs</h2>
        </div>
        <button
          type="button"
          className="btn-secondary btn-xs"
          onClick={() => onOpenTerminalTab(node.id)}
          title="Open full Read-Only TX Terminal"
        >
          📟 Full TX Terminal
        </button>
      </div>

      {/* Node Selector Box */}
      <div className="sidebar-card">
        <label className="compact-label">
          Select Node to Inspect
          <select
            value={node.id}
            onChange={e => onSelectInspectedNode(e.target.value)}
            aria-label="Inspect Node"
          >
            {nodes.map(n => (
              <option key={n.id} value={n.id}>
                {n.label} (:{n.port}) —{' '}
                {n.offline
                  ? 'OFFLINE'
                  : n.state?.node === 'ready'
                    ? `${formatSats(n.summary?.btcSpendableSat)} sats · ${n.channels.length} ch · ${n.history.length} tx`
                    : 'LOCKED'}
              </option>
            ))}
          </select>
        </label>

        {/* Quick node pills for the primary topology nodes */}
        <div className="quick-node-pills">
          {nodes.slice(0, 6).map(n => (
            <button
              key={n.id}
              type="button"
              className={`node-pill-btn ${n.id === node.id ? 'active' : ''}`}
              onClick={() => onSelectInspectedNode(n.id)}
            >
              <span
                className={`status-dot ${
                  n.offline ? 'dot-red' : n.state?.node === 'ready' ? 'dot-green' : 'dot-yellow'
                }`}
              />
              {n.label}
            </button>
          ))}
        </div>
      </div>

      {/* Selected Node Detailed Card */}
      <section className={`inspector-node-card node-card-active accent-${node.accent}`}>
        <div className="node-card-header">
          <div className="node-title-group">
            <div>
              <div className="node-name-row">
                <h3>
                  {node.label} <span className="port-tag">API :{node.port} · P2P :{node.p2pPort}</span>
                </h3>
                {isOperator && <span className="active-operator-badge">ACTIVE SENDER</span>}
              </div>
              <div className="node-sub-badges">
                <span
                  className={`status-pill ${
                    node.offline
                      ? 'pill-danger'
                      : isReady
                        ? 'pill-success'
                        : node.state?.keystoreExists
                          ? 'pill-warning'
                          : 'pill-neutral'
                  }`}
                >
                  {node.offline
                    ? 'OFFLINE'
                    : isReady
                      ? 'READY · UNLOCKED'
                      : node.state?.keystoreExists
                        ? 'LOCKED'
                        : 'NO VAULT'}
                </span>
                {node.state?.sendEnabled && (
                  <span className="status-pill pill-lightning">SEND ON</span>
                )}
              </div>
            </div>
          </div>

          <div className="node-header-actions">
            {!isOperator && (
              <button
                type="button"
                className="btn-secondary btn-xs"
                onClick={() => onSelectActiveNode(node.id)}
                title={`Switch operator to ${node.label}`}
              >
                Set as Operator
              </button>
            )}
            <button
              type="button"
              className="btn-secondary btn-xs"
              disabled={node.busy || node.offline || !isReady}
              onClick={() => void onSyncNode(node.id)}
              title={`Synchronize ${node.label}`}
            >
              {node.busy ? '...' : '↻ Sync'}
            </button>
          </div>
        </div>

        {node.offline && (
          <div className="error compact-notice" role="alert">
            Node {node.label} unreachable at {node.directUrl}.
          </div>
        )}
        {node.error && (
          <div className="error compact-notice" role="alert">
            {node.error}
          </div>
        )}
        {node.notice && (
          <div className="notice compact-notice" role="status">
            {node.notice}
          </div>
        )}

        {/* Metrics Strip */}
        <div className="node-metrics-strip">
          <div className="metric-cell">
            <span className="metric-label">Spendable BTC</span>
            <strong className="metric-value">
              {formatSats(node.summary?.btcSpendableSat)} <small>sats</small>
            </strong>
          </div>
          <div className="metric-cell">
            <span className="metric-label">Ready Channels</span>
            <strong className="metric-value">
              {node.channels.filter(c => c.isUsable).length}/{node.channels.length}
            </strong>
          </div>
          <div className="metric-cell">
            <span className="metric-label">Transactions</span>
            <strong className="metric-value">
              {Math.max(node.history.length, node.intents.length)}
            </strong>
          </div>
        </div>

        {/* Identity Chips */}
        <div className="chips-stack">
          <CopyableChip label="Node Pubkey" value={node.summary?.nodeId} />
          <CopyableChip label="Peer URI" value={node.summary?.peerUri} />
          <CopyableChip label="BTC On-Chain" value={node.summary?.address} />
        </div>

        {/* Quick Invoice Generator on Selected Node */}
        <div className="bob-shortcut-box">
          <button
            type="button"
            className="btn-lightning full-width"
            disabled={node.busy || node.offline || !isReady}
            onClick={() => void onQuickGenerateInvoice(node.id)}
          >
            {node.busy
              ? `Generating Invoice on ${node.label}...`
              : `⚡ Generate Test Invoice on ${node.label}`}
          </button>
          {node.lastInvoice && (
            <div className="bob-last-invoice">
              <CopyableChip label={`Latest ${node.label} Invoice`} value={node.lastInvoice} />
              <button
                type="button"
                className="btn-qvac btn-xs full-width"
                onClick={() =>
                  onUseInvoiceForPayment(
                    node.lastInvoice,
                    node.id === activeNodeId ? 'alice' : activeNodeId,
                  )
                }
              >
                ↗ Load Invoice into Payment Form
              </button>
            </div>
          )}
        </div>

        {/* Node Transactions Section */}
        <div className="inspector-subsection">
          <div className="subsection-title-row">
            <h4>Node Transactions ({node.history.length})</h4>
            <button
              type="button"
              className="btn-secondary btn-xs"
              onClick={() => onOpenTerminalTab(node.id)}
            >
              View in Terminal →
            </button>
          </div>
          {node.history.length === 0 && node.intents.length === 0 ? (
            <p className="empty-inline">No transactions recorded on {node.label} yet.</p>
          ) : (
            <div className="structured-list">
              {node.history.slice(0, 6).map((tx, idx) => {
                const matchedIntent = node.intents.find(
                  i =>
                    i.paymentHash &&
                    tx.paymentHash &&
                    i.paymentHash.toLowerCase() === tx.paymentHash.toLowerCase(),
                );
                const statusLower = tx.status.toLowerCase();
                return (
                  <div key={`${tx.paymentHash ?? 'tx'}-${idx}`} className="channel-mini-card">
                    <div className="channel-mini-top">
                      <span
                        className={`status-pill ${
                          statusLower.includes('succeed') || statusLower.includes('settled')
                            ? 'pill-success'
                            : statusLower.includes('fail')
                              ? 'pill-danger'
                              : 'pill-warning'
                        }`}
                      >
                        {tx.status.toUpperCase()}
                      </span>
                      <code className="mono-small" title={tx.paymentHash ?? ''}>
                        {tx.paymentHash ? `${tx.paymentHash.slice(0, 12)}…` : 'no-hash'}
                      </code>
                      <strong className="mono-small">{formatSats(tx.amountMsat)} msat</strong>
                    </div>
                    <div className="liq-labels">
                      <span className="text-emerald">
                        {tx.assetId
                          ? `RGB: ${tx.assetAmount ?? '0'} units (${tx.assetId.slice(0, 14)}…)`
                          : 'Asset: BTC'}
                      </span>
                      {matchedIntent && (
                        <span>Algo: {matchedIntent.routing.algorithm}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Channels & Liquidity */}
        <div className="inspector-subsection">
          <div className="subsection-title-row">
            <h4>Lightning Channels ({node.channels.length})</h4>
          </div>
          {node.channels.length === 0 ? (
            <p className="empty-inline">No open channels on {node.label}.</p>
          ) : (
            <div className="structured-list">
              {node.channels.map((ch, idx) => {
                const btcPct = computeLiquidityPct(ch.outboundMsat, ch.inboundMsat);
                const rgbPct = computeLiquidityPct(ch.assetLocalAmount, ch.assetRemoteAmount);
                const peerLabel = ch.peerNodeId
                  ? pubkeyToAlias.get(ch.peerNodeId.toLowerCase()) ??
                    `${ch.peerNodeId.slice(0, 10)}…`
                  : `ch-#${idx + 1}`;
                return (
                  <div key={ch.channelId ?? idx} className="channel-mini-card">
                    <div className="channel-mini-top">
                      <span
                        className={`status-pill ${ch.isUsable ? 'pill-success' : 'pill-warning'}`}
                      >
                        {ch.isUsable ? 'READY' : 'PENDING'}
                      </span>
                      <strong className="mono-small">Peer: {peerLabel}</strong>
                      <span className="cap-badge">{formatSats(ch.capacitySat)} sat</span>
                    </div>

                    <div className="liquidity-mini-row">
                      <div className="liq-labels">
                        <span>Out: {formatSats(ch.outboundMsat)} msat</span>
                        <span>In: {formatSats(ch.inboundMsat)} msat</span>
                      </div>
                      <div className="liquidity-bar-track">
                        <div
                          className="liquidity-bar-fill fill-btc"
                          style={{ width: `${btcPct}%` }}
                        />
                      </div>
                    </div>

                    {ch.assetId && (
                      <div className="liquidity-mini-row">
                        <div className="liq-labels">
                          <span className="text-emerald">
                            RGB Local: {formatSats(ch.assetLocalAmount)}
                          </span>
                          <span>Remote: {formatSats(ch.assetRemoteAmount)}</span>
                        </div>
                        <div className="liquidity-bar-track">
                          <div
                            className="liquidity-bar-fill fill-rgb"
                            style={{ width: `${rgbPct}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* RGB Assets */}
        <div className="inspector-subsection">
          <div className="subsection-title-row">
            <h4>RGB Assets ({node.assets.length})</h4>
          </div>
          {node.assets.length === 0 ? (
            <p className="empty-inline">No RGB assets on {node.label}.</p>
          ) : (
            <div className="structured-list">
              {node.assets.map((asset, idx) => {
                const id = asset.assetId ?? '';
                const bal = id ? node.assetBalances[id] : undefined;
                return (
                  <div key={id || idx} className="asset-mini-card">
                    <div className="asset-mini-top">
                      <div>
                        <span className="ticker-badge">{asset.ticker ?? 'RGB'}</span>
                        <strong className="asset-name-text">{asset.name ?? 'Asset'}</strong>
                      </div>
                      <span className="asset-balance-pill">
                        Spendable: <strong>{bal?.spendable ?? bal?.settled ?? '—'}</strong>
                      </span>
                    </div>
                    <CopyableChip label="Contract ID" value={asset.assetId} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </aside>
  );
}
