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

export type DemoPreset = {
  id: string;
  title: string;
  badge: string;
  description: string;
  targetMode: 'chat' | 'manual';
  manualSubTab?: 'send' | 'receive' | 'channels' | 'l1';
  promptText: string;
  feeLimitSat?: string;
  excludedNode?: string;
  priority?: 'lowest_fee' | 'reliability' | 'balanced';
  privacy?: 'avoid_extra_probing' | 'unspecified' | null;
};

export const DEMO_PRESETS: DemoPreset[] = [
  {
    id: 'low-fee-rgb',
    title: 'Low-Fee tUSDT Transfer',
    badge: 'QVAC + RLN',
    description: 'Send RGB asset with a maximum fee cap of 25 sat and fee savings priority.',
    targetMode: 'chat',
    promptText: 'Send the RGB payment on the current invoice with at most 25 sat in fees and lowest_fee priority.',
    feeLimitSat: '25',
    priority: 'lowest_fee',
    privacy: null,
  },
  {
    id: 'high-reliability-mpp',
    title: 'High-Reliability Multi-Objective',
    badge: 'Multi-Objective',
    description: 'Prioritize channel reliability and reduce HTLC failure risk.',
    targetMode: 'chat',
    promptText: 'Execute this payment prioritizing maximum channel reliability, with a fee limit of at most 100 sat.',
    feeLimitSat: '100',
    priority: 'reliability',
    privacy: null,
  },
  {
    id: 'privacy-single-path',
    title: 'Privacy No-Probing Route',
    badge: 'Privacy',
    description: 'Avoid extra graph probing and force single-path routing.',
    targetMode: 'chat',
    promptText: 'Send the payment and avoid extra probing to maximize privacy, with fees less than 50 sat.',
    feeLimitSat: '50',
    priority: 'balanced',
    privacy: 'avoid_extra_probing',
  },
  {
    id: 'chat-setup-utxo-nia',
    title: 'UTXO Setup & NIA Issuance',
    badge: 'L1 Setup',
    description: 'Propose in chat the preparation of 4 colorable UTXOs or RGB asset issuance.',
    targetMode: 'chat',
    promptText: 'Prepare 4 RGB UTXO of 200000 sat each with fee rate 2 sat/vB on the active node.',
  },
  {
    id: 'manual-compile-preset',
    title: 'Manual Constraints Compiler',
    badge: 'Manual TX',
    description: 'Opens the manual builder pre-configured with multi_objective and constraints ready to compile.',
    targetMode: 'manual',
    manualSubTab: 'send',
    promptText: 'At most 40 sat fee, reliability priority, avoid extra probing.',
    feeLimitSat: '40',
    priority: 'reliability',
    privacy: 'avoid_extra_probing',
  },
];

export type LeftServiceSidebarProps = {
  health: ServiceHealth;
  healthLoading: boolean;
  onRefreshHealth: () => Promise<void>;
  chainHeight: number | null;
  chainBusy: boolean;
  chainMessage: string;
  chainError: string;
  onReadHeight: () => Promise<void>;
  onMineBlocks: (blocks: number) => Promise<void>;
  onSyncAllNodes: () => Promise<void>;
  activeNodeId: string;
  activeNodeLabel: string;
  activeNodePort: number;
  activeNodeOffline: boolean;
  activeNodeState: NodeWalletState | null;
  onSelectActiveNode: (nodeId: string) => void;
  availableNodes: { id: string; label: string; port: number }[];
  onCreateKeystore: (password: string) => Promise<string | null>;
  onImportKeystore: (password: string, mnemonic: string) => Promise<void>;
  onUnlockNode: (password: string) => Promise<void>;
  onApplyPreset: (preset: DemoPreset) => void;
};

function getHealthDotClass(status: string | undefined): 'dot-green' | 'dot-yellow' | 'dot-red' {
  if (!status) return 'dot-red';
  const normalized = status.toLowerCase();
  if (normalized === 'ready' || normalized === 'online' || normalized === 'ok' || normalized === 'regtest') {
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
  onReadHeight,
  onMineBlocks,
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
  onApplyPreset,
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

  const dockerRegtestStatus =
    !activeNodeOffline && (health.network === 'regtest' || chainHeight !== null)
      ? chainHeight !== null
        ? `online (#${chainHeight})`
        : 'regtest ready'
      : activeNodeOffline
        ? 'unreachable'
        : 'checking';

  async function handleCreate() {
    if (password.length < 12) {
      setKeystoreError('Keystore password must contain at least 12 characters.');
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
      setKeystoreNotice(`BIP39 keystore created for ${activeNodeLabel}.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  async function handleImport() {
    if (password.length < 12) {
      setKeystoreError('Keystore password must contain at least 12 characters.');
      return;
    }
    if (wordCount !== 12) {
      setKeystoreError(`Please enter a valid 12-word BIP39 seed phrase (found: ${wordCount}).`);
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      await onImportKeystore(password, mnemonic.trim());
      setPassword('');
      setMnemonic('');
      setKeystoreNotice(`BIP39 seed imported successfully on ${activeNodeLabel}.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  async function handleUnlock() {
    if (!password) {
      setKeystoreError('Please enter the password to unlock the node.');
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      await onUnlockNode(password);
      setPassword('');
      setKeystoreNotice(`Node ${activeNodeLabel} unlocked and operational.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  return (
    <aside className="left-sidebar" aria-label="Services, Chain and Keystore">
      {/* 1. SERVICE HEALTH MATRIX */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">INFRASTRUCTURE</span>
            <h2>Service Health Matrix</h2>
          </div>
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={healthLoading}
            onClick={() => void onRefreshHealth()}
            title="Refresh service status"
          >
            {healthLoading ? '...' : '↻ Poll'}
          </button>
        </div>

        <div className="health-grid">
          <div className="health-item">
            <span className="health-label">
              <span className={`status-dot ${getHealthDotClass(health.api)}`} />
              API Service
            </span>
            <span className="mono-badge">{health.api ?? 'offline'}</span>
          </div>

          <div className="health-item">
            <span className="health-label">
              <span className={`status-dot ${getHealthDotClass(health.rln)}`} />
              RLN Daemon
            </span>
            <span className="mono-badge">{health.rln ?? 'unknown'}</span>
          </div>

          <div className="health-item">
            <span className="health-label">
              <span className={`status-dot ${getHealthDotClass(health.qvac)}`} />
              QVAC AI Engine
            </span>
            <span className="mono-badge">{health.qvac ?? 'unknown'}</span>
          </div>

          <div className="health-item">
            <span className="health-label">
              <span
                className={`status-dot ${
                  dockerRegtestStatus.startsWith('online') || dockerRegtestStatus.includes('ready')
                    ? 'dot-green'
                    : dockerRegtestStatus === 'checking'
                      ? 'dot-yellow'
                      : 'dot-red'
                }`}
              />
              Docker Regtest
            </span>
            <span className="mono-badge">{dockerRegtestStatus}</span>
          </div>
        </div>
      </section>

      {/* 2. CHAIN CONTROLS (REGTEST MINING) */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">BITCOIN L1 · ELECTRS</span>
            <h2>ChainControls (Regtest)</h2>
          </div>
          <button
            type="button"
            className="btn-secondary btn-xs"
            disabled={chainBusy}
            onClick={() => void onReadHeight()}
          >
            Refresh
          </button>
        </div>

        <div className="chain-height-box">
          <span className="muted-label">Current Block Height</span>
          <strong className="chain-height-value">
            {chainHeight !== null ? `#${chainHeight.toLocaleString()}` : 'Not read'}
          </strong>
        </div>

        <div className="button-stack">
          <button
            type="button"
            className="btn-lightning"
            disabled={chainBusy || activeNodeOffline}
            onClick={() => void onMineBlocks(1)}
          >
            {chainBusy ? 'Mining in progress...' : '⛏️ Mine 1 Block (miner)'}
          </button>
          <button
            type="button"
            className="btn-rgb"
            disabled={chainBusy || activeNodeOffline}
            onClick={() => void onMineBlocks(6)}
          >
            {chainBusy ? 'Mining in progress...' : '⚡ +6 Blocks (Confirm LN Channels)'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={chainBusy}
            onClick={() => void onSyncAllNodes()}
          >
            {chainBusy ? 'Synchronizing...' : '🔄 Sync All Nodes'}
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

      {/* 3. KEYSTORE MANAGER (WDK / BIP39) */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">TETHER WDK · VAULT</span>
            <h2>Keystore Manager BIP39</h2>
          </div>
          <span
            className={`status-pill ${
              activeNodeState?.node === 'ready'
                ? 'pill-success'
                : activeNodeState?.keystoreExists
                  ? 'pill-warning'
                  : 'pill-neutral'
            }`}
          >
            {activeNodeState?.node === 'ready'
              ? 'UNLOCKED'
              : activeNodeState?.keystoreExists
                ? 'LOCKED'
                : 'NO VAULT'}
          </span>
        </div>

        <label className="compact-label">
          Target Keystore Node
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
                {n.label} (:{n.port})
              </option>
            ))}
          </select>
        </label>

        {recoveryPhrase && (
          <div className="recovery-vault-alert" role="alert">
            <div className="recovery-header">
              <strong>⚠️ BIP39 Recovery Phrase (Shown only once)</strong>
            </div>
            <p className="muted-text">
              Store these 12 words in a safe place. They cannot be viewed again after closing.
            </p>
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
              <span>I confirm I have saved the BIP39 seed</span>
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
              I Have Saved the Recovery Phrase
            </button>
          </div>
        )}

        {!activeNodeState?.keystoreExists && (
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
                New Seed
              </button>
              <button
                type="button"
                className={keystoreMode === 'import' ? 'active' : ''}
                onClick={() => {
                  setKeystoreMode('import');
                  setKeystoreError('');
                }}
              >
                Import BIP39
              </button>
            </div>

            <label className="compact-label">
              Keystore Password (min. 12 characters)
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 12 characters..."
              />
            </label>
            <div className="password-meter">
              <span className={password.length >= 12 ? 'text-emerald' : 'text-amber'}>
                Length: {password.length}/12 characters
              </span>
            </div>

            {keystoreMode === 'import' && (
              <label className="compact-label">
                BIP39 Seed Phrase (12 words)
                <textarea
                  rows={3}
                  value={mnemonic}
                  onChange={e => setMnemonic(e.target.value)}
                  placeholder="word1 word2 ... word12"
                  autoComplete="off"
                />
                <span className="field-hint">Detected words: {wordCount}/12</span>
              </label>
            )}

            {keystoreMode === 'create' ? (
              <button
                type="button"
                className="btn-rgb full-width"
                disabled={keystoreBusy || activeNodeOffline || password.length < 12}
                onClick={() => void handleCreate()}
              >
                {keystoreBusy ? 'Creating Keystore...' : `🔐 Create Keystore on ${activeNodeLabel}`}
              </button>
            ) : (
              <button
                type="button"
                className="btn-rgb full-width"
                disabled={keystoreBusy || activeNodeOffline || password.length < 12 || wordCount !== 12}
                onClick={() => void handleImport()}
              >
                {keystoreBusy ? 'Importing...' : `📥 Import Seed on ${activeNodeLabel}`}
              </button>
            )}
          </div>
        )}

        {activeNodeState?.keystoreExists && activeNodeState.node !== 'ready' && (
          <div className="keystore-form">
            <p className="muted-text">
              Encrypted keystore found on <strong>{activeNodeLabel} (:{activeNodePort})</strong>. Unlock the RLN daemon.
            </p>
            <label className="compact-label">
              Unlock Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Keystore password..."
              />
            </label>
            <button
              type="button"
              className="btn-rgb full-width"
              disabled={keystoreBusy || activeNodeOffline || !password}
              onClick={() => void handleUnlock()}
            >
              {keystoreBusy ? 'Starting and unlocking RLN...' : `🔓 Unlock ${activeNodeLabel}`}
            </button>
          </div>
        )}

        {activeNodeState?.node === 'ready' && (
          <div className="keystore-ready-summary">
            <div className="kv-row">
              <span>RLN Node</span>
              <strong className="text-emerald">Operational (Ready)</strong>
            </div>
            <div className="kv-row">
              <span>Regtest Send</span>
              <strong className={activeNodeState.sendEnabled ? 'text-emerald' : 'text-amber'}>
                {activeNodeState.sendEnabled ? 'Enabled (ENABLE_REGTEST_SEND=1)' : 'Disabled'}
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

      {/* 4. DEMO PROMPT SHORTCUTS */}
      <section className="sidebar-card">
        <div className="card-header-row">
          <div>
            <span className="eyebrow">QUICK SCENARIOS</span>
            <h2>Demo Prompt Shortcuts</h2>
          </div>
        </div>
        <p className="muted-text">
          Pre-fill the QVAC Chat or Manual TX Builder with typical RGB-LN test scenarios.
        </p>
        <div className="preset-list">
          {DEMO_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className="preset-card-btn"
              onClick={() => onApplyPreset(preset)}
            >
              <div className="preset-top">
                <strong>{preset.title}</strong>
                <span className="preset-badge">{preset.badge}</span>
              </div>
              <span className="preset-desc">{preset.description}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
