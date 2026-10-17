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
    description: 'Invia asset RGB con tetto massimo 25 sat di fee e priorità risparmio commissioni.',
    targetMode: 'chat',
    promptText: 'Invia il pagamento RGB sulla invoice corrente con massimo 25 sat di fee e priorità lowest_fee.',
    feeLimitSat: '25',
    priority: 'lowest_fee',
    privacy: null,
  },
  {
    id: 'high-reliability-mpp',
    title: 'High-Reliability Multi-Objective',
    badge: 'Multi-Objective',
    description: 'Privilegia affidabilità del canale e riduci il rischio di fallimento HTLC.',
    targetMode: 'chat',
    promptText: 'Esegui questo pagamento privilegiando la massima affidabilità del canale, con limite fee di 100 sat.',
    feeLimitSat: '100',
    priority: 'reliability',
    privacy: null,
  },
  {
    id: 'privacy-single-path',
    title: 'Privacy No-Probing Route',
    badge: 'Privacy',
    description: 'Evita probing extra sul grafo e forza instradamento su singolo percorso.',
    targetMode: 'chat',
    promptText: 'Invia il pagamento evitando qualsiasi probing aggiuntivo per massimizzare la privacy, fee sotto 50 sat.',
    feeLimitSat: '50',
    priority: 'balanced',
    privacy: 'avoid_extra_probing',
  },
  {
    id: 'chat-setup-utxo-nia',
    title: 'Setup UTXO & Emissione NIA',
    badge: 'L1 Setup',
    description: 'Proponi in chat la preparazione di 4 UTXO colorabili o emissione asset RGB.',
    targetMode: 'chat',
    promptText: 'Prepara 4 UTXO RGB da 200000 sat ciascuno con fee rate 2 sat/vB sul nodo attivo.',
  },
  {
    id: 'manual-compile-preset',
    title: 'Compilatore Vincoli Manuale',
    badge: 'Manual TX',
    description: 'Apre il builder manuale pre-configurato con multi_objective e vincoli pronti da compilare.',
    targetMode: 'manual',
    manualSubTab: 'send',
    promptText: 'Massimo 40 sat di fee, priorità affidabilità, nessun probing extra.',
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
      setKeystoreError('La password del keystore deve contenere almeno 12 caratteri.');
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
      setKeystoreNotice(`Keystore BIP39 creato per ${activeNodeLabel}.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  async function handleImport() {
    if (password.length < 12) {
      setKeystoreError('La password del keystore deve contenere almeno 12 caratteri.');
      return;
    }
    if (wordCount !== 12) {
      setKeystoreError(`Inserire una frase seed BIP39 valida da 12 parole (trovate: ${wordCount}).`);
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      await onImportKeystore(password, mnemonic.trim());
      setPassword('');
      setMnemonic('');
      setKeystoreNotice(`Seed BIP39 importato con successo su ${activeNodeLabel}.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  async function handleUnlock() {
    if (!password) {
      setKeystoreError('Inserire la password per sbloccare il nodo.');
      return;
    }
    setKeystoreBusy(true);
    setKeystoreError('');
    setKeystoreNotice('');
    try {
      await onUnlockNode(password);
      setPassword('');
      setKeystoreNotice(`Nodo ${activeNodeLabel} sbloccato e operativo.`);
    } catch (err) {
      setKeystoreError((err as Error).message);
    } finally {
      setKeystoreBusy(false);
    }
  }

  return (
    <aside className="left-sidebar" aria-label="Servizi, Chain e Keystore">
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
            title="Aggiorna stato servizi"
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
            Aggiorna
          </button>
        </div>

        <div className="chain-height-box">
          <span className="muted-label">Altezza Blocco Corrente</span>
          <strong className="chain-height-value">
            {chainHeight !== null ? `#${chainHeight.toLocaleString()}` : 'Non letta'}
          </strong>
        </div>

        <div className="button-stack">
          <button
            type="button"
            className="btn-lightning"
            disabled={chainBusy || activeNodeOffline}
            onClick={() => void onMineBlocks(1)}
          >
            {chainBusy ? 'Mining in corso...' : '⛏️ Mine 1 Block (miner)'}
          </button>
          <button
            type="button"
            className="btn-rgb"
            disabled={chainBusy || activeNodeOffline}
            onClick={() => void onMineBlocks(6)}
          >
            {chainBusy ? 'Mining in corso...' : '⚡ +6 Blocchi (Conferma Canali LN)'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={chainBusy}
            onClick={() => void onSyncAllNodes()}
          >
            {chainBusy ? 'Sincronizzazione...' : '🔄 Sync All Nodes'}
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
          Nodo Target Keystore
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
              <strong>⚠️ Frase di Recupero BIP39 (Mostrata una sola volta)</strong>
            </div>
            <p className="muted-text">
              Conserva queste 12 parole in luogo sicuro. Non potranno più essere visualizzate dopo la chiusura.
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
              <span>Confermo di aver salvato il seed BIP39</span>
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
              Ho salvato la Recovery Phrase
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
                Nuovo Seed
              </button>
              <button
                type="button"
                className={keystoreMode === 'import' ? 'active' : ''}
                onClick={() => {
                  setKeystoreMode('import');
                  setKeystoreError('');
                }}
              >
                Importa BIP39
              </button>
            </div>

            <label className="compact-label">
              Password Keystore (min. 12 caratteri)
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Almeno 12 caratteri..."
              />
            </label>
            <div className="password-meter">
              <span className={password.length >= 12 ? 'text-emerald' : 'text-amber'}>
                Lunghezza: {password.length}/12 caratteri
              </span>
            </div>

            {keystoreMode === 'import' && (
              <label className="compact-label">
                Seed Phrase BIP39 (12 parole)
                <textarea
                  rows={3}
                  value={mnemonic}
                  onChange={e => setMnemonic(e.target.value)}
                  placeholder="parola1 parola2 ... parola12"
                  autoComplete="off"
                />
                <span className="field-hint">Parole rilevate: {wordCount}/12</span>
              </label>
            )}

            {keystoreMode === 'create' ? (
              <button
                type="button"
                className="btn-rgb full-width"
                disabled={keystoreBusy || activeNodeOffline || password.length < 12}
                onClick={() => void handleCreate()}
              >
                {keystoreBusy ? 'Creazione Keystore...' : `🔐 Crea Keystore su ${activeNodeLabel}`}
              </button>
            ) : (
              <button
                type="button"
                className="btn-rgb full-width"
                disabled={keystoreBusy || activeNodeOffline || password.length < 12 || wordCount !== 12}
                onClick={() => void handleImport()}
              >
                {keystoreBusy ? 'Importazione...' : `📥 Importa Seed su ${activeNodeLabel}`}
              </button>
            )}
          </div>
        )}

        {activeNodeState?.keystoreExists && activeNodeState.node !== 'ready' && (
          <div className="keystore-form">
            <p className="muted-text">
              Keystore cifrato presente su <strong>{activeNodeLabel} (:{activeNodePort})</strong>. Sblocca il daemon RLN.
            </p>
            <label className="compact-label">
              Password di Sblocco
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password del keystore..."
              />
            </label>
            <button
              type="button"
              className="btn-rgb full-width"
              disabled={keystoreBusy || activeNodeOffline || !password}
              onClick={() => void handleUnlock()}
            >
              {keystoreBusy ? 'Avvio e sblocco RLN...' : `🔓 Unlock ${activeNodeLabel}`}
            </button>
          </div>
        )}

        {activeNodeState?.node === 'ready' && (
          <div className="keystore-ready-summary">
            <div className="kv-row">
              <span>Nodo RLN</span>
              <strong className="text-emerald">Operativo (Ready)</strong>
            </div>
            <div className="kv-row">
              <span>Invio Regtest</span>
              <strong className={activeNodeState.sendEnabled ? 'text-emerald' : 'text-amber'}>
                {activeNodeState.sendEnabled ? 'Abilitato (ENABLE_REGTEST_SEND=1)' : 'Disabilitato'}
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
            <span className="eyebrow">SCENARI RAPIDI</span>
            <h2>Demo Prompt Shortcuts</h2>
          </div>
        </div>
        <p className="muted-text">
          Pre-compila la Chat QVAC o il Manual TX Builder con scenari tipici di test RGB-LN.
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
