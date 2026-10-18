import Ajv from 'ajv';
import algorithmSelectionSchema from '../../packages/contracts/algorithm-selection.schema.json' with { type: 'json' };
import type {
  AlgorithmSelectionReasonCode,
  AlgorithmSelectionResult,
  AlgorithmSelectorClassifierOutput,
  ChannelScoreEntry,
  ChannelScoreProfile,
  ChannelScoringResult,
  CompiledPolicy,
  EphemeralFeasibilitySummary,
  ObjectiveWeights,
  PaymentRouting,
  RagTelemetryHit,
  RoutingAlgorithm,
  TelemetryEpisode,
} from '../../packages/contracts/types.js';
import { ROUTING_ALGORITHMS } from '../../packages/contracts/types.js';
import type { LiveChannelInput, QvacRagStore, ScoreChannelsInput } from './channel-scoring.js';
import { scoreChannelsWithQvac } from './channel-scoring.js';
import { InterpretationError } from './interpret.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSelector = ajv.compile<AlgorithmSelectorClassifierOutput>(algorithmSelectionSchema);

export type AlgorithmHistoricalStats = {
  algorithm: RoutingAlgorithm;
  succeeded: number;
  failed: number;
  failureRatePct: number;
  avgFeeMsat: number;
  insufficientLiquidityCount: number;
  timeoutOrTempFailureCount: number;
  feeBudgetExceededCount: number;
};

type EphemeralChannelBound = {
  channelId: string;
  maxSafeSinglePathMsat: bigint;
  maxMppContributionMsat: bigint;
  maxSafeAssetAmount: bigint;
  outboundRatioPct: number;
  healthy: boolean;
};

/**
 * Ephemeral request-scoped RAM context for dichotomous split / capacity bound analysis.
 * Strictly obeys the "don't hold other people's data" rule:
 * - Only inspects the current request's candidate channels and first-party history in RAM.
 * - Never writes capacity bounds or probe results to SQLite or QVAC RAG.
 * - Explicitly zeroes and clears all internal maps/arrays in `wipe()` inside a `finally {}` block.
 */
export class EphemeralRoutingContext {
  private channelBounds: EphemeralChannelBound[] = [];
  private algoStats = new Map<RoutingAlgorithm, AlgorithmHistoricalStats>();
  private wiped = false;

  constructor(
    input: ScoreChannelsInput,
    scoredChannels: ChannelScoreEntry[],
    firstPartyEpisodes: TelemetryEpisode[],
  ) {
    this.computeDichotomousBounds(input, scoredChannels);
    this.computeFirstPartyAlgorithmStats(firstPartyEpisodes);
  }

  private computeDichotomousBounds(input: ScoreChannelsInput, scoredChannels: ChannelScoreEntry[]): void {
    const reqMsat = BigInt(input.amountMsat || '0');
    const needsRgb = Boolean(input.assetId);

    for (let i = 0; i < input.channels.length; i++) {
      const ch = input.channels[i];
      const scored = scoredChannels[i];
      if (ch.isUsable === false || scored?.classification === 'avoid') continue;

      const outMsat = ch.outboundMsat ? BigInt(ch.outboundMsat) : 0n;
      const inMsat = ch.inboundMsat ? BigInt(ch.inboundMsat) : 0n;
      const totalMsat = outMsat + inMsat;
      const ratioPct = totalMsat > 0n ? Number((outMsat * 100n) / totalMsat) : 50;

      // Dichotomous capacity probing simulation in RAM:
      // Find largest power-of-two / binary-search step <= outMsat that preserves a safe reserve
      let low = 0n;
      let high = outMsat;
      // Reserve at least 10% of channel outbound capacity when possible to avoid channel exhaustion
      const safeCap = outMsat > reqMsat ? (outMsat * 90n) / 100n : outMsat;
      for (let step = 0; step < 8; step++) {
        const mid = (low + high + 1n) / 2n;
        if (mid <= safeCap) {
          low = mid;
        } else {
          high = mid - 1n;
        }
      }

      const assetMatches = !needsRgb || ch.assetId === input.assetId;
      const localAsset = assetMatches && ch.assetLocalAmount ? BigInt(ch.assetLocalAmount) : 0n;

      this.channelBounds.push({
        channelId: ch.channelId ?? scored?.channelId ?? `ch-${i + 1}`,
        maxSafeSinglePathMsat: outMsat,
        maxMppContributionMsat: low > 0n ? low : outMsat,
        maxSafeAssetAmount: localAsset,
        outboundRatioPct: ratioPct,
        healthy:
          scored?.classification === 'optimal' ||
          scored?.classification === 'good',
      });
    }
  }

  private computeFirstPartyAlgorithmStats(episodes: TelemetryEpisode[]): void {
    for (const alg of ROUTING_ALGORITHMS) {
      this.algoStats.set(alg, {
        algorithm: alg,
        succeeded: 0,
        failed: 0,
        failureRatePct: 0,
        avgFeeMsat: 0,
        insufficientLiquidityCount: 0,
        timeoutOrTempFailureCount: 0,
        feeBudgetExceededCount: 0,
      });
    }

    const feeSums = new Map<RoutingAlgorithm, { sum: number; count: number }>();
    for (const ep of episodes) {
      const alg = ROUTING_ALGORITHMS.find(a => a === ep.routingAlgorithm);
      if (!alg) continue;
      const stat = this.algoStats.get(alg)!;
      if (ep.outcome === 'succeeded') {
        stat.succeeded += 1;
        if (typeof ep.feeMsat === 'number' && ep.feeMsat >= 0) {
          const prev = feeSums.get(alg) ?? { sum: 0, count: 0 };
          feeSums.set(alg, { sum: prev.sum + ep.feeMsat, count: prev.count + 1 });
        }
      } else {
        stat.failed += 1;
        const reason = (ep.failureReason ?? '').toLocaleLowerCase();
        if (reason.includes('insufficientliquidity') || reason.includes('exhausted')) {
          stat.insufficientLiquidityCount += 1;
        } else if (reason.includes('timeout') || reason.includes('temporarychannelfailure')) {
          stat.timeoutOrTempFailureCount += 1;
        } else if (reason.includes('feebudgetexceeded') || reason.includes('fee')) {
          stat.feeBudgetExceededCount += 1;
        }
      }
    }

    for (const [alg, stat] of this.algoStats.entries()) {
      const total = stat.succeeded + stat.failed;
      stat.failureRatePct = total > 0 ? Math.round((stat.failed * 100) / total) : 0;
      const fees = feeSums.get(alg);
      stat.avgFeeMsat = fees && fees.count > 0 ? Math.round(fees.sum / fees.count) : 0;
    }
  }

  analyzeFeasibility(input: ScoreChannelsInput): {
    summary: EphemeralFeasibilitySummary;
    algorithmStats: AlgorithmHistoricalStats[];
    hasCongestedOrUnreliableHistory: boolean;
  } {
    if (this.wiped) {
      throw new Error('EphemeralRoutingContext already wiped');
    }

    const reqMsat = BigInt(input.amountMsat || '0');
    const needsRgb = Boolean(input.assetId);
    const reqAsset = needsRgb && input.assetAmount ? BigInt(input.assetAmount) : 0n;

    const singleCoverChannels = this.channelBounds.filter(
      b => b.maxSafeSinglePathMsat >= reqMsat && (!needsRgb || b.maxSafeAssetAmount >= reqAsset),
    );
    const healthySingleChannels = singleCoverChannels.filter(b => b.healthy && b.outboundRatioPct >= 35);

    const totalMsatAcrossUsable = this.channelBounds.reduce((acc, b) => acc + b.maxSafeSinglePathMsat, 0n);
    const totalAssetAcrossUsable = this.channelBounds.reduce((acc, b) => acc + b.maxSafeAssetAmount, 0n);

    const singlePathPossible = singleCoverChannels.length > 0;
    const mppContributors = this.channelBounds.filter(
      b => b.maxSafeSinglePathMsat > 0n && (!needsRgb || b.maxSafeAssetAmount > 0n),
    );
    const mppPossible =
      mppContributors.length >= 2 &&
      totalMsatAcrossUsable >= reqMsat &&
      (!needsRgb || totalAssetAcrossUsable >= reqAsset);

    // Compute minimum number of paths k in [1..8] needed to cover reqMsat (and reqAsset) sorted by largest capacity
    let recommendedMaxPaths = 1;
    const avoidProbing =
      input.compiledPolicy?.soft.privacyPreference === 'avoid_extra_probing' ||
      /(?:privac|probing|singol|single)/i.test(input.userPreference ?? '');

    if (!avoidProbing) {
      if (!singlePathPossible && mppPossible) {
        const sorted = [...this.channelBounds].sort((a, b) => {
          if (needsRgb && b.maxSafeAssetAmount !== a.maxSafeAssetAmount) {
            return b.maxSafeAssetAmount > a.maxSafeAssetAmount ? 1 : -1;
          }
          return b.maxSafeSinglePathMsat > a.maxSafeSinglePathMsat ? 1 : -1;
        });
        let accMsat = 0n;
        let accAsset = 0n;
        let parts = 0;
        for (const b of sorted) {
          accMsat += b.maxSafeSinglePathMsat;
          accAsset += b.maxSafeAssetAmount;
          parts += 1;
          if (accMsat >= reqMsat && (!needsRgb || accAsset >= reqAsset)) break;
        }
        recommendedMaxPaths = Math.max(2, Math.min(8, parts));
      } else if (singlePathPossible && healthySingleChannels.length === 0 && mppPossible && !needsRgb) {
        // Single channel exists but would be heavily drained (<35% ratio); split across 2 paths
        recommendedMaxPaths = 2;
      }
    }

    const statsList = [...this.algoStats.values()];
    const totalTempOrTimeout = statsList.reduce((acc, s) => acc + s.timeoutOrTempFailureCount, 0);
    const hasCongestedOrUnreliableHistory =
      totalTempOrTimeout > 0 ||
      this.channelBounds.some(b => !b.healthy || b.outboundRatioPct < 30);

    return {
      summary: {
        singlePathPossible,
        mppPossible,
        recommendedMaxPaths,
        usableChannelCount: this.channelBounds.length,
        singlePathHealthyChannelCount: healthySingleChannels.length,
        ephemeralRamWiped: true,
      },
      algorithmStats: statsList,
      hasCongestedOrUnreliableHistory,
    };
  }

  wipe(): void {
    for (const bound of this.channelBounds) {
      bound.channelId = '';
      bound.maxSafeSinglePathMsat = 0n;
      bound.maxMppContributionMsat = 0n;
      bound.maxSafeAssetAmount = 0n;
      bound.outboundRatioPct = 0;
      bound.healthy = false;
    }
    this.channelBounds.length = 0;
    this.algoStats.clear();
    this.wiped = true;
  }

  isWiped(): boolean {
    return this.wiped && this.channelBounds.length === 0 && this.algoStats.size === 0;
  }
}

/**
 * Deterministic routing algorithm & MPP selector used both as guardrail over QVAC output
 * and directly inside sanitizeAndValidateChannelScore.
 */
export function selectRoutingStrategyDeterministic(params: {
  input: ScoreChannelsInput;
  overallProfile: ChannelScoreProfile;
  recommendedWeights: ObjectiveWeights;
  excludedNodeIds: string[];
  scoredChannels: ChannelScoreEntry[];
  feasibility: EphemeralFeasibilitySummary;
  hasCongestedOrUnreliableHistory: boolean;
  ragHits: RagTelemetryHit[];
  llmCandidate?: {
    selectedAlgorithm?: RoutingAlgorithm;
    reasonCode?: AlgorithmSelectionReasonCode;
    recommendedMaxPaths?: number;
    rationale?: string;
  };
}): {
  selectedAlgorithm: RoutingAlgorithm;
  reasonCode: AlgorithmSelectionReasonCode;
  recommendedMaxPaths: number;
  recommendedRouting: PaymentRouting;
  rationale: string;
} {
  const {
    input,
    overallProfile,
    recommendedWeights,
    excludedNodeIds,
    scoredChannels,
    feasibility,
    hasCongestedOrUnreliableHistory,
    llmCandidate,
  } = params;

  const reqMsat = BigInt(input.amountMsat || '0');
  const isRgb = Boolean(input.assetId);
  const avoidProbing =
    overallProfile === 'single_path_privacy' ||
    input.compiledPolicy?.soft.privacyPreference === 'avoid_extra_probing';
  const hasExplicitPolicyPriority =
    Boolean(input.compiledPolicy?.soft.priority && input.compiledPolicy.soft.priority !== 'balanced') ||
    Boolean(input.userPreference && input.userPreference.trim().length > 0);
  const hasUnreliableOrCongestedChannel = scoredChannels.some(
    ch => ch.classification === 'congested' || ch.classification === 'unreliable',
  );

  let selectedAlgorithm: RoutingAlgorithm;
  let reasonCode: AlgorithmSelectionReasonCode;
  let recommendedMaxPaths = feasibility.recommendedMaxPaths;
  let defaultRationale: string;

  // Rule 1: Hard privacy preference ("avoid_extra_probing" / "single_path_privacy")
  if (avoidProbing) {
    recommendedMaxPaths = 1;
    selectedAlgorithm = isRgb || hasExplicitPolicyPriority ? 'multi_objective' : 'ldk_dijkstra';
    reasonCode = 'privacy_single_path';
    defaultRationale = 'Vincolo privacy attivo: selezionato percorso singolo senza probing MPP aggiuntivo.';
  }
  // Rule 2: MPP split needed because no single healthy channel can cover the payment, or splitting preserves liquidity
  else if (
    (!feasibility.singlePathPossible && feasibility.mppPossible) ||
    (feasibility.recommendedMaxPaths >= 2 && feasibility.mppPossible)
  ) {
    selectedAlgorithm = 'min_cost_flow';
    reasonCode = 'mpp_liquidity_split';
    recommendedMaxPaths = Math.max(2, Math.min(8, feasibility.recommendedMaxPaths));
    defaultRationale = `Nessun singolo canale copre in sicurezza ${reqMsat} msat; selezionato min_cost_flow con split MPP su ${recommendedMaxPaths} percorsi.`;
  }
  // Rule 3: Congested / unreliable channels or node exclusions -> explore k-shortest alternative paths with Yen
  else if (
    (hasUnreliableOrCongestedChannel || hasCongestedOrUnreliableHistory || excludedNodeIds.length > 0) &&
    !isRgb &&
    overallProfile !== 'fee_saver'
  ) {
    selectedAlgorithm = 'yen';
    reasonCode = 'alternative_paths_exploration';
    recommendedMaxPaths = 1;
    defaultRationale = 'Rilevati canali congestionati/instabili o nodi esclusi; selezionato yen per esplorare k-percorsi alternativi affidabili.';
  }
  // Rule 4: Small/medium native BTC payment with healthy single channel and no custom multi-objective constraint -> fast LDK Dijkstra
  else if (
    !isRgb &&
    reqMsat <= 15_000_000n &&
    feasibility.singlePathHealthyChannelCount >= 1 &&
    !hasExplicitPolicyPriority &&
    overallProfile === 'balanced'
  ) {
    selectedAlgorithm = 'ldk_dijkstra';
    reasonCode = 'small_fast_single_path';
    recommendedMaxPaths = 1;
    defaultRationale = `Pagamento BTC diretto (${reqMsat} msat) coperto da canale ottimale; selezionato ldk_dijkstra a singolo percorso.`;
  }
  // Rule 5: RGB asset transfer or explicit multi-objective trade-off (lowest_fee / reliability / custom preference)
  else {
    selectedAlgorithm = 'multi_objective';
    reasonCode = isRgb ? 'rgb_asset_conservation' : 'multi_objective_tradeoff';
    recommendedMaxPaths = 1;
    defaultRationale = isRgb
      ? 'Trasferimento asset RGB: selezionato multi_objective per bilanciare affidabilità HTLC e conservazione liquidità.'
      : `Ottimizzazione multi-obiettivo (${overallProfile}) con pesi personalizzati su fee, affidabilità e hop.`;
  }

  // Allow QVAC LLM candidate to refine between yen and multi_objective when single-path is viable and privacy/MPP constraints aren't violated
  if (
    llmCandidate?.selectedAlgorithm &&
    ROUTING_ALGORITHMS.includes(llmCandidate.selectedAlgorithm) &&
    !avoidProbing &&
    reasonCode !== 'mpp_liquidity_split'
  ) {
    if (
      llmCandidate.selectedAlgorithm === 'yen' &&
      (hasUnreliableOrCongestedChannel || excludedNodeIds.length > 0)
    ) {
      selectedAlgorithm = 'yen';
      reasonCode = 'alternative_paths_exploration';
    } else if (
      llmCandidate.selectedAlgorithm === 'ldk_dijkstra' &&
      !isRgb &&
      feasibility.singlePathHealthyChannelCount >= 1 &&
      !hasExplicitPolicyPriority
    ) {
      selectedAlgorithm = 'ldk_dijkstra';
      reasonCode = 'small_fast_single_path';
    } else if (llmCandidate.selectedAlgorithm === 'multi_objective' && hasExplicitPolicyPriority) {
      selectedAlgorithm = 'multi_objective';
      reasonCode = isRgb ? 'rgb_asset_conservation' : 'multi_objective_tradeoff';
    }
  }

  const rationale =
    typeof llmCandidate?.rationale === 'string' && llmCandidate.rationale.trim().length > 0
      ? llmCandidate.rationale.trim().slice(0, 160)
      : defaultRationale.slice(0, 160);

  const routingPatch = {
    ...(input.compiledPolicy?.hard.maxRoutingFeeMsat
      ? { max_fee_msat: Number(input.compiledPolicy.hard.maxRoutingFeeMsat) }
      : {}),
    ...(excludedNodeIds.length > 0 ? { excluded_nodes: excludedNodeIds } : {}),
    max_paths: recommendedMaxPaths,
  };

  const recommendedRouting: PaymentRouting =
    selectedAlgorithm === 'multi_objective'
      ? {
          algorithm: 'multi_objective',
          weights: recommendedWeights,
          ...routingPatch,
        }
      : {
          algorithm: selectedAlgorithm,
          ...routingPatch,
        };

  return {
    selectedAlgorithm,
    reasonCode,
    recommendedMaxPaths,
    recommendedRouting,
    rationale,
  };
}

const SELECTOR_SYSTEM_PROMPT = [
  'Seleziona dinamicamente l’algoritmo di routing Lightning/RGB ottimale tra ldk_dijkstra, yen, min_cost_flow e multi_objective.',
  'Regole: usa min_cost_flow con recommendedMaxPaths>=2 quando nessun singolo canale copre il pagamento (mpp_liquidity_split);',
  'usa ldk_dijkstra per pagamenti BTC rapidi su canale singolo capiente (small_fast_single_path);',
  'usa yen quando ci sono canali congestionati/inaffidabili o nodi esclusi (alternative_paths_exploration);',
  'usa multi_objective per asset RGB o bilanciamento fee/reliability (rgb_asset_conservation o multi_objective_tradeoff).',
  'Rispondi solo in JSON conciso (rationale max 18 parole).',
].join(' ');

function getQvacBaseUrl(): URL {
  const base = new URL(process.env.QVAC_URL ?? 'http://127.0.0.1:11434');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
    throw new InterpretationError('QVAC_CONFIG', 'QVAC deve essere sul loopback HTTP');
  }
  return base;
}

export async function selectRoutingAlgorithmWithQvac(
  input: ScoreChannelsInput,
  ragStore: QvacRagStore,
  signal?: AbortSignal,
  options: { requireModelDecision?: boolean } = {},
): Promise<AlgorithmSelectionResult> {
  const started = performance.now();
  const channelScoring = await scoreChannelsWithQvac(input, ragStore, signal);
  const firstPartyEpisodes = ragStore.listEpisodes(50);

  const ephemeral = new EphemeralRoutingContext(input, channelScoring.channels, firstPartyEpisodes);
  try {
    const { summary: feasibility, algorithmStats, hasCongestedOrUnreliableHistory } =
      ephemeral.analyzeFeasibility(input);

    let llmCandidate:
      | {
          selectedAlgorithm?: RoutingAlgorithm;
          reasonCode?: AlgorithmSelectionReasonCode;
          recommendedMaxPaths?: number;
          rationale?: string;
        }
      | undefined;

    const base = getQvacBaseUrl();
    const model = process.env.QVAC_MODEL;
    if (model) {
      try {
        const promptPayload = {
          payment: {
            amountMsat: input.amountMsat,
            asset: input.assetId ? 'RGB' : 'BTC',
            assetAmount: input.assetAmount ?? null,
            profile: channelScoring.overallProfile,
            avoidExtraProbing: input.compiledPolicy?.soft.privacyPreference === 'avoid_extra_probing',
          },
          feasibility: {
            singlePathPossible: feasibility.singlePathPossible,
            mppPossible: feasibility.mppPossible,
            recommendedMaxPaths: feasibility.recommendedMaxPaths,
            usableChannelCount: feasibility.usableChannelCount,
            singlePathHealthyChannelCount: feasibility.singlePathHealthyChannelCount,
          },
          channelClasses: channelScoring.channels.map(c => ({
            peer: c.peerAlias ?? c.channelId,
            class: c.classification,
            score: c.score,
          })),
          algorithmHistory: algorithmStats.map(s => ({
            alg: s.algorithm,
            ok: s.succeeded,
            fail: s.failed,
            failPct: s.failureRatePct,
          })),
        };

        const response = await fetch(new URL('/v1/chat/completions', base), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
          body: JSON.stringify({
            model,
            stream: false,
            temperature: 0,
            max_tokens: 512,
            reasoning_budget: false,
            messages: [
              { role: 'system', content: SELECTOR_SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(promptPayload) },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'routing_algorithm_selector',
                strict: true,
                schema: algorithmSelectionSchema,
              },
            },
          }),
        });

        if (response.ok) {
          const body = (await response.json()) as {
            choices?: { finish_reason?: string; message?: { content?: unknown } }[];
          };
          const content = body.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.trim()) {
            const parsed = JSON.parse(content) as Record<string, unknown>;
            parsed.schemaVersion = '1.0';
            if (validateSelector(parsed)) {
              llmCandidate = {
                selectedAlgorithm: parsed.selectedAlgorithm,
                reasonCode: parsed.reasonCode,
                recommendedMaxPaths: parsed.recommendedMaxPaths,
                rationale: parsed.rationale,
              };
            }
          }
        }
      } catch {
        /* Deterministic selector guardrails remain authoritative if QVAC selector call times out */
      }
    }

    if (options.requireModelDecision && !llmCandidate) {
      throw new InterpretationError('QVAC_SELECTOR_REQUIRED', 'Il benchmark richiede una risposta valida del selettore QVAC; fallback deterministico escluso');
    }

    const decision = selectRoutingStrategyDeterministic({
      input,
      overallProfile: channelScoring.overallProfile,
      recommendedWeights: channelScoring.recommendedWeights,
      excludedNodeIds: channelScoring.excludedNodeIds,
      scoredChannels: channelScoring.channels,
      feasibility,
      hasCongestedOrUnreliableHistory,
      ragHits: channelScoring.ragHits,
      llmCandidate,
    });

    const updatedChannelScoring: ChannelScoringResult = {
      ...channelScoring,
      recommendedRouting: decision.recommendedRouting,
    };

    return {
      schemaVersion: '1.0',
      model: process.env.QVAC_MODEL ?? null,
      modelDecision: llmCandidate ?? null,
      selectionSource: llmCandidate ? 'qvac_with_guardrails' : 'deterministic_fallback',
      selectedAlgorithm: decision.selectedAlgorithm,
      reasonCode: decision.reasonCode,
      rationale: decision.rationale,
      recommendedRouting: decision.recommendedRouting,
      recommendedWeights: channelScoring.recommendedWeights,
      feasibility,
      channelScoring: updatedChannelScoring,
      latencyMs: Math.round(performance.now() - started),
    };
  } finally {
    ephemeral.wipe();
  }
}
