import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExtractedConstraints, PaymentRouting, RoutingCapabilities, TelemetryEpisode } from '../../packages/contracts/types.js';
import type { LiveChannelInput } from '../../apps/local-service/channel-scoring.js';

export const topologyPath = fileURLToPath(new URL('../../../topology.json', import.meta.url));
export const fixtureDirectory = new URL('../fixtures/routing-history/', import.meta.url);
export const readJson = <T>(path: string | URL): T => JSON.parse(readFileSync(path, 'utf8')) as T;
export type FixturePayment = { sender: string; recipient: string; amountMsat: string; asset: string | null; assetAmount: string | null };
export type FixtureRouting = { max_fee_msat: number; max_paths: number; excludedNodeIds: string[] };
export type ReferencePath = { nodes: string[]; amountMsat: string; assetAmount?: string | null };
export type Scenario = {
  id: string; prompt?: string; expectedExtraction?: Partial<ExtractedConstraints>;
  payment?: Partial<FixturePayment>; routing?: Partial<FixtureRouting>;
  overrides?: { unavailableChannelIds: string[] };
  expected: { outcome: string; graphFeasible: boolean; paths?: ReferencePath[]; pathCount?: number; totalFeeMsat?: string; maximumDeliverableAssetAmount?: string };
};
export type Topology = {
  name: string; nodes: { id: string; alias: string; apiPort: number; p2pPort: number }[];
  channels: { id: string; from: string; to: string; asset_amount: number; fee_base_msat: number }[];
  channelDefaults: { capacity_sat: number; fee_proportional_millionths: number };
  assets: { id: string; supply: string; initialAllocations: Record<string, string> }[];
  algorithmMatrix: PaymentRouting[]; paymentDefaults: FixturePayment; routingDefaults: FixtureRouting;
  expectedExtractionDefaults: ExtractedConstraints; scenarios: Scenario[];
};
export type HistoricalPath = ReferencePath & { plannedFeeMsat: number; settled: boolean; hops: { channelId: string; fromNodeId: string; toNodeId: string; amountMsat: string; forwardingFeeMsat: number }[] };
export type HistoricalTransaction = {
  id: string; timestamp: number; senderNodeId: string; recipientNodeId: string; amountMsat: string;
  assetId: string | null; assetAmount: string | null; routing: PaymentRouting & { max_fee_msat: number; max_paths: number };
  outcome: 'succeeded' | 'failed'; failureReason: string | null; totalFeeMsat: number; paths: HistoricalPath[];
};
export type ChannelState = { channelId: string; fromMsat: string; toMsat: string; fromAssetAmount: string; toAssetAmount: string };
export type History = {
  synthetic: boolean; provenance: { sourceTopologySha256: string; asOf: string };
  topology: { nodes: { id: string; alias: string; pubkey: string }[]; channels: { id: string; channelId: string; from: string; to: string; assetId: string; capacitySat: string; assetCapacity: string; forwardFeeBaseMsat: number; reverseFeeBaseMsat: number }[] };
  knownNodes: { alias: string; pubkey: string }[]; initialChannelStates: ChannelState[]; finalChannelStates: ChannelState[];
  currentChannelsByNode: Record<string, LiveChannelInput[]>;
  transactions: HistoricalTransaction[];
  nodeHistories: Record<string, { transactionId: string; pathIndex: number; direction: 'incoming' | 'outgoing'; episode: TelemetryEpisode }[]>;
  summary: { transactionCount: number; succeeded: number; failed: number; incomingEpisodes: number; outgoingEpisodes: number };
};
export type Manifest = { sourceTopologySha256: string; datasets: { filename: string; sha256: string; bytes: number; transactionCount: number }[] };
export const topology = readJson<Topology>(topologyPath);
export const manifest = readJson<Manifest>(new URL('manifest.json', fixtureDirectory));
const cache = new Map<number, History>();
export function loadHistory(count: number): History {
  const entry = manifest.datasets.find(item => item.transactionCount === count);
  assert(entry, `Missing history size ${count}`);
  if (!cache.has(count)) cache.set(count, readJson<History>(new URL(entry.filename, fixtureDirectory)));
  return cache.get(count)!;
}
export const capabilities: RoutingCapabilities = {
  backendVersion: 'fixture-contract', revision: 'rgb-mpp-1', hardFeeCap: true, hardNodeExclusion: true,
  hardChannelExclusion: false, perPaymentScoringProfile: true, avoidExtraProbing: true,
  canInspectFullRoute: true, canGuaranteeConstraintsAcrossRetries: true,
};
export function resolved(scenario: Scenario) {
  return { payment: { ...topology.paymentDefaults, ...scenario.payment }, routing: { ...topology.routingDefaults, ...scenario.routing },
    extracted: { ...topology.expectedExtractionDefaults, ...scenario.expectedExtraction } };
}
type Edge = Topology['channels'][number];
function edgesFor(scenario: Scenario): Edge[] {
  const { routing } = resolved(scenario);
  return topology.channels.filter(edge => !routing.excludedNodeIds.includes(edge.from) && !routing.excludedNodeIds.includes(edge.to)
    && !scenario.overrides?.unavailableChannelIds.includes(edge.id));
}
export function enumeratePaths(scenario: Scenario): string[][] {
  const { payment } = resolved(scenario), edges = edgesFor(scenario), paths: string[][] = [];
  const visit = (path: string[]) => {
    if (path.at(-1) === payment.recipient) { paths.push(path); return; }
    for (const edge of edges.filter(edge => edge.from === path.at(-1))) if (!path.includes(edge.to)) visit([...path, edge.to]);
  };
  visit([payment.sender]);
  return paths;
}
export function pathEdges(nodes: string[]): Edge[] {
  return nodes.slice(1).map((to, i) => {
    const edge = topology.channels.find(edge => edge.from === nodes[i] && edge.to === to);
    assert(edge, `Unknown directed topology edge ${nodes[i]} -> ${to}`);
    return edge;
  });
}
export const pathFee = (nodes: string[]) => pathEdges(nodes).slice(1).reduce((sum, edge) => sum + edge.fee_base_msat, 0);
export function assertRoutePlan(scenario: Scenario, plan: ReferencePath[]): void {
  const { payment, routing } = resolved(scenario);
  assert(plan.length > 0 && plan.length <= routing.max_paths, 'path count');
  const rgbUsed = new Map<string, bigint>(), btcUsed = new Map<string, bigint>();
  let delivered = 0n, rgb = 0n, fee = 0;
  for (const path of plan) {
    assert.equal(path.nodes[0], payment.sender); assert.equal(path.nodes.at(-1), payment.recipient);
    assert.equal(new Set(path.nodes).size, path.nodes.length, 'cyclic route');
    assert(!path.nodes.some(node => routing.excludedNodeIds.includes(node)), 'excluded node');
    const edges = pathEdges(path.nodes);
    assert(!edges.some(edge => scenario.overrides?.unavailableChannelIds.includes(edge.id)), 'unavailable channel');
    const amount = BigInt(path.amountMsat), units = BigInt(path.assetAmount ?? '0');
    assert(amount >= 3000000n, 'HTLC minimum');
    if (payment.asset) assert(units > 0n, 'positive RGB part'); else assert.equal(units, 0n);
    delivered += amount; rgb += units; fee += pathFee(path.nodes);
    let carried = amount;
    for (let i = edges.length - 1; i >= 0; i--) {
      const edge = edges[i];
      rgbUsed.set(edge.id, (rgbUsed.get(edge.id) ?? 0n) + units);
      btcUsed.set(edge.id, (btcUsed.get(edge.id) ?? 0n) + carried);
      assert(rgbUsed.get(edge.id)! <= BigInt(edge.asset_amount), 'shared RGB capacity');
      assert(btcUsed.get(edge.id)! <= BigInt(topology.channelDefaults.capacity_sat) * 1000n, 'shared BTC capacity');
      if (i > 0) carried += BigInt(edge.fee_base_msat);
    }
  }
  assert.equal(delivered, BigInt(payment.amountMsat), 'BTC total');
  assert.equal(rgb, BigInt(payment.assetAmount ?? '0'), 'RGB total');
  assert(fee <= routing.max_fee_msat, 'aggregate fee budget');
}
// Independent fixture oracle. This does not execute any production Rust planner.
export function referencePlans(scenario: Scenario): ReferencePath[][] {
  const { payment, routing } = resolved(scenario), paths = enumeratePaths(scenario), plans: ReferencePath[][] = [];
  const consider = (plan: ReferencePath[]) => { try { assertRoutePlan(scenario, plan); plans.push(plan); } catch { /* Infeasible candidate. */ } };
  for (const nodes of paths) consider([{ nodes, amountMsat: payment.amountMsat, assetAmount: payment.assetAmount }]);
  if (routing.max_paths >= 2 && payment.asset) {
    const total = BigInt(payment.assetAmount!);
    for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
      for (let first = 1n; first < total; first++) {
        const firstMsat = (BigInt(payment.amountMsat) * first + total - 1n) / total;
        consider([{ nodes: paths[i], amountMsat: String(firstMsat), assetAmount: String(first) },
          { nodes: paths[j], amountMsat: String(BigInt(payment.amountMsat) - firstMsat), assetAmount: String(total - first) }]);
      }
    }
  }
  // The fixture only has feasible cases requiring <=2 paths. Higher path limits
  // occur in impossible-capacity cases, which are proved by maxFlowRgb below.
  if (routing.max_paths > 2 && payment.asset) assert(maxFlowRgb(scenario) < Number(payment.assetAmount), 'Oracle requires a general allocator for this new scenario');
  return plans;
}
export function maxFlowRgb(scenario: Scenario): number {
  const { payment } = resolved(scenario), residual = new Map<string, Map<string, number>>();
  for (const node of topology.nodes) residual.set(node.id, new Map());
  for (const edge of edgesFor(scenario)) {
    residual.get(edge.from)!.set(edge.to, edge.asset_amount); residual.get(edge.to)!.set(edge.from, 0);
  }
  let total = 0;
  for (;;) {
    const parents = new Map<string, string | null>([[payment.sender, null]]), queue = [payment.sender];
    for (let i = 0; i < queue.length && !parents.has(payment.recipient); i++) for (const [next, amount] of residual.get(queue[i])!) {
      if (amount > 0 && !parents.has(next)) { parents.set(next, queue[i]); queue.push(next); }
    }
    if (!parents.has(payment.recipient)) return total;
    let amount = Infinity;
    for (let at = payment.recipient; parents.get(at); at = parents.get(at)!) amount = Math.min(amount, residual.get(parents.get(at)!)!.get(at)!);
    for (let at = payment.recipient; parents.get(at); at = parents.get(at)!) {
      const previous = parents.get(at)!;
      residual.get(previous)!.set(at, residual.get(previous)!.get(at)! - amount);
      residual.get(at)!.set(previous, (residual.get(at)!.get(previous) ?? 0) + amount);
    }
    total += amount;
  }
}
