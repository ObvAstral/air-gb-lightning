import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AlgorithmSelectionResult,
  CompileResult,
  ExtractedConstraints,
  ObjectiveWeights,
  PaymentDraft,
  PaymentRouting,
  RoutingAlgorithm,
} from '../../../packages/contracts/types.js';
import {
  CenterWorkspace,
  RGB_HTLC_MIN_MSAT,
  type ChatTxProposal,
  type DecodedInvoiceView,
  type DemoPromptShortcut,
  type ManualSubTab,
  type PreparedPaymentIntent,
  type WorkspaceTab,
} from './components/CenterWorkspace.js';
import {
  LeftServiceSidebar,
  type NodeWalletState,
  type ServiceHealth,
} from './components/LeftServiceSidebar.js';
import {
  RightNodesInspector,
  type NodeAssetBalance,
  type NodeAssetRow,
  type NodeChannelRow,
  type NodePaymentHistoryRow,
  type NodePaymentIntentRecord,
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
  intents: NodePaymentIntentRecord[];
  bitcoinTxs: unknown[];
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
  intents: [],
  bitcoinTxs: [],
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
  if (
    extracted.feeLimit ||
    extracted.excludedNodeReferences.length > 0 ||
    extracted.privacyRequest
  ) {
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

function hasAnyConstraints(extracted: ExtractedConstraints): boolean {
  return Boolean(
    extracted.feeLimit !== null ||
      extracted.excludedNodeReferences.length > 0 ||
      extracted.priority !== null ||
      extracted.privacyRequest !== null,
  );
}

/**
 * Extracts payment parameters (recipient node, RGB/BTC amount, optional BOLT11 invoice)
 * and cleans the prompt so the backend constraint extractor receives only routing constraints.
 */
type ExtractedChatIntent = {
  targetNodeId: string;
  explicitTarget: boolean;
  assetMode: 'rgb' | 'btc';
  rgbAmount: string;
  btcAmountMsat: string;
  invoiceOverride: string | null;
  constraintText: string;
};

function extractChatPaymentIntent(
  rawPrompt: string,
  activeNodeId: string,
  defaultRgbAmount = '10',
): ExtractedChatIntent {
  let working = rawPrompt.trim();

  // 1. Detect if the user pasted a BOLT11 invoice directly in the prompt
  let invoiceOverride: string | null = null;
  const bolt11Match = /\blnbcrt1[a-z0-9]+\b/i.exec(working);
  if (bolt11Match) {
    invoiceOverride = bolt11Match[0].toLowerCase();
    working = working.replace(bolt11Match[0], ' ').replace(/\s+/g, ' ').trim();
  }

  // 2. Identify excluded node names so we never mistake an excluded node for an implicit recipient
  const excludedNames = new Set<string>();
  const exclusionRegex =
    /\b(?:avoid|exclude|without|evita|escludi|non\s+passare\s+da)\s+([a-z0-9_]+)(?:\s+(?:and|e|,)\s*([a-z0-9_]+))?/gi;
  for (const match of working.matchAll(exclusionRegex)) {
    if (match[1]) excludedNames.add(match[1].toLowerCase());
    if (match[2]) excludedNames.add(match[2].toLowerCase());
  }

  const candidateNodes = UI_NODES.filter(n => n.id !== activeNodeId);
  const nodeIdsPattern = candidateNodes.map(n => n.id).join('|');

  // 3. Determine recipient node from natural language
  let targetNodeId = '';
  let explicitTarget = false;

  if (nodeIdsPattern) {
    // Pattern A: "to Bob", "verso Judy", "a Erin", "for Dave", "recipient Carol"
    const prepRecipientRegex = new RegExp(
      `\\b(?:to|verso|a|for|recipient|destinatario)\\s+(?:node\\s+|nodo\\s+)?(${nodeIdsPattern})\\b`,
      'i',
    );
    // Pattern B: "pay Bob", "paga Judy", "send Erin"
    const verbRecipientRegex = new RegExp(
      `\\b(?:pay|paga|send|invia|transfer|trasferisci)\\s+(${nodeIdsPattern})\\b`,
      'i',
    );

    const prepMatch = prepRecipientRegex.exec(working);
    const verbMatch = verbRecipientRegex.exec(working);
    const matchedId = (prepMatch?.[1] ?? verbMatch?.[1])?.toLowerCase();

    if (matchedId) {
      targetNodeId = matchedId;
      explicitTarget = true;
    } else {
      // Check if any node name is mentioned outside of exclusion clauses
      for (const node of candidateNodes) {
        const mentionRegex = new RegExp(`\\b${node.id}\\b`, 'i');
        if (mentionRegex.test(working) && !excludedNames.has(node.id.toLowerCase())) {
          targetNodeId = node.id;
          explicitTarget = true;
          break;
        }
      }
    }
  }

  if (!targetNodeId) {
    const nonExcludedDefault =
      candidateNodes.find(n => n.id === 'bob' && !excludedNames.has('bob')) ??
      candidateNodes.find(n => !excludedNames.has(n.id.toLowerCase())) ??
      candidateNodes[0];
    targetNodeId = nonExcludedDefault?.id ?? 'bob';
  }

  // 4. Determine payment amount and asset mode (ignoring fee budget numbers)
  const textWithoutFees = working
    .replace(
      /(?:at\s+most|less\s+than|under|max(?:imum)?|up\s+to|cap(?:\s+fees)?\s+at|massimo|meno\s+di|fino\s+a|non\s+oltre)\s+\d+(?:\.\d+)?\s*(?:sat|sats|msat)\b(?:\s*(?:in\s+fees?|fees?|di\s+commissioni|di\s+fee))?/gi,
      ' ',
    )
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:sat|sats|msat)\s+(?:in\s+fees?|fees?|di\s+commissioni|di\s+fee)\b/gi,
      ' ',
    );

  let assetMode: 'rgb' | 'btc' = 'rgb';
  let rgbAmount = defaultRgbAmount;
  let btcAmountMsat = String(RGB_HTLC_MIN_MSAT);

  const rgbMatch = /\b(\d+)\s*(?:demo|rgb|route|test|units?|unit[aà]|tokens?)\b/i.exec(
    textWithoutFees,
  );
  const btcTransferMatch =
    /\b(?:send|pay|transfer|invia|paga|trasferisci)\s+(\d+)\s*(sat|sats|msat)\b/i.exec(
      textWithoutFees,
    );
  const bareVerbAmountMatch =
    /\b(?:send|pay|transfer|invia|paga|trasferisci)(?:\s+[a-z0-9_]+)?\s+(\d+)\b/i.exec(
      textWithoutFees,
    );

  if (rgbMatch) {
    assetMode = 'rgb';
    rgbAmount = rgbMatch[1];
  } else if (btcTransferMatch) {
    assetMode = 'btc';
    const rawNum = Number(btcTransferMatch[1]);
    const unit = btcTransferMatch[2].toLowerCase();
    btcAmountMsat = unit === 'msat' ? String(rawNum) : String(Math.max(1000, rawNum * 1000));
  } else if (bareVerbAmountMatch) {
    assetMode = 'rgb';
    rgbAmount = bareVerbAmountMatch[1];
  }

  // 5. Strip payment/transfer clauses so /api/constraints/interpret receives pure routing constraints
  let cleaned = working
    .replace(
      /\b(?:please\s+)?(?:pay|send|transfer|route|invia|paga|trasferisci|manda)\s+(?:\d+\s*(?:demo|rgb|route|test|units?|unit[aà]|tokens?|sat|sats|msat)?\s+)?(?:to|verso|a|for)\s+(?:node\s+|nodo\s+)?[a-z0-9_]+\b[\s,.:;-]*/gi,
      ' ',
    )
    .replace(
      /\b(?:please\s+)?(?:pay|send|transfer|route|invia|paga|trasferisci|manda)\s+[a-z0-9_]+\s+\d+\s*(?:demo|rgb|route|test|units?|unit[aà]|tokens?|sat|sats|msat)?\b[\s,.:;-]*/gi,
      ' ',
    )
    .replace(
      /\b(?:please\s+)?(?:pay|send|transfer|route|invia|paga|trasferisci|manda)\s+\d+\s*(?:demo|rgb|route|test|units?|unit[aà]|tokens?|sat|sats|msat)\b[\s,.:;-]*/gi,
      ' ',
    )
    .replace(
      new RegExp(
        `\\b(?:to|verso|a|for|recipient|destinatario)\\s+(?:node\\s+|nodo\\s+)?(${nodeIdsPattern})\\b[\\s,.:;-]*`,
        'gi',
      ),
      ' ',
    )
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
    .replace(/^(?:and|with|con|e)\s+/i, '')
    .trim();

  return {
    targetNodeId,
    explicitTarget,
    assetMode,
    rgbAmount,
    btcAmountMsat,
    invoiceOverride,
    constraintText: cleaned,
  };
}

type NodeId = string;

export function App() {
  const sessions = useNodeDirectory(UI_NODES);

  const [activeNodeId, setActiveNodeId] = useState<NodeId>('alice');
  const [inspectedNodeId, setInspectedNodeId] = useState<NodeId>('bob');
  const [devMode, setDevMode] = useState<boolean>(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('chat');
  const [manualSubTab, setManualSubTab] = useState<ManualSubTab>('send');
  const [terminalNodeFilter, setTerminalNodeFilter] = useState<string>('all');

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

  // Payment, Routing & QVAC Constraints State
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
  const [algorithmSelection, setAlgorithmSelection] = useState<AlgorithmSelectionResult | null>(
    null,
  );
  const [preparedIntent, setPreparedIntent] = useState<PreparedPaymentIntent | null>(null);

  // QVAC Chat with Pre-Execution Approval Notification State
  const [chatTargetNodeId, setChatTargetNodeId] = useState<string>('bob');
  const [chatRgbAmount, setChatRgbAmount] = useState<string>('10');
  const [chatPrompt, setChatPrompt] = useState(
    'Send 10 DEMO to Bob, at most 5 sat in fees and spend as little as possible',
  );
  const [pendingProposal, setPendingProposal] = useState<ChatTxProposal | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatTxProposal[]>([]);
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

  const findOnlineSession = useCallback(() => {
    const active = sessions[activeNodeId];
    if (active?.token && !active.offline) return active;
    for (const n of UI_NODES) {
      const s = sessions[n.id];
      if (s?.token && !s.offline) return s;
    }
    return null;
  }, [activeNodeId, sessions]);

  // Build knownNodes array from all unlocked topology nodes so QVAC & policy compiler can resolve any node alias
  const knownNodesList = useMemo(() => {
    const list: { alias: string; pubkey: string }[] = [];
    for (const node of UI_NODES) {
      const pubkey = nodeMap[node.id]?.summary?.nodeId;
      if (pubkey) {
        list.push({ alias: node.label, pubkey });
      }
    }
    return list;
  }, [nodeMap]);

  // Pre-resolve node aliases (e.g. "Bob", "Judy") to 66-hex compressed pubkeys so
  // /api/constraints/compile works even on container images that do not read body.knownNodes
  const resolveExcludedReferencesToPubkeys = useCallback(
    async (refs: string[]): Promise<string[]> => {
      const aliasMap = new Map<string, string>();
      for (const k of knownNodesList) {
        aliasMap.set(k.alias.toLowerCase(), k.pubkey);
      }
      const resolvedRefs: string[] = [];
      for (const rawRef of refs) {
        const key = rawRef.trim().toLowerCase();
        let pubkey = aliasMap.get(key);
        if (!pubkey) {
          const matchingNode = UI_NODES.find(
            n => n.id.toLowerCase() === key || n.label.toLowerCase() === key,
          );
          const nodeSession = matchingNode ? sessions[matchingNode.id] : undefined;
          if (matchingNode && nodeSession?.token) {
            try {
              const summary = await nodeSession.api<NodeSummaryInfo>('/api/wallet/summary');
              if (summary?.nodeId) {
                pubkey = summary.nodeId;
                aliasMap.set(key, pubkey);
              }
            } catch {
              /* Node locked or unreachable */
            }
          }
        }
        resolvedRefs.push(pubkey ?? rawRef);
      }
      return [...new Set(resolvedRefs)];
    },
    [knownNodesList, sessions],
  );

  const handleSelectActiveNode = useCallback(
    (nodeId: string) => {
      if (!UI_NODES.some(node => node.id === nodeId)) return;
      setActiveNodeId(nodeId);
      if (chatTargetNodeId === nodeId) {
        const nextTarget = UI_NODES.find(n => n.id !== nodeId)?.id ?? 'bob';
        setChatTargetNodeId(nextTarget);
      }
    },
    [chatTargetNodeId],
  );

  // Refresh health across active node + QVAC
  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      let apiHealth: ServiceHealth | null = null;
      const candidateUrls = [
        getBaseUrlForNode(activeNodeId),
        ...UI_NODES.map(node => node.baseUrl),
      ];
      for (const baseUrl of candidateUrls) {
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
        const qRes = await fetch('/qvac/v1/models', {
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
  }, [activeNodeId, getBaseUrlForNode]);

  // Refresh single node state, summary, channels, assets, balances, history, intents, bitcoinTxs
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
            intents: [],
            bitcoinTxs: [],
            busy: false,
          });
          return;
        }

        const [summary, channels, assets, history, intents, btcHistoryRes] = await Promise.all([
          session.api<NodeSummaryInfo>('/api/wallet/summary'),
          session.api<NodeChannelRow[]>('/api/wallet/channels'),
          session.api<NodeAssetRow[]>('/api/wallet/assets'),
          session.api<NodePaymentHistoryRow[]>('/api/wallet/history'),
          session.api<NodePaymentIntentRecord[]>('/api/payments').catch(() => []),
          session
            .api<{ data?: unknown }>('/api/wallet/history/bitcoin')
            .catch(() => ({ data: [] })),
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

        const rawBtcData = btcHistoryRes?.data;
        const bitcoinTxs = Array.isArray(rawBtcData)
          ? rawBtcData
          : rawBtcData &&
              typeof rawBtcData === 'object' &&
              Array.isArray((rawBtcData as Record<string, unknown>).transactions)
            ? ((rawBtcData as Record<string, unknown>).transactions as unknown[])
            : [];

        patchNodeData(id, {
          state,
          summary,
          channels,
          assets,
          assetBalances,
          history,
          intents: Array.isArray(intents) ? intents : [],
          bitcoinTxs,
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

  const refreshAllNodes = useCallback(async () => {
    await Promise.all(
      UI_NODES.map(node =>
        sessions[node.id]?.token ? refreshNodeSnapshot(node.id) : Promise.resolve(),
      ),
    );
  }, [refreshNodeSnapshot, sessions]);

  // Read chain height via first available online node
  const readHeight = useCallback(async () => {
    const chainSession = findOnlineSession();
    if (!chainSession) return;
    setChainError('');
    try {
      const status = await chainSession.api<{ height: number }>('/api/chain/status');
      setChainHeight(status.height);
    } catch (err) {
      setChainError((err as Error).message);
    }
  }, [findOnlineSession]);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    for (const node of UI_NODES) {
      if (sessions[node.id]?.token) void refreshNodeSnapshot(node.id);
    }
  }, [sessions, refreshNodeSnapshot]);

  useEffect(() => {
    const chainSession = findOnlineSession();
    if (chainSession) void readHeight();
  }, [findOnlineSession, readHeight]);

  // Mine blocks AND automatically synchronize all ready nodes
  const handleMineBlocksAndSync = useCallback(
    async (blocks: number) => {
      const chainSession = findOnlineSession();
      if (!chainSession) {
        setChainError('No online node session available to mine blocks.');
        return;
      }
      setChainBusy(true);
      setChainError('');
      setChainMessage('');
      try {
        let remaining = blocks;
        let latestHeight = chainHeight ?? 0;
        let totalMined = 0;
        while (remaining > 0) {
          const chunk = Math.min(6, remaining);
          const res = await chainSession.api<{ height: number; mined: number }>(
            '/api/chain/mine',
            { blocks: chunk },
          );
          latestHeight = res.height;
          totalMined += res.mined;
          remaining -= chunk;
        }
        setChainHeight(latestHeight);

        // Automatically sync all ready nodes so channels and UTXOs update immediately
        const syncTasks = UI_NODES.flatMap(node => {
          const s = sessions[node.id];
          if (!s?.token || nodeMap[node.id]?.state?.node !== 'ready') return [];
          return [s.api('/api/wallet/sync', {}).catch(() => undefined)];
        });
        await Promise.all(syncTasks);
        await refreshAllNodes();

        setChainMessage(
          `Mined +${totalMined} block(s) at #${latestHeight} & synchronized all ready nodes.`,
        );
      } catch (err) {
        setChainError((err as Error).message);
      } finally {
        setChainBusy(false);
      }
    },
    [chainHeight, findOnlineSession, nodeMap, refreshAllNodes, sessions],
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
        patchNodeData(nodeId, { notice: 'Node synchronized.' });
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
      await Promise.all([refreshAllNodes(), readHeight(), refreshHealth()]);
      setChainMessage('All unlocked nodes synchronized.');
    } catch (err) {
      setChainError((err as Error).message);
    } finally {
      setChainBusy(false);
    }
  }, [nodeMap, readHeight, refreshAllNodes, refreshHealth, sessions]);

  // Keystore handlers
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

  const handleUpdatePaymentDraft = useCallback(
    (patch: Partial<PaymentDraft>) => {
      invalidateQvacConcurrency();
      setPreparedIntent(null);
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
      setPreparedIntent(null);
      setExtracted(prev => ({ ...prev, ...patch }));
    },
    [invalidateQvacConcurrency],
  );

  const handleResetExtracted = useCallback(() => {
    invalidateQvacConcurrency();
    setPreparedIntent(null);
    setExtracted(INITIAL_EXTRACTED);
  }, [invalidateQvacConcurrency]);

  const handleChangeChatPrompt = useCallback(
    (text: string) => {
      invalidateQvacConcurrency();
      setChatPrompt(text);
    },
    [invalidateQvacConcurrency],
  );

  // Generate an invoice on any target node (used by both Chat and Guided Manual Step 1)
  const handleGenerateInvoiceFromNode = useCallback(
    async (input: {
      targetNodeId: string;
      amountMsat: string;
      assetId?: string;
      assetAmount?: string;
    }): Promise<string> => {
      const targetSession = getSessionForNode(input.targetNodeId);
      if (!targetSession?.token) {
        throw new Error(`Target node ${input.targetNodeId} is not reachable.`);
      }
      const created = await targetSession.api<{ invoice: string }>(
        '/api/wallet/receive/lightning',
        {
          amountMsat: input.amountMsat,
          expirySec: 3600,
          ...(input.assetId
            ? { assetId: input.assetId, assetAmount: input.assetAmount ?? '10' }
            : {}),
        },
      );
      patchNodeData(input.targetNodeId, { lastInvoice: created.invoice });
      setPaymentDraft(prev => ({
        ...prev,
        invoice: created.invoice,
        amount: input.amountMsat,
        assetId: input.assetId ?? 'BTC',
      }));
      return created.invoice;
    },
    [getSessionForNode, patchNodeData],
  );

  // Apply In-Screen Real-UC Shortcut in Chat
  const handleApplyShortcut = useCallback(
    (shortcut: DemoPromptShortcut) => {
      invalidateQvacConcurrency();
      setPendingProposal(null);
      const targetId =
        shortcut.targetNodeId === activeNodeId ? 'bob' : shortcut.targetNodeId;
      setChatTargetNodeId(targetId);
      setInspectedNodeId(targetId);
      setChatRgbAmount(shortcut.rgbAmount);
      setChatPrompt(shortcut.promptText);
      // Clear previous invoice so a fresh invoice for this target node & amount is generated
      setPaymentDraft(prev => ({ ...prev, invoice: '' }));
      setDecodedInvoice(null);
    },
    [activeNodeId, invalidateQvacConcurrency],
  );

  // QVAC Chat Step 1: Interpret + Auto-Generate Target Invoice + Compile + Open Approval Notification
  const handleRequestChatProposal = useCallback(async () => {
    const activeSession = getSessionForNode(activeNodeId);
    const activeBaseUrl = getBaseUrlForNode(activeNodeId);
    const rawPrompt = chatPrompt.trim();
    if (!rawPrompt || !activeSession.token) return;

    invalidateQvacConcurrency();
    const ownRevision = revisionRef.current;
    const abort = new AbortController();
    abortControllerRef.current = abort;
    setQvacBusy(true);
    setPendingProposal(null);

    try {
      const intent = extractChatPaymentIntent(rawPrompt, activeNodeId, '10');
      let resolvedTargetId = intent.targetNodeId;
      const constraintText = intent.constraintText;

      setChatTargetNodeId(resolvedTargetId);
      setChatRgbAmount(intent.rgbAmount);
      setInspectedNodeId(resolvedTargetId);

      // 1. Interpret routing constraints via QVAC (/api/constraints/interpret) when constraints exist
      let nextExtracted: ExtractedConstraints = INITIAL_EXTRACTED;
      let latency: number | null = null;

      if (constraintText) {
        const interpretRes = await fetch(`${activeBaseUrl}/api/constraints/interpret`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-session-token': activeSession.token,
          },
          body: JSON.stringify({ text: constraintText }),
          signal: abort.signal,
        });

        const interpretData = (await interpretRes.json()) as {
          extracted?: ExtractedConstraints;
          latencyMs?: number;
          message?: string;
          code?: string;
        };
        if (ownRevision !== revisionRef.current) return;

        if (!interpretRes.ok || !interpretData.extracted) {
          throw new Error(
            interpretData.message ?? interpretData.code ?? 'QVAC could not interpret the prompt.',
          );
        }

        nextExtracted = interpretData.extracted;
        latency = interpretData.latencyMs ?? null;
      }

      setExtracted(nextExtracted);
      setQvacLatencyMs(latency);

      // 2. Ensure we have an invoice for the AI-determined Target Node & Amount (or pasted BOLT11)
      const senderNodeData = nodeMap[activeNodeId];
      const primaryAsset = senderNodeData?.assets[0];
      let invoiceToPay = intent.invoiceOverride ?? '';

      if (!invoiceToPay) {
        const useRgbAsset = intent.assetMode === 'rgb' && Boolean(primaryAsset?.assetId);
        invoiceToPay = await handleGenerateInvoiceFromNode({
          targetNodeId: resolvedTargetId,
          amountMsat: useRgbAsset ? String(RGB_HTLC_MIN_MSAT) : intent.btcAmountMsat,
          ...(useRgbAsset && primaryAsset?.assetId
            ? {
                assetId: primaryAsset.assetId,
                assetAmount: intent.rgbAmount || '10',
              }
            : {}),
        });
      }
      if (ownRevision !== revisionRef.current) return;

      // 3. Decode invoice on sender node
      const decoded = await activeSession.api<DecodedInvoiceView>('/api/payments/decode', {
        invoice: invoiceToPay,
      });
      if (ownRevision !== revisionRef.current) return;
      setDecodedInvoice(decoded);

      if (intent.invoiceOverride && decoded.payeePubkey) {
        const matchedByPubkey = knownNodesList.find(
          k => k.pubkey.toLowerCase() === decoded.payeePubkey?.toLowerCase(),
        );
        if (matchedByPubkey) {
          const matchedNode = UI_NODES.find(
            n => n.label.toLowerCase() === matchedByPubkey.alias.toLowerCase(),
          );
          if (matchedNode) {
            resolvedTargetId = matchedNode.id;
            setChatTargetNodeId(matchedNode.id);
            setInspectedNodeId(matchedNode.id);
          }
        }
      }

      const canonicalPayment: PaymentDraft = {
        invoice: decoded.invoice,
        amount: decoded.amountMsat ?? String(RGB_HTLC_MIN_MSAT),
        assetId: decoded.assetId ?? 'BTC',
        network: 'regtest',
      };
      setPaymentDraft(canonicalPayment);

      // 4. Deterministic constraint compilation (/api/constraints/compile) with pre-resolved pubkeys
      const resolvedExcludedRefs = await resolveExcludedReferencesToPubkeys(
        nextExtracted.excludedNodeReferences,
      );
      const extractedForCompile: ExtractedConstraints = {
        ...nextExtracted,
        excludedNodeReferences: resolvedExcludedRefs,
      };

      const compileRes = await fetch(`${activeBaseUrl}/api/constraints/compile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': activeSession.token,
        },
        body: JSON.stringify({
          extracted: extractedForCompile,
          payment: canonicalPayment,
          knownNodes: knownNodesList,
        }),
        signal: abort.signal,
      });
      const compiled = (await compileRes.json()) as CompileResult;
      if (ownRevision !== revisionRef.current) return;
      setCompileResult(compiled);

      // 5. Dynamic routing algorithm selection (/api/routing/select-algorithm)
      let suggested = deriveSuggestedRouting(nextExtracted, compiled);
      let suggestedMaxPaths: number | undefined;
      let suggestedExcludedNodes: string[] | undefined =
        compiled.policy?.hard.excludedNodeIds ?? compiled.normalized?.excludedNodeIds;
      let rationale: string | undefined =
        suggested.algorithm === 'multi_objective'
          ? `Applied multi_objective routing (weights: fee=${suggested.weights.fee}, reliability=${suggested.weights.reliability}, cltv=${suggested.weights.cltv}, hops=${suggested.weights.hops}) tailored to your prompt preferences.`
          : 'Applied standard LDK Dijkstra shortest-path routing.';

      if (compiled.status === 'validated' || compiled.status === 'unsupported') {
        try {
          const selectRes = await fetch(`${activeBaseUrl}/api/routing/select-algorithm`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-session-token': activeSession.token,
            },
            body: JSON.stringify({
              invoice: decoded.invoice,
              amountMsat: canonicalPayment.amount,
              assetId: decoded.assetId,
              assetAmount: decoded.assetAmount,
              payeePubkey: decoded.payeePubkey,
              userPreference: constraintText || rawPrompt,
              constraints: compiled.policy,
              knownNodes: knownNodesList,
            }),
            signal: abort.signal,
          });
          if (selectRes.ok) {
            const selected = (await selectRes.json()) as AlgorithmSelectionResult;
            if (ownRevision === revisionRef.current) {
              setAlgorithmSelection(selected);
              suggested = {
                algorithm: selected.selectedAlgorithm,
                weights: selected.recommendedWeights,
              };
              suggestedMaxPaths = selected.recommendedRouting.max_paths;
              suggestedExcludedNodes =
                selected.recommendedRouting.excluded_nodes ??
                compiled.policy?.hard.excludedNodeIds ??
                compiled.normalized?.excludedNodeIds;
              rationale = selected.rationale;
              if (latency === null && typeof selected.latencyMs === 'number') {
                latency = selected.latencyMs;
                setQvacLatencyMs(selected.latencyMs);
              }
            }
          }
        } catch {
          /* Fallback to deterministic routing suggestion */
        }
      }

      setAlgorithm(suggested.algorithm);
      setWeights(suggested.weights);

      const senderLabel =
        UI_NODES.find(n => n.id === activeNodeId)?.label ?? activeNodeId;
      const targetLabel =
        UI_NODES.find(n => n.id === resolvedTargetId)?.label ?? resolvedTargetId;

      const excludedLabels = (suggestedExcludedNodes ?? []).map(pub => {
        const match = knownNodesList.find(
          k => k.pubkey.toLowerCase() === pub.toLowerCase(),
        );
        return match ? match.alias : `${pub.slice(0, 10)}…`;
      });

      const proposal: ChatTxProposal = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        senderNodeId: activeNodeId,
        senderNodeLabel: senderLabel,
        targetNodeId: resolvedTargetId,
        targetNodeLabel: targetLabel,
        prompt: rawPrompt,
        invoice: decoded.invoice,
        decodedInvoice: decoded,
        amountMsat: canonicalPayment.amount,
        assetId: canonicalPayment.assetId,
        assetTicker: primaryAsset?.ticker ?? 'DEMO',
        assetAmount: decoded.assetAmount,
        latencyMs: latency,
        extracted: nextExtracted,
        compileResult: compiled,
        selectedAlgorithm: suggested.algorithm,
        selectedWeights: suggested.weights,
        maxPaths: suggestedMaxPaths,
        excludedNodes: suggestedExcludedNodes,
        excludedNodeLabels:
          excludedLabels.length > 0
            ? excludedLabels
            : nextExtracted.excludedNodeReferences,
        rationale,
        status: 'awaiting_approval',
        resultMessage: '',
      };

      setPendingProposal(proposal);
    } catch (err) {
      if (ownRevision === revisionRef.current && (err as Error).name !== 'AbortError') {
        const message = (err as Error).message;
        setQvacError(message);
      }
    } finally {
      if (ownRevision === revisionRef.current) {
        setQvacBusy(false);
      }
    }
  }, [
    activeNodeId,
    chatPrompt,
    getBaseUrlForNode,
    getSessionForNode,
    handleGenerateInvoiceFromNode,
    invalidateQvacConcurrency,
    knownNodesList,
    nodeMap,
    resolveExcludedReferencesToPubkeys,
  ]);

  // QVAC Chat Step 2A: User Approves Notification -> Prepare & Confirm TX -> Return Confirmation or Error
  const handleApproveChatProposal = useCallback(
    async (proposalId: string) => {
      if (!pendingProposal || pendingProposal.id !== proposalId) return;
      const session = getSessionForNode(pendingProposal.senderNodeId);

      setPendingProposal(prev => (prev ? { ...prev, status: 'executing' } : null));

      try {
        const supportsHardRoutingExtras =
          pendingProposal.compileResult?.status === 'validated';
        const routing: PaymentRouting = {
          ...(pendingProposal.selectedAlgorithm === 'multi_objective'
            ? {
                algorithm: 'multi_objective',
                weights: pendingProposal.selectedWeights,
              }
            : { algorithm: pendingProposal.selectedAlgorithm }),
          ...(supportsHardRoutingExtras && pendingProposal.excludedNodes?.length
            ? { excluded_nodes: pendingProposal.excludedNodes }
            : {}),
          ...(supportsHardRoutingExtras && pendingProposal.maxPaths
            ? { max_paths: pendingProposal.maxPaths }
            : {}),
        };

        const intentId = crypto.randomUUID();
        const prepared = await session.api<PreparedPaymentIntent>(
          '/api/payments/prepare',
          {
            id: intentId,
            invoice: pendingProposal.invoice,
            amountMsat: pendingProposal.amountMsat,
            constraints: pendingProposal.compileResult?.policy ?? {},
            routing,
          },
        );

        let finalIntent = await session.api<PreparedPaymentIntent>(
          '/api/payments/confirm',
          { id: prepared.id },
        );

        // Poll briefly if status is pending/unknown
        for (
          let attempt = 0;
          attempt < 8 && !['succeeded', 'failed'].includes(finalIntent.status);
          attempt++
        ) {
          await new Promise(resolve => setTimeout(resolve, 600));
          finalIntent = await session.api<PreparedPaymentIntent>(
            `/api/payments/${encodeURIComponent(prepared.id)}`,
          );
        }

        setPreparedIntent(finalIntent);
        // Clear draft invoice so next chat prompt gets a fresh invoice
        setPaymentDraft(prev => ({ ...prev, invoice: '' }));
        setDecodedInvoice(null);

        const isSuccess = finalIntent.status === 'succeeded';
        const completedEntry: ChatTxProposal = {
          ...pendingProposal,
          status: isSuccess ? 'confirmed' : 'error',
          intentId: finalIntent.id,
          paymentHash: finalIntent.paymentHash,
          resultMessage: isSuccess
            ? `CONFIRMED: Sent ${
                pendingProposal.assetAmount
                  ? `${pendingProposal.assetAmount} ${pendingProposal.assetTicker}`
                  : `${pendingProposal.amountMsat} msat`
              } from ${pendingProposal.senderNodeLabel} to ${pendingProposal.targetNodeLabel} via ${finalIntent.routing.algorithm}.`
            : `ERROR: Payment finished with status "${finalIntent.status.toUpperCase()}". Route or liquidity constraints could not be satisfied.`,
        };

        setChatHistory(prev => [completedEntry, ...prev]);
        setPendingProposal(null);

        await Promise.all([
          refreshNodeSnapshot(pendingProposal.senderNodeId),
          refreshNodeSnapshot(pendingProposal.targetNodeId),
        ]);
      } catch (err) {
        const failedEntry: ChatTxProposal = {
          ...pendingProposal,
          status: 'error',
          resultMessage: `EXECUTION ERROR: ${(err as Error).message}`,
        };
        setChatHistory(prev => [failedEntry, ...prev]);
        setPendingProposal(null);
      }
    },
    [getSessionForNode, pendingProposal, refreshNodeSnapshot],
  );

  // QVAC Chat Step 2B: User Rejects Notification
  const handleRejectChatProposal = useCallback(
    (proposalId: string) => {
      if (!pendingProposal || pendingProposal.id !== proposalId) return;
      const rejectedEntry: ChatTxProposal = {
        ...pendingProposal,
        status: 'rejected',
        resultMessage: 'Cancelled by user at the approval notification step.',
      };
      setChatHistory(prev => [rejectedEntry, ...prev]);
      setPendingProposal(null);
    },
    [pendingProposal],
  );

  // Auto-select routing algorithm with QVAC in Guided Manual Step 2
  const handleSelectAlgorithmWithQvac = useCallback(
    async (userPreference?: string) => {
      const session = getSessionForNode(activeNodeId);
      setQvacBusy(true);
      setQvacError('');
      try {
        let dec = decodedInvoice;
        if (!dec && paymentDraft.invoice.trim()) {
          dec = await handleDecodeInvoice(paymentDraft.invoice.trim());
        }
        const amountMsat =
          dec?.amountMsat ?? (paymentDraft.amount || String(RGB_HTLC_MIN_MSAT));
        try {
          const selected = await session.api<AlgorithmSelectionResult>(
            '/api/routing/select-algorithm',
            {
              invoice: dec?.invoice ?? (paymentDraft.invoice.trim() || undefined),
              amountMsat,
              assetId:
                dec?.assetId ??
                (paymentDraft.assetId !== 'BTC' ? paymentDraft.assetId : null),
              assetAmount: dec?.assetAmount ?? null,
              payeePubkey: dec?.payeePubkey ?? null,
              userPreference: userPreference ?? undefined,
              constraints: compileResult?.policy ?? undefined,
              knownNodes: knownNodesList,
            },
          );
          setAlgorithmSelection(selected);
          setAlgorithm(selected.selectedAlgorithm);
          setWeights(selected.recommendedWeights);
        } catch {
          const fallback = deriveSuggestedRouting(extracted, compileResult);
          setAlgorithm(fallback.algorithm);
          setWeights(fallback.weights);
        }
      } catch (err) {
        setQvacError((err as Error).message);
      } finally {
        setQvacBusy(false);
      }
    },
    [
      activeNodeId,
      compileResult,
      decodedInvoice,
      extracted,
      getSessionForNode,
      handleDecodeInvoice,
      knownNodesList,
      paymentDraft,
    ],
  );

  // Guided Manual Step 3: Automatically compile constraints (if any) + Prepare Payment Intent
  const handlePreparePaymentManual = useCallback(async (): Promise<PreparedPaymentIntent> => {
    const session = getSessionForNode(activeNodeId);
    let dec = decodedInvoice;
    if (!dec && paymentDraft.invoice.trim()) {
      dec = await handleDecodeInvoice(paymentDraft.invoice.trim());
    }
    if (!dec) {
      throw new Error('Generate or paste a valid BOLT11 invoice in Step 1 first.');
    }

    const canonicalPayment: PaymentDraft = {
      invoice: dec.invoice,
      amount: dec.amountMsat ?? (paymentDraft.amount || String(RGB_HTLC_MIN_MSAT)),
      assetId: dec.assetId ?? 'BTC',
      network: 'regtest',
    };

    let activePolicy = compileResult?.policy ?? null;
    let effectiveAlgorithm = algorithm;
    let effectiveWeights = weights;
    let supportsHardExtras = compileResult?.status === 'validated';

    if (hasAnyConstraints(extracted)) {
      const resolvedExcludedRefs = await resolveExcludedReferencesToPubkeys(
        extracted.excludedNodeReferences,
      );
      const compiled = await session.api<CompileResult>('/api/constraints/compile', {
        extracted: {
          ...extracted,
          excludedNodeReferences: resolvedExcludedRefs,
        },
        payment: canonicalPayment,
        knownNodes: knownNodesList,
      });
      setCompileResult(compiled);
      if (compiled.status === 'conflict' || compiled.status === 'needs_clarification') {
        throw new Error(
          compiled.issues[0] ??
            `Constraint validation failed (${compiled.code}). Adjust Step 2 constraints.`,
        );
      }
      activePolicy = compiled.policy;
      supportsHardExtras = compiled.status === 'validated';
      const suggested = deriveSuggestedRouting(extracted, compiled);
      effectiveAlgorithm = suggested.algorithm;
      effectiveWeights = suggested.weights;
      setAlgorithm(suggested.algorithm);
      setWeights(suggested.weights);
    }

    const excludedNodes =
      activePolicy?.hard.excludedNodeIds ??
      algorithmSelection?.recommendedRouting.excluded_nodes;
    const maxPaths =
      extracted.privacyRequest === 'avoid_extra_probing'
        ? 1
        : algorithmSelection?.recommendedRouting.max_paths;

    const routing: PaymentRouting = {
      ...(effectiveAlgorithm === 'multi_objective'
        ? { algorithm: 'multi_objective', weights: effectiveWeights }
        : { algorithm: effectiveAlgorithm }),
      ...(supportsHardExtras && excludedNodes?.length
        ? { excluded_nodes: excludedNodes }
        : {}),
      ...(supportsHardExtras && maxPaths ? { max_paths: maxPaths } : {}),
    };

    const intent = await session.api<PreparedPaymentIntent>('/api/payments/prepare', {
      id: crypto.randomUUID(),
      invoice: canonicalPayment.invoice,
      amountMsat: canonicalPayment.amount,
      constraints: activePolicy ?? {},
      routing,
    });
    setPreparedIntent(intent);
    return intent;
  }, [
    activeNodeId,
    algorithm,
    algorithmSelection,
    compileResult?.policy,
    compileResult?.status,
    decodedInvoice,
    extracted,
    getSessionForNode,
    handleDecodeInvoice,
    knownNodesList,
    paymentDraft,
    resolveExcludedReferencesToPubkeys,
    weights,
  ]);

  const handleConfirmPaymentManual = useCallback(async (): Promise<PreparedPaymentIntent> => {
    if (!preparedIntent) {
      throw new Error('Prepare the transaction first.');
    }
    const session = getSessionForNode(activeNodeId);
    let updated = await session.api<PreparedPaymentIntent>('/api/payments/confirm', {
      id: preparedIntent.id,
    });
    for (
      let attempt = 0;
      attempt < 8 && !['succeeded', 'failed'].includes(updated.status);
      attempt++
    ) {
      await new Promise(resolve => setTimeout(resolve, 600));
      updated = await session.api<PreparedPaymentIntent>(
        `/api/payments/${encodeURIComponent(preparedIntent.id)}`,
      );
    }
    setPreparedIntent(updated);
    await refreshAllNodes();
    return updated;
  }, [activeNodeId, getSessionForNode, preparedIntent, refreshAllNodes]);

  // Manual Sub-tab 2: Create Invoice & Check Status
  const handleCreateInvoice = useCallback(
    async (input: {
      amountMsat: string;
      expirySec: number;
      assetId?: string;
      assetAmount?: string;
    }): Promise<string> => {
      const session = getSessionForNode(activeNodeId);
      const created = await session.api<{ invoice: string }>(
        '/api/wallet/receive/lightning',
        input,
      );
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

  // Quick Invoice Generator on Inspected Node from Right Sidebar
  const handleQuickGenerateInvoice = useCallback(
    async (targetNodeId: string) => {
      const id = UI_NODES.some(node => node.id === targetNodeId) ? targetNodeId : 'bob';
      const session = getSessionForNode(id);
      const nodeState = nodeMap[id];
      const firstAssetId =
        nodeState.assets[0]?.assetId ?? nodeMap.alice.assets[0]?.assetId ?? undefined;

      patchNodeData(id, { busy: true, error: '', notice: '' });
      try {
        const created = await session.api<{ invoice: string }>(
          '/api/wallet/receive/lightning',
          {
            amountMsat: String(RGB_HTLC_MIN_MSAT),
            expirySec: 3600,
            ...(firstAssetId ? { assetId: firstAssetId, assetAmount: '10' } : {}),
          },
        );
        patchNodeData(id, {
          busy: false,
          lastInvoice: created.invoice,
          notice: 'Test Invoice generated and loaded into payment draft!',
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

  const handleUseInvoiceForPayment = useCallback(
    (invoice: string, targetPayerNodeId?: string) => {
      if (targetPayerNodeId && UI_NODES.some(node => node.id === targetPayerNodeId)) {
        handleSelectActiveNode(targetPayerNodeId);
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
        : 'UTXO creation requested. Click "+1 Block & Sync" in ChainControls to confirm.';
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

  const handleToggleDevMode = useCallback(() => {
    setDevMode(prev => {
      const next = !prev;
      if (!next) {
        setWorkspaceTab('chat');
      }
      return next;
    });
  }, []);

  const handleOpenTerminalTab = useCallback((filterNodeId?: string) => {
    setDevMode(true);
    setTerminalNodeFilter(filterNodeId ?? 'all');
    setWorkspaceTab('terminal');
  }, []);

  const nodesList: RegtestNodeSnapshot[] = useMemo(
    () =>
      UI_NODES.map(node => ({
        id: node.id,
        label: node.label,
        port: node.port,
        p2pPort: node.p2pPort,
        baseUrl: node.baseUrl,
        directUrl: node.directUrl,
        accent: node.accent,
        offline: sessions[node.id]?.offline ?? false,
        ...(nodeMap[node.id] ?? EMPTY_NODE_DATA),
      })),
    [nodeMap, sessions],
  );

  const activeNodeSnapshot =
    nodesList.find(n => n.id === activeNodeId) ?? nodesList[0];

  return (
    <div className="app-shell">
      <div className={devMode ? 'three-col-layout' : 'single-col-chat-layout'}>
        {/* COLUMN 1 (LEFT): Node Selector, Auto-Sync ChainControls, Service Health (Dev/Admin Mode only) */}
        {devMode && (
          <LeftServiceSidebar
            health={health}
            healthLoading={healthLoading}
            onRefreshHealth={refreshHealth}
            chainHeight={chainHeight}
            chainBusy={chainBusy}
            chainMessage={chainMessage}
            chainError={chainError}
            hasOnlineChainNode={findOnlineSession() !== null}
            onReadHeight={readHeight}
            onMineBlocksAndSync={handleMineBlocksAndSync}
            onSyncAllNodes={handleSyncAllNodes}
            activeNodeId={activeNodeSnapshot.id}
            activeNodeLabel={activeNodeSnapshot.label}
            activeNodePort={activeNodeSnapshot.port}
            activeNodeOffline={activeNodeSnapshot.offline}
            activeNodeState={activeNodeSnapshot.state}
            onSelectActiveNode={handleSelectActiveNode}
            availableNodes={nodesList.map(n => ({
              id: n.id,
              label: n.label,
              port: n.port,
              offline: n.offline,
              ready: n.state?.node === 'ready',
            }))}
            onCreateKeystore={handleCreateKeystore}
            onImportKeystore={handleImportKeystore}
            onUnlockNode={handleUnlockNode}
          />
        )}

        {/* COLUMN 2 (CENTER): Modern Chatbot UI (+ Manual & Terminal in Dev Mode) */}
        <CenterWorkspace
          devMode={devMode}
          onToggleDevMode={handleToggleDevMode}
          nodes={nodesList}
          activeNode={activeNodeSnapshot}
          onSelectActiveNode={handleSelectActiveNode}
          workspaceTab={devMode ? workspaceTab : 'chat'}
          onChangeWorkspaceTab={setWorkspaceTab}
          manualSubTab={manualSubTab}
          onChangeManualSubTab={setManualSubTab}
          terminalNodeFilter={terminalNodeFilter}
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
          algorithmSelection={algorithmSelection}
          onSelectAlgorithmWithQvac={handleSelectAlgorithmWithQvac}
          preparedIntent={preparedIntent}
          onPreparePaymentManual={handlePreparePaymentManual}
          onConfirmPaymentManual={handleConfirmPaymentManual}
          chatTargetNodeId={chatTargetNodeId}
          onChangeChatTargetNodeId={setChatTargetNodeId}
          chatRgbAmount={chatRgbAmount}
          onChangeChatRgbAmount={setChatRgbAmount}
          chatPrompt={chatPrompt}
          onChangeChatPrompt={handleChangeChatPrompt}
          pendingProposal={pendingProposal}
          chatHistory={chatHistory}
          onRequestChatProposal={handleRequestChatProposal}
          onApproveChatProposal={handleApproveChatProposal}
          onRejectChatProposal={handleRejectChatProposal}
          onApplyShortcut={handleApplyShortcut}
          onGenerateInvoiceFromNode={handleGenerateInvoiceFromNode}
          onCreateInvoice={handleCreateInvoice}
          onCheckInvoiceStatus={handleCheckInvoiceStatus}
          onUseInvoiceOnOtherNode={inv => handleUseInvoiceForPayment(inv)}
          onConnectPeer={handleConnectPeer}
          onOpenChannel={handleOpenChannel}
          onPrepareUtxos={handlePrepareUtxos}
          onIssueNiaAsset={handleIssueNiaAsset}
          onQueryAssetBalance={handleQueryAssetBalance}
          onRefreshAllNodes={refreshAllNodes}
        />

        {/* COLUMN 3 (RIGHT): Node Explorer (Dev/Admin Mode only) */}
        {devMode && (
          <RightNodesInspector
            nodes={nodesList}
            activeNodeId={activeNodeSnapshot.id}
            inspectedNodeId={inspectedNodeId}
            onSelectInspectedNode={setInspectedNodeId}
            onSelectActiveNode={handleSelectActiveNode}
            onSyncNode={handleSyncNode}
            onQuickGenerateInvoice={handleQuickGenerateInvoice}
            onUseInvoiceForPayment={handleUseInvoiceForPayment}
            onOpenTerminalTab={handleOpenTerminalTab}
          />
        )}
      </div>

      <footer className="app-footer">
        <span>
          <strong>AIR-GB · RGB Lightning + Multi-Path Routing + QVAC AI</strong> · Demo Console
        </span>
        <span className="footer-disclaimer">
          All AI-assisted payments require explicit user approval before HTLC execution.
        </span>
      </footer>
    </div>
  );
}

export default App;
