import React, { useMemo, useState } from 'react';
import {
  ROUTING_ALGORITHMS,
  type AlgorithmSelectionResult,
  type ChannelScoringResult,
  type CompileResult,
  type ExtractedConstraints,
  type FixtureLoadResult,
  type ObjectiveWeights,
  type PaymentDraft,
  type PaymentRouting,
  type Priority,
  type RoutingAlgorithm,
  type SyntheticHistoryLevel,
} from '../../../../packages/contracts/types.js';
import {
  CopyableChip,
  type NodeAssetBalance,
  type RegtestNodeSnapshot,
} from './RightNodesInspector.js';

export const RGB_HTLC_MIN_MSAT = 3_000_000;

export type DecodedInvoiceView = {
  invoice: string;
  network: 'regtest';
  paymentHash: string;
  payeePubkey: string | null;
  amountMsat: string | null;
  assetId: string | null;
  assetAmount: string | null;
  expiresAt: number;
  description?: string | null;
};

export type PreparedPaymentIntent = {
  id: string;
  paymentHash: string;
  invoice: string;
  amountMsat: string;
  assetId: string | null;
  assetAmount?: string | null;
  status: 'prepared' | 'unknown' | 'pending' | 'succeeded' | 'failed' | string;
  routing: PaymentRouting;
};

export type SetupOperationDraft =
  | {
      kind: 'prepare_utxos';
      count: number;
      sizeSat: string;
      feeRateSatPerVbyte: string;
    }
  | {
      kind: 'issue_nia';
      ticker: string;
      name: string;
      precision: number;
      amount: number;
    }
  | {
      kind: 'open_channel';
      peer: string;
      capacitySat: string;
      assetId?: string;
      assetAmount?: string;
    };

export type ChatActionCardData = {
  id: string;
  timestamp: number;
  prompt: string;
  nodeId: string;
  nodeLabel: string;
  actionType: 'payment' | 'setup';
  latencyMs: number | null;
  extracted: ExtractedConstraints;
  compileResult: CompileResult | null;
  suggestedAlgorithm: RoutingAlgorithm;
  suggestedWeights: ObjectiveWeights;
  suggestedMaxPaths?: number;
  suggestedExcludedNodes?: string[];
  algorithmRationale?: string;
  paymentDraft: PaymentDraft;
  decodedInvoice: DecodedInvoiceView | null;
  setupDraft?: SetupOperationDraft;
  preparedIntent: PreparedPaymentIntent | null;
  executionStatus: 'idle' | 'preparing' | 'prepared' | 'confirming' | 'completed' | 'error';
  executionMessage: string;
};

export type WorkspaceTab = 'chat' | 'manual' | 'split';
export type ManualSubTab = 'send' | 'receive' | 'channels' | 'l1';

export type CenterWorkspaceProps = {
  nodes: RegtestNodeSnapshot[];
  activeNode: RegtestNodeSnapshot;
  counterpartyNode: RegtestNodeSnapshot | undefined;
  userWallet?: boolean;
  onSelectActiveNode: (nodeId: string) => void;
  workspaceTab: WorkspaceTab;
  onChangeWorkspaceTab: (tab: WorkspaceTab) => void;
  manualSubTab: ManualSubTab;
  onChangeManualSubTab: (sub: ManualSubTab) => void;

  // Shared Payment & Constraints State
  paymentDraft: PaymentDraft;
  onUpdatePaymentDraft: (patch: Partial<PaymentDraft>) => void;
  decodedInvoice: DecodedInvoiceView | null;
  onDecodeInvoice: (invoice?: string) => Promise<DecodedInvoiceView | null>;
  algorithm: RoutingAlgorithm;
  onChangeAlgorithm: (alg: RoutingAlgorithm) => void;
  weights: ObjectiveWeights;
  onChangeWeights: (weights: ObjectiveWeights) => void;
  extracted: ExtractedConstraints;
  onUpdateExtracted: (patch: Partial<ExtractedConstraints>) => void;
  onResetExtracted: () => void;
  compileResult: CompileResult | null;
  qvacBusy: boolean;
  qvacLatencyMs: number | null;
  qvacError: string;
  onCompileConstraintsManual: () => Promise<CompileResult | null>;
  channelScore: ChannelScoringResult | null;
  onScoreChannelsWithQvac: (userPreference?: string) => Promise<void>;
  onSeedTelemetry: () => Promise<void>;
  algorithmSelection?: AlgorithmSelectionResult | null;
  onSelectAlgorithmWithQvac?: (userPreference?: string) => Promise<void>;
  fixtureNodeId?: string;
  onChangeFixtureNodeId?: (nodeId: string) => void;
  fixtureLevel?: SyntheticHistoryLevel;
  onChangeFixtureLevel?: (level: SyntheticHistoryLevel) => void;
  fixtureInfo?: FixtureLoadResult | null;
  onLoadFixtureHistory?: () => Promise<void>;
  preparedIntent: PreparedPaymentIntent | null;
  onPreparePayment: () => Promise<void>;
  onConfirmPayment: () => Promise<void>;
  onRefreshPaymentIntent: () => Promise<void>;

  // QVAC Chat State & Actions
  chatPrompt: string;
  onChangeChatPrompt: (text: string) => void;
  chatCards: ChatActionCardData[];
  onSubmitChatPrompt: () => Promise<void>;
  onTransferCardToManual: (card: ChatActionCardData) => void;
  onPrepareCardPayment: (cardId: string) => Promise<void>;
  onConfirmCardPayment: (cardId: string) => Promise<void>;
  onExecuteCardSetup: (cardId: string) => Promise<void>;

  // Manual Sub-tab 2: Receive / Create Invoice
  onCreateInvoice: (input: {
    amountMsat: string;
    expirySec: number;
    assetId?: string;
    assetAmount?: string;
  }) => Promise<string>;
  onCheckInvoiceStatus: (invoice: string) => Promise<unknown>;
  onUseInvoiceOnOtherNode: (invoice: string) => void;

  // Manual Sub-tab 3: Connect Peer & Open Channel
  onConnectPeer: (peerUri: string) => Promise<void>;
  onOpenChannel: (input: {
    peer: string;
    capacitySat: string;
    assetId?: string;
    assetAmount?: string;
  }) => Promise<void>;

  // Manual Sub-tab 4: L1 & RGB Assets
  onPrepareUtxos: (input: {
    count: number;
    sizeSat: string;
    feeRateSatPerVbyte: string;
  }) => Promise<string>;
  onIssueNiaAsset: (input: {
    ticker: string;
    name: string;
    precision: number;
    amounts: number[];
  }) => Promise<{ assetId: string; ticker: string; name: string; issuedSupply: string }>;
  onQueryAssetBalance: (assetId: string) => Promise<NodeAssetBalance>;
};

function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('it-IT') : String(value);
}

function describeInvoiceStatus(raw: unknown): {
  badge: string;
  tone: 'pill-success' | 'pill-warning' | 'pill-danger' | 'pill-neutral';
  detail: string;
} {
  const str = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const lower = str.toLowerCase();
  if (lower.includes('succeeded') || lower.includes('paid') || lower.includes('settled')) {
    return { badge: 'PAID', tone: 'pill-success', detail: 'Invoice saldata correttamente.' };
  }
  if (lower.includes('expired') || lower.includes('failed') || lower.includes('cancelled')) {
    return { badge: 'EXPIRED / FAILED', tone: 'pill-danger', detail: 'Invoice scaduta o annullata.' };
  }
  if (lower.includes('pending') || lower.includes('open') || lower.includes('unpaid')) {
    return { badge: 'PENDING', tone: 'pill-warning', detail: 'In attesa di pagamento HTLC.' };
  }
  return { badge: 'VERIFIED', tone: 'pill-neutral', detail: str || 'Stato interrogato' };
}

export function CenterWorkspace({
  nodes,
  activeNode,
  counterpartyNode,
  userWallet = false,
  onSelectActiveNode,
  workspaceTab,
  onChangeWorkspaceTab,
  manualSubTab,
  onChangeManualSubTab,
  paymentDraft,
  onUpdatePaymentDraft,
  decodedInvoice,
  onDecodeInvoice,
  algorithm,
  onChangeAlgorithm,
  weights,
  onChangeWeights,
  extracted,
  onUpdateExtracted,
  onResetExtracted,
  compileResult,
  qvacBusy,
  qvacLatencyMs,
  qvacError,
  onCompileConstraintsManual,
  channelScore,
  onScoreChannelsWithQvac,
  onSeedTelemetry,
  algorithmSelection = null,
  onSelectAlgorithmWithQvac,
  fixtureNodeId = 'alice',
  onChangeFixtureNodeId,
  fixtureLevel = 100,
  onChangeFixtureLevel,
  fixtureInfo = null,
  onLoadFixtureHistory,
  preparedIntent,
  onPreparePayment,
  onConfirmPayment,
  onRefreshPaymentIntent,
  chatPrompt,
  onChangeChatPrompt,
  chatCards,
  onSubmitChatPrompt,
  onTransferCardToManual,
  onPrepareCardPayment,
  onConfirmCardPayment,
  onExecuteCardSetup,
  onCreateInvoice,
  onCheckInvoiceStatus,
  onUseInvoiceOnOtherNode,
  onConnectPeer,
  onOpenChannel,
  onPrepareUtxos,
  onIssueNiaAsset,
  onQueryAssetBalance,
}: CenterWorkspaceProps) {
  // Top bar RGB contract selector & quick balance lookup
  const [selectedOverviewAssetId, setSelectedOverviewAssetId] = useState('');
  const [overviewBalanceBusy, setOverviewBalanceBusy] = useState(false);
  const [overviewBalanceError, setOverviewBalanceError] = useState('');

  // Manual Sub-tab 1 local UI feedback
  const [sendBusy, setSendBusy] = useState(false);
  const [sendNotice, setSendNotice] = useState('');
  const [sendError, setSendError] = useState('');

  // Manual Sub-tab 2: Receive / Create Invoice local state
  const [receiveContractMode, setReceiveContractMode] = useState<'select' | 'custom'>('select');
  const [receiveAssetId, setReceiveAssetId] = useState('');
  const [receiveAssetAmount, setReceiveAssetAmount] = useState('25');
  const [receiveMsat, setReceiveMsat] = useState(String(RGB_HTLC_MIN_MSAT));
  const [receiveExpirySec, setReceiveExpirySec] = useState('3600');
  const [generatedInvoice, setGeneratedInvoice] = useState('');
  const [generatedInvoiceStatus, setGeneratedInvoiceStatus] = useState<unknown>(null);
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [receiveError, setReceiveError] = useState('');
  const [receiveNotice, setReceiveNotice] = useState('');

  // Manual Sub-tab 3: Channels & Peers local state
  const [peerUriInput, setPeerUriInput] = useState('');
  const [channelPeerInput, setChannelPeerInput] = useState('');
  const [channelCapacitySat, setChannelCapacitySat] = useState('200000');
  const [includeRgbInChannel, setIncludeRgbInChannel] = useState(true);
  const [channelAssetId, setChannelAssetId] = useState('');
  const [channelAssetAmount, setChannelAssetAmount] = useState('100');
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelNotice, setChannelNotice] = useState('');
  const [channelError, setChannelError] = useState('');

  // Manual Sub-tab 4: L1 & RGB Assets local state
  const [utxoCount, setUtxoCount] = useState('4');
  const [utxoSizeSat, setUtxoSizeSat] = useState('200000');
  const [utxoFeeRate, setUtxoFeeRate] = useState('2');
  const [niaTicker, setNiaTicker] = useState('TUSDT');
  const [niaName, setNiaName] = useState('Agentic Tether USD');
  const [niaAmount, setNiaAmount] = useState('1000');
  const [niaPrecision, setNiaPrecision] = useState('0');
  const [lastIssuedAsset, setLastIssuedAsset] = useState<{
    assetId: string;
    ticker: string;
    name: string;
    issuedSupply: string;
  } | null>(null);
  const [lookupAssetId, setLookupAssetId] = useState('');
  const [lookupResult, setLookupResult] = useState<NodeAssetBalance | null>(null);
  const [l1Busy, setL1Busy] = useState(false);
  const [l1Notice, setL1Notice] = useState('');
  const [l1Error, setL1Error] = useState('');

  const effectiveOverviewAssetId =
    selectedOverviewAssetId || activeNode.assets[0]?.assetId || '';

  const currentOverviewBalance = effectiveOverviewAssetId
    ? activeNode.assetBalances[effectiveOverviewAssetId]
    : undefined;

  // Aggregate Channel Liquidity for Top Wallet Overview
  const liquidityTotals = useMemo(() => {
    let totalCapacitySat = 0;
    let totalOutboundMsat = 0;
    let totalInboundMsat = 0;
    let totalRgbLocal = 0;
    let totalRgbRemote = 0;

    for (const ch of activeNode.channels) {
      totalCapacitySat += Number(ch.capacitySat ?? 0);
      totalOutboundMsat += Number(ch.outboundMsat ?? 0);
      totalInboundMsat += Number(ch.inboundMsat ?? 0);
      if (!effectiveOverviewAssetId || ch.assetId === effectiveOverviewAssetId) {
        totalRgbLocal += Number(ch.assetLocalAmount ?? 0);
        totalRgbRemote += Number(ch.assetRemoteAmount ?? 0);
      }
    }

    const btcTotal = totalOutboundMsat + totalInboundMsat;
    const btcOutPct = btcTotal > 0 ? Math.round((totalOutboundMsat / btcTotal) * 100) : 50;

    const rgbTotal = totalRgbLocal + totalRgbRemote;
    const rgbOutPct = rgbTotal > 0 ? Math.round((totalRgbLocal / rgbTotal) * 100) : 50;

    return {
      totalCapacitySat,
      totalOutboundMsat,
      totalInboundMsat,
      totalRgbLocal,
      totalRgbRemote,
      btcOutPct,
      rgbOutPct,
    };
  }, [activeNode.channels, effectiveOverviewAssetId]);

  const receiveMsatNumber = Number(receiveMsat);
  const isReceiveBelowHtlcMin =
    !Number.isFinite(receiveMsatNumber) || receiveMsatNumber < RGB_HTLC_MIN_MSAT;

  async function handleOverviewBalanceCheck() {
    if (!effectiveOverviewAssetId.trim()) return;
    setOverviewBalanceBusy(true);
    setOverviewBalanceError('');
    try {
      await onQueryAssetBalance(effectiveOverviewAssetId.trim());
    } catch (err) {
      setOverviewBalanceError((err as Error).message);
    } finally {
      setOverviewBalanceBusy(false);
    }
  }

  async function handleDecodeClick() {
    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    try {
      const d = await onDecodeInvoice();
      if (d) {
        setSendNotice('Invoice BOLT11/RGB decodificata e verificata con successo.');
      }
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  async function handlePrepareClick() {
    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    try {
      await onPreparePayment();
      setSendNotice('Pagamento preparato (Step 1/2 completato). Verifica la rotta e conferma.');
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  async function handleConfirmClick() {
    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    try {
      await onConfirmPayment();
      setSendNotice('Pagamento inviato sul canale RGB-LN.');
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  async function handleGenerateInvoice() {
    const chosenAsset =
      receiveContractMode === 'select'
        ? receiveAssetId || activeNode.assets[0]?.assetId || ''
        : receiveAssetId.trim();

    if (chosenAsset && isReceiveBelowHtlcMin) {
      setReceiveError(
        `RGB Lightning richiede un minimo HTLC di ${RGB_HTLC_MIN_MSAT.toLocaleString('it-IT')} msat (3.000 sat).`,
      );
      return;
    }
    setReceiveBusy(true);
    setReceiveError('');
    setReceiveNotice('');
    try {
      const inv = await onCreateInvoice({
        amountMsat: receiveMsat.trim(),
        expirySec: Number(receiveExpirySec) || 3600,
        ...(chosenAsset
          ? { assetId: chosenAsset, assetAmount: receiveAssetAmount.trim() }
          : {}),
      });
      setGeneratedInvoice(inv);
      setGeneratedInvoiceStatus(null);
      setReceiveNotice(`Invoice generata con successo su ${activeNode.label}.`);
    } catch (err) {
      setReceiveError((err as Error).message);
    } finally {
      setReceiveBusy(false);
    }
  }

  async function handleCheckInvoiceStatus() {
    if (!generatedInvoice) return;
    setReceiveBusy(true);
    setReceiveError('');
    try {
      const st = await onCheckInvoiceStatus(generatedInvoice);
      setGeneratedInvoiceStatus(st);
    } catch (err) {
      setReceiveError((err as Error).message);
    } finally {
      setReceiveBusy(false);
    }
  }

  function handleAutoFillPeerUri() {
    if (counterpartyNode?.summary?.peerUri) {
      setPeerUriInput(counterpartyNode.summary.peerUri);
      setChannelPeerInput(counterpartyNode.summary.peerUri);
      setChannelError('');
      setChannelNotice(`Auto-compilato Peer URI di ${counterpartyNode.label}.`);
    } else {
      setChannelError(
        `Peer URI di ${counterpartyNode?.label ?? 'controparte'} non disponibile. Sblocca prima il nodo controparte.`,
      );
    }
  }

  async function handleConnectPeerClick() {
    if (!peerUriInput.trim()) return;
    setChannelBusy(true);
    setChannelError('');
    setChannelNotice('');
    try {
      await onConnectPeer(peerUriInput.trim());
      setChannelNotice(`Connessione peer stabilita: ${peerUriInput.trim()}`);
    } catch (err) {
      setChannelError((err as Error).message);
    } finally {
      setChannelBusy(false);
    }
  }

  async function handleOpenChannelClick() {
    const rawPeer = channelPeerInput.trim() || peerUriInput.trim();
    if (!rawPeer) {
      setChannelError('Inserire Peer URI o Pubkey del nodo controparte.');
      return;
    }
    // If the user typed only the 66-hex nodeId, enrich with @host:port if known from counterparty
    let normalizedPeer = rawPeer;
    if (!rawPeer.includes('@') && counterpartyNode?.summary?.peerUri?.startsWith(rawPeer)) {
      normalizedPeer = counterpartyNode.summary.peerUri;
    } else if (!rawPeer.includes('@')) {
      const fallbackPort = counterpartyNode?.port === 8788 ? 9736 : 9735;
      normalizedPeer = `${rawPeer}@127.0.0.1:${fallbackPort}`;
    }

    const chosenAsset = includeRgbInChannel
      ? (channelAssetId || activeNode.assets[0]?.assetId || '').trim()
      : '';

    setChannelBusy(true);
    setChannelError('');
    setChannelNotice('');
    try {
      await onOpenChannel({
        peer: normalizedPeer,
        capacitySat: channelCapacitySat.trim(),
        ...(chosenAsset
          ? { assetId: chosenAsset, assetAmount: channelAssetAmount.trim() }
          : {}),
      });
      setChannelNotice(
        'Richiesta apertura canale inviata! Mina +6 blocchi nella barra di sinistra per confermare il canale.',
      );
    } catch (err) {
      setChannelError((err as Error).message);
    } finally {
      setChannelBusy(false);
    }
  }

  async function handlePrepareUtxosClick() {
    setL1Busy(true);
    setL1Error('');
    setL1Notice('');
    try {
      const statusMsg = await onPrepareUtxos({
        count: Number(utxoCount),
        sizeSat: utxoSizeSat.trim(),
        feeRateSatPerVbyte: utxoFeeRate.trim(),
      });
      setL1Notice(statusMsg);
    } catch (err) {
      setL1Error((err as Error).message);
    } finally {
      setL1Busy(false);
    }
  }

  async function handleIssueNiaClick() {
    setL1Busy(true);
    setL1Error('');
    setL1Notice('');
    try {
      const created = await onIssueNiaAsset({
        ticker: niaTicker.trim().toUpperCase(),
        name: niaName.trim(),
        precision: Number(niaPrecision),
        amounts: [Number(niaAmount)],
      });
      setLastIssuedAsset(created);
      setLookupAssetId(created.assetId);
      setSelectedOverviewAssetId(created.assetId);
      setChannelAssetId(created.assetId);
      setReceiveAssetId(created.assetId);
      setL1Notice(`Asset NIA ${created.ticker} emesso con Contract ID ${created.assetId}.`);
    } catch (err) {
      setL1Error((err as Error).message);
    } finally {
      setL1Busy(false);
    }
  }

  async function handleLookupBalanceClick() {
    if (!lookupAssetId.trim()) return;
    setL1Busy(true);
    setL1Error('');
    try {
      const res = await onQueryAssetBalance(lookupAssetId.trim());
      setLookupResult(res);
    } catch (err) {
      setL1Error((err as Error).message);
    } finally {
      setL1Busy(false);
    }
  }

  const invoiceStatusView =
    generatedInvoiceStatus !== null ? describeInvoiceStatus(generatedInvoiceStatus) : null;

  return (
    <main className="center-workspace" aria-label="Area Operativa Centrale Wallet e QVAC">
      {/* A. TOP BAR: WDK & RGB-LN USER WALLET OVERVIEW */}
      <section className="wallet-overview-header">
        <div className="wallet-overview-top">
          <div className="brand-block">
            <span className="eyebrow">TETHER WDK · RGB-LN · QVAC AI</span>
            <h1>AIR-GB Command Center</h1>
          </div>

          {/* Selettore Nodo Operativo */}
          <div className="node-switcher" role="group" aria-label="Selettore Nodo Operativo">
            {nodes.map(node => {
              const selected = node.id === activeNode.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`node-switch-btn ${selected ? 'active' : ''} accent-${node.accent}`}
                  onClick={() => onSelectActiveNode(node.id)}
                >
                  <span className="switch-dot">
                    {node.accent === 'emerald' ? '🟢' : node.accent === 'purple' ? '🟣' : '🔵'}
                  </span>
                  <span className="switch-name">{node.label}</span>
                  <code className="switch-port">:{node.port}</code>
                </button>
              );
            })}
          </div>
        </div>

        {/* Riepilogo Saldi Utente */}
        <div className="wallet-balances-grid">
          <div className="balance-kpi-card">
            <span className="kpi-title">Saldo Bitcoin On-Chain</span>
            <div className="kpi-main">
              <strong>{formatNumber(activeNode.summary?.btcSpendableSat)}</strong>
              <span className="kpi-unit">sats</span>
            </div>
            <span className="kpi-sub">
              Capacità Totale Canali LN:{' '}
              <strong>{formatNumber(liquidityTotals.totalCapacitySat)} sats</strong>
            </span>
          </div>

          <div className="balance-kpi-card kpi-rgb">
            <div className="kpi-header-inline">
              <span className="kpi-title">Saldo Asset RGB</span>
              <button
                type="button"
                className="btn-secondary btn-xs"
                disabled={overviewBalanceBusy || !effectiveOverviewAssetId}
                onClick={() => void handleOverviewBalanceCheck()}
              >
                {overviewBalanceBusy ? '...' : '↻ Verifica'}
              </button>
            </div>

            <div className="kpi-main">
              <strong className="text-emerald">
                {formatNumber(
                  currentOverviewBalance?.spendable ??
                    currentOverviewBalance?.settled ??
                    liquidityTotals.totalRgbLocal,
                )}
              </strong>
              <span className="kpi-unit">
                {activeNode.assets.find(a => a.assetId === effectiveOverviewAssetId)?.ticker ??
                  'RGB units'}
              </span>
            </div>

            <div className="contract-selector-row">
              {activeNode.assets.length > 0 ? (
                <select
                  aria-label="Seleziona Contract ID RGB"
                  value={effectiveOverviewAssetId}
                  onChange={e => setSelectedOverviewAssetId(e.target.value)}
                >
                  {activeNode.assets.map(a => (
                    <option key={a.assetId ?? ''} value={a.assetId ?? ''}>
                      {a.ticker ?? 'NIA'} — {a.assetId?.slice(0, 18)}…
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={selectedOverviewAssetId}
                  onChange={e => setSelectedOverviewAssetId(e.target.value)}
                  placeholder="Incolla contract_id (rgb:...) per verifica"
                />
              )}
            </div>
            {overviewBalanceError && (
              <span className="inline-err-text" role="alert">
                {overviewBalanceError}
              </span>
            )}
          </div>

          {/* Barra Grafica Liquidità Lightning (Outbound vs Inbound BTC + RGB) */}
          <div className="balance-kpi-card kpi-liquidity">
            <span className="kpi-title">Liquidità Canali Lightning (Outbound vs Inbound)</span>

            <div className="dual-liquidity-group">
              <div className="liquidity-row">
                <div className="liq-row-header">
                  <span>
                    ⚡ BTC Outbound: <strong>{formatNumber(liquidityTotals.totalOutboundMsat)}</strong> msat
                  </span>
                  <span>
                    Inbound: <strong>{formatNumber(liquidityTotals.totalInboundMsat)}</strong> msat
                  </span>
                </div>
                <div className="liquidity-bar-track large">
                  <div
                    className="liquidity-bar-fill fill-btc"
                    style={{ width: `${liquidityTotals.btcOutPct}%` }}
                  />
                </div>
              </div>

              <div className="liquidity-row">
                <div className="liq-row-header">
                  <span className="text-emerald">
                    🪙 RGB Local: <strong>{formatNumber(liquidityTotals.totalRgbLocal)}</strong>
                  </span>
                  <span>
                    Remote: <strong>{formatNumber(liquidityTotals.totalRgbRemote)}</strong>
                  </span>
                </div>
                <div className="liquidity-bar-track large">
                  <div
                    className="liquidity-bar-fill fill-rgb"
                    style={{ width: `${liquidityTotals.rgbOutPct}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* B. SELETTORE MODALITÀ OPERATIVA (TAB BAR CENTRALE) */}
      <nav className="workspace-mode-tabs" aria-label="Modalità Operativa">
        {!userWallet && <button
          type="button"
          className={`mode-tab-btn tab-qvac ${workspaceTab === 'chat' ? 'active' : ''}`}
          onClick={() => onChangeWorkspaceTab('chat')}
        >
          💬 QVAC AI Copilot (Chat)
        </button>}
        <button
          type="button"
          className={`mode-tab-btn tab-manual ${workspaceTab === 'manual' ? 'active' : ''}`}
          onClick={() => onChangeWorkspaceTab('manual')}
        >
          ✍️ Inserimento Manuale TX & Operazioni
        </button>
        {!userWallet && <button
          type="button"
          className={`mode-tab-btn tab-split ${workspaceTab === 'split' ? 'active' : ''}`}
          onClick={() => onChangeWorkspaceTab('split')}
          title="Mostra Chat QVAC e Inserimento Manuale affiancati"
        >
          ⚡ Vista Split (Chat + Manuale)
        </button>}
      </nav>

      {qvacError && (
        <div className="error" role="alert">
          <strong>Errore QVAC / Validazione:</strong> {qvacError}
        </div>
      )}

      <div className={`workspace-panes ${workspaceTab === 'split' ? 'panes-split' : ''}`}>
        {/* C. DETTAGLIO TAB 1: QVAC AI COPILOT (CHAT) */}
        {( !userWallet && (workspaceTab === 'chat' || workspaceTab === 'split')) && (
          <section className="workspace-panel chat-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow text-qvac">NATURAL LANGUAGE INTENT ENGINE</span>
                <h2>💬 QVAC AI Copilot · Proposta Azione con Conferma</h2>
              </div>
              {qvacLatencyMs !== null && (
                <span className="latency-badge">Inferenza QVAC: {qvacLatencyMs} ms</span>
              )}
            </div>

            <p className="muted-text">
              Descrivi il pagamento o l’operazione in linguaggio naturale. QVAC estrae i vincoli (
              <code>/api/constraints/interpret</code>), li compila deterministicamente (
              <code>/api/constraints/compile</code>) e genera una{' '}
              <strong>Action Confirmation Card</strong> prima di qualsiasi esecuzione.
            </p>

            {/* Contesto Invoice Rapido per la Chat */}
            <div className="chat-invoice-context">
              <label className="compact-label">
                Invoice di riferimento per la compilazione in Chat (opzionale per operazioni setup)
                <div className="input-with-action">
                  <input
                    value={paymentDraft.invoice}
                    onChange={e => onUpdatePaymentDraft({ invoice: e.target.value })}
                    placeholder="lnbcrt1... (incolla o carica da Bob)"
                  />
                  {counterpartyNode?.lastInvoice && (
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={() =>
                        onUpdatePaymentDraft({ invoice: counterpartyNode.lastInvoice })
                      }
                    >
                      Incolla Invoice di {counterpartyNode.label}
                    </button>
                  )}
                </div>
              </label>
            </div>

            {/* Input Prompt Linguaggio Naturale */}
            <div className="chat-composer">
              <label className="compact-label">
                Prompt Operativo QVAC (operando come <strong>{activeNode.label}</strong>)
                <textarea
                  rows={3}
                  value={chatPrompt}
                  onChange={e => onChangeChatPrompt(e.target.value)}
                  placeholder="Es: Invia 50 tUSDT a Bob usando questa invoice, spendi meno di 100 sat di fee, escludi il nodo X e privilegia l'affidabilità"
                  maxLength={1000}
                />
              </label>
              <div className="chat-composer-actions">
                <button
                  type="button"
                  className="btn-qvac"
                  disabled={qvacBusy || !chatPrompt.trim()}
                  onClick={() => void onSubmitChatPrompt()}
                >
                  {qvacBusy
                    ? 'Interpretazione e Compilazione QVAC...'
                    : '✨ Interpreta & Genera Action Card'}
                </button>
              </div>
            </div>

            {/* Stream delle Action Confirmation Cards */}
            <div className="chat-cards-stream">
              {chatCards.length === 0 ? (
                <div className="empty-chat-box">
                  <p>
                    Nessuna proposta attiva. Scrivi un comando sopra oppure clicca uno dei{' '}
                    <strong>Demo Prompt Shortcuts</strong> nella barra di sinistra.
                  </p>
                </div>
              ) : (
                chatCards.map(card => {
                  const isSendEnabled = activeNode.state?.sendEnabled ?? false;
                  const canConfirmSend =
                    isSendEnabled && card.preparedIntent?.status === 'prepared';

                  return (
                    <article key={card.id} className="action-confirmation-card">
                      <div className="action-card-top">
                        <div>
                          <span className="qvac-pill">ACTION CONFIRMATION CARD</span>
                          <span className="node-badge-inline">Nodo: {card.nodeLabel}</span>
                          {card.latencyMs !== null && (
                            <span className="mono-badge">{card.latencyMs} ms</span>
                          )}
                        </div>
                        <time className="card-time">
                          {new Date(card.timestamp).toLocaleTimeString('it-IT')}
                        </time>
                      </div>

                      <blockquote className="user-prompt-quote">“{card.prompt}”</blockquote>

                      {/* Parametri Estratti da QVAC */}
                      <div className="extracted-kv-grid">
                        <div className="kv-box">
                          <span className="kv-label">Algoritmo Suggerito</span>
                          <code className="kv-val text-qvac">{card.suggestedAlgorithm}</code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Pesi Multi-Objective</span>
                          <code className="kv-val">
                            fee:{card.suggestedWeights.fee} · rel:{card.suggestedWeights.reliability}{' '}
                            · cltv:{card.suggestedWeights.cltv} · hops:{card.suggestedWeights.hops}
                          </code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Max Fee Estratta</span>
                          <code className="kv-val">
                            {card.extracted.feeLimit
                              ? `${card.extracted.feeLimit.comparison === 'lt' ? '<' : '≤'} ${card.extracted.feeLimit.value} ${card.extracted.feeLimit.unit}`
                              : 'Nessun tetto'}
                          </code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Priorità & Privacy</span>
                          <code className="kv-val">
                            {card.extracted.priority ?? 'balanced'} /{' '}
                            {card.extracted.privacyRequest ?? 'standard'}
                          </code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Nodi Esclusi</span>
                          <code className="kv-val">
                            {card.extracted.excludedNodeReferences.length > 0
                              ? card.extracted.excludedNodeReferences.join(', ')
                              : 'Nessuno'}
                          </code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Importo & Asset</span>
                          <code className="kv-val">
                            {card.decodedInvoice?.assetAmount
                              ? `${card.decodedInvoice.assetAmount} RGB (${card.paymentDraft.amount || card.decodedInvoice.amountMsat} msat)`
                              : `${card.paymentDraft.amount || '3000000'} msat (${card.paymentDraft.assetId})`}
                          </code>
                        </div>
                      </div>

                      {card.compileResult && (
                        <div className="compile-summary-strip">
                          <span
                            className={`status-pill ${
                              card.compileResult.status === 'validated'
                                ? 'pill-success'
                                : 'pill-warning'
                            }`}
                          >
                            {card.compileResult.code} · {card.compileResult.status.toUpperCase()}
                          </span>
                          {card.compileResult.normalized && (
                            <span className="mono-small">
                              MaxFee: {card.compileResult.normalized.maxRoutingFeeMsat ?? '∞'} msat
                              · Esclusi: {card.compileResult.normalized.excludedNodeIds.length}
                            </span>
                          )}
                        </div>
                      )}

                      {card.compileResult?.issues.map((issue, idx) => (
                        <div key={idx} className="notice compact-notice" role="alert">
                          {issue}
                        </div>
                      ))}

                      {card.setupDraft && (
                        <div className="setup-draft-box">
                          <strong>Operazione Setup Rilevata:</strong>{' '}
                          {card.setupDraft.kind === 'prepare_utxos' &&
                            `Prepara ${card.setupDraft.count} UTXO RGB da ${card.setupDraft.sizeSat} sat (${card.setupDraft.feeRateSatPerVbyte} sat/vB)`}
                          {card.setupDraft.kind === 'issue_nia' &&
                            `Emetti Asset NIA ${card.setupDraft.ticker} (${card.setupDraft.name}) · Quantità ${card.setupDraft.amount}`}
                          {card.setupDraft.kind === 'open_channel' &&
                            `Apri Canale verso ${card.setupDraft.peer} · Capacità ${card.setupDraft.capacitySat} sat`}
                        </div>
                      )}

                      {card.preparedIntent && (
                        <div className="intent-ready-banner">
                          <span>
                            Intento <code>{card.preparedIntent.id.slice(0, 12)}…</code> → Stato:{' '}
                            <strong>{card.preparedIntent.status.toUpperCase()}</strong>
                          </span>
                        </div>
                      )}

                      {card.executionMessage && (
                        <div
                          className={
                            card.executionStatus === 'error'
                              ? 'error compact-notice'
                              : 'notice compact-notice'
                          }
                          role={card.executionStatus === 'error' ? 'alert' : 'status'}
                        >
                          {card.executionMessage}
                        </div>
                      )}

                      {/* Azioni sulla Card */}
                      <div className="action-card-buttons">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => onTransferCardToManual(card)}
                        >
                          ✏️ Modifica nel Form Manuale
                        </button>

                        {card.actionType === 'payment' ? (
                          <>
                            <button
                              type="button"
                              className="btn-lightning"
                              disabled={
                                card.executionStatus === 'preparing' ||
                                card.executionStatus === 'confirming' ||
                                !card.paymentDraft.invoice.trim()
                              }
                              onClick={() => void onPrepareCardPayment(card.id)}
                            >
                              {card.executionStatus === 'preparing'
                                ? 'Preparazione...'
                                : '1. Prepare Payment'}
                            </button>
                            <button
                              type="button"
                              className="btn-rgb"
                              disabled={
                                !canConfirmSend || card.executionStatus === 'confirming'
                              }
                              onClick={() => void onConfirmCardPayment(card.id)}
                              title={
                                !isSendEnabled
                                  ? 'Abilita ENABLE_REGTEST_SEND=1 per confermare invii reali'
                                  : 'Conferma e invia il pagamento preparato'
                              }
                            >
                              {card.executionStatus === 'confirming'
                                ? 'Invio HTLC...'
                                : '2. Confirm & Send'}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-rgb"
                            disabled={
                              card.executionStatus === 'preparing' ||
                              card.executionStatus === 'completed'
                            }
                            onClick={() => void onExecuteCardSetup(card.id)}
                          >
                            {card.executionStatus === 'preparing'
                              ? 'Esecuzione...'
                              : card.executionStatus === 'completed'
                                ? '✓ Eseguito'
                                : 'Conferma ed Esegui'}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        )}

        {/* D. DETTAGLIO TAB 2: INSERIMENTO MANUALE TX & OPERAZIONI */}
        {(workspaceTab === 'manual' || workspaceTab === 'split') && (
          <section className="workspace-panel manual-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow text-emerald">PRECISION MANUAL CONTROLS</span>
                <h2>✍️ Inserimento Manuale TX & Operazioni ({activeNode.label})</h2>
              </div>
            </div>

            {/* Navigazione a 4 Sotto-Schede Operative */}
            <div className="manual-subtabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={manualSubTab === 'send'}
                className={`subtab-btn ${manualSubTab === 'send' ? 'active' : ''}`}
                onClick={() => onChangeManualSubTab('send')}
              >
                ⚡ Invia Pagamento RGB-LN
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={manualSubTab === 'receive'}
                className={`subtab-btn ${manualSubTab === 'receive' ? 'active' : ''}`}
                onClick={() => onChangeManualSubTab('receive')}
              >
                📥 Ricevi / Crea Invoice
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={manualSubTab === 'channels'}
                className={`subtab-btn ${manualSubTab === 'channels' ? 'active' : ''}`}
                onClick={() => onChangeManualSubTab('channels')}
              >
                🔗 Apri Canale & Peer
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={manualSubTab === 'l1'}
                className={`subtab-btn ${manualSubTab === 'l1' ? 'active' : ''}`}
                onClick={() => onChangeManualSubTab('l1')}
              >
                🪙 Operazioni L1 & Asset RGB
              </button>
            </div>

            {/* SUB-TAB 1: INVIA PAGAMENTO RGB-LN (MANUAL TX) */}
            {manualSubTab === 'send' && (
              <div className="subtab-content">
                {/* 1. Input Invoice & Decode */}
                <div className="form-card">
                  <div className="card-header-row">
                    <h3>1. Input Invoice BOLT11 / RGB & Decode</h3>
                    <div className="inline-actions">
                      {counterpartyNode?.lastInvoice && (
                        <button
                          type="button"
                          className="btn-secondary btn-xs"
                          onClick={() =>
                            onUpdatePaymentDraft({ invoice: counterpartyNode.lastInvoice })
                          }
                        >
                          📋 Incolla ultima Invoice di {counterpartyNode.label}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-lightning btn-xs"
                        disabled={sendBusy || !paymentDraft.invoice.trim()}
                        onClick={() => void handleDecodeClick()}
                      >
                        {sendBusy ? 'Decodifica...' : '🔍 Decode Invoice'}
                      </button>
                    </div>
                  </div>

                  <label className="compact-label">
                    BOLT11 / RGB Lightning Invoice (regtest)
                    <textarea
                      rows={2}
                      value={paymentDraft.invoice}
                      onChange={e => onUpdatePaymentDraft({ invoice: e.target.value })}
                      placeholder="lnbcrt1..."
                    />
                  </label>

                  <div className="row-2col">
                    <label className="compact-label">
                      Importo Lightning (msat)
                      <input
                        inputMode="numeric"
                        value={paymentDraft.amount}
                        onChange={e => onUpdatePaymentDraft({ amount: e.target.value })}
                        placeholder="3000000"
                      />
                    </label>
                    <label className="compact-label">
                      Contract ID RGB / Asset ID
                      <input
                        value={paymentDraft.assetId}
                        onChange={e => onUpdatePaymentDraft({ assetId: e.target.value })}
                        placeholder="BTC oppure rgb:..."
                      />
                    </label>
                  </div>

                  {/* Scheda Strutturata Decodifica Invoice (Zero <pre> grezzi) */}
                  {decodedInvoice && (
                    <div className="decoded-invoice-card">
                      <div className="decoded-header">
                        <span className="status-pill pill-success">INVOICE DECODIFICATA</span>
                        <span className="mono-small">
                          Scadenza: {new Date(decodedInvoice.expiresAt).toLocaleString('it-IT')}
                        </span>
                      </div>
                      <div className="decoded-grid">
                        <div className="kv-box">
                          <span className="kv-label">Importo Asset RGB</span>
                          <strong className="kv-val text-emerald">
                            {decodedInvoice.assetAmount ?? 'N/A (Solo BTC)'}
                          </strong>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Contract ID</span>
                          <code className="kv-val">{decodedInvoice.assetId ?? 'BTC'}</code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Importo HTLC (msat)</span>
                          <strong className="kv-val">
                            {formatNumber(decodedInvoice.amountMsat ?? paymentDraft.amount)} msat
                          </strong>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Destinatario (Payee Pubkey)</span>
                          <code className="kv-val" title={decodedInvoice.payeePubkey ?? ''}>
                            {decodedInvoice.payeePubkey
                              ? `${decodedInvoice.payeePubkey.slice(0, 14)}…${decodedInvoice.payeePubkey.slice(-10)}`
                              : 'n/d'}
                          </code>
                        </div>
                      </div>
                      <CopyableChip label="Payment Hash" value={decodedInvoice.paymentHash} />
                    </div>
                  )}
                </div>

                {/* 2. Configurazione Algoritmo di Routing */}
                {userWallet ? (
                  <p className="notice">I planner MPP e QVAC restano sui nodi della fork. Questo wallet paga senza scegliere l&apos;algoritmo.</p>
                ) : (
                <div className="form-card">
                  <div className="card-header-row">
                    <h3>2. Configurazione Algoritmo di Routing (Feature 2 + 3)</h3>
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="btn-qvac btn-xs"
                        disabled={qvacBusy}
                        onClick={() =>
                          void (onSelectAlgorithmWithQvac
                            ? onSelectAlgorithmWithQvac()
                            : onScoreChannelsWithQvac())
                        }
                      >
                        🧭 Scegli Algoritmo + Score Canali (QVAC)
                      </button>
                      <button
                        type="button"
                        className="btn-secondary btn-xs"
                        disabled={qvacBusy}
                        onClick={() => void onSeedTelemetry()}
                      >
                        Seed Telemetria Demo
                      </button>
                    </div>
                  </div>

                  {/* Synthetic First-Party History Loader */}
                  {onLoadFixtureHistory && (
                    <div className="row-3col" style={{ marginBottom: '0.75rem', alignItems: 'end' }}>
                      <label className="compact-label">
                        Nodo First-Party (Topologia)
                        <select
                          value={fixtureNodeId}
                          onChange={e => onChangeFixtureNodeId?.(e.target.value)}
                          disabled={qvacBusy}
                        >
                          {(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy'] as const).map(n => (
                            <option key={n} value={n}>
                              {n.charAt(0).toUpperCase() + n.slice(1)} (first-party)
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="compact-label">
                        Dataset Storico (Tx)
                        <select
                          value={fixtureLevel}
                          onChange={e => onChangeFixtureLevel?.(Number(e.target.value) as SyntheticHistoryLevel)}
                          disabled={qvacBusy}
                        >
                          {([20, 100, 500, 2000] as const).map(lvl => (
                            <option key={lvl} value={lvl}>
                              history-{String(lvl).padStart(4, '0')}.json ({lvl} tx)
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="btn-secondary btn-xs"
                        disabled={qvacBusy}
                        onClick={() => void onLoadFixtureHistory()}
                      >
                        📥 Carica Storico Nodo
                      </button>
                    </div>
                  )}

                  {fixtureInfo && (
                    <p className="muted-text" style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '0.8rem' }}>
                      Storico first-party attivo: <strong>{fixtureInfo.nodeId.toUpperCase()}</strong> ·{' '}
                      <code>{fixtureInfo.datasetId}</code> ({fixtureInfo.loadedSqliteCount} episodi SQLite,{' '}
                      {fixtureInfo.ingestedRagCount} su QVAC RAG · privacy:{' '}
                      <code>{fixtureInfo.privacyCheck}</code>)
                    </p>
                  )}

                  <label className="compact-label">
                    Seleziona Algoritmo RLN
                    <select
                      value={algorithm}
                      onChange={e => onChangeAlgorithm(e.target.value as RoutingAlgorithm)}
                    >
                      {ROUTING_ALGORITHMS.map(alg => (
                        <option key={alg} value={alg}>
                          {alg}
                        </option>
                      ))}
                    </select>
                  </label>

                  {algorithm === 'multi_objective' && (
                    <div className="weights-sliders-grid">
                      {(['fee', 'reliability', 'cltv', 'hops'] as const).map(key => (
                        <div key={key} className="weight-control-box">
                          <div className="weight-top">
                            <label htmlFor={`weight-${key}`}>Peso {key.toUpperCase()}</label>
                            <input
                              id={`weight-${key}`}
                              type="number"
                              min={0}
                              max={1000000}
                              step={1}
                              value={weights[key]}
                              onChange={e =>
                                onChangeWeights({
                                  ...weights,
                                  [key]: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                            />
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={200}
                            value={Math.min(200, weights[key])}
                            onChange={e =>
                              onChangeWeights({
                                ...weights,
                                [key]: Number(e.target.value),
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {algorithmSelection && (
                    <div className="channel-score-card" style={{ marginBottom: '0.6rem' }}>
                      <div className="card-header-row">
                        <span className="qvac-pill">
                          FEATURE 3 ALGORITMO: {algorithmSelection.selectedAlgorithm.toUpperCase()} ·{' '}
                          {algorithmSelection.reasonCode.toUpperCase()}
                        </span>
                        <span className="mono-small">
                          {algorithmSelection.recommendedRouting.max_paths &&
                          algorithmSelection.recommendedRouting.max_paths > 1
                            ? `MPP max_paths=${algorithmSelection.recommendedRouting.max_paths}`
                            : 'Single-Path (max_paths=1)'}{' '}
                          · {algorithmSelection.latencyMs} ms
                        </span>
                      </div>
                      <p className="muted-text">{algorithmSelection.rationale}</p>
                      <span className="mono-small">
                        Canali usabili: {algorithmSelection.feasibility.usableChannelCount} · Singolo path sano:{' '}
                        {algorithmSelection.feasibility.singlePathHealthyChannelCount} · Probing effimero RAM:{' '}
                        {algorithmSelection.feasibility.ephemeralRamWiped ? 'WIPED ✓' : 'n/a'}
                      </span>
                    </div>
                  )}

                  {channelScore && (
                    <div className="channel-score-card">
                      <div className="card-header-row">
                        <span className="qvac-pill">
                          PROFILO: {channelScore.overallProfile.toUpperCase()} (
                          {channelScore.latencyMs} ms)
                        </span>
                        <span className="mono-small">{channelScore.ragBackend}</span>
                      </div>
                      <p className="muted-text">{channelScore.summary}</p>
                      <div className="score-badges-list">
                        {channelScore.channels.map(ch => (
                          <div key={ch.channelId} className="score-badge-item">
                            <span className="status-pill pill-neutral">
                              {ch.classification.toUpperCase()} · {ch.score}/100
                            </span>
                            <code>{ch.peerAlias ?? ch.channelId.slice(0, 12)}</code>
                            <span className="muted-text">{ch.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                )}

                {/* 3. Form Manuale Vincoli (QVAC Constraints Compiler) */}
                {!userWallet && (
                <div className="form-card">
                  <div className="card-header-row">
                    <h3>3. Form Manuale Vincoli (QVAC Constraints Compiler)</h3>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={onResetExtracted}
                    >
                      Reset Vincoli
                    </button>
                  </div>

                  <div className="row-3col">
                    <label className="compact-label">
                      Max Fee
                      <input
                        inputMode="numeric"
                        value={extracted.feeLimit?.value ?? ''}
                        onChange={e =>
                          onUpdateExtracted({
                            feeLimit: e.target.value
                              ? {
                                  value: e.target.value,
                                  unit: extracted.feeLimit?.unit ?? 'sat',
                                  comparison: extracted.feeLimit?.comparison ?? 'lte',
                                }
                              : null,
                          })
                        }
                        placeholder="Nessun limite"
                      />
                    </label>
                    <label className="compact-label">
                      Unità Fee
                      <select
                        value={extracted.feeLimit?.unit ?? 'sat'}
                        onChange={e =>
                          extracted.feeLimit &&
                          onUpdateExtracted({
                            feeLimit: {
                              ...extracted.feeLimit,
                              unit: e.target.value as 'sat' | 'msat',
                            },
                          })
                        }
                      >
                        <option value="sat">sat</option>
                        <option value="msat">msat</option>
                      </select>
                    </label>
                    <label className="compact-label">
                      Operatore
                      <select
                        value={extracted.feeLimit?.comparison ?? 'lte'}
                        onChange={e =>
                          extracted.feeLimit &&
                          onUpdateExtracted({
                            feeLimit: {
                              ...extracted.feeLimit,
                              comparison: e.target.value as 'lte' | 'lt',
                            },
                          })
                        }
                      >
                        <option value="lte">≤ Massimo (lte)</option>
                        <option value="lt">&lt; Meno di (lt)</option>
                      </select>
                    </label>
                  </div>

                  <label className="compact-label">
                    Nodi Esclusi (lista pubkey o alias separati da virgola)
                    <input
                      value={extracted.excludedNodeReferences.join(', ')}
                      onChange={e =>
                        onUpdateExtracted({
                          excludedNodeReferences: e.target.value
                            .split(',')
                            .map(s => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="Es: 02abc..., Bob"
                    />
                  </label>

                  <div className="row-2col">
                    <label className="compact-label">
                      Priorità di Instradamento
                      <select
                        value={extracted.priority ?? ''}
                        onChange={e =>
                          onUpdateExtracted({
                            priority: (e.target.value || null) as Priority | null,
                          })
                        }
                      >
                        <option value="">Nessuna espressa (default balanced)</option>
                        <option value="lowest_fee">lowest_fee (Minimo costo)</option>
                        <option value="reliability">reliability (Massima affidabilità)</option>
                        <option value="balanced">balanced (Bilanciata)</option>
                      </select>
                    </label>

                    <label className="compact-label">
                      Livello Privacy
                      <select
                        value={extracted.privacyRequest ?? ''}
                        onChange={e =>
                          onUpdateExtracted({
                            privacyRequest: (e.target.value ||
                              null) as ExtractedConstraints['privacyRequest'],
                          })
                        }
                      >
                        <option value="">Standard (MPP consentito)</option>
                        <option value="avoid_extra_probing">
                          avoid_extra_probing (Singolo path / No probing)
                        </option>
                        <option value="unspecified">unspecified (Da precisare)</option>
                      </select>
                    </label>
                  </div>

                  <button
                    type="button"
                    className="btn-qvac full-width"
                    disabled={qvacBusy || !paymentDraft.invoice.trim()}
                    onClick={() => void onCompileConstraintsManual()}
                  >
                    {qvacBusy
                      ? 'Compilazione deterministica...'
                      : '⚙️ Compila Vincoli (/api/constraints/compile)'}
                  </button>

                  {compileResult && (
                    <div className="compiled-policy-card">
                      <div className="card-header-row">
                        <span
                          className={`status-pill ${
                            compileResult.status === 'validated'
                              ? 'pill-success'
                              : 'pill-warning'
                          }`}
                        >
                          {compileResult.code} · {compileResult.status.toUpperCase()}
                        </span>
                        {compileResult.policy && (
                          <code className="mono-small">
                            Policy ID: {compileResult.policy.policyId.slice(0, 12)}…
                          </code>
                        )}
                      </div>
                      {compileResult.normalized && (
                        <div className="decoded-grid">
                          <div className="kv-box">
                            <span className="kv-label">Max Fee Normalizzata</span>
                            <code className="kv-val">
                              {compileResult.normalized.maxRoutingFeeMsat ?? 'Nessun limite'} msat
                            </code>
                          </div>
                          <div className="kv-box">
                            <span className="kv-label">Nodi Esclusi Risolti</span>
                            <code className="kv-val">
                              {compileResult.normalized.excludedNodeIds.join(', ') || 'Nessuno'}
                            </code>
                          </div>
                          <div className="kv-box">
                            <span className="kv-label">Priorità</span>
                            <code className="kv-val">{compileResult.normalized.priority}</code>
                          </div>
                          <div className="kv-box">
                            <span className="kv-label">Preferenza Privacy</span>
                            <code className="kv-val">
                              {compileResult.normalized.privacyPreference}
                            </code>
                          </div>
                        </div>
                      )}
                      {compileResult.issues.map((issue, idx) => (
                        <div key={idx} className="notice compact-notice" role="alert">
                          {issue}
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="constraint-disclaimer">
                    Nota: L&apos;enforcement reale dei vincoli non è ancora attivo a livello
                    protocollo.
                  </p>
                </div>
                )}

                {/* 4. Flusso di Esecuzione Sicuro a 2 Step */}
                <div className="form-card execution-card">
                  <h3>4. Esecuzione Pagamento Sicura a 2 Step</h3>

                  <div className="two-step-buttons">
                    <button
                      type="button"
                      className="btn-lightning"
                      disabled={sendBusy || !paymentDraft.invoice.trim()}
                      onClick={() => void handlePrepareClick()}
                    >
                      {sendBusy ? 'Elaborazione...' : '1. Prepare Payment'}
                    </button>

                    <button
                      type="button"
                      className="btn-rgb"
                      disabled={
                        sendBusy ||
                        preparedIntent?.status !== 'prepared' ||
                        !activeNode.state?.sendEnabled
                      }
                      onClick={() => void handleConfirmClick()}
                    >
                      {sendBusy ? 'Conferma in corso...' : '2. Confirm Payment'}
                    </button>

                    {preparedIntent && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={sendBusy}
                        onClick={() => void onRefreshPaymentIntent()}
                      >
                        ↻ Stato Intento
                      </button>
                    )}
                  </div>

                  {!activeNode.state?.sendEnabled && (
                    <p className="field-hint text-amber">
                      ⚠️ Invio bloccato finché <code>sendEnabled</code> non è attivo sul nodo (
                      <code>ENABLE_REGTEST_SEND=1</code>).
                    </p>
                  )}

                  {preparedIntent && (
                    <div className="prepared-intent-box">
                      <div className="card-header-row">
                        <strong>Intento #{preparedIntent.id.slice(0, 12)}…</strong>
                        <span
                          className={`status-pill ${
                            preparedIntent.status === 'succeeded'
                              ? 'pill-success'
                              : preparedIntent.status === 'prepared'
                                ? 'pill-lightning'
                                : 'pill-warning'
                          }`}
                        >
                          {preparedIntent.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="decoded-grid">
                        <div className="kv-box">
                          <span className="kv-label">Algoritmo Applicato</span>
                          <code className="kv-val">{preparedIntent.routing.algorithm}</code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Importo</span>
                          <code className="kv-val">{preparedIntent.amountMsat} msat</code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Max Fee Policy</span>
                          <code className="kv-val">
                            {preparedIntent.routing.max_fee_msat !== undefined
                              ? `${preparedIntent.routing.max_fee_msat} msat`
                              : 'Standard'}
                          </code>
                        </div>
                        <div className="kv-box">
                          <span className="kv-label">Asset ID</span>
                          <code className="kv-val">{preparedIntent.assetId ?? 'BTC'}</code>
                        </div>
                      </div>
                    </div>
                  )}

                  {sendNotice && (
                    <div className="notice compact-notice" role="status">
                      {sendNotice}
                    </div>
                  )}
                  {sendError && (
                    <div className="error compact-notice" role="alert">
                      {sendError}
                    </div>
                  )}
                </div>

                {/* 5. Storico Pagamenti & Stati Invoice */}
                <div className="form-card">
                  <h3>5. Storico Pagamenti Lightning ({activeNode.history.length})</h3>
                  {activeNode.history.length === 0 ? (
                    <p className="empty-inline">Nessun pagamento registrato su {activeNode.label}.</p>
                  ) : (
                    <div className="history-table">
                      {activeNode.history.map((item, idx) => (
                        <div key={`${item.paymentHash ?? 'pay'}-${idx}`} className="history-row">
                          <span
                            className={`status-pill ${
                              item.status.toLowerCase().includes('succeed')
                                ? 'pill-success'
                                : item.status.toLowerCase().includes('fail')
                                  ? 'pill-danger'
                                  : 'pill-warning'
                            }`}
                          >
                            {item.status.toUpperCase()}
                          </span>
                          <code className="mono-small">
                            {item.paymentHash ? `${item.paymentHash.slice(0, 14)}…` : 'hash n/d'}
                          </code>
                          <strong>{formatNumber(item.amountMsat)} msat</strong>
                          <span className="text-emerald">
                            {item.assetId
                              ? `${item.assetAmount ?? ''} (${item.assetId.slice(0, 12)}…)`
                              : 'BTC'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SUB-TAB 2: RICEVI / CREA INVOICE RGB-LN */}
            {manualSubTab === 'receive' && (
              <div className="subtab-content">
                <div className="form-card">
                  <div className="card-header-row">
                    <h3>Genera Invoice BOLT11 / RGB-LN su {activeNode.label}</h3>
                    <div className="subtab-pills">
                      <button
                        type="button"
                        className={receiveContractMode === 'select' ? 'active' : ''}
                        onClick={() => setReceiveContractMode('select')}
                      >
                        Da Asset del Nodo
                      </button>
                      <button
                        type="button"
                        className={receiveContractMode === 'custom' ? 'active' : ''}
                        onClick={() => setReceiveContractMode('custom')}
                      >
                        Input Contract ID
                      </button>
                    </div>
                  </div>

                  {receiveContractMode === 'select' ? (
                    <label className="compact-label">
                      Seleziona Contract ID RGB
                      <select
                        value={receiveAssetId || activeNode.assets[0]?.assetId || ''}
                        onChange={e => setReceiveAssetId(e.target.value)}
                      >
                        <option value="">Solo BTC (nessun asset RGB)</option>
                        {activeNode.assets.map(a => (
                          <option key={a.assetId ?? ''} value={a.assetId ?? ''}>
                            {a.ticker ?? 'RGB'} — {a.assetId}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="compact-label">
                      Contract ID RGB Manuale (lascia vuoto per solo BTC)
                      <input
                        value={receiveAssetId}
                        onChange={e => setReceiveAssetId(e.target.value)}
                        placeholder="rgb:..."
                      />
                    </label>
                  )}

                  <div className="row-3col">
                    <label className="compact-label">
                      Quantità Asset RGB
                      <input
                        inputMode="numeric"
                        value={receiveAssetAmount}
                        onChange={e => setReceiveAssetAmount(e.target.value)}
                        placeholder="25"
                      />
                    </label>

                    <label className="compact-label">
                      Importo Millisatoshi (msat)
                      <input
                        inputMode="numeric"
                        value={receiveMsat}
                        onChange={e => setReceiveMsat(e.target.value)}
                      />
                    </label>

                    <label className="compact-label">
                      Scadenza (secondi)
                      <input
                        inputMode="numeric"
                        value={receiveExpirySec}
                        onChange={e => setReceiveExpirySec(e.target.value)}
                      />
                    </label>
                  </div>

                  {isReceiveBelowHtlcMin && (
                    <div className="notice compact-notice" role="alert">
                      ⚠️ Attenzione: L&apos;importo msat è inferiore al minimo HTLC RGB di{' '}
                      <strong>3.000.000 msat</strong> (3.000 sat).
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn-rgb full-width"
                    disabled={receiveBusy || !receiveMsat.trim()}
                    onClick={() => void handleGenerateInvoice()}
                  >
                    {receiveBusy ? 'Generazione Invoice...' : '⚡ Genera Invoice'}
                  </button>

                  {receiveNotice && (
                    <div className="notice compact-notice" role="status">
                      {receiveNotice}
                    </div>
                  )}
                  {receiveError && (
                    <div className="error compact-notice" role="alert">
                      {receiveError}
                    </div>
                  )}

                  {generatedInvoice && (
                    <div className="generated-invoice-box">
                      <CopyableChip
                        label={`Invoice Generata (${activeNode.label})`}
                        value={generatedInvoice}
                        truncate={false}
                      />

                      <div className="two-step-buttons">
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={receiveBusy}
                          onClick={() => void handleCheckInvoiceStatus()}
                        >
                          🔍 Verifica Stato Invoice
                        </button>
                        <button
                          type="button"
                          className="btn-qvac"
                          onClick={() => onUseInvoiceOnOtherNode(generatedInvoice)}
                        >
                          ↗ Usa subito come Invoice da pagare sull&apos;altro nodo
                        </button>
                      </div>

                      {invoiceStatusView && (
                        <div className="invoice-status-card">
                          <span className={`status-pill ${invoiceStatusView.tone}`}>
                            {invoiceStatusView.badge}
                          </span>
                          <span>{invoiceStatusView.detail}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SUB-TAB 3: APRI CANALE & CONNETTI PEER */}
            {manualSubTab === 'channels' && (
              <div className="subtab-content">
                <div className="form-card">
                  <div className="card-header-row">
                    <h3>1. Connect Peer (P2P LDK)</h3>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={handleAutoFillPeerUri}
                    >
                      ⚡ Auto-compila Peer URI di {counterpartyNode?.label ?? 'Bob/Alice'}
                    </button>
                  </div>

                  <label className="compact-label">
                    Peer URI (<code>node_id@host:port</code>)
                    <input
                      value={peerUriInput}
                      onChange={e => setPeerUriInput(e.target.value)}
                      placeholder="02...@127.0.0.1:9736"
                    />
                  </label>

                  <button
                    type="button"
                    className="btn-secondary full-width"
                    disabled={channelBusy || !peerUriInput.trim()}
                    onClick={() => void handleConnectPeerClick()}
                  >
                    {channelBusy ? 'Connessione in corso...' : '🔗 Connetti Peer'}
                  </button>
                </div>

                <div className="form-card">
                  <h3>2. Open Channel (BTC + Asset RGB Opzionale)</h3>

                  <div className="row-2col">
                    <label className="compact-label">
                      Peer Pubkey / Node ID o Peer URI
                      <input
                        value={channelPeerInput}
                        onChange={e => setChannelPeerInput(e.target.value)}
                        placeholder={
                          counterpartyNode?.summary?.peerUri ?? '02... oppure pubkey@host:port'
                        }
                      />
                    </label>
                    <label className="compact-label">
                      Capacità Canale BTC (sats)
                      <input
                        inputMode="numeric"
                        value={channelCapacitySat}
                        onChange={e => setChannelCapacitySat(e.target.value)}
                        placeholder="200000"
                      />
                    </label>
                  </div>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={includeRgbInChannel}
                      onChange={e => setIncludeRgbInChannel(e.target.checked)}
                    />
                    <span>Alloca un Asset RGB nel canale Lightning</span>
                  </label>

                  {includeRgbInChannel && (
                    <div className="row-2col">
                      <label className="compact-label">
                        Contract ID Asset RGB
                        {activeNode.assets.length > 0 ? (
                          <select
                            value={channelAssetId || activeNode.assets[0]?.assetId || ''}
                            onChange={e => setChannelAssetId(e.target.value)}
                          >
                            {activeNode.assets.map(a => (
                              <option key={a.assetId ?? ''} value={a.assetId ?? ''}>
                                {a.ticker ?? 'RGB'} — {a.assetId}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={channelAssetId}
                            onChange={e => setChannelAssetId(e.target.value)}
                            placeholder="rgb:..."
                          />
                        )}
                      </label>

                      <label className="compact-label">
                        Asset Amount da allocare nel canale
                        <input
                          inputMode="numeric"
                          value={channelAssetAmount}
                          onChange={e => setChannelAssetAmount(e.target.value)}
                          placeholder="100"
                        />
                      </label>
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn-rgb full-width"
                    disabled={channelBusy || !channelCapacitySat.trim()}
                    onClick={() => void handleOpenChannelClick()}
                  >
                    {channelBusy ? 'Apertura Canale...' : '⚡ Apri Canale'}
                  </button>

                  {channelNotice && (
                    <div className="notice compact-notice" role="status">
                      {channelNotice}
                    </div>
                  )}
                  {channelError && (
                    <div className="error compact-notice" role="alert">
                      {channelError}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* SUB-TAB 4: OPERAZIONI L1 & ASSET RGB (UTXO / NIA) */}
            {manualSubTab === 'l1' && (
              <div className="subtab-content">
                {/* 1. Prepara UTXO RGB */}
                <div className="form-card">
                  <h3>1. Prepara UTXO Colorabili RGB (On-Chain)</h3>
                  <div className="row-3col">
                    <label className="compact-label">
                      Numero UTXO (1–8)
                      <input
                        inputMode="numeric"
                        value={utxoCount}
                        onChange={e => setUtxoCount(e.target.value)}
                      />
                    </label>
                    <label className="compact-label">
                      Dimensione UTXO (sats)
                      <input
                        inputMode="numeric"
                        value={utxoSizeSat}
                        onChange={e => setUtxoSizeSat(e.target.value)}
                      />
                    </label>
                    <label className="compact-label">
                      Fee Rate (sat/vB)
                      <input
                        inputMode="numeric"
                        value={utxoFeeRate}
                        onChange={e => setUtxoFeeRate(e.target.value)}
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn-lightning full-width"
                    disabled={l1Busy}
                    onClick={() => void handlePrepareUtxosClick()}
                  >
                    {l1Busy ? 'Preparazione UTXO...' : '🧱 Prepara UTXO RGB'}
                  </button>
                </div>

                {/* 2. Emetti Asset NIA */}
                <div className="form-card">
                  <h3>2. Emetti Nuovo Asset RGB (Schema NIA)</h3>
                  <div className="row-2col">
                    <label className="compact-label">
                      Ticker (2–8 lettere maiuscole)
                      <input
                        value={niaTicker}
                        onChange={e => setNiaTicker(e.target.value.toUpperCase())}
                        placeholder="TUSDT"
                      />
                    </label>
                    <label className="compact-label">
                      Nome Asset
                      <input
                        value={niaName}
                        onChange={e => setNiaName(e.target.value)}
                        placeholder="Agentic Tether USD"
                      />
                    </label>
                  </div>
                  <div className="row-2col">
                    <label className="compact-label">
                      Quantità / Supply da emettere
                      <input
                        inputMode="numeric"
                        value={niaAmount}
                        onChange={e => setNiaAmount(e.target.value)}
                        placeholder="1000"
                      />
                    </label>
                    <label className="compact-label">
                      Precisione (0–6)
                      <input
                        inputMode="numeric"
                        value={niaPrecision}
                        onChange={e => setNiaPrecision(e.target.value)}
                        placeholder="0"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn-rgb full-width"
                    disabled={l1Busy || !niaTicker.trim() || !niaName.trim() || !niaAmount.trim()}
                    onClick={() => void handleIssueNiaClick()}
                  >
                    {l1Busy ? 'Emissione in corso...' : '🪙 Emetti Asset NIA'}
                  </button>

                  {lastIssuedAsset && (
                    <div className="issued-asset-highlight">
                      <div className="card-header-row">
                        <span className="status-pill pill-success">
                          EMESSO: {lastIssuedAsset.ticker}
                        </span>
                        <span>Supply: {formatNumber(lastIssuedAsset.issuedSupply)}</span>
                      </div>
                      <CopyableChip
                        label="Contract ID Emesso"
                        value={lastIssuedAsset.assetId}
                        truncate={false}
                      />
                    </div>
                  )}
                </div>

                {/* 3. Verifica Saldo per Contract ID */}
                <div className="form-card">
                  <h3>3. Verifica Saldo Puntuale per Contract ID</h3>
                  <div className="input-with-action">
                    <input
                      value={lookupAssetId}
                      onChange={e => setLookupAssetId(e.target.value)}
                      placeholder="rgb:..."
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={l1Busy || !lookupAssetId.trim()}
                      onClick={() => void handleLookupBalanceClick()}
                    >
                      Interroga Saldo
                    </button>
                  </div>

                  {lookupResult && (
                    <div className="decoded-grid" style={{ marginTop: '12px' }}>
                      <div className="kv-box">
                        <span className="kv-label">Settled</span>
                        <strong className="kv-val">{formatNumber(lookupResult.settled)}</strong>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Spendable</span>
                        <strong className="kv-val text-emerald">
                          {formatNumber(lookupResult.spendable)}
                        </strong>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Future</span>
                        <strong className="kv-val">{formatNumber(lookupResult.future)}</strong>
                      </div>
                    </div>
                  )}
                </div>

                {l1Notice && (
                  <div className="notice compact-notice" role="status">
                    {l1Notice}
                  </div>
                )}
                {l1Error && (
                  <div className="error compact-notice" role="alert">
                    {l1Error}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
