import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AlgorithmSelectionResult,
  ChannelScoringResult,
  CompileResult,
  ExtractedConstraints,
  FixtureLoadResult,
  ObjectiveWeights,
  PaymentDraft,
  PaymentRouting,
  RoutingAlgorithm,
  SyntheticHistoryLevel,
} from '../../../packages/contracts/types.js';
import {
  CenterWorkspace,
  RGB_HTLC_MIN_MSAT,
  type ChatActionCardData,
  type DecodedInvoiceView,
  type ManualSubTab,
  type PreparedPaymentIntent,
  type SetupOperationDraft,
  type WorkspaceTab,
} from './components/CenterWorkspace.js';
import {
  LeftServiceSidebar,
  type DemoPreset,
  type NodeWalletState,
  type ServiceHealth,
} from './components/LeftServiceSidebar.js';
import {
  RightNodesInspector,
  type NodeAssetBalance,
  type NodeAssetRow,
  type NodeChannelRow,
  type NodePaymentHistoryRow,
  type NodeSummaryInfo,
  type RegtestNodeSnapshot,
} from './components/RightNodesInspector.js';
import { ALICE_BASE_URL, UI_NODES, useNodeDirectory } from './components/node-client.js';

const INITIAL_EXTRACTED: ExtractedConstraints = {
  schemaVersion: '1.0',
  status: 'parsed',
  feeLimit: null,
  excludedNodeReferences: [],
  priority: null,
  privacyRequest: null,
  unhandledRequests: [],
};

const DEFAULT_WEIGHTS: ObjectiveWeights = {
  fee: 10,
  reliability: 50,
  cltv: 5,
  hops: 10,
};

type NodeMutableData = {
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

const EMPTY_NODE_DATA: NodeMutableData = {
  busy: false,
  error: '',
  notice: '',
  state: null,
  summary: null,
  channels: [],
  assets: [],
  assetBalances: {},
  history: [],
  lastInvoice: '',
};

function deriveSuggestedRouting(
  extracted: ExtractedConstraints,
  compiled: CompileResult | null,
): { algorithm: RoutingAlgorithm; weights: ObjectiveWeights } {
  const priority = compiled?.normalized?.priority ?? extracted.priority;
  if (priority === 'lowest_fee') {
    return {
      algorithm: 'multi_objective',
      weights: { fee: 100, reliability: 15, cltv: 1, hops: 5 },
    };
  }
  if (priority === 'reliability') {
    return {
      algorithm: 'multi_objective',
      weights: { fee: 5, reliability: 100, cltv: 5, hops: 10 },
    };
  }
  if (extracted.feeLimit || extracted.excludedNodeReferences.length > 0 || extracted.privacyRequest) {
    return {
      algorithm: 'multi_objective',
      weights: { fee: 35, reliability: 55, cltv: 5, hops: 10 },
    };
  }
  return {
    algorithm: 'ldk_dijkstra',
    weights: DEFAULT_WEIGHTS,
  };
}

function detectSetupDraftFromPrompt(
  prompt: string,
  counterpartyPeerUri: string | null | undefined,
): SetupOperationDraft | undefined {
  const lower = prompt.toLowerCase();
  if (lower.includes('utxo')) {
    const countMatch = /(\d+)\s*utxo/i.exec(prompt);
    const satMatch = /(\d{4,7})\s*sat/i.exec(prompt);
    return {
      kind: 'prepare_utxos',
      count: countMatch ? Math.min(8, Math.max(1, Number(countMatch[1]))) : 4,
      sizeSat: satMatch ? satMatch[1] : '200000',
      feeRateSatPerVbyte: '2',
    };
  }
  if (lower.includes('emetti') || lower.includes('issue') || lower.includes('nia')) {
    const tickerMatch = /\b([A-Z]{2,8})\b/.exec(prompt);
    return {
      kind: 'issue_nia',
      ticker: tickerMatch ? tickerMatch[1] : 'TUSDT',
      name: 'Agentic Tether USD',
      precision: 0,
      amount: 1000,
    };
  }
  if (lower.includes('apri canale') || lower.includes('open channel')) {
    return {
      kind: 'open_channel',
      peer: counterpartyPeerUri ?? '127.0.0.1:9802',
      capacitySat: '200000',
    };
  }
  return undefined;
}

type NodeId = string;

export function App() {
  const sessions = useNodeDirectory(UI_NODES);
  const aliceSession = sessions.alice;

  const [activeNodeId, setActiveNodeId] = useState<NodeId>('alice');
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('chat');
  const [manualSubTab, setManualSubTab] = useState<ManualSubTab>('send');

  // Health & Chain state
  const [health, setHealth] = useState<ServiceHealth>({
    api: 'checking',
    rln: 'checking',
    qvac: 'checking',
  });
  const [healthLoading, setHealthLoading] = useState(false);
  const [chainHeight, setChainHeight] = useState<number | null>(null);
  const [chainBusy, setChainBusy] = useState(false);
  const [chainMessage, setChainMessage] = useState('');
  const [chainError, setChainError] = useState('');

  // Node mutable states
  const [nodeMap, setNodeMap] = useState<Record<NodeId, NodeMutableData>>(() =>
    Object.fromEntries(UI_NODES.map(node => [node.id, { ...EMPTY_NODE_DATA }])),
  );

  // Payment, Routing & QVAC Constraints State (with revision + AbortController)
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>({
    invoice: '',
    amount: String(RGB_HTLC_MIN_MSAT),
    assetId: 'BTC',
    network: 'regtest',
  });
  const [decodedInvoice, setDecodedInvoice] = useState<DecodedInvoiceView | null>(null);
  const [algorithm, setAlgorithm] = useState<RoutingAlgorithm>('ldk_dijkstra');
  const [weights, setWeights] = useState<ObjectiveWeights>(DEFAULT_WEIGHTS);
  const [extracted, setExtracted] = useState<ExtractedConstraints>(INITIAL_EXTRACTED);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [channelScore, setChannelScore] = useState<ChannelScoringResult | null>(null);
  const [algorithmSelection, setAlgorithmSelection] = useState<AlgorithmSelectionResult | null>(null);
  const [fixtureNodeId, setFixtureNodeId] = useState<string>('alice');
  const [fixtureLevel, setFixtureLevel] = useState<SyntheticHistoryLevel>(100);
  const [fixtureInfo, setFixtureInfo] = useState<FixtureLoadResult | null>(null);
  const [preparedIntent, setPreparedIntent] = useState<PreparedPaymentIntent | null>(null);

  const [chatPrompt, setChatPrompt] = useState('');
  const [chatCards, setChatCards] = useState<ChatActionCardData[]>([]);
  const [qvacBusy, setQvacBusy] = useState(false);
  const [qvacLatencyMs, setQvacLatencyMs] = useState<number | null>(null);
  const [qvacError, setQvacError] = useState('');

  // Concurrency control: revision + AbortController
  const revisionRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const invalidateQvacConcurrency = useCallback(() => {
    revisionRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setCompileResult(null);
    setQvacError('');
    setQvacLatencyMs(null);
    setQvacBusy(false);
  }, []);

  const patchNodeData = useCallback((id: NodeId, patch: Partial<NodeMutableData>) => {
    setNodeMap(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY_NODE_DATA), ...patch },
    }));
  }, []);

  const getSessionForNode = useCallback(
    (id: string) => sessions[id] ?? sessions.alice,
    [sessions],
  );

  const getBaseUrlForNode = useCallback(
    (id: string) => sessions[id]?.baseUrl ?? ALICE_BASE_URL,
    [sessions],
  );

  const handleSelectActiveNode = useCallback((nodeId: string) => {
    if (!UI_NODES.some(node => node.id === nodeId)) return;
    setActiveNodeId(nodeId);
    if (nodeId !== 'user') setFixtureNodeId(nodeId);
  }, []);

  // Refresh health across active node + QVAC
  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      let apiHealth: ServiceHealth | null = null;
      for (const baseUrl of [...UI_NODES.map(node => node.baseUrl), '']) {
        try {
          const response = await fetch(`${baseUrl}/api/health`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) {
            apiHealth = (await response.json()) as ServiceHealth;
            break;
          }
        } catch {
          /* try next endpoint */
        }
      }

      let qvacDirect: string | null = null;
      try {
        const qRes = await fetch('http://127.0.0.1:11434/v1/models', {
          cache: 'no-store',
          signal: AbortSignal.timeout(1500),
        });
        if (qRes.ok) {
          qvacDirect = 'online';
        }
      } catch {
        /* fallback to backend health report */
      }

      if (apiHealth) {
        setHealth({
          ...apiHealth,
          qvac: qvacDirect ?? apiHealth.qvac ?? 'offline',
        });
      } else {
        setHealth({
          api: 'offline',
          rln: 'offline',
          qvac: qvacDirect ?? 'offline',
        });
      }
    } catch {
      setHealth({ api: 'offline', rln: 'offline', qvac: 'offline' });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  // Refresh single node state, summary, channels, assets, balances, history
  const refreshNodeSnapshot = useCallback(
    async (id: NodeId) => {
      const session = sessions[id];
      if (!session?.token) return;

      patchNodeData(id, { busy: true, error: '' });
      try {
        const state = await session.api<NodeWalletState>('/api/wallet/state');
        if (state.node !== 'ready') {
          patchNodeData(id, {
            state,
            summary: null,
            channels: [],
            assets: [],
            history: [],
            busy: false,
          });
          return;
        }

        const [summary, channels, assets, history] = await Promise.all([
          session.api<NodeSummaryInfo>('/api/wallet/summary'),
          session.api<NodeChannelRow[]>('/api/wallet/channels'),
          session.api<NodeAssetRow[]>('/api/wallet/assets'),
          session.api<NodePaymentHistoryRow[]>('/api/wallet/history'),
        ]);

        const assetBalances: Record<string, NodeAssetBalance> = {};
        await Promise.all(
          assets.slice(0, 6).map(async a => {
            if (!a.assetId) return;
            try {
              const bal = await session.api<NodeAssetBalance>(
                `/api/wallet/asset-balance?assetId=${encodeURIComponent(a.assetId)}`,
              );
              assetBalances[a.assetId] = bal;
            } catch {
              /* Ignore single asset balance lookup failure */
            }
          }),
        );

        patchNodeData(id, {
          state,
          summary,
          channels,
          assets,
          assetBalances,
          history,
          busy: false,
        });
      } catch (err) {
        patchNodeData(id, {
          busy: false,
          error: (err as Error).message,
        });
      }
    },
    [sessions, patchNodeData],
  );

  // Read chain height via Alice
  const readHeight = useCallback(async () => {
    if (!aliceSession.token) return;
    setChainError('');
    try {
      const status = await aliceSession.api<{ height: number }>('/api/chain/status');
      setChainHeight(status.height);
    } catch (err) {
      setChainError((err as Error).message);
    }
  }, [aliceSession.api, aliceSession.token]);

  // Initial load when tokens become available
  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    for (const node of UI_NODES) {
      if (sessions[node.id]?.token) void refreshNodeSnapshot(node.id);
    }
  }, [sessions, refreshNodeSnapshot]);

  useEffect(() => {
    if (aliceSession.token) void readHeight();
  }, [aliceSession.token, readHeight]);

  // Mine blocks on regtest
  const handleMineBlocks = useCallback(
    async (blocks: number) => {
      if (!aliceSession.token) return;
      setChainBusy(true);
      setChainError('');
      setChainMessage('');
      try {
        const res = await aliceSession.api<{ height: number; mined: number }>('/api/chain/mine', {
          blocks,
        });
        setChainHeight(res.height);
        setChainMessage(`Mined +${res.mined} blocks. New height: #${res.height}.`);
        await Promise.all(UI_NODES.map(node => refreshNodeSnapshot(node.id)));
      } catch (err) {
        setChainError((err as Error).message);
      } finally {
        setChainBusy(false);
      }
    },
    [aliceSession, refreshNodeSnapshot],
  );

  // Sync a single node
  const handleSyncNode = useCallback(
    async (nodeId: string) => {
      const session = getSessionForNode(nodeId);
      if (!session?.token) return;
      patchNodeData(nodeId, { busy: true, error: '', notice: '' });
      try {
        await session.api('/api/wallet/sync', {});
        await refreshNodeSnapshot(nodeId);
        patchNodeData(nodeId, { notice: 'Synchronization completed.' });
      } catch (err) {
        patchNodeData(nodeId, { busy: false, error: (err as Error).message });
      }
    },
    [getSessionForNode, patchNodeData, refreshNodeSnapshot],
  );

  // Sync all ready nodes
  const handleSyncAllNodes = useCallback(async () => {
    setChainBusy(true);
    setChainError('');
    setChainMessage('');
    try {
      const tasks = UI_NODES.flatMap(node => {
        const session = sessions[node.id];
        if (!session?.token || nodeMap[node.id]?.state?.node !== 'ready') return [];
        return [session.api('/api/wallet/sync', {}).then(() => undefined)];
      });
      await Promise.all(tasks);
      await Promise.all([...UI_NODES.map(node => refreshNodeSnapshot(node.id)), readHeight(), refreshHealth()]);
      setChainMessage('All Regtest nodes synchronized.');
    } catch (err) {
      setChainError((err as Error).message);
    } finally {
      setChainBusy(false);
    }
  }, [
    sessions,
    nodeMap,
    readHeight,
    refreshHealth,
    refreshNodeSnapshot,
  ]);

  // Keystore handlers for active node
  const handleCreateKeystore = useCallback(
    async (password: string): Promise<string | null> => {
      const session = getSessionForNode(activeNodeId);
      const created = await session.api<{ recoveryPhrase: string | null }>('/api/wallet/create', {
        password,
      });
      await refreshNodeSnapshot(activeNodeId);
      await refreshHealth();
      return created.recoveryPhrase;
    },
    [activeNodeId, getSessionForNode, refreshHealth, refreshNodeSnapshot],
  );

  const handleImportKeystore = useCallback(
    async (password: string, mnemonic: string): Promise<void> => {
      const session = getSessionForNode(activeNodeId);
      await session.api('/api/wallet/import', { password, mnemonic });
      await refreshNodeSnapshot(activeNodeId);
      await refreshHealth();
    },
    [activeNodeId, getSessionForNode, refreshHealth, refreshNodeSnapshot],
  );

  const handleUnlockNode = useCallback(
    async (password: string): Promise<void> => {
      const session = getSessionForNode(activeNodeId);
      await session.api('/api/wallet/unlock', { password });
      await refreshNodeSnapshot(activeNodeId);
      await refreshHealth();
    },
    [activeNodeId, getSessionForNode, refreshHealth, refreshNodeSnapshot],
  );

  // Decode invoice on active node
  const handleDecodeInvoice = useCallback(
    async (overrideInvoice?: string): Promise<DecodedInvoiceView | null> => {
      const inv = (overrideInvoice ?? paymentDraft.invoice).trim();
      if (!inv) return null;
      const session = getSessionForNode(activeNodeId);
      const decoded = await session.api<DecodedInvoiceView>('/api/payments/decode', {
        invoice: inv,
      });
      setDecodedInvoice(decoded);
      setPaymentDraft(prev => ({
        ...prev,
        invoice: decoded.invoice,
        amount: decoded.amountMsat ?? (prev.amount || String(RGB_HTLC_MIN_MSAT)),
        assetId: decoded.assetId ?? 'BTC',
      }));
      return decoded;
    },
    [activeNodeId, getSessionForNode, paymentDraft.invoice],
  );

  // Update paymentDraft & invalidate concurrent QVAC request
  const handleUpdatePaymentDraft = useCallback(
    (patch: Partial<PaymentDraft>) => {
      invalidateQvacConcurrency();
      setPreparedIntent(null);
      setChannelScore(null);
      setAlgorithmSelection(null);
      if (patch.invoice !== undefined) {
        setDecodedInvoice(null);
      }
      setPaymentDraft(prev => ({ ...prev, ...patch }));
    },
    [invalidateQvacConcurrency],
  );

  const handleUpdateExtracted = useCallback(
    (patch: Partial<ExtractedConstraints>) => {
      invalidateQvacConcurrency();
      setExtracted(prev => ({ ...prev, ...patch }));
    },
    [invalidateQvacConcurrency],
  );

  const handleResetExtracted = useCallback(() => {
    invalidateQvacConcurrency();
    setExtracted(INITIAL_EXTRACTED);
  }, [invalidateQvacConcurrency]);

  const handleChangeChatPrompt = useCallback(
    (text: string) => {
      invalidateQvacConcurrency();
      setChatPrompt(text);
    },
    [invalidateQvacConcurrency],
  );

  // Compile constraints manually (/api/constraints/compile) with revision + AbortController
  const handleCompileConstraintsManual = useCallback(async (): Promise<CompileResult | null> => {
    const activeSession = getSessionForNode(activeNodeId);
    const activeBaseUrl = getBaseUrlForNode(activeNodeId);
    if (!activeSession.token) {
      setQvacError('Node session is not active.');
      return null;
    }

    invalidateQvacConcurrency();
    const ownRevision = revisionRef.current;
    const abort = new AbortController();
    abortControllerRef.current = abort;
    setQvacBusy(true);

    try {
      let currentDecoded = decodedInvoice;
      if (!currentDecoded && paymentDraft.invoice.trim()) {
        currentDecoded = await handleDecodeInvoice(paymentDraft.invoice.trim());
      }
      if (ownRevision !== revisionRef.current) return null;

      const canonicalPayment: PaymentDraft = {
        invoice: currentDecoded?.invoice ?? paymentDraft.invoice.trim(),
        amount: currentDecoded?.amountMsat ?? (paymentDraft.amount.trim() || String(RGB_HTLC_MIN_MSAT)),
        assetId: currentDecoded?.assetId ?? (paymentDraft.assetId.trim() || 'BTC'),
        network: 'regtest',
      };

      const response = await fetch(`${activeBaseUrl}/api/constraints/compile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': activeSession.token,
        },
        body: JSON.stringify({
          extracted,
          payment: canonicalPayment,
        }),
        signal: abort.signal,
      });

      const data = (await response.json()) as CompileResult & { message?: string };
      if (ownRevision !== revisionRef.current) return null;
      if (!response.ok) {
        throw new Error(data.message ?? data.code ?? `HTTP ${response.status}`);
      }

      setCompileResult(data);
      const suggested = deriveSuggestedRouting(extracted, data);
      setAlgorithm(suggested.algorithm);
      setWeights(suggested.weights);
      return data;
    } catch (err) {
      if (ownRevision === revisionRef.current && (err as Error).name !== 'AbortError') {
        setQvacError((err as Error).message);
      }
      return null;
    } finally {
      if (ownRevision === revisionRef.current) {
        setQvacBusy(false);
      }
    }
  }, [
    activeNodeId,
    decodedInvoice,
    extracted,
    getBaseUrlForNode,
    getSessionForNode,
    handleDecodeInvoice,
    invalidateQvacConcurrency,
    paymentDraft,
  ]);

  // QVAC Chat: Interpret + Compile + Generate Action Confirmation Card
  const handleSubmitChatPrompt = useCallback(async () => {
    const activeSession = getSessionForNode(activeNodeId);
    const activeBaseUrl = getBaseUrlForNode(activeNodeId);
    const promptText = chatPrompt.trim();
    if (!promptText || !activeSession.token) return;

    invalidateQvacConcurrency();
    const ownRevision = revisionRef.current;
    const abort = new AbortController();
    abortControllerRef.current = abort;
    setQvacBusy(true);

    const counterparty = activeNodeId === 'alice' ? nodeMap.bob : nodeMap.alice;
    const detectedSetup = detectSetupDraftFromPrompt(promptText, counterparty.summary?.peerUri);

    try {
      // 1. Call /api/constraints/interpret with AbortController
      const interpretRes = await fetch(`${activeBaseUrl}/api/constraints/interpret`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': activeSession.token,
        },
        body: JSON.stringify({ text: promptText }),
        signal: abort.signal,
      });

      const interpretData = (await interpretRes.json()) as {
        extracted?: ExtractedConstraints;
        latencyMs?: number;
        message?: string;
        code?: string;
      };
      if (ownRevision !== revisionRef.current) return;

      let nextExtracted: ExtractedConstraints = INITIAL_EXTRACTED;
      let latency: number | null = null;

      if (interpretRes.ok && interpretData.extracted) {
        nextExtracted = interpretData.extracted;
        latency = interpretData.latencyMs ?? null;
        setExtracted(nextExtracted);
        setQvacLatencyMs(latency);
      } else if (!detectedSetup) {
        throw new Error(
          interpretData.message ?? interpretData.code ?? 'Failed to interpret prompt with QVAC',
        );
      }

      // 2. If there is a reference invoice (or counterparty lastInvoice), decode & compile
      const candidateInvoice = paymentDraft.invoice.trim() || counterparty.lastInvoice.trim();
      let decoded: DecodedInvoiceView | null = decodedInvoice;
      let compiled: CompileResult | null = null;

      if (candidateInvoice && !detectedSetup) {
        try {
          decoded = await activeSession.api<DecodedInvoiceView>('/api/payments/decode', {
            invoice: candidateInvoice,
          });
          if (ownRevision !== revisionRef.current) return;
          setDecodedInvoice(decoded);
        } catch {
          decoded = null;
        }

        if (decoded) {
          const canonicalPayment: PaymentDraft = {
            invoice: decoded.invoice,
            amount: decoded.amountMsat ?? (paymentDraft.amount || String(RGB_HTLC_MIN_MSAT)),
            assetId: decoded.assetId ?? 'BTC',
            network: 'regtest',
          };
          setPaymentDraft(canonicalPayment);

          const compileRes = await fetch(`${activeBaseUrl}/api/constraints/compile`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-session-token': activeSession.token,
            },
            body: JSON.stringify({
              extracted: nextExtracted,
              payment: canonicalPayment,
            }),
            signal: abort.signal,
          });
          const compileBody = (await compileRes.json()) as CompileResult;
          if (ownRevision !== revisionRef.current) return;
          if (compileRes.ok) {
            compiled = compileBody;
            setCompileResult(compiled);
          }
        }
      }

      let suggested = deriveSuggestedRouting(nextExtracted, compiled);
      let suggestedMaxPaths: number | undefined;
      let suggestedExcludedNodes: string[] | undefined;
      let algorithmRationale: string | undefined;

      if (!detectedSetup) {
        try {
          const selectRes = await fetch(`${activeBaseUrl}/api/routing/select-algorithm`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-session-token': activeSession.token,
            },
            body: JSON.stringify({
              invoice: decoded?.invoice ?? (candidateInvoice || undefined),
              amountMsat: decoded?.amountMsat ?? (paymentDraft.amount || String(RGB_HTLC_MIN_MSAT)),
              assetId: decoded?.assetId ?? (paymentDraft.assetId !== 'BTC' ? paymentDraft.assetId : null),
              assetAmount: decoded?.assetAmount ?? null,
              payeePubkey: decoded?.payeePubkey ?? null,
              userPreference: promptText,
              constraints: compiled?.policy ?? undefined,
            }),
            signal: abort.signal,
          });
          if (selectRes.ok) {
            const selected = (await selectRes.json()) as AlgorithmSelectionResult;
            if (ownRevision === revisionRef.current) {
              setAlgorithmSelection(selected);
              setChannelScore(selected.channelScoring);
              suggested = {
                algorithm: selected.selectedAlgorithm,
                weights: selected.recommendedWeights,
              };
              suggestedMaxPaths = selected.recommendedRouting.max_paths;
              suggestedExcludedNodes = selected.recommendedRouting.excluded_nodes;
              algorithmRationale = selected.rationale;
            }
          }
        } catch {
          /* Fallback to deriveSuggestedRouting if selector is unavailable */
        }
      }

      setAlgorithm(suggested.algorithm);
      setWeights(suggested.weights);

      const newCard: ChatActionCardData = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        prompt: promptText,
        nodeId: activeNodeId,
        nodeLabel: `${UI_NODES.find(node => node.id === activeNodeId)?.label ?? activeNodeId} (:${UI_NODES.find(node => node.id === activeNodeId)?.port ?? ''})`,
        actionType: detectedSetup ? 'setup' : 'payment',
        latencyMs: latency,
        extracted: nextExtracted,
        compileResult: compiled,
        suggestedAlgorithm: suggested.algorithm,
        suggestedWeights: suggested.weights,
        suggestedMaxPaths,
        suggestedExcludedNodes,
        algorithmRationale,
        paymentDraft: {
          invoice: decoded?.invoice ?? candidateInvoice,
          amount: decoded?.amountMsat ?? (paymentDraft.amount || String(RGB_HTLC_MIN_MSAT)),
          assetId: decoded?.assetId ?? paymentDraft.assetId,
          network: 'regtest',
        },
        decodedInvoice: decoded,
        setupDraft: detectedSetup,
        preparedIntent: null,
        executionStatus: 'idle',
        executionMessage: candidateInvoice || detectedSetup
          ? ''
          : 'Tip: attach or generate an Invoice from Bob first to enable direct Prepare Payment.',
      };

      setChatCards(prev => [newCard, ...prev]);
    } catch (err) {
      if (ownRevision === revisionRef.current && (err as Error).name !== 'AbortError') {
        setQvacError((err as Error).message);
      }
    } finally {
      if (ownRevision === revisionRef.current) {
        setQvacBusy(false);
      }
    }
  }, [
    activeNodeId,
    chatPrompt,
    decodedInvoice,
    getBaseUrlForNode,
    getSessionForNode,
    invalidateQvacConcurrency,
    nodeMap.alice,
    nodeMap.bob,
    paymentDraft,
  ]);

  // Transfer an Action Card from QVAC Chat into the Manual Form
  const handleTransferCardToManual = useCallback((card: ChatActionCardData) => {
    setExtracted(card.extracted);
    setCompileResult(card.compileResult);
    setAlgorithm(card.suggestedAlgorithm);
    setWeights(card.suggestedWeights);
    setPaymentDraft(card.paymentDraft);
    if (card.decodedInvoice) {
      setDecodedInvoice(card.decodedInvoice);
    }
    setWorkspaceTab('manual');
    if (card.setupDraft?.kind === 'open_channel') {
      setManualSubTab('channels');
    } else if (card.setupDraft) {
      setManualSubTab('l1');
    } else {
      setManualSubTab('send');
    }
  }, []);

  // Prepare Payment from Action Confirmation Card in Chat
  const handlePrepareCardPayment = useCallback(
    async (cardId: string) => {
      const card = chatCards.find(c => c.id === cardId);
      if (!card) return;
      const session = getSessionForNode(card.nodeId);

      setChatCards(prev =>
        prev.map(c =>
          c.id === cardId ? { ...c, executionStatus: 'preparing', executionMessage: '' } : c,
        ),
      );

      try {
        const routing: PaymentRouting = {
          ...(card.suggestedAlgorithm === 'multi_objective'
            ? { algorithm: 'multi_objective', weights: card.suggestedWeights }
            : { algorithm: card.suggestedAlgorithm }),
          ...(card.suggestedExcludedNodes?.length
            ? { excluded_nodes: card.suggestedExcludedNodes }
            : {}),
          ...(card.suggestedMaxPaths ? { max_paths: card.suggestedMaxPaths } : {}),
        };

        const intent = await session.api<PreparedPaymentIntent>('/api/payments/prepare', {
          id: crypto.randomUUID(),
          invoice: card.paymentDraft.invoice,
          amountMsat: card.paymentDraft.amount,
          constraints: card.compileResult?.policy ?? {},
          routing,
        });

        setPreparedIntent(intent);
        setChatCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? {
                  ...c,
                  preparedIntent: intent,
                  executionStatus: 'prepared',
                  executionMessage: `Payment prepared (${intent.id.slice(0, 10)}…). Ready for Confirm & Send.`,
                }
              : c,
          ),
        );
      } catch (err) {
        setChatCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? { ...c, executionStatus: 'error', executionMessage: (err as Error).message }
              : c,
          ),
        );
      }
    },
    [chatCards, getSessionForNode],
  );

  // Confirm & Send Payment from Action Confirmation Card in Chat
  const handleConfirmCardPayment = useCallback(
    async (cardId: string) => {
      const card = chatCards.find(c => c.id === cardId);
      if (!card?.preparedIntent) return;
      const session = getSessionForNode(card.nodeId);

      setChatCards(prev =>
        prev.map(c =>
          c.id === cardId ? { ...c, executionStatus: 'confirming', executionMessage: '' } : c,
        ),
      );

      try {
        const confirmed = await session.api<PreparedPaymentIntent>('/api/payments/confirm', {
          id: card.preparedIntent.id,
        });
        setPreparedIntent(confirmed);
        setChatCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? {
                  ...c,
                  preparedIntent: confirmed,
                  executionStatus: 'completed',
                  executionMessage: `Payment confirmed! Final status: ${confirmed.status.toUpperCase()}.`,
                }
              : c,
          ),
        );
        await Promise.all(UI_NODES.map(node => refreshNodeSnapshot(node.id)));
      } catch (err) {
        setChatCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? { ...c, executionStatus: 'error', executionMessage: (err as Error).message }
              : c,
          ),
        );
      }
    },
    [chatCards, getSessionForNode, refreshNodeSnapshot],
  );

  // Execute Setup Operation from Action Confirmation Card in Chat
  const handleExecuteCardSetup = useCallback(
    async (cardId: string) => {
      const card = chatCards.find(c => c.id === cardId);
      if (!card?.setupDraft) return;
      const session = getSessionForNode(card.nodeId);

      setChatCards(prev =>
        prev.map(c =>
          c.id === cardId ? { ...c, executionStatus: 'preparing', executionMessage: '' } : c,
        ),
      );

      try {
        let message = 'Operation executed successfully.';
        if (card.setupDraft.kind === 'prepare_utxos') {
          const res = await session.api<{ status: string }>('/api/wallet/rgb/utxos', {
            count: card.setupDraft.count,
            sizeSat: card.setupDraft.sizeSat,
            feeRateSatPerVbyte: card.setupDraft.feeRateSatPerVbyte,
          });
          message =
            res.status === 'ready'
              ? 'RGB UTXOs are already available on the node.'
              : 'RGB UTXOs requested. Mine 1 block to confirm them.';
        } else if (card.setupDraft.kind === 'issue_nia') {
          const created = await session.api<{ assetId: string; ticker: string }>(
            '/api/wallet/rgb/issue',
            {
              ticker: card.setupDraft.ticker,
              name: card.setupDraft.name,
              precision: card.setupDraft.precision,
              amounts: [card.setupDraft.amount],
            },
          );
          message = `Asset ${created.ticker} issued with Contract ID: ${created.assetId}`;
        } else if (card.setupDraft.kind === 'open_channel') {
          await session.api('/api/wallet/channels/open', {
            peer: card.setupDraft.peer,
            capacitySat: card.setupDraft.capacitySat,
            public: true,
          });
          message = 'Channel opening submitted! Mine +6 blocks to make it READY.';
        }

        setChatCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? { ...c, executionStatus: 'completed', executionMessage: message }
              : c,
          ),
        );
        await refreshNodeSnapshot(card.nodeId);
      } catch (err) {
        setChatCards(prev =>
          prev.map(c =>
            c.id === cardId
              ? { ...c, executionStatus: 'error', executionMessage: (err as Error).message }
              : c,
          ),
        );
      }
    },
    [chatCards, getSessionForNode, refreshNodeSnapshot],
  );

  // Score channels + Dynamically select routing algorithm with QVAC (Feature 2 + Feature 3)
  const handleSelectAlgorithmWithQvac = useCallback(
    async (userPreference?: string) => {
      const session = getSessionForNode(activeNodeId);
      setQvacBusy(true);
      setQvacError('');
      try {
        let dec = decodedInvoice;
        if (!dec && paymentDraft.invoice.trim()) {
          try {
            dec = await handleDecodeInvoice(paymentDraft.invoice.trim());
          } catch {
            dec = null;
          }
        }
        const amountMsat = dec?.amountMsat ?? (paymentDraft.amount || String(RGB_HTLC_MIN_MSAT));
        const selected = await session.api<AlgorithmSelectionResult>('/api/routing/select-algorithm', {
          invoice: dec?.invoice ?? (paymentDraft.invoice.trim() || undefined),
          amountMsat,
          assetId: dec?.assetId ?? (paymentDraft.assetId !== 'BTC' ? paymentDraft.assetId : null),
          assetAmount: dec?.assetAmount ?? null,
          payeePubkey: dec?.payeePubkey ?? null,
          userPreference: userPreference ?? (chatPrompt.trim() || undefined),
          constraints: compileResult?.policy ?? undefined,
        });
        setAlgorithmSelection(selected);
        setChannelScore(selected.channelScoring);
        setAlgorithm(selected.selectedAlgorithm);
        setWeights(selected.recommendedWeights);
      } catch (err) {
        setQvacError((err as Error).message);
      } finally {
        setQvacBusy(false);
      }
    },
    [
      activeNodeId,
      chatPrompt,
      compileResult?.policy,
      decodedInvoice,
      getSessionForNode,
      handleDecodeInvoice,
      paymentDraft,
    ],
  );

  // Score channels with QVAC RAG (Feature 2 endpoint, also uses dynamic recommendedRouting)
  const handleScoreChannelsWithQvac = useCallback(
    async (userPreference?: string) => {
      await handleSelectAlgorithmWithQvac(userPreference);
    },
    [handleSelectAlgorithmWithQvac],
  );

  const handleLoadFixtureHistory = useCallback(async () => {
    const session = getSessionForNode(activeNodeId);
    setQvacBusy(true);
    setQvacError('');
    try {
      const res = await session.api<FixtureLoadResult>('/api/routing/telemetry/load-fixture', {
        nodeId: fixtureNodeId,
        level: fixtureLevel,
        maxRagIngest: 16,
      });
      setFixtureInfo(res);
    } catch (err) {
      setQvacError((err as Error).message);
    } finally {
      setQvacBusy(false);
    }
  }, [activeNodeId, fixtureLevel, fixtureNodeId, getSessionForNode]);

  const handleSeedTelemetry = useCallback(async () => {
    const session = getSessionForNode(activeNodeId);
    setQvacBusy(true);
    try {
      await session.api('/api/routing/telemetry/seed', {});
    } catch (err) {
      setQvacError((err as Error).message);
    } finally {
      setQvacBusy(false);
    }
  }, [activeNodeId, getSessionForNode]);

  // Manual 2-Step Payment Prepare & Confirm
  const handlePreparePaymentManual = useCallback(async () => {
    const session = getSessionForNode(activeNodeId);
    let dec = decodedInvoice;
    if (!dec && paymentDraft.invoice.trim()) {
      dec = await handleDecodeInvoice(paymentDraft.invoice.trim());
    }
    const excludedNodes =
      algorithmSelection?.recommendedRouting.excluded_nodes ??
      (channelScore?.excludedNodeIds.length ? channelScore.excludedNodeIds : undefined);
    const maxPaths =
      algorithmSelection?.recommendedRouting.max_paths ??
      channelScore?.recommendedRouting.max_paths;

    const routing: PaymentRouting = {
      ...(algorithm === 'multi_objective'
        ? { algorithm: 'multi_objective', weights }
        : { algorithm }),
      ...(excludedNodes?.length ? { excluded_nodes: excludedNodes } : {}),
      ...(maxPaths ? { max_paths: maxPaths } : {}),
    };

    const intent = await session.api<PreparedPaymentIntent>('/api/payments/prepare', {
      id: crypto.randomUUID(),
      invoice: dec?.invoice ?? paymentDraft.invoice.trim(),
      ...(paymentDraft.amount ? { amountMsat: paymentDraft.amount } : {}),
      constraints: compileResult?.policy ?? {},
      routing,
    });
    setPreparedIntent(intent);
  }, [
    activeNodeId,
    algorithm,
    algorithmSelection,
    channelScore,
    compileResult?.policy,
    decodedInvoice,
    getSessionForNode,
    handleDecodeInvoice,
    paymentDraft,
    weights,
  ]);

  const handleConfirmPaymentManual = useCallback(async () => {
    if (!preparedIntent) return;
    const session = getSessionForNode(activeNodeId);
    const updated = await session.api<PreparedPaymentIntent>('/api/payments/confirm', {
      id: preparedIntent.id,
    });
    setPreparedIntent(updated);
    await Promise.all(UI_NODES.map(node => refreshNodeSnapshot(node.id)));
  }, [activeNodeId, getSessionForNode, preparedIntent, refreshNodeSnapshot]);

  const handleRefreshPaymentIntent = useCallback(async () => {
    if (!preparedIntent) return;
    const session = getSessionForNode(activeNodeId);
    const updated = await session.api<PreparedPaymentIntent>(
      `/api/payments/${encodeURIComponent(preparedIntent.id)}`,
    );
    setPreparedIntent(updated);
  }, [activeNodeId, getSessionForNode, preparedIntent]);

  // Manual Sub-tab 2: Create Invoice & Check Status
  const handleCreateInvoice = useCallback(
    async (input: {
      amountMsat: string;
      expirySec: number;
      assetId?: string;
      assetAmount?: string;
    }): Promise<string> => {
      const session = getSessionForNode(activeNodeId);
      const created = await session.api<{ invoice: string }>('/api/wallet/receive/lightning', input);
      patchNodeData(activeNodeId, { lastInvoice: created.invoice });
      return created.invoice;
    },
    [activeNodeId, getSessionForNode, patchNodeData],
  );

  const handleCheckInvoiceStatus = useCallback(
    async (invoice: string): Promise<unknown> => {
      const session = getSessionForNode(activeNodeId);
      return await session.api('/api/wallet/receive/lightning/status', { invoice });
    },
    [activeNodeId, getSessionForNode],
  );

  // Quick Demo Invoice Generator on Bob from Right Sidebar
  const handleQuickGenerateBobInvoice = useCallback(
    async (targetNodeId: string) => {
      const id = UI_NODES.some(node => node.id === targetNodeId) ? targetNodeId : 'bob';
      const session = getSessionForNode(id);
      const nodeState = nodeMap[id];
      const firstAssetId =
        nodeState.assets[0]?.assetId ?? nodeMap.alice.assets[0]?.assetId ?? undefined;

      patchNodeData(id, { busy: true, error: '', notice: '' });
      try {
        const created = await session.api<{ invoice: string }>('/api/wallet/receive/lightning', {
          amountMsat: String(RGB_HTLC_MIN_MSAT),
          expirySec: 3600,
          ...(firstAssetId ? { assetId: firstAssetId, assetAmount: '10' } : {}),
        });
        patchNodeData(id, {
          busy: false,
          lastInvoice: created.invoice,
          notice: 'Test Invoice generated and pre-loaded for payment!',
        });
        setPaymentDraft(prev => ({
          ...prev,
          invoice: created.invoice,
          amount: String(RGB_HTLC_MIN_MSAT),
          assetId: firstAssetId ?? 'BTC',
        }));
      } catch (err) {
        patchNodeData(id, { busy: false, error: (err as Error).message });
      }
    },
    [getSessionForNode, nodeMap, patchNodeData],
  );

  // Use generated invoice immediately as payment invoice on the other node
  const handleUseInvoiceForPayment = useCallback(
    (invoice: string, targetPayerNodeId?: string) => {
      if (UI_NODES.some(node => node.id === targetPayerNodeId)) {
        handleSelectActiveNode(targetPayerNodeId!);
      } else if (activeNodeId === 'bob') {
        handleSelectActiveNode('alice');
      }
      setPaymentDraft(prev => ({
        ...prev,
        invoice,
        amount: String(RGB_HTLC_MIN_MSAT),
      }));
      setDecodedInvoice(null);
      setPreparedIntent(null);
      setWorkspaceTab('manual');
      setManualSubTab('send');
    },
    [activeNodeId, handleSelectActiveNode],
  );

  // Manual Sub-tab 3: Connect Peer & Open Channel
  const handleConnectPeer = useCallback(
    async (peerUri: string) => {
      const session = getSessionForNode(activeNodeId);
      await session.api('/api/wallet/peers/connect', { peer: peerUri });
      await refreshNodeSnapshot(activeNodeId);
    },
    [activeNodeId, getSessionForNode, refreshNodeSnapshot],
  );

  const handleOpenChannel = useCallback(
    async (input: {
      peer: string;
      capacitySat: string;
      assetId?: string;
      assetAmount?: string;
    }) => {
      const session = getSessionForNode(activeNodeId);
      await session.api('/api/wallet/channels/open', {
        peer: input.peer,
        capacitySat: input.capacitySat,
        public: true,
        ...(input.assetId
          ? { assetId: input.assetId, assetAmount: input.assetAmount ?? '100' }
          : {}),
      });
      await refreshNodeSnapshot(activeNodeId);
    },
    [activeNodeId, getSessionForNode, refreshNodeSnapshot],
  );

  // Manual Sub-tab 4: L1 & RGB Assets
  const handlePrepareUtxos = useCallback(
    async (input: {
      count: number;
      sizeSat: string;
      feeRateSatPerVbyte: string;
    }): Promise<string> => {
      const session = getSessionForNode(activeNodeId);
      const res = await session.api<{ status: string }>('/api/wallet/rgb/utxos', input);
      await refreshNodeSnapshot(activeNodeId);
      return res.status === 'ready'
        ? 'Colorable RGB UTXOs are already ready on the node.'
        : 'UTXO creation requested. Mine 1 block in the left sidebar to confirm.';
    },
    [activeNodeId, getSessionForNode, refreshNodeSnapshot],
  );

  const handleIssueNiaAsset = useCallback(
    async (input: {
      ticker: string;
      name: string;
      precision: number;
      amounts: number[];
    }) => {
      const session = getSessionForNode(activeNodeId);
      const created = await session.api<{
        assetId: string;
        ticker: string;
        name: string;
        issuedSupply: string;
      }>('/api/wallet/rgb/issue', input);
      await refreshNodeSnapshot(activeNodeId);
      return created;
    },
    [activeNodeId, getSessionForNode, refreshNodeSnapshot],
  );

  const handleQueryAssetBalance = useCallback(
    async (assetId: string): Promise<NodeAssetBalance> => {
      const session = getSessionForNode(activeNodeId);
      const bal = await session.api<NodeAssetBalance>(
        `/api/wallet/asset-balance?assetId=${encodeURIComponent(assetId)}`,
      );
      setNodeMap(prev => ({
        ...prev,
        [activeNodeId]: {
          ...prev[activeNodeId],
          assetBalances: {
            ...prev[activeNodeId].assetBalances,
            [assetId]: bal,
          },
        },
      }));
      return bal;
    },
    [activeNodeId, getSessionForNode],
  );

  // Apply Demo Preset from Left Sidebar
  const handleApplyPreset = useCallback(
    (preset: DemoPreset) => {
      invalidateQvacConcurrency();
      if (activeNodeId === 'user') {
        setActiveNodeId('alice');
        setFixtureNodeId('alice');
      }
      setChatPrompt(preset.promptText);
      setExtracted({
        ...INITIAL_EXTRACTED,
        feeLimit: preset.feeLimitSat
          ? { value: preset.feeLimitSat, unit: 'sat', comparison: 'lte' }
          : null,
        excludedNodeReferences: preset.excludedNode ? [preset.excludedNode] : [],
        priority: preset.priority ?? null,
        privacyRequest: preset.privacy ?? null,
      });
      if (preset.targetMode === 'manual') {
        setWorkspaceTab('manual');
        setManualSubTab(preset.manualSubTab ?? 'send');
        setAlgorithm('multi_objective');
      } else {
        setWorkspaceTab('chat');
      }
    },
    [activeNodeId, invalidateQvacConcurrency],
  );

  // Build dynamic array of Regtest nodes for CenterWorkspace and RightNodesInspector
  const nodesList: RegtestNodeSnapshot[] = useMemo(
    () =>
      UI_NODES.map(node => ({
        id: node.id,
        label: node.label,
        port: node.port,
        baseUrl: node.baseUrl,
        accent: node.accent,
        offline: sessions[node.id]?.offline ?? false,
        ...(nodeMap[node.id] ?? EMPTY_NODE_DATA),
      })),
    [nodeMap, sessions],
  );

  const activeNodeSnapshot =
    nodesList.find(n => n.id === activeNodeId) ?? nodesList[0];
  const counterpartySnapshot = nodesList.find(n => n.id === 'alice') ?? nodesList.find(n => n.id !== activeNodeId);

  return (
    <div className="app-shell">
      <div className="three-col-layout">
        {/* COLUMN 1 (LEFT): Services, Chain & Keystore */}
        <LeftServiceSidebar
          health={health}
          healthLoading={healthLoading}
          onRefreshHealth={refreshHealth}
          chainHeight={chainHeight}
          chainBusy={chainBusy}
          chainMessage={chainMessage}
          chainError={chainError}
          onReadHeight={readHeight}
          onMineBlocks={handleMineBlocks}
          onSyncAllNodes={handleSyncAllNodes}
          activeNodeId={activeNodeSnapshot.id}
          activeNodeLabel={activeNodeSnapshot.label}
          activeNodePort={activeNodeSnapshot.port}
          activeNodeOffline={activeNodeSnapshot.offline}
          activeNodeState={activeNodeSnapshot.state}
          onSelectActiveNode={handleSelectActiveNode}
          availableNodes={nodesList.map(n => ({ id: n.id, label: n.label, port: n.port }))}
          onCreateKeystore={handleCreateKeystore}
          onImportKeystore={handleImportKeystore}
          onUnlockNode={handleUnlockNode}
          onApplyPreset={handleApplyPreset}
        />

        {/* COLUMN 2 (CENTER): WDK Wallet Overview + QVAC Chat + Manual TX Builder */}
        <CenterWorkspace
          nodes={nodesList}
          activeNode={activeNodeSnapshot}
          counterpartyNode={counterpartySnapshot}
          userWallet={activeNodeSnapshot.id === 'user'}
          onSelectActiveNode={handleSelectActiveNode}
          workspaceTab={workspaceTab}
          onChangeWorkspaceTab={setWorkspaceTab}
          manualSubTab={manualSubTab}
          onChangeManualSubTab={setManualSubTab}
          paymentDraft={paymentDraft}
          onUpdatePaymentDraft={handleUpdatePaymentDraft}
          decodedInvoice={decodedInvoice}
          onDecodeInvoice={handleDecodeInvoice}
          algorithm={algorithm}
          onChangeAlgorithm={setAlgorithm}
          weights={weights}
          onChangeWeights={setWeights}
          extracted={extracted}
          onUpdateExtracted={handleUpdateExtracted}
          onResetExtracted={handleResetExtracted}
          compileResult={compileResult}
          qvacBusy={qvacBusy}
          qvacLatencyMs={qvacLatencyMs}
          qvacError={qvacError}
          onCompileConstraintsManual={handleCompileConstraintsManual}
          channelScore={channelScore}
          onScoreChannelsWithQvac={handleScoreChannelsWithQvac}
          onSeedTelemetry={handleSeedTelemetry}
          algorithmSelection={algorithmSelection}
          onSelectAlgorithmWithQvac={handleSelectAlgorithmWithQvac}
          fixtureNodeId={fixtureNodeId}
          onChangeFixtureNodeId={setFixtureNodeId}
          fixtureLevel={fixtureLevel}
          onChangeFixtureLevel={setFixtureLevel}
          fixtureInfo={fixtureInfo}
          onLoadFixtureHistory={handleLoadFixtureHistory}
          preparedIntent={preparedIntent}
          onPreparePayment={handlePreparePaymentManual}
          onConfirmPayment={handleConfirmPaymentManual}
          onRefreshPaymentIntent={handleRefreshPaymentIntent}
          chatPrompt={chatPrompt}
          onChangeChatPrompt={handleChangeChatPrompt}
          chatCards={chatCards}
          onSubmitChatPrompt={handleSubmitChatPrompt}
          onTransferCardToManual={handleTransferCardToManual}
          onPrepareCardPayment={handlePrepareCardPayment}
          onConfirmCardPayment={handleConfirmCardPayment}
          onExecuteCardSetup={handleExecuteCardSetup}
          onCreateInvoice={handleCreateInvoice}
          onCheckInvoiceStatus={handleCheckInvoiceStatus}
          onUseInvoiceOnOtherNode={inv => handleUseInvoiceForPayment(inv)}
          onConnectPeer={handleConnectPeer}
          onOpenChannel={handleOpenChannel}
          onPrepareUtxos={handlePrepareUtxos}
          onIssueNiaAsset={handleIssueNiaAsset}
          onQueryAssetBalance={handleQueryAssetBalance}
        />

        {/* COLUMN 3 (RIGHT): Regtest Nodes List & Debug */}
        <RightNodesInspector
          nodes={nodesList}
          activeNodeId={activeNodeSnapshot.id}
          onSelectActiveNode={handleSelectActiveNode}
          onSyncNode={handleSyncNode}
          onQuickGenerateBobInvoice={handleQuickGenerateBobInvoice}
          onUseInvoiceForPayment={handleUseInvoiceForPayment}
        />
      </div>

      <footer className="app-footer">
        <span>
          <strong>AIR-GB · Tether WDK + RGB Lightning + QVAC AI</strong> · Concurrency protected via{' '}
          <code>revision + AbortController</code>.
        </span>
        <span className="footer-disclaimer">
          Disclaimer: QVAC interpretation and deterministic compilation generate validated
          proposals, but protocol-level enforcement of constraints is not yet active.
        </span>
      </footer>
    </div>
  );
}

export default App;
