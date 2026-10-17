import React, { useState } from 'react';
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

export type RegtestNodeSnapshot = {
  id: string;
  label: string;
  port: number;
  baseUrl: string;
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
        <span className="chip-val muted-text">n/d</span>
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
      /* Fallback ignore if clipboard is unavailable */
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
        title={`Copia ${label}`}
      >
        {copied ? '✓ Copiato' : 'Copia'}
      </button>
    </div>
  );
}

export type RightNodesInspectorProps = {
  nodes: RegtestNodeSnapshot[];
  activeNodeId: string;
  onSelectActiveNode: (nodeId: string) => void;
  onSyncNode: (nodeId: string) => Promise<void>;
  onQuickGenerateBobInvoice: (nodeId: string) => Promise<void>;
  onUseInvoiceForPayment: (invoice: string, targetPayerNodeId?: string) => void;
};

function formatSats(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === '') return '0';
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString('it-IT') : String(val);
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
  onSelectActiveNode,
  onSyncNode,
  onQuickGenerateBobInvoice,
  onUseInvoiceForPayment,
}: RightNodesInspectorProps) {
  return (
    <aside className="right-inspector" aria-label="Ispezione Nodi Regtest e Debug">
      <div className="inspector-top-header">
        <div>
          <span className="eyebrow">REGTEST TOPOLOGY · DEBUG</span>
          <h2>Nodi Regtest ({nodes.length})</h2>
        </div>
        <span className="mono-badge">127.0.0.1</span>
      </div>

      <div className="inspector-node-list">
        {nodes.map(node => {
          const isActive = node.id === activeNodeId;
          const isReady = node.state?.node === 'ready';
          const utxoEstimate = node.channels.length + (Number(node.summary?.btcSpendableSat ?? 0) > 0 ? 1 : 0);

          return (
            <section
              key={node.id}
              className={`inspector-node-card ${isActive ? 'node-card-active' : ''} accent-${node.accent}`}
            >
              {/* Header Card Nodo */}
              <div className="node-card-header">
                <div className="node-title-group">
                  <span className={`node-avatar avatar-${node.accent}`}>
                    {node.accent === 'purple' ? '🟣' : '🔵'}
                  </span>
                  <div>
                    <div className="node-name-row">
                      <h3>
                        {node.label} <span className="port-tag">:{node.port}</span>
                      </h3>
                      {isActive && <span className="active-operator-badge">OPERATIVO</span>}
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
                              : 'NO KEYSTORE'}
                      </span>
                      {node.state?.sendEnabled && (
                        <span className="status-pill pill-lightning">SEND ON</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="node-header-actions">
                  {!isActive && (
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={() => onSelectActiveNode(node.id)}
                      title={`Imposta ${node.label} come nodo attivo al centro`}
                    >
                      Usa
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary btn-xs"
                    disabled={node.busy || node.offline || !isReady}
                    onClick={() => void onSyncNode(node.id)}
                    title={`Sincronizza il nodo ${node.label}`}
                  >
                    {node.busy ? '...' : '↻ Sync'}
                  </button>
                </div>
              </div>

              {node.offline && (
                <div className="error compact-notice" role="alert">
                  Nodo {node.label} non raggiungibile su {node.baseUrl}.
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

              {/* Statistiche Rapide Sats & Canali */}
              <div className="node-metrics-strip">
                <div className="metric-cell">
                  <span className="metric-label">BTC Spendibili</span>
                  <strong className="metric-value">
                    {formatSats(node.summary?.btcSpendableSat)} <small>sats</small>
                  </strong>
                </div>
                <div className="metric-cell">
                  <span className="metric-label">Canali LN</span>
                  <strong className="metric-value">
                    {node.channels.filter(c => c.isUsable).length}/{node.channels.length}
                  </strong>
                </div>
                <div className="metric-cell">
                  <span className="metric-label">Asset RGB / UTXO</span>
                  <strong className="metric-value">
                    {node.assets.length} <small>({utxoEstimate} attiva)</small>
                  </strong>
                </div>
              </div>

              {/* Chip Copiabili 1-Click */}
              <div className="chips-stack">
                <CopyableChip label="Node ID" value={node.summary?.nodeId} />
                <CopyableChip label="Peer URI" value={node.summary?.peerUri} />
                <CopyableChip label="BTC On-Chain" value={node.summary?.address} />
              </div>

              {/* Scorciatoia Demo su Bob (e nodi secondari) */}
              {node.id === 'bob' && (
                <div className="bob-shortcut-box">
                  <button
                    type="button"
                    className="btn-lightning full-width"
                    disabled={node.busy || node.offline || !isReady}
                    onClick={() => void onQuickGenerateBobInvoice(node.id)}
                  >
                    {node.busy
                      ? 'Generazione Invoice su Bob...'
                      : '⚡ Genera Invoice Test su Bob'}
                  </button>
                  {node.lastInvoice && (
                    <div className="bob-last-invoice">
                      <CopyableChip label="Ultima Invoice Bob" value={node.lastInvoice} />
                      <button
                        type="button"
                        className="btn-qvac btn-xs full-width"
                        onClick={() => onUseInvoiceForPayment(node.lastInvoice, 'alice')}
                      >
                        ↗ Carica su Alice per Pagamento
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Vista Strutturata Canali */}
              <div className="inspector-subsection">
                <div className="subsection-title-row">
                  <h4>Canali Lightning ({node.channels.length})</h4>
                </div>
                {node.channels.length === 0 ? (
                  <p className="empty-inline">Nessun canale aperto su {node.label}.</p>
                ) : (
                  <div className="structured-list">
                    {node.channels.map((ch, idx) => {
                      const btcPct = computeLiquidityPct(ch.outboundMsat, ch.inboundMsat);
                      const rgbPct = computeLiquidityPct(ch.assetLocalAmount, ch.assetRemoteAmount);
                      return (
                        <div key={ch.channelId ?? idx} className="channel-mini-card">
                          <div className="channel-mini-top">
                            <span
                              className={`status-pill ${
                                ch.isUsable ? 'pill-success' : 'pill-warning'
                              }`}
                            >
                              {ch.isUsable ? 'READY' : 'PENDING'}
                            </span>
                            <code className="mono-small" title={ch.channelId ?? ''}>
                              {ch.channelId ? `${ch.channelId.slice(0, 10)}…` : `ch-#${idx + 1}`}
                            </code>
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

              {/* Vista Strutturata Asset RGB */}
              <div className="inspector-subsection">
                <div className="subsection-title-row">
                  <h4>Asset RGB NIA ({node.assets.length})</h4>
                </div>
                {node.assets.length === 0 ? (
                  <p className="empty-inline">Nessun asset RGB registrato.</p>
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
                              Spendibile: <strong>{bal?.spendable ?? bal?.settled ?? '—'}</strong>
                            </span>
                          </div>
                          <CopyableChip label="Contract ID" value={asset.assetId} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Cassetto <details> Raw JSON */}
              <details className="debug-drawer">
                <summary>Raw JSON (Canali / Asset / Invoice)</summary>
                <pre>
                  {JSON.stringify(
                    {
                      state: node.state,
                      summary: node.summary,
                      channels: node.channels,
                      assets: node.assets,
                      assetBalances: node.assetBalances,
                      lastInvoice: node.lastInvoice || null,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
