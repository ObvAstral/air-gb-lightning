import React, { useState } from 'react';

export type ServiceHealth = {
  api?: string;
  rln?: string;
  qvac?: string;
  network?: string;
};

export type NodeWalletState = {
  keystoreExists: boolean;
  node: string;
  network: string;
  sendEnabled: boolean;
};

export type LeftServiceSidebarProps = {
  health: ServiceHealth;
  healthLoading: boolean;
  onRefreshHealth: () => Promise<void>;
  chainHeight: number | null;
  chainBusy: boolean;
  chainMessage: string;
  chainError: string;
  hasOnlineChainNode: boolean;
  onReadHeight: () => Promise<void>;
  onMineBlocksAndSync: (blocks: number) => Promise<void>;
  onSyncAllNodes: () => Promise<void>;
  activeNodeId: string;
  activeNodeLabel: string;
  activeNodePort: number;
  activeNodeOffline: boolean;
  activeNodeState: NodeWalletState | null;
  onSelectActiveNode: (nodeId: string) => void;
  availableNodes: {
    id: string;
    label: string;
    port: number;
    offline: boolean;
    ready: boolean;
  }[];
  onCreateKeystore: (password: string) => Promise<string | null>;
  onImportKeystore: (password: string, mnemonic: string) => Promise<void>;
  onUnlockNode: (password: string) => Promise<void>;
};

function getHealthDotClass(status: string | undefined): 'dot-green' | 'dot-yellow' | 'dot-red' {
  if (!status) return 'dot-red';
  const normalized = status.toLowerCase();
  if (
    normalized === 'ready' ||
    normalized === 'online' ||
    normalized === 'ok' ||
    normalized === 'regtest'
  ) {
    return 'dot-green';
  }
  if (
    normalized.includes('configured') ||
    normalized === 'locked' ||
    normalized === 'degraded' ||
    normalized === 'starting'
  ) {
    return 'dot-yellow';
  }
  return 'dot-red';
}

export function LeftServiceSidebar({
  health,
  healthLoading,
  onRefreshHealth,
  chainHeight,
  chainBusy,
  chainMessage,
  chainError,
  hasOnlineChainNode,
  onReadHeight,
  onMineBlocksAndSync,
  onSyncAllNodes,
  activeNodeId,
  activeNodeLabel,
  activeNodePort,
  activeNodeOffline,
  activeNodeState,
  onSelectActiveNode,
  availableNodes,
  onCreateKeystore,
  onImportKeystore,
  onUnlockNode,
}: LeftServiceSidebarProps) {
  const [keystoreMode, setKeystoreMode] = useState<'create' | 'import'>('create');
  const [password, setPassword] = useState('');
  const [mnemonic, setMnemonic] = useState('');
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [keystoreBusy, setKeystoreBusy] = useState(false);
  const [keystoreError, setKeystoreError] = useState('');
  const [keystoreNotice, setKeystoreNotice] = useState('');

  const wordCount = mnemonic
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  const readyNodesCount = availableNodes.filter(n => n.ready).length;

  async function handleCreate() {
    if (password.length < 12) {
      setKeystoreError('Password must contain at least 12 characters.');
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      const phrase = await onCreateKeystore(password);
      setPassword('');
      if (phrase) {
        setRecoveryPhrase(phrase);
        setRecoveryConfirmed(false);
      }
      setKeystoreNotice(`Vault created for ${activeNodeLabel}.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  async function handleImport() {
    if (password.length < 12) {
      setKeystoreError('Password must contain at least 12 characters.');
      return;
    }
    if (wordCount !== 12) {
      setKeystoreError(`Enter a valid 12-word BIP39 seed phrase (found: ${wordCount}).`);
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      await onImportKeystore(password, mnemonic.trim());
      setPassword('');
      setMnemonic('');
      setKeystoreNotice(`Seed imported on ${activeNodeLabel}.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  async function handleUnlock() {
    if (!password) {
      setKeystoreError('Enter the node password to unlock.');
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      await onUnlockNode(password);
      setPassword('');
      setKeystoreNotice(`Node ${activeNodeLabel} unlocked and ready.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  return (
    <aside className="left-sidebar" aria-label="Infrastructure, Chain Controls and Node Selector">
      {/* 1. ACTIVE NODE SWITCHER & VAULT ACCESS */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">ACTIVE OPERATOR NODE</span>
            <h2>Node Selector &amp; Access</h2>
          </div>
          <span
            className={`status-pill ${
              activeNodeOffline
                ? 'pill-danger'
                : activeNodeState?.node === 'ready'
                  ? 'pill-success'
                  : activeNodeState?.keystoreExists
                    ? 'pill-warning'
                    : 'pill-neutral'
            }`}
          >
            {activeNodeOffline
              ? 'OFFLINE'
              : activeNodeState?.node === 'ready'
                ? 'READY'
                : activeNodeState?.keystoreExists
                  ? 'LOCKED'
                  : 'NO VAULT'}
          </span>
        </div>

        <label className="compact-label">
          Operating as Node
          <select
            value={activeNodeId}
            onChange={e => {
              setKeystoreError('');
              setKeystoreNotice('');
              onSelectActiveNode(e.target.value);
            }}
          >
            {availableNodes.map(n => (
              <option key={n.id} value={n.id}>
                {n.label} (:{n.port}) — {n.offline ? 'OFFLINE' : n.ready ? 'READY' : 'LOCKED'}
              </option>
            ))}
          </select>
        </label>

        {recoveryPhrase && (
          <div className="recovery-vault-alert" role="alert">
            <div className="recovery-header">
              <strong>BIP39 Recovery Phrase (Shown Once)</strong>
            </div>
            <div className="mnemonic-grid">
              {recoveryPhrase.split(/\s+/).map((word, idx) => (
                <div key={`${word}-${idx}`} className="mnemonic-word">
                  <span className="word-index">{idx + 1}.</span>
                  <code>{word}</code>
                </div>
              ))}
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={recoveryConfirmed}
                onChange={e => setRecoveryConfirmed(e.target.checked)}
              />
              <span>I have saved the seed phrase</span>
            </label>
            <button
              type="button"
              className="btn-rgb full-width"
              disabled={!recoveryConfirmed}
              onClick={() => {
                setRecoveryPhrase(null);
                setRecoveryConfirmed(false);
              }}
            >
              Done
            </button>
          </div>
        )}

        {!activeNodeOffline && !activeNodeState?.keystoreExists && (
          <div className="keystore-form">
            <div className="subtab-pills">
              <button
                type="button"
                className={keystoreMode === 'create' ? 'active' : ''}
                onClick={() => {
                  setKeystoreMode('create');
                  setKeystoreError('');
                }}
              >
                New Vault
              </button>
              <button
                type="button"
                className={keystoreMode === 'import' ? 'active' : ''}
                onClick={() => {
                  setKeystoreMode('import');
                  setKeystoreError('');
                }}
              >
                Import Seed
              </button>
            </div>

            <label className="compact-label">
              Vault Password (min. 12 chars)
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 12 characters..."
              />
            </label>

            {keystoreMode === 'import' && (
              <label className="compact-label">
                BIP39 Seed (12 words)
                <textarea
                  rows={2}
                  value={mnemonic}
                  onChange={e => setMnemonic(e.target.value)}
                  placeholder="word1 word2 ... word12"
                  autoComplete="off"
                />
              </label>
            )}

            <button
              type="button"
              className="btn-rgb full-width"
              disabled={
                keystoreBusy ||
                password.length < 12 ||
                (keystoreMode === 'import' && wordCount !== 12)
              }
              onClick={() => void (keystoreMode === 'create' ? handleCreate() : handleImport())}
            >
              {keystoreBusy
                ? 'Processing...'
                : keystoreMode === 'create'
                  ? `Create Vault on ${activeNodeLabel}`
                  : `Import Seed on ${activeNodeLabel}`}
            </button>
          </div>
        )}

        {!activeNodeOffline &&
          activeNodeState?.keystoreExists &&
          activeNodeState.node !== 'ready' && (
            <div className="keystore-form">
              <label className="compact-label">
                Unlock {activeNodeLabel} (:{activeNodePort})
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter vault password..."
                />
              </label>
              <button
                type="button"
                className="btn-rgb full-width"
                disabled={keystoreBusy || !password}
                onClick={() => void handleUnlock()}
              >
                {keystoreBusy ? 'Unlocking RLN Daemon...' : `Unlock ${activeNodeLabel}`}
              </button>
            </div>
          )}

        {activeNodeState?.node === 'ready' && (
          <div className="keystore-ready-summary">
            <div className="kv-row">
              <span>RLN Daemon</span>
              <strong className="text-emerald">Online &amp; Unlocked</strong>
            </div>
            <div className="kv-row">
              <span>Lightning Send</span>
              <strong className={activeNodeState.sendEnabled ? 'text-emerald' : 'text-amber'}>
                {activeNodeState.sendEnabled ? 'Enabled' : 'Disabled'}
              </strong>
            </div>
            <div className="kv-row">
              <span>Ready Topology Nodes</span>
              <strong>
                {readyNodesCount}/{availableNodes.length}
              </strong>
            </div>
          </div>
        )}

        {keystoreNotice && (
          <div className="notice compact-notice" role="status">
            {keystoreNotice}
          </div>
        )}
        {keystoreError && (
          <div className="error compact-notice" role="alert">
            {keystoreError}
          </div>
        )}
      </section>

      {/* 2. SIMPLIFIED CHAIN CONTROLS (AUTO-SYNC AFTER MINING) */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">BITCOIN REGTEST · ELECTRS</span>
            <h2>ChainControls</h2>
          </div>
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={chainBusy || !hasOnlineChainNode}
            onClick={() => void onReadHeight()}
          >
            ↻ Height
          </button>
        </div>

        <div className="chain-height-box">
          <span className="muted-label">Block Height</span>
          <strong className="chain-height-value">
            {chainHeight !== null ? `#${chainHeight.toLocaleString()}` : '—'}
          </strong>
        </div>

        <p className="muted-text">
          Mining automatically synchronizes all unlocked RLN nodes and refreshes balances.
        </p>

        <div className="button-stack">
          <button
            type="button"
            className="btn-lightning"
            disabled={chainBusy || !hasOnlineChainNode}
            onClick={() => void onMineBlocksAndSync(1)}
            title="Mines 1 block to the miner wallet and syncs all nodes (confirms UTXOs and L1 transfers)"
          >
            {chainBusy ? 'Mining & Syncing...' : '⛏️ +1 Block & Sync (Confirm UTXO / L1)'}
          </button>
          <button
            type="button"
            className="btn-rgb"
            disabled={chainBusy || !hasOnlineChainNode}
            onClick={() => void onMineBlocksAndSync(6)}
            title="Mines 6 blocks and syncs all nodes so pending Lightning channels become READY"
          >
            {chainBusy ? 'Mining & Syncing...' : '⚡ +6 Blocks & Sync (Activate Channels)'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={chainBusy || !hasOnlineChainNode}
            onClick={() => void onSyncAllNodes()}
          >
            {chainBusy ? 'Synchronizing...' : '🔄 Sync All Nodes Only'}
          </button>
        </div>

        {chainMessage && (
          <div className="notice compact-notice" role="status">
            {chainMessage}
          </div>
        )}
        {chainError && (
          <div className="error compact-notice" role="alert">
            {chainError}
          </div>
        )}
      </section>

      {/* 3. SERVICE HEALTH MATRIX */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">SYSTEM STATUS</span>
            <h2>Service Health</h2>
          </div>
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={healthLoading}
            onClick={() => void onRefreshHealth()}
          >
            {healthLoading ? '...' : '↻ Poll'}
          </button>
        </div>

        <div className="health-grid">
          <div className="health-item">
            <span className="health-label">
              <span className={`status-dot ${getHealthDotClass(health.api)}`} />
              Node REST API
            </span>
            <span className="mono-badge">{health.api ?? 'offline'}</span>
          </div>

          <div className="health-item">
            <span className="health-label">
              <span className={`status-dot ${getHealthDotClass(health.rln)}`} />
              RLN Daemon ({activeNodeLabel})
            </span>
            <span className="mono-badge">{health.rln ?? 'unknown'}</span>
          </div>

          <div className="health-item">
            <span className="health-label">
              <span className={`status-dot ${getHealthDotClass(health.qvac)}`} />
              QVAC AI (:11434)
            </span>
            <span className="mono-badge">{health.qvac ?? 'unknown'}</span>
          </div>
        </div>
      </section>
    </aside>
  );
}
