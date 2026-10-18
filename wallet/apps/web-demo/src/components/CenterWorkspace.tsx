import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ROUTING_ALGORITHMS,
  type AlgorithmSelectionResult,
  type CompileResult,
  type ExtractedConstraints,
  type ObjectiveWeights,
  type PaymentDraft,
  type PaymentRouting,
  type Priority,
  type RoutingAlgorithm,
} from '../../../../packages/contracts/types.js';
import {
  CopyableChip,
  type NodeAssetBalance,
  type RegtestNodeSnapshot,
} from './RightNodesInspector.js';
import { TxTerminalView } from './TxTerminalView.js';

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

export type DemoPromptShortcut = {
  id: string;
  title: string;
  useCaseTag: string;
  targetNodeId: string;
  rgbAmount: string;
  promptText: string;
  description: string;
};

export const REAL_UC_PROMPT_SHORTCUTS: DemoPromptShortcut[] = [
  {
    id: 'uc-merchant-low-fee',
    title: 'Low-Fee to Bob',
    useCaseTag: '10 DEMO · ≤ 5 SAT',
    targetNodeId: 'bob',
    rgbAmount: '10',
    promptText: 'Send 10 DEMO to Bob, at most 5 sat in fees and spend as little as possible',
    description: 'Settle 10 DEMO to Bob enforcing a strict 5 sat fee ceiling and cost priority.',
  },
  {
    id: 'uc-treasury-reliability',
    title: 'Reliable to Judy',
    useCaseTag: '20 DEMO · RELIABILITY',
    targetNodeId: 'judy',
    rgbAmount: '20',
    promptText: 'Send 20 DEMO to Judy, prioritize reliability with at most 15 sat in fees',
    description: 'Route 20 DEMO across the mesh to Judy prioritizing high-success channels.',
  },
  {
    id: 'uc-detour-exclude-node',
    title: 'Pay Erin (Avoid Bob)',
    useCaseTag: '10 DEMO · DETOUR',
    targetNodeId: 'erin',
    rgbAmount: '10',
    promptText: 'Send 10 DEMO to Erin, avoid Bob, at most 10 sat in fees',
    description: 'Pay 10 DEMO to Erin while excluding Bob so routing detours via Carol.',
  },
  {
    id: 'uc-private-single-path',
    title: 'Private to Dave',
    useCaseTag: '10 DEMO · NO PROBING',
    targetNodeId: 'dave',
    rgbAmount: '10',
    promptText: 'Send 10 DEMO to Dave, avoid extra probing, less than 8 sat in fees',
    description: 'Send 10 DEMO to Dave with single-path privacy (max_paths=1) and < 8 sat fee.',
  },
  {
    id: 'uc-guardrail-cutset',
    title: 'Policy Conflict Test',
    useCaseTag: '15 DEMO · GUARDRAIL',
    targetNodeId: 'judy',
    rgbAmount: '15',
    promptText: 'Send 15 DEMO to Judy, avoid Judy, at most 3 sat in fees',
    description: 'Attempts to exclude the destination node Judy to trigger a pre-execution policy block.',
  },
];

export type ChatTxProposal = {
  id: string;
  timestamp: number;
  senderNodeId: string;
  senderNodeLabel: string;
  targetNodeId: string;
  targetNodeLabel: string;
  prompt: string;
  invoice: string;
  decodedInvoice: DecodedInvoiceView;
  amountMsat: string;
  assetId: string;
  assetTicker: string;
  assetAmount: string | null;
  latencyMs: number | null;
  extracted: ExtractedConstraints;
  compileResult: CompileResult | null;
  selectedAlgorithm: RoutingAlgorithm;
  selectedWeights: ObjectiveWeights;
  maxPaths?: number;
  excludedNodes?: string[];
  excludedNodeLabels: string[];
  rationale?: string;
  status: 'awaiting_approval' | 'executing' | 'confirmed' | 'rejected' | 'error';
  resultMessage: string;
  paymentHash?: string;
  intentId?: string;
};

export type WorkspaceTab = 'chat' | 'manual' | 'terminal';
export type ManualSubTab = 'send' | 'receive' | 'channels' | 'l1';

export type CenterWorkspaceProps = {
  devMode: boolean;
  onToggleDevMode: () => void;
  nodes: RegtestNodeSnapshot[];
  activeNode: RegtestNodeSnapshot;
  onSelectActiveNode: (nodeId: string) => void;
  workspaceTab: WorkspaceTab;
  onChangeWorkspaceTab: (tab: WorkspaceTab) => void;
  manualSubTab: ManualSubTab;
  onChangeManualSubTab: (sub: ManualSubTab) => void;
  terminalNodeFilter: string;

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
  algorithmSelection: AlgorithmSelectionResult | null;
  onSelectAlgorithmWithQvac: (userPreference?: string) => Promise<void>;
  preparedIntent: PreparedPaymentIntent | null;
  onPreparePaymentManual: () => Promise<PreparedPaymentIntent>;
  onConfirmPaymentManual: () => Promise<PreparedPaymentIntent>;

  // Simplified QVAC Chat with Pre-Execution Approval Notification
  chatTargetNodeId: string;
  onChangeChatTargetNodeId: (nodeId: string) => void;
  chatRgbAmount: string;
  onChangeChatRgbAmount: (amount: string) => void;
  chatPrompt: string;
  onChangeChatPrompt: (text: string) => void;
  pendingProposal: ChatTxProposal | null;
  chatHistory: ChatTxProposal[];
  onRequestChatProposal: () => Promise<void>;
  onApproveChatProposal: (proposalId: string) => Promise<void>;
  onRejectChatProposal: (proposalId: string) => void;
  onApplyShortcut: (shortcut: DemoPromptShortcut) => void;

  // Helper to generate an invoice on any target node and load it into Manual Step 1
  onGenerateInvoiceFromNode: (input: {
    targetNodeId: string;
    amountMsat: string;
    assetId?: string;
    assetAmount?: string;
  }) => Promise<string>;

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
  onRefreshAllNodes: () => Promise<void>;
};

function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
}

export function CenterWorkspace({
  devMode,
  onToggleDevMode,
  nodes,
  activeNode,
  onSelectActiveNode,
  workspaceTab,
  onChangeWorkspaceTab,
  manualSubTab,
  onChangeManualSubTab,
  terminalNodeFilter,
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
  algorithmSelection,
  onSelectAlgorithmWithQvac,
  preparedIntent,
  onPreparePaymentManual,
  onConfirmPaymentManual,
  chatTargetNodeId,
  onChangeChatTargetNodeId,
  chatRgbAmount,
  onChangeChatRgbAmount,
  chatPrompt,
  onChangeChatPrompt,
  pendingProposal,
  chatHistory,
  onRequestChatProposal,
  onApproveChatProposal,
  onRejectChatProposal,
  onApplyShortcut,
  onGenerateInvoiceFromNode,
  onCreateInvoice,
  onCheckInvoiceStatus,
  onUseInvoiceOnOtherNode,
  onConnectPeer,
  onOpenChannel,
  onPrepareUtxos,
  onIssueNiaAsset,
  onQueryAssetBalance,
  onRefreshAllNodes,
}: CenterWorkspaceProps) {
  const [selectedOverviewAssetId, setSelectedOverviewAssetId] = useState('');
  const [overviewBalanceBusy, setOverviewBalanceBusy] = useState(false);

  // Guided Manual Step 1 state
  const [invoiceSourceMode, setInvoiceSourceMode] = useState<'auto' | 'paste'>('auto');
  const [manualTargetNodeId, setManualTargetNodeId] = useState<string>('bob');
  const [manualRgbAmount, setManualRgbAmount] = useState<string>('10');
  const [manualAssetMode, setManualAssetMode] = useState<'rgb' | 'btc'>('rgb');
  const [sendBusy, setSendBusy] = useState(false);
  const [sendNotice, setSendNotice] = useState('');
  const [sendError, setSendError] = useState('');
  const [manualApprovalPending, setManualApprovalPending] = useState(false);

  // Manual Sub-tab 2: Receive Invoice state
  const [receiveAssetId, setReceiveAssetId] = useState('');
  const [receiveAssetAmount, setReceiveAssetAmount] = useState('15');
  const [receiveMsat, setReceiveMsat] = useState(String(RGB_HTLC_MIN_MSAT));
  const [generatedInvoice, setGeneratedInvoice] = useState('');
  const [generatedInvoiceStatus, setGeneratedInvoiceStatus] = useState<string>('');
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [receiveError, setReceiveError] = useState('');
  const [receiveNotice, setReceiveNotice] = useState('');

  // Manual Sub-tab 3: Channels state
  const [selectedChannelPeerId, setSelectedChannelPeerId] = useState('bob');
  const [customPeerUri, setCustomPeerUri] = useState('');
  const [channelCapacitySat, setChannelCapacitySat] = useState('200000');
  const [channelAssetAmount, setChannelAssetAmount] = useState('100');
  const [includeRgbInChannel, setIncludeRgbInChannel] = useState(true);
  const [channelBusy, setChannelBusy] = useState(false);
  const [channelNotice, setChannelNotice] = useState('');
  const [channelError, setChannelError] = useState('');

  // Manual Sub-tab 4: L1 & Assets state
  const [utxoCount, setUtxoCount] = useState('4');
  const [utxoSizeSat, setUtxoSizeSat] = useState('200000');
  const [niaTicker, setNiaTicker] = useState('DEMO');
  const [niaName, setNiaName] = useState('Demo RGB Asset');
  const [niaAmount, setNiaAmount] = useState('1000');
  const [l1Busy, setL1Busy] = useState(false);
  const [l1Notice, setL1Notice] = useState('');
  const [l1Error, setL1Error] = useState('');

  const recipientNodes = useMemo(
    () => nodes.filter(n => n.id !== activeNode.id),
    [nodes, activeNode.id],
  );

  const effectiveOverviewAssetId =
    selectedOverviewAssetId || activeNode.assets[0]?.assetId || '';

  const currentOverviewBalance = effectiveOverviewAssetId
    ? activeNode.assetBalances[effectiveOverviewAssetId]
    : undefined;

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

  async function handleOverviewBalanceCheck() {
    if (!effectiveOverviewAssetId.trim()) return;
    setOverviewBalanceBusy(true);
    try {
      await onQueryAssetBalance(effectiveOverviewAssetId.trim());
    } finally {
      setOverviewBalanceBusy(false);
    }
  }

  // Step 1 Guided Manual: Auto-generate invoice on chosen recipient node & decode
  async function handleAutoGenerateRecipientInvoice() {
    const targetId =
      recipientNodes.some(n => n.id === manualTargetNodeId)
        ? manualTargetNodeId
        : (recipientNodes[0]?.id ?? 'bob');
    const chosenAssetId =
      manualAssetMode === 'rgb' ? effectiveOverviewAssetId || undefined : undefined;

    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    setManualApprovalPending(false);
    try {
      const inv = await onGenerateInvoiceFromNode({
        targetNodeId: targetId,
        amountMsat: String(RGB_HTLC_MIN_MSAT),
        ...(chosenAssetId
          ? { assetId: chosenAssetId, assetAmount: manualRgbAmount.trim() || '10' }
          : {}),
      });
      await onDecodeInvoice(inv);
      const targetLabel = nodes.find(n => n.id === targetId)?.label ?? targetId;
      setSendNotice(
        `Invoice generated on ${targetLabel} and decoded. Proceed to Step 2 & Step 3.`,
      );
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  async function handleDecodeManualInvoice() {
    if (!paymentDraft.invoice.trim()) return;
    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    try {
      const d = await onDecodeInvoice(paymentDraft.invoice.trim());
      if (d) setSendNotice('Invoice decoded and verified.');
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  // Toggle node exclusion chip in Guided Manual Step 2
  function toggleExcludedNode(alias: string) {
    const exists = extracted.excludedNodeReferences.some(
      ref => ref.toLowerCase() === alias.toLowerCase(),
    );
    const next = exists
      ? extracted.excludedNodeReferences.filter(ref => ref.toLowerCase() !== alias.toLowerCase())
      : [...extracted.excludedNodeReferences, alias];
    onUpdateExtracted({ excludedNodeReferences: next });
  }

  // Step 3 Guided Manual: Prepare & show approval banner
  async function handleManualPrepareClick() {
    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    try {
      const intent = await onPreparePaymentManual();
      setManualApprovalPending(true);
      setSendNotice(
        `Payment Intent #${intent.id.slice(0, 8)} prepared. Approve below to send HTLC.`,
      );
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  async function handleManualConfirmClick() {
    setSendBusy(true);
    setSendError('');
    setSendNotice('');
    try {
      const confirmed = await onConfirmPaymentManual();
      setManualApprovalPending(false);
      if (confirmed.status === 'succeeded') {
        setSendNotice(
          `CONFIRMED: Payment succeeded! Hash: ${confirmed.paymentHash.slice(0, 16)}…`,
        );
      } else if (confirmed.status === 'failed') {
        setSendError(`Payment failed during settlement (status: ${confirmed.status}).`);
      } else {
        setSendNotice(`Payment submitted. Current status: ${confirmed.status.toUpperCase()}.`);
      }
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSendBusy(false);
    }
  }

  async function handleGenerateInvoiceSubTab() {
    const assetToUse = receiveAssetId || effectiveOverviewAssetId;
    setReceiveBusy(true);
    setReceiveError('');
    setReceiveNotice('');
    try {
      const inv = await onCreateInvoice({
        amountMsat: receiveMsat.trim() || String(RGB_HTLC_MIN_MSAT),
        expirySec: 3600,
        ...(assetToUse
          ? { assetId: assetToUse, assetAmount: receiveAssetAmount.trim() || '10' }
          : {}),
      });
      setGeneratedInvoice(inv);
      setGeneratedInvoiceStatus('');
      setReceiveNotice(`Invoice created on ${activeNode.label}.`);
    } catch (err) {
      setReceiveError((err as Error).message);
    } finally {
      setReceiveBusy(false);
    }
  }

  async function handleCheckInvoiceSubTab() {
    if (!generatedInvoice) return;
    setReceiveBusy(true);
    setReceiveError('');
    try {
      const st = await onCheckInvoiceStatus(generatedInvoice);
      setGeneratedInvoiceStatus(typeof st === 'string' ? st : JSON.stringify(st));
    } catch (err) {
      setReceiveError((err as Error).message);
    } finally {
      setReceiveBusy(false);
    }
  }

  async function handleConnectAndOpenChannel() {
    const peerNode = nodes.find(n => n.id === selectedChannelPeerId);
    const peerUri = customPeerUri.trim() || peerNode?.summary?.peerUri || '';
    if (!peerUri) {
      setChannelError('Select an unlocked peer node or enter a valid pubkey@host:port URI.');
      return;
    }
    const chosenAsset = includeRgbInChannel ? effectiveOverviewAssetId : '';
    setChannelBusy(true);
    setChannelError('');
    setChannelNotice('');
    try {
      try {
        await onConnectPeer(peerUri);
      } catch {
        /* Peer may already be connected */
      }
      await onOpenChannel({
        peer: peerUri,
        capacitySat: channelCapacitySat.trim() || '200000',
        ...(chosenAsset
          ? { assetId: chosenAsset, assetAmount: channelAssetAmount.trim() || '100' }
          : {}),
      });
      setChannelNotice(
        'Channel open requested! Click "+6 Blocks & Sync" in ChainControls to activate it.',
      );
    } catch (err) {
      setChannelError((err as Error).message);
    } finally {
      setChannelBusy(false);
    }
  }

  async function handlePrepareUtxosSubTab() {
    setL1Busy(true);
    setL1Error('');
    setL1Notice('');
    try {
      const msg = await onPrepareUtxos({
        count: Number(utxoCount) || 4,
        sizeSat: utxoSizeSat.trim() || '200000',
        feeRateSatPerVbyte: '2',
      });
      setL1Notice(msg);
    } catch (err) {
      setL1Error((err as Error).message);
    } finally {
      setL1Busy(false);
    }
  }

  async function handleIssueNiaSubTab() {
    setL1Busy(true);
    setL1Error('');
    setL1Notice('');
    try {
      const created = await onIssueNiaAsset({
        ticker: niaTicker.trim().toUpperCase(),
        name: niaName.trim(),
        precision: 0,
        amounts: [Number(niaAmount) || 1000],
      });
      setSelectedOverviewAssetId(created.assetId);
      setL1Notice(`Issued ${created.ticker} (${created.issuedSupply} units) · ${created.assetId}`);
    } catch (err) {
      setL1Error((err as Error).message);
    } finally {
      setL1Busy(false);
    }
  }

  const chatStreamRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  const chronologicalHistory = useMemo(() => [...chatHistory].reverse(), [chatHistory]);

  useEffect(() => {
    const el = chatStreamRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatHistory.length, pendingProposal?.id, qvacBusy, qvacError]);

  const activeAssetTicker =
    activeNode.assets.find(a => a.assetId === effectiveOverviewAssetId)?.ticker ??
    activeNode.assets[0]?.ticker ??
    'DEMO';

  const activeRgbBalanceValue = formatNumber(
    currentOverviewBalance?.spendable ??
      currentOverviewBalance?.settled ??
      liquidityTotals.totalRgbLocal,
  );

  return (
    <main className="center-workspace" aria-label="Central Demo Workspace">
      {/* A. COMPACT WALLET BALANCE BAR */}
      <header className="wallet-compact-topbar">
        <div className="compact-brand-group">
          <div className="brand-avatar-badge">⚡</div>
          <div>
            <span className="eyebrow">AIR-GB · RGB LIGHTNING + QVAC AI</span>
            <h1>{activeNode.label} Wallet</h1>
          </div>
          <span
            className={`status-pill ${
              activeNode.offline
                ? 'pill-danger'
                : activeNode.state?.node === 'ready'
                  ? 'pill-success'
                  : 'pill-warning'
            }`}
          >
            {activeNode.offline
              ? 'OFFLINE'
              : activeNode.state?.node === 'ready'
                ? 'ONLINE'
                : 'LOCKED'}
          </span>
        </div>

        <div className="compact-balances-strip">
          <div className="compact-metric-pill">
            <span className="compact-metric-label">BTC On-Chain</span>
            <strong>{formatNumber(activeNode.summary?.btcSpendableSat)} sats</strong>
          </div>

          <div className="compact-metric-pill pill-rgb-balance">
            <span className="compact-metric-label">RGB Balance</span>
            <strong className="text-emerald">
              {activeRgbBalanceValue} {activeAssetTicker}
            </strong>
            {activeNode.assets.length > 1 && (
              <select
                aria-label="Select RGB Asset"
                className="compact-asset-select"
                value={effectiveOverviewAssetId}
                onChange={e => setSelectedOverviewAssetId(e.target.value)}
              >
                {activeNode.assets.map(a => (
                  <option key={a.assetId ?? ''} value={a.assetId ?? ''}>
                    {a.ticker ?? 'RGB'}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn-icon-xs"
              title="Verify RGB Asset Balance"
              disabled={overviewBalanceBusy || !effectiveOverviewAssetId}
              onClick={() => void handleOverviewBalanceCheck()}
            >
              {overviewBalanceBusy ? '…' : '↻'}
            </button>
          </div>

          <div className="compact-metric-pill">
            <span className="compact-metric-label">Channel Liquidity</span>
            <span>
              ⚡ <strong>{formatNumber(liquidityTotals.totalOutboundMsat)}</strong> msat · 🪙{' '}
              <strong className="text-emerald">{formatNumber(liquidityTotals.totalRgbLocal)}</strong>{' '}
              {activeAssetTicker}
            </span>
          </div>
        </div>

        <div className="inline-actions">
          {devMode && (
            <label
              className="compact-label"
              style={{ flexDirection: 'row', alignItems: 'center', gap: '6px' }}
            >
              <span>Sender:</span>
              <select
                value={activeNode.id}
                onChange={e => onSelectActiveNode(e.target.value)}
                style={{ width: 'auto', minWidth: '125px', padding: '5px 8px' }}
              >
                {nodes.map(n => (
                  <option key={n.id} value={n.id}>
                    {n.label} (:{n.port})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className={`btn-secondary btn-xs ${devMode ? 'btn-dev-active' : ''}`}
            onClick={onToggleDevMode}
            title="Toggle Developer & Node Inspector Panels"
          >
            {devMode ? '✕ Hide Dev Panels' : '⚙️ Dev / Admin'}
          </button>
        </div>
      </header>

      {/* B. WORKSPACE MODE SELECTOR (ONLY VISIBLE IN DEV/ADMIN MODE) */}
      {devMode && (
        <nav className="workspace-mode-tabs" aria-label="Workspace Views">
          <button
            type="button"
            className={`mode-tab-btn tab-qvac ${workspaceTab === 'chat' ? 'active' : ''}`}
            onClick={() => onChangeWorkspaceTab('chat')}
          >
            💬 1. QVAC AI Chat
          </button>
          <button
            type="button"
            className={`mode-tab-btn tab-manual ${workspaceTab === 'manual' ? 'active' : ''}`}
            onClick={() => onChangeWorkspaceTab('manual')}
          >
            🧭 2. Guided Manual TX &amp; Setup
          </button>
          <button
            type="button"
            className={`mode-tab-btn tab-terminal ${workspaceTab === 'terminal' ? 'active' : ''}`}
            onClick={() => onChangeWorkspaceTab('terminal')}
          >
            📟 3. Read-Only TX Terminal
          </button>
        </nav>
      )}

      {/* C. VIEW 1: MODERN CHATBOT UI WITH SUGGESTIONS ABOVE INPUT & AI PARAMETER EXTRACTION */}
      {workspaceTab === 'chat' && (
        <section className="chatbot-shell" aria-label="QVAC AI Payment Chatbot">
          <div className="chatbot-topbar">
            <div className="chatbot-title-row">
              <span className="chatbot-status-dot" />
              <div>
                <h2>QVAC AI Payment Copilot</h2>
                <p className="muted-text">
                  Type naturally who to pay, how much, and your routing constraints — QVAC determines all parameters automatically.
                </p>
              </div>
            </div>
            {qvacLatencyMs !== null && (
              <span className="latency-badge">QVAC Inference: {qvacLatencyMs} ms</span>
            )}
          </div>

          {/* SCROLLABLE CHAT MESSAGE STREAM */}
          <div className="chatbot-messages-stream" ref={chatStreamRef}>
            {chronologicalHistory.length === 0 && !pendingProposal && !qvacBusy && !qvacError && (
              <div className="chatbot-welcome-state">
                <div className="welcome-orb">✨</div>
                <h3>How would you like to route your payment today?</h3>
                <p className="muted-text">
                  Specify the recipient, amount, and routing preferences in a single message (e.g.{' '}
                  <em>“Send 10 DEMO to Bob, at most 5 sat in fees”</em>). QVAC AI extracts every parameter,
                  generates the invoice, selects the routing algorithm, and asks for your approval before sending.
                </p>
              </div>
            )}

            {chronologicalHistory.map(item => (
              <div key={item.id} className="chat-exchange-group">
                {/* User Message Bubble */}
                <div className="chat-row chat-row-user">
                  <div className="chat-bubble chat-bubble-user">
                    <p>{item.prompt}</p>
                    <time className="chat-msg-time">
                      {new Date(item.timestamp).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                </div>

                {/* Assistant Execution Result Card */}
                <div className="chat-row chat-row-assistant">
                  <div className="chat-avatar-assistant">AI</div>
                  <article
                    className={`chat-bubble chat-bubble-assistant action-confirmation-card ${
                      item.status === 'confirmed'
                        ? 'card-confirmed'
                        : item.status === 'error'
                          ? 'card-error'
                          : ''
                    }`}
                  >
                    <div className="action-card-top">
                      <div className="inline-actions">
                        <span
                          className={`status-pill ${
                            item.status === 'confirmed'
                              ? 'pill-success'
                              : item.status === 'error'
                                ? 'pill-danger'
                                : 'pill-neutral'
                          }`}
                        >
                          {item.status === 'confirmed'
                            ? '✓ TX CONFIRMED'
                            : item.status === 'error'
                              ? '✕ TX ERROR'
                              : 'CANCELLED'}
                        </span>
                        <strong>
                          {item.senderNodeLabel} → {item.targetNodeLabel}
                        </strong>
                        <span className="text-emerald">
                          {item.assetAmount
                            ? `${item.assetAmount} ${item.assetTicker}`
                            : `${formatNumber(item.amountMsat)} msat`}
                        </span>
                        <code className="mono-badge">{item.selectedAlgorithm}</code>
                      </div>
                      {item.latencyMs !== null && (
                        <span className="mono-small">QVAC {item.latencyMs} ms</span>
                      )}
                    </div>

                    <div
                      className={
                        item.status === 'error' ? 'error compact-notice' : 'notice compact-notice'
                      }
                      role={item.status === 'error' ? 'alert' : 'status'}
                    >
                      {item.resultMessage}
                    </div>

                    {item.paymentHash && (
                      <CopyableChip label="Settled Payment Hash" value={item.paymentHash} />
                    )}
                  </article>
                </div>
              </div>
            ))}

            {/* Active Thinking State */}
            {qvacBusy && !pendingProposal && (
              <div className="chat-exchange-group">
                <div className="chat-row chat-row-user">
                  <div className="chat-bubble chat-bubble-user">
                    <p>{chatPrompt}</p>
                  </div>
                </div>
                <div className="chat-row chat-row-assistant">
                  <div className="chat-avatar-assistant pulse-avatar">AI</div>
                  <div className="chat-bubble chat-bubble-assistant chat-thinking-bubble">
                    <span className="thinking-dot-group">
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                      <span className="thinking-dot" />
                    </span>
                    <span>
                      QVAC AI is extracting recipient, amount, routing constraints, and preparing the transaction...
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Error State in Chat Stream */}
            {qvacError && (
              <div className="chat-row chat-row-assistant">
                <div className="chat-avatar-assistant">AI</div>
                <div className="chat-bubble chat-bubble-assistant error" role="alert">
                  <strong>QVAC / Routing Error:</strong> {qvacError}
                </div>
              </div>
            )}

            {/* PRE-EXECUTION "ACTION REQUIRED" CARD IN CHAT STREAM */}
            {pendingProposal && (
              <div className="chat-exchange-group">
                <div className="chat-row chat-row-user">
                  <div className="chat-bubble chat-bubble-user">
                    <p>{pendingProposal.prompt}</p>
                    <time className="chat-msg-time">
                      {new Date(pendingProposal.timestamp).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                </div>

                <div className="chat-row chat-row-assistant">
                  <div className="chat-avatar-assistant">AI</div>
                  <div
                    className="approval-notification-banner chat-approval-card"
                    role="dialog"
                    aria-modal="false"
                    aria-label="Transaction Approval Required"
                  >
                    <div className="approval-banner-header">
                      <div className="inline-actions">
                        <span className="status-pill pill-warning">ACTION REQUIRED</span>
                        <h3>🔔 Approve AI-Prepared Transaction</h3>
                      </div>
                      {pendingProposal.latencyMs !== null && (
                        <span className="mono-badge">QVAC {pendingProposal.latencyMs} ms</span>
                      )}
                    </div>

                    <p className="muted-text">
                      QVAC extracted the payment parameters from your prompt and generated an invoice on{' '}
                      <strong>{pendingProposal.targetNodeLabel}</strong>. Review and approve to execute on Lightning.
                    </p>

                    <div className="extracted-kv-grid">
                      <div className="kv-box">
                        <span className="kv-label">Sender → Recipient</span>
                        <strong className="kv-val">
                          {pendingProposal.senderNodeLabel} → {pendingProposal.targetNodeLabel}
                        </strong>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Payment Amount</span>
                        <strong className="kv-val text-emerald">
                          {pendingProposal.assetAmount
                            ? `${pendingProposal.assetAmount} ${pendingProposal.assetTicker} (${formatNumber(pendingProposal.amountMsat)} msat)`
                            : `${formatNumber(pendingProposal.amountMsat)} msat (BTC)`}
                        </strong>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Selected Routing Algorithm</span>
                        <code className="kv-val text-qvac">{pendingProposal.selectedAlgorithm}</code>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Max Fee Cap</span>
                        <code className="kv-val">
                          {pendingProposal.compileResult?.normalized?.maxRoutingFeeMsat
                            ? `≤ ${formatNumber(pendingProposal.compileResult.normalized.maxRoutingFeeMsat)} msat`
                            : pendingProposal.extracted.feeLimit
                              ? `${pendingProposal.extracted.feeLimit.comparison === 'lt' ? '<' : '≤'} ${pendingProposal.extracted.feeLimit.value} ${pendingProposal.extracted.feeLimit.unit}`
                              : 'Standard (no hard cap)'}
                        </code>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Excluded Nodes</span>
                        <code className="kv-val">
                          {pendingProposal.excludedNodeLabels.length > 0
                            ? pendingProposal.excludedNodeLabels.join(', ')
                            : 'None'}
                        </code>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Priority &amp; Privacy</span>
                        <code className="kv-val">
                          {pendingProposal.extracted.priority ?? 'balanced'} /{' '}
                          {pendingProposal.extracted.privacyRequest ?? 'standard'}
                          {pendingProposal.maxPaths ? ` (max_paths=${pendingProposal.maxPaths})` : ''}
                        </code>
                      </div>
                    </div>

                    {pendingProposal.rationale && (
                      <div className="notice compact-notice">
                        <strong>QVAC Routing Strategy:</strong> {pendingProposal.rationale}
                      </div>
                    )}

                    {(pendingProposal.compileResult?.status === 'conflict' ||
                      pendingProposal.compileResult?.status === 'needs_clarification') &&
                      pendingProposal.compileResult.issues.map((issue, idx) => (
                        <div key={idx} className="error compact-notice" role="alert">
                          <strong>Policy Block:</strong> {issue}
                        </div>
                      ))}

                    <div className="approval-actions-row">
                      <button
                        type="button"
                        className="btn-rgb"
                        disabled={
                          pendingProposal.status === 'executing' ||
                          pendingProposal.compileResult?.status === 'conflict' ||
                          pendingProposal.compileResult?.status === 'needs_clarification'
                        }
                        onClick={() => void onApproveChatProposal(pendingProposal.id)}
                      >
                        {pendingProposal.status === 'executing'
                          ? 'Executing Payment on RLN...'
                          : '✅ Approve & Execute Payment'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={pendingProposal.status === 'executing'}
                        onClick={() => onRejectChatProposal(pendingProposal.id)}
                      >
                        ❌ Reject / Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* BOTTOM DOCK: DEMO PROMPT SHORTCUTS ABOVE THE TEXT BAR */}
          <div className="chatbot-bottom-dock">
            <div className="prompt-suggestions-above-bar" aria-label="Demo Prompt Suggestions">
              <span className="suggestions-label">Suggestions:</span>
              <div className="suggestions-chips-scroll">
                {REAL_UC_PROMPT_SHORTCUTS.map(sc => (
                  <button
                    key={sc.id}
                    type="button"
                    className={`prompt-suggestion-chip ${
                      chatPrompt.trim() === sc.promptText.trim() ? 'chip-active' : ''
                    }`}
                    title={sc.promptText}
                    onClick={() => {
                      onApplyShortcut(sc);
                      chatInputRef.current?.focus();
                    }}
                  >
                    <span className="chip-title">{sc.title}</span>
                    <span className="chip-tag">{sc.useCaseTag}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="chatbot-input-bar">
              <textarea
                ref={chatInputRef}
                rows={2}
                value={chatPrompt}
                onChange={e => onChangeChatPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!qvacBusy && chatPrompt.trim()) {
                      void onRequestChatProposal();
                    }
                  }
                }}
                placeholder="Message QVAC AI (e.g. 'Send 10 DEMO to Bob, at most 5 sat in fees and spend as little as possible')..."
                maxLength={1000}
                aria-label="Payment Prompt"
              />
              <button
                type="button"
                className="btn-qvac chatbot-send-btn"
                disabled={qvacBusy || !chatPrompt.trim()}
                onClick={() => void onRequestChatProposal()}
              >
                {qvacBusy ? 'Analyzing…' : 'Send ↑'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* D. VIEW 2: GUIDED MANUAL TX WIZARD & ESSENTIAL SETUP */}
      {workspaceTab === 'manual' && (
        <section className="workspace-panel manual-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow text-emerald">GUIDED TRANSACTION BUILDER</span>
              <h2>🧭 Guided Manual Operations ({activeNode.label})</h2>
            </div>
          </div>

          <div className="manual-subtabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={manualSubTab === 'send'}
              className={`subtab-btn ${manualSubTab === 'send' ? 'active' : ''}`}
              onClick={() => onChangeManualSubTab('send')}
            >
              ⚡ 1. Guided Send TX
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={manualSubTab === 'receive'}
              className={`subtab-btn ${manualSubTab === 'receive' ? 'active' : ''}`}
              onClick={() => onChangeManualSubTab('receive')}
            >
              📥 2. Receive Invoice
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={manualSubTab === 'channels'}
              className={`subtab-btn ${manualSubTab === 'channels' ? 'active' : ''}`}
              onClick={() => onChangeManualSubTab('channels')}
            >
              🔗 3. Open Channel
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={manualSubTab === 'l1'}
              className={`subtab-btn ${manualSubTab === 'l1' ? 'active' : ''}`}
              onClick={() => onChangeManualSubTab('l1')}
            >
              🪙 4. L1 UTXOs &amp; Issue Asset
            </button>
          </div>

          {/* SUB-TAB 1: 3-STEP GUIDED SEND TX WIZARD */}
          {manualSubTab === 'send' && (
            <div className="subtab-content">
              {/* STEP 1: DESTINATION & INVOICE */}
              <div className="form-card wizard-step-card">
                <div className="card-header-row">
                  <div className="inline-actions">
                    <span className="step-number-badge">STEP 1</span>
                    <h3>Destination &amp; Invoice (Essential Payment Info)</h3>
                  </div>
                  <div className="subtab-pills" style={{ width: 'auto' }}>
                    <button
                      type="button"
                      className={invoiceSourceMode === 'auto' ? 'active' : ''}
                      onClick={() => setInvoiceSourceMode('auto')}
                    >
                      Pick Recipient Node
                    </button>
                    <button
                      type="button"
                      className={invoiceSourceMode === 'paste' ? 'active' : ''}
                      onClick={() => setInvoiceSourceMode('paste')}
                    >
                      Paste BOLT11 Invoice
                    </button>
                  </div>
                </div>

                {invoiceSourceMode === 'auto' ? (
                  <div className="row-3col" style={{ alignItems: 'end' }}>
                    <label className="compact-label">
                      Recipient Node
                      <select
                        value={manualTargetNodeId}
                        onChange={e => setManualTargetNodeId(e.target.value)}
                      >
                        {recipientNodes.map(n => (
                          <option key={n.id} value={n.id}>
                            {n.label} (:{n.port})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="compact-label">
                      Asset Type
                      <select
                        value={manualAssetMode}
                        onChange={e => setManualAssetMode(e.target.value as 'rgb' | 'btc')}
                      >
                        <option value="rgb">
                          RGB Asset ({activeNode.assets[0]?.ticker ?? 'DEMO'})
                        </option>
                        <option value="btc">BTC Only (3,000 sat)</option>
                      </select>
                    </label>

                    {manualAssetMode === 'rgb' ? (
                      <label className="compact-label">
                        RGB Units to Send
                        <div className="input-with-action">
                          <input
                            inputMode="numeric"
                            value={manualRgbAmount}
                            onChange={e => setManualRgbAmount(e.target.value)}
                            placeholder="10"
                          />
                          <button
                            type="button"
                            className="btn-lightning"
                            disabled={sendBusy}
                            onClick={() => void handleAutoGenerateRecipientInvoice()}
                          >
                            {sendBusy ? '...' : '⚡ Load Invoice'}
                          </button>
                        </div>
                      </label>
                    ) : (
                      <button
                        type="button"
                        className="btn-lightning"
                        disabled={sendBusy}
                        onClick={() => void handleAutoGenerateRecipientInvoice()}
                      >
                        {sendBusy ? 'Generating...' : '⚡ Generate BTC Invoice'}
                      </button>
                    )}
                  </div>
                ) : (
                  <label className="compact-label">
                    BOLT11 / RGB Lightning Invoice
                    <div className="input-with-action">
                      <input
                        value={paymentDraft.invoice}
                        onChange={e => onUpdatePaymentDraft({ invoice: e.target.value })}
                        placeholder="lnbcrt1..."
                      />
                      <button
                        type="button"
                        className="btn-lightning"
                        disabled={sendBusy || !paymentDraft.invoice.trim()}
                        onClick={() => void handleDecodeManualInvoice()}
                      >
                        {sendBusy ? '...' : 'Decode'}
                      </button>
                    </div>
                  </label>
                )}

                {decodedInvoice && (
                  <div className="decoded-invoice-card">
                    <div className="decoded-header">
                      <span className="status-pill pill-success">✓ INVOICE READY</span>
                      <span className="mono-small">
                        Hash: {decodedInvoice.paymentHash.slice(0, 16)}…
                      </span>
                    </div>
                    <div className="decoded-grid">
                      <div className="kv-box">
                        <span className="kv-label">RGB Asset Amount</span>
                        <strong className="kv-val text-emerald">
                          {decodedInvoice.assetAmount
                            ? `${decodedInvoice.assetAmount} units`
                            : 'BTC Only'}
                        </strong>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">HTLC Amount</span>
                        <strong className="kv-val">
                          {formatNumber(decodedInvoice.amountMsat ?? paymentDraft.amount)} msat
                        </strong>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* STEP 2: ESSENTIAL ROUTING & PREFERENCES */}
              <div className="form-card wizard-step-card">
                <div className="card-header-row">
                  <div className="inline-actions">
                    <span className="step-number-badge">STEP 2</span>
                    <h3>Routing Strategy &amp; Essential Constraints</h3>
                  </div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="btn-qvac btn-xs"
                      disabled={qvacBusy || !paymentDraft.invoice.trim()}
                      onClick={() => void onSelectAlgorithmWithQvac()}
                    >
                      ✨ Auto-Tune Route with QVAC
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={onResetExtracted}
                    >
                      Reset
                    </button>
                  </div>
                </div>

                <div className="row-3col">
                  <label className="compact-label">
                    Routing Algorithm
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

                  <label className="compact-label">
                    Max Routing Fee Cap (sat)
                    <input
                      inputMode="numeric"
                      value={extracted.feeLimit?.value ?? ''}
                      onChange={e =>
                        onUpdateExtracted({
                          feeLimit: e.target.value
                            ? {
                                value: e.target.value,
                                unit: 'sat',
                                comparison: 'lte',
                              }
                            : null,
                        })
                      }
                      placeholder="No limit (e.g. 10)"
                    />
                  </label>

                  <label className="compact-label">
                    Optimization Priority
                    <select
                      value={extracted.priority ?? ''}
                      onChange={e =>
                        onUpdateExtracted({
                          priority: (e.target.value || null) as Priority | null,
                        })
                      }
                    >
                      <option value="">Balanced (Default)</option>
                      <option value="lowest_fee">Lowest Fee</option>
                      <option value="reliability">High Reliability</option>
                    </select>
                  </label>
                </div>

                {algorithm === 'multi_objective' && (
                  <div className="row-2col">
                    <label className="compact-label">
                      Fee Weight ({weights.fee})
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.min(100, weights.fee)}
                        onChange={e =>
                          onChangeWeights({ ...weights, fee: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label className="compact-label">
                      Reliability Weight ({weights.reliability})
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.min(100, weights.reliability)}
                        onChange={e =>
                          onChangeWeights({ ...weights, reliability: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>
                )}

                <div className="row-2col" style={{ alignItems: 'center' }}>
                  <div>
                    <span className="muted-label">Click Intermediate Nodes to Exclude:</span>
                    <div className="quick-node-pills" style={{ marginTop: '6px' }}>
                      {recipientNodes.slice(0, 8).map(n => {
                        const isExcluded = extracted.excludedNodeReferences.some(
                          ref => ref.toLowerCase() === n.label.toLowerCase(),
                        );
                        return (
                          <button
                            key={n.id}
                            type="button"
                            className={`node-pill-btn ${isExcluded ? 'pill-excluded' : ''}`}
                            onClick={() => toggleExcludedNode(n.label)}
                          >
                            {isExcluded ? `✕ ${n.label}` : n.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={extracted.privacyRequest === 'avoid_extra_probing'}
                      onChange={e =>
                        onUpdateExtracted({
                          privacyRequest: e.target.checked ? 'avoid_extra_probing' : null,
                        })
                      }
                    />
                    <span>Single-Path Privacy (Disable extra route probing)</span>
                  </label>
                </div>

                {algorithmSelection && (
                  <div className="notice compact-notice">
                    <strong>QVAC Recommended:</strong>{' '}
                    <code>{algorithmSelection.selectedAlgorithm}</code> —{' '}
                    {algorithmSelection.rationale}
                  </div>
                )}
              </div>

              {/* STEP 3: PREPARE, APPROVE & SEND */}
              <div className="form-card wizard-step-card execution-card">
                <div className="inline-actions">
                  <span className="step-number-badge">STEP 3</span>
                  <h3>Prepare &amp; Confirm Execution</h3>
                </div>

                <div className="two-step-buttons">
                  <button
                    type="button"
                    className="btn-lightning"
                    disabled={sendBusy || qvacBusy || !paymentDraft.invoice.trim()}
                    onClick={() => void handleManualPrepareClick()}
                  >
                    {sendBusy ? 'Preparing...' : '1. Prepare & Validate TX'}
                  </button>

                  <button
                    type="button"
                    className="btn-rgb"
                    disabled={
                      sendBusy ||
                      preparedIntent?.status !== 'prepared' ||
                      !activeNode.state?.sendEnabled
                    }
                    onClick={() => void handleManualConfirmClick()}
                  >
                    {sendBusy ? 'Sending...' : '2. Approve & Send Payment'}
                  </button>
                </div>

                {(manualApprovalPending || preparedIntent) && (
                  <div className="prepared-intent-box">
                    <div className="card-header-row">
                      <strong>
                        Intent #{preparedIntent?.id.slice(0, 10)} · Ready for Approval
                      </strong>
                      <span
                        className={`status-pill ${
                          preparedIntent?.status === 'succeeded'
                            ? 'pill-success'
                            : preparedIntent?.status === 'prepared'
                              ? 'pill-lightning'
                              : 'pill-warning'
                        }`}
                      >
                        {preparedIntent?.status.toUpperCase()}
                      </span>
                    </div>
                    <div className="decoded-grid">
                      <div className="kv-box">
                        <span className="kv-label">Algorithm</span>
                        <code className="kv-val">{preparedIntent?.routing.algorithm}</code>
                      </div>
                      <div className="kv-box">
                        <span className="kv-label">Max Fee</span>
                        <code className="kv-val">
                          {preparedIntent?.routing.max_fee_msat !== undefined
                            ? `${preparedIntent.routing.max_fee_msat} msat`
                            : 'Standard'}
                        </code>
                      </div>
                    </div>
                  </div>
                )}

                {(compileResult?.status === 'conflict' ||
                  compileResult?.status === 'needs_clarification') &&
                  compileResult.issues.map((issue, idx) => (
                    <div key={idx} className="error compact-notice" role="alert">
                      {issue}
                    </div>
                  ))}

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
            </div>
          )}

          {/* SUB-TAB 2: RECEIVE INVOICE */}
          {manualSubTab === 'receive' && (
            <div className="subtab-content">
              <div className="form-card">
                <h3>Generate BOLT11 / RGB Invoice on {activeNode.label}</h3>
                <div className="row-3col">
                  <label className="compact-label">
                    RGB Asset
                    <select
                      value={receiveAssetId || effectiveOverviewAssetId}
                      onChange={e => setReceiveAssetId(e.target.value)}
                    >
                      <option value="">BTC Only</option>
                      {activeNode.assets.map(a => (
                        <option key={a.assetId ?? ''} value={a.assetId ?? ''}>
                          {a.ticker ?? 'RGB'} — {a.assetId?.slice(0, 16)}…
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="compact-label">
                    RGB Units
                    <input
                      inputMode="numeric"
                      value={receiveAssetAmount}
                      onChange={e => setReceiveAssetAmount(e.target.value)}
                    />
                  </label>
                  <label className="compact-label">
                    HTLC msat (min 3,000,000)
                    <input
                      inputMode="numeric"
                      value={receiveMsat}
                      onChange={e => setReceiveMsat(e.target.value)}
                    />
                  </label>
                </div>

                <button
                  type="button"
                  className="btn-rgb full-width"
                  disabled={receiveBusy}
                  onClick={() => void handleGenerateInvoiceSubTab()}
                >
                  {receiveBusy ? 'Generating...' : '⚡ Generate Invoice'}
                </button>

                {receiveNotice && <div className="notice compact-notice">{receiveNotice}</div>}
                {receiveError && <div className="error compact-notice">{receiveError}</div>}

                {generatedInvoice && (
                  <div className="generated-invoice-box">
                    <CopyableChip
                      label={`Invoice (${activeNode.label})`}
                      value={generatedInvoice}
                      truncate={false}
                    />
                    <div className="two-step-buttons">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void handleCheckInvoiceSubTab()}
                      >
                        Check Status
                      </button>
                      <button
                        type="button"
                        className="btn-qvac"
                        onClick={() => onUseInvoiceOnOtherNode(generatedInvoice)}
                      >
                        ↗ Pay this Invoice from Counterparty Node
                      </button>
                    </div>
                    {generatedInvoiceStatus && (
                      <code className="mono-small">Status: {generatedInvoiceStatus}</code>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SUB-TAB 3: OPEN CHANNEL */}
          {manualSubTab === 'channels' && (
            <div className="subtab-content">
              <div className="form-card">
                <h3>Connect Peer &amp; Open Channel from {activeNode.label}</h3>
                <div className="row-2col">
                  <label className="compact-label">
                    Select Topology Peer Node
                    <select
                      value={selectedChannelPeerId}
                      onChange={e => {
                        setSelectedChannelPeerId(e.target.value);
                        setCustomPeerUri('');
                      }}
                    >
                      {recipientNodes.map(n => (
                        <option key={n.id} value={n.id}>
                          {n.label} (:{n.port}) — {n.summary?.peerUri ? 'URI Ready' : 'Locked'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="compact-label">
                    Or Custom Peer URI (pubkey@host:port)
                    <input
                      value={customPeerUri}
                      onChange={e => setCustomPeerUri(e.target.value)}
                      placeholder={
                        nodes.find(n => n.id === selectedChannelPeerId)?.summary?.peerUri ??
                        '02...@127.0.0.1:9802'
                      }
                    />
                  </label>
                </div>

                <div className="row-2col">
                  <label className="compact-label">
                    Channel BTC Capacity (sats)
                    <input
                      inputMode="numeric"
                      value={channelCapacitySat}
                      onChange={e => setChannelCapacitySat(e.target.value)}
                    />
                  </label>
                  <label className="compact-label">
                    RGB Asset Amount in Channel
                    <input
                      inputMode="numeric"
                      value={channelAssetAmount}
                      disabled={!includeRgbInChannel}
                      onChange={e => setChannelAssetAmount(e.target.value)}
                    />
                  </label>
                </div>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={includeRgbInChannel}
                    onChange={e => setIncludeRgbInChannel(e.target.checked)}
                  />
                  <span>Include RGB Asset ({activeNode.assets[0]?.ticker ?? 'DEMO'}) in Channel</span>
                </label>

                <button
                  type="button"
                  className="btn-rgb full-width"
                  disabled={channelBusy}
                  onClick={() => void handleConnectAndOpenChannel()}
                >
                  {channelBusy ? 'Connecting & Opening Channel...' : '🔗 Connect & Open Channel'}
                </button>

                {channelNotice && <div className="notice compact-notice">{channelNotice}</div>}
                {channelError && <div className="error compact-notice">{channelError}</div>}
              </div>
            </div>
          )}

          {/* SUB-TAB 4: L1 UTXOs & ISSUE ASSET */}
          {manualSubTab === 'l1' && (
            <div className="subtab-content">
              <div className="form-card">
                <h3>1. Prepare Colorable RGB UTXOs on {activeNode.label}</h3>
                <div className="row-2col">
                  <label className="compact-label">
                    UTXO Count
                    <input
                      inputMode="numeric"
                      value={utxoCount}
                      onChange={e => setUtxoCount(e.target.value)}
                    />
                  </label>
                  <label className="compact-label">
                    Size per UTXO (sats)
                    <input
                      inputMode="numeric"
                      value={utxoSizeSat}
                      onChange={e => setUtxoSizeSat(e.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="btn-lightning full-width"
                  disabled={l1Busy}
                  onClick={() => void handlePrepareUtxosSubTab()}
                >
                  {l1Busy ? 'Preparing...' : '🧱 Prepare RGB UTXOs'}
                </button>
              </div>

              <div className="form-card">
                <h3>2. Issue RGB Asset (NIA)</h3>
                <div className="row-3col">
                  <label className="compact-label">
                    Ticker
                    <input
                      value={niaTicker}
                      onChange={e => setNiaTicker(e.target.value.toUpperCase())}
                    />
                  </label>
                  <label className="compact-label">
                    Asset Name
                    <input value={niaName} onChange={e => setNiaName(e.target.value)} />
                  </label>
                  <label className="compact-label">
                    Supply
                    <input
                      inputMode="numeric"
                      value={niaAmount}
                      onChange={e => setNiaAmount(e.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="btn-rgb full-width"
                  disabled={l1Busy}
                  onClick={() => void handleIssueNiaSubTab()}
                >
                  {l1Busy ? 'Issuing...' : '🪙 Issue NIA Asset'}
                </button>
              </div>

              {l1Notice && <div className="notice compact-notice">{l1Notice}</div>}
              {l1Error && <div className="error compact-notice">{l1Error}</div>}
            </div>
          )}
        </section>
      )}

      {/* E. VIEW 3: READ-ONLY TRANSACTION TERMINAL */}
      {workspaceTab === 'terminal' && (
        <TxTerminalView
          nodes={nodes}
          initialNodeFilter={terminalNodeFilter}
          busy={qvacBusy}
          onRefreshAll={onRefreshAllNodes}
        />
      )}
    </main>
  );
}
