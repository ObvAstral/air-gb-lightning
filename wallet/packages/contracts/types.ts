export type FeeLimit = { value: string; unit: 'sat' | 'msat'; comparison: 'lte' | 'lt' };
export type Priority = 'balanced' | 'lowest_fee' | 'reliability';
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
