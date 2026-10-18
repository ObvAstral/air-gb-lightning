import React, { useMemo, useState } from 'react';
import type { RegtestNodeSnapshot } from './RightNodesInspector.js';

export type TerminalLogEntry = {
  id: string;
  timestamp: number | null;
  nodeId: string;
  nodeLabel: string;
  nodePort: number;
  kind: 'LIGHTNING_INTENT' | 'NODE_PAYMENT' | 'ONCHAIN_BTC';
  status: string;
  paymentHash: string | null;
  amountMsat: string | null;
  assetId: string | null;
  assetAmount: string | null;
  algorithm: string | null;
  routingDetails: string | null;
};

export type TxTerminalViewProps = {
  nodes: RegtestNodeSnapshot[];
  initialNodeFilter?: string;
  busy: boolean;
  onRefreshAll: () => Promise<void>;
};

function formatNumber(val: string | number | null | undefined): string {
  if (val === null || val === undefined || val === '') return '0';
  const n = Number(val);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(val);
}

function formatTime(ts: number | null): string {
  if (!ts || !Number.isFinite(ts)) return '--:--:--';
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function TxTerminalView({
  nodes,
  initialNodeFilter = 'all',
  busy,
  onRefreshAll,
}: TxTerminalViewProps) {
  const [nodeFilter, setNodeFilter] = useState<string>(initialNodeFilter);
  const [statusFilter, setStatusFilter] = useState<'all' | 'succeeded' | 'failed' | 'pending'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Build unified read-only transaction log from all nodes
  const entries = useMemo<TerminalLogEntry[]>(() => {
    const list: TerminalLogEntry[] = [];

    for (const node of nodes) {
      const seenHashes = new Set<string>();
      const tickerMap = new Map<string, string>();
      for (const a of node.assets) {
        if (a.assetId && a.ticker) tickerMap.set(a.assetId, a.ticker);
      }

      // 1. Reconciled Payment Intents (/api/payments)
      for (const intent of node.intents) {
        if (intent.paymentHash) seenHashes.add(intent.paymentHash.toLowerCase());
        const routingParts: string[] = [`alg=${intent.routing.algorithm}`];
        if (intent.routing.max_fee_msat !== undefined) {
          routingParts.push(`max_fee=${intent.routing.max_fee_msat}msat`);
        }
        if (intent.routing.max_paths !== undefined) {
          routingParts.push(`max_paths=${intent.routing.max_paths}`);
        }
        if (intent.routing.excluded_nodes?.length) {
          routingParts.push(`excl=${intent.routing.excluded_nodes.length}`);
        }
        if (intent.routing.algorithm === 'multi_objective' && intent.routing.weights) {
          const w = intent.routing.weights;
          routingParts.push(`w=[f:${w.fee},r:${w.reliability},c:${w.cltv},h:${w.hops}]`);
        }

        const ticker = intent.assetId ? tickerMap.get(intent.assetId) ?? 'RGB' : 'BTC';
        list.push({
          id: `intent-${node.id}-${intent.id}`,
          timestamp: intent.updatedAt || intent.createdAt || null,
          nodeId: node.id,
          nodeLabel: node.label,
          nodePort: node.port,
          kind: 'LIGHTNING_INTENT',
          status: intent.status.toUpperCase(),
          paymentHash: intent.paymentHash,
          amountMsat: intent.amountMsat,
          assetId: intent.assetId ? `${ticker} (${intent.assetId.slice(0, 14)}…)` : 'BTC',
          assetAmount: intent.assetAmount,
          algorithm: intent.routing.algorithm,
          routingDetails: routingParts.join(' · '),
        });
      }

      // 2. Native RLN Payment History (/api/wallet/history) not already in intents
      node.history.forEach((tx, idx) => {
        const hashKey = tx.paymentHash?.toLowerCase() ?? '';
        if (hashKey && seenHashes.has(hashKey)) return;
        const ticker = tx.assetId ? tickerMap.get(tx.assetId) ?? 'RGB' : 'BTC';
        list.push({
          id: `hist-${node.id}-${tx.paymentHash ?? idx}`,
          timestamp: null,
          nodeId: node.id,
          nodeLabel: node.label,
          nodePort: node.port,
          kind: 'NODE_PAYMENT',
          status: (tx.status || 'UNKNOWN').toUpperCase(),
          paymentHash: tx.paymentHash,
          amountMsat: tx.amountMsat,
          assetId: tx.assetId ? `${ticker} (${tx.assetId.slice(0, 14)}…)` : 'BTC',
          assetAmount: tx.assetAmount,
          algorithm: null,
          routingDetails: 'native-rln-ledger',
        });
      });

      // 3. On-chain Bitcoin transactions (/api/wallet/history/bitcoin)
      node.bitcoinTxs.forEach((rawTx, idx) => {
        if (!rawTx || typeof rawTx !== 'object') return;
        const row = rawTx as Record<string, unknown>;
        const txid = typeof row.txid === 'string' ? row.txid : null;
        const txType = typeof row.transaction_type === 'string' ? row.transaction_type : 'ONCHAIN';
        const received = Number(row.received ?? 0);
        const sent = Number(row.sent ?? 0);
        const netSat = Math.abs(received - sent);
        const confTime =
          row.confirmation_time && typeof row.confirmation_time === 'object'
            ? Number((row.confirmation_time as Record<string, unknown>).timestamp ?? 0) * 1000
            : null;

        list.push({
          id: `btc-${node.id}-${txid ?? idx}`,
          timestamp: confTime && confTime > 0 ? confTime : null,
          nodeId: node.id,
          nodeLabel: node.label,
          nodePort: node.port,
          kind: 'ONCHAIN_BTC',
          status: confTime ? 'CONFIRMED' : 'MEMPOOL',
          paymentHash: txid,
          amountMsat: netSat > 0 ? String(netSat * 1000) : null,
          assetId: `BTC (${txType})`,
          assetAmount: netSat > 0 ? `${formatNumber(netSat)} sat` : null,
          algorithm: 'bitcoin-l1',
          routingDetails: `tx_type=${txType}`,
        });
      });
    }

    return list.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }, [nodes]);

  const filteredEntries = useMemo(() => {
    return entries.filter(item => {
      if (nodeFilter !== 'all' && item.nodeId !== nodeFilter) return false;
      if (statusFilter !== 'all') {
        const st = item.status.toLowerCase();
        if (
          statusFilter === 'succeeded' &&
          !st.includes('succeed') &&
          !st.includes('settled') &&
          !st.includes('confirmed')
        ) {
          return false;
        }
        if (statusFilter === 'failed' && !st.includes('fail')) return false;
        if (
          statusFilter === 'pending' &&
          !st.includes('pend') &&
          !st.includes('prepar') &&
          !st.includes('mempool')
        ) {
          return false;
        }
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const hay = [
          item.nodeLabel,
          item.status,
          item.paymentHash ?? '',
          item.assetId ?? '',
          item.algorithm ?? '',
          item.routingDetails ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, nodeFilter, searchQuery, statusFilter]);

  return (
    <section className="workspace-panel terminal-panel" aria-label="Read-Only Transaction Terminal">
      <div className="panel-header">
        <div>
          <span className="eyebrow text-emerald">READ-ONLY AUDIT STREAM</span>
          <h2>📟 Transaction Terminal · All Nodes Ledger ({filteredEntries.length})</h2>
        </div>
        <div className="inline-actions">
          <span className="mono-badge">MODE: READ-ONLY</span>
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={busy}
            onClick={() => void onRefreshAll()}
          >
            {busy ? 'Refreshing...' : '↻ Refresh All Nodes'}
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="terminal-toolbar">
        <label className="compact-label">
          Filter by Node
          <select value={nodeFilter} onChange={e => setNodeFilter(e.target.value)}>
            <option value="all">All Topology Nodes ({entries.length} records)</option>
            {nodes.map(n => (
              <option key={n.id} value={n.id}>
                {n.label} (:{n.port})
              </option>
            ))}
          </select>
        </label>

        <label className="compact-label">
          Filter by Status
          <select
            value={statusFilter}
            onChange={e =>
              setStatusFilter(e.target.value as 'all' | 'succeeded' | 'failed' | 'pending')
            }
          >
            <option value="all">All Statuses</option>
            <option value="succeeded">Succeeded / Confirmed</option>
            <option value="pending">Prepared / Pending</option>
            <option value="failed">Failed</option>
          </select>
        </label>

        <label className="compact-label">
          Search Hash / Asset / Algorithm
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter by hash, node, DEMO, ldk_dijkstra..."
          />
        </label>
      </div>

      {/* Read-Only Monospace Terminal Window */}
      <div className="terminal-window" role="log" aria-live="polite">
        <div className="terminal-window-bar">
          <div className="terminal-dots">
            <span className="term-dot dot-red" />
            <span className="term-dot dot-yellow" />
            <span className="term-dot dot-green" />
          </div>
          <span className="terminal-title">
            airgb-regtest://ledger/transactions — [READ-ONLY] — showing {filteredEntries.length} of{' '}
            {entries.length} entries
          </span>
        </div>

        <div className="terminal-body">
          {filteredEntries.length === 0 ? (
            <div className="terminal-empty">
              $ No transactions match the current filter. Execute a payment in QVAC AI Copilot or
              Guided Manual TX to see live entries here.
            </div>
          ) : (
            filteredEntries.map((entry, idx) => {
              const stLower = entry.status.toLowerCase();
              const toneClass =
                stLower.includes('succeed') ||
                stLower.includes('settled') ||
                stLower.includes('confirmed')
                  ? 'term-status-ok'
                  : stLower.includes('fail')
                    ? 'term-status-err'
                    : 'term-status-warn';

              return (
                <div key={entry.id} className="terminal-line">
                  <span className="term-idx">#{String(filteredEntries.length - idx).padStart(3, '0')}</span>
                  <span className="term-time">[{formatTime(entry.timestamp)}]</span>
                  <span className="term-node">
                    {entry.nodeLabel}(:{entry.nodePort})
                  </span>
                  <span className={`term-status ${toneClass}`}>{entry.status}</span>
                  <span className="term-kind">{entry.kind}</span>
                  <span className="term-amount">
                    {entry.assetAmount
                      ? `${entry.assetAmount} · ${entry.assetId ?? 'RGB'}`
                      : `${formatNumber(entry.amountMsat)} msat · ${entry.assetId ?? 'BTC'}`}
                  </span>
                  {entry.amountMsat && entry.assetAmount && (
                    <span className="term-msat">({formatNumber(entry.amountMsat)} msat)</span>
                  )}
                  {entry.routingDetails && (
                    <span className="term-routing">[{entry.routingDetails}]</span>
                  )}
                  <span className="term-hash" title={entry.paymentHash ?? ''}>
                    hash={entry.paymentHash ? `${entry.paymentHash.slice(0, 16)}…` : 'n/a'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
