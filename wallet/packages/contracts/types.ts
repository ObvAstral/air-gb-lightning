export type FeeLimit = { value: string; unit: 'sat' | 'msat'; comparison: 'lte' | 'lt' };
export type Priority = 'balanced' | 'lowest_fee' | 'reliability';
export const ROUTING_ALGORITHMS = ['ldk_dijkstra', 'yen', 'min_cost_flow', 'multi_objective'] as const;
export type RoutingAlgorithm = typeof ROUTING_ALGORITHMS[number];
export type ObjectiveWeights = { fee: number; reliability: number; cltv: number; hops: number };
export type RoutingConstraintsPatch = {
  max_fee_msat?: number;
  excluded_nodes?: string[];
  max_paths?: number;
};
export type PaymentRouting = (
  | { algorithm: Exclude<RoutingAlgorithm, 'multi_objective'>; weights?: never }
  | { algorithm: 'multi_objective'; weights: ObjectiveWeights }
) & RoutingConstraintsPatch;
export type ExtractedConstraints = {
  schemaVersion: '1.0';
  status: 'parsed' | 'needs_clarification' | 'out_of_scope';
  feeLimit: FeeLimit | null;
  excludedNodeReferences: string[];
  priority: Priority | null;
  privacyRequest: 'avoid_extra_probing' | 'unspecified' | null;
  unhandledRequests: string[];
};
export type RoutingCapabilities = {
  backendVersion: string;
  revision: string;
  hardFeeCap: boolean;
  hardNodeExclusion: boolean;
  hardChannelExclusion: boolean;
  perPaymentScoringProfile: boolean;
  avoidExtraProbing: boolean;
  canInspectFullRoute: boolean;
  canGuaranteeConstraintsAcrossRetries: boolean;
};
export type PaymentDraft = { invoice: string; amount: string; assetId: string; network: 'regtest' };
export type CompiledPolicy = {
  schemaVersion: '1.0';
  policyId: string;
  paymentId: string;
  paymentFingerprint: string;
  capabilityRevision: string;
  hard: { maxRoutingFeeMsat: string | null; excludedNodeIds: string[]; excludedChannels: string[] };
  soft: { priority: Priority; privacyPreference: 'standard' | 'avoid_extra_probing' };
  status: 'validated';
};
export type CompileResult = {
  status: 'validated' | 'needs_clarification' | 'unsupported' | 'conflict';
  code: 'OK' | 'INVALID_EXTRACTION' | 'CONSTRAINT_UNSUPPORTED' | 'CONSTRAINT_CONFLICT' | 'NODE_UNRESOLVED';
  issues: string[];
  normalized: { maxRoutingFeeMsat: string | null; excludedNodeIds: string[]; priority: Priority; privacyPreference: 'standard' | 'avoid_extra_probing' } | null;
  policy: CompiledPolicy | null;
};

export type ChannelClassification =
  | 'optimal'
  | 'good'
  | 'congested'
  | 'insufficient_liquidity'
  | 'unreliable'
  | 'avoid';

export type ChannelScoreProfile =
  | 'balanced'
  | 'fee_saver'
  | 'high_reliability'
  | 'liquidity_preserving'
  | 'single_path_privacy';

export type ChannelScoreEntry = {
  channelId: string;
  peerNodeId: string;
  peerAlias?: string | null;
  classification: ChannelClassification;
  score: number;
  reason: string;
  outboundMsat?: string | null;
  inboundMsat?: string | null;
  assetId?: string | null;
  assetLocalAmount?: string | null;
  isUsable?: boolean | null;
};

export type RagTelemetryHit = {
  fileId: string;
  filename: string;
  score: number;
  text: string;
};

export type TelemetryEpisode = {
  id: string;
  timestamp: number;
  eventType: 'payment_succeeded' | 'payment_failed' | 'channel_anomaly' | 'liquidity_probe';
  peerNodeId: string | null;
  peerAlias: string | null;
  channelId: string | null;
  amountMsat: string;
  assetId: string | null;
  assetAmount: string | null;
  routingAlgorithm: string;
  outcome: 'succeeded' | 'failed' | 'degraded';
  failureReason: string | null;
  outboundRatioPct: number | null;
  feeMsat: number | null;
  notes: string;
};

export type ChannelClassifierOutput = {
  schemaVersion: '1.0';
  overallProfile: ChannelScoreProfile;
  recommendedWeights: ObjectiveWeights;
  channels: {
    channelId: string;
    peerNodeId: string;
    classification: ChannelClassification;
    score: number;
    reason: string;
  }[];
  summary: string;
};

export type ChannelScoringResult = {
  schemaVersion: '1.0';
  vectorStoreId: string | null;
  ragBackend: 'qvac-turbovec';
  overallProfile: ChannelScoreProfile;
  recommendedWeights: ObjectiveWeights;
  recommendedRouting: PaymentRouting;
  excludedNodeIds: string[];
  channels: ChannelScoreEntry[];
  ragHits: RagTelemetryHit[];
  summary: string;
  latencyMs: number;
};

