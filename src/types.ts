export type Visibility = "private" | "link" | "public";
export type SharePermission = "read" | "fork";

export interface StylePack {
  id: string;
  name: string;
  slug: string;
  description: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface StylePackSummary extends StylePack {
  ruleCount: number;
}

export interface Rule {
  id: string;
  packId: string;
  title: string;
  bodyMarkdown: string;
  globs: string[];
  alwaysApply: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleVersion {
  id: string;
  ruleId: string;
  bodyMarkdown: string;
  metadataJson: string | null;
  createdAt: string;
}

export interface ShareToken {
  id: string;
  packId: string;
  token: string;
  permission: SharePermission;
  expiresAt: string | null;
  maxUses: number | null;
  createdAt: string;
}

export interface ExportedPack {
  schemaVersion: number;
  exportedAt: string;
  pack: StylePack;
  rules: Rule[];
  shareTokens: ShareToken[];
}

export interface ResolvedRule extends Rule {
  matchedBy: "alwaysApply" | "glob";
}

export interface SearchResult extends Rule {
  score: number;
}

export interface CreatePackInput {
  name: string;
  slug?: string;
  description?: string;
  visibility?: Visibility;
}

export interface UpsertRuleInput {
  pack: string;
  ruleId?: string;
  title: string;
  bodyMarkdown: string;
  globs?: string[];
  alwaysApply?: boolean;
  sortOrder?: number;
}

export interface CreateShareTokenInput {
  pack: string;
  permission?: SharePermission;
  expiresAt?: string;
  maxUses?: number;
}

export interface RemoteProfile {
  name: string;
  kind: "tidb-zero";
  connectionString: string;
  instanceId?: string;
  expiresAt?: string;
  lastPushAt?: string;
  lastPullAt?: string;
}

export interface StoreMetadata {
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  updatedAt: string;
  defaultRemoteProfile?: string;
  remotes: Record<string, RemoteProfile>;
}

export interface SyncOptions {
  remoteName?: string;
  pack?: string;
}

export interface RuleActivityEntry {
  id: string;
  ruleId: string;
  matchedPath: string | null;
  matchedBy: "alwaysApply" | "glob";
  occurredAt: string;
}

export interface LintResult {
  issues: LintIssue[];
  summary: LintSummary;
}

export interface LintIssue {
  type: "orphan_rule" | "overlapping_glob" | "contradiction" | "stale_rule" | "unused_pack";
  severity: "error" | "warning" | "info";
  ruleId?: string;
  packId?: string;
  message: string;
  details?: string;
}

export interface LintSummary {
  totalRules: number;
  totalPacks: number;
  orphanRules: number;
  overlappingGlobPairs: number;
  contradictions: number;
  staleRules: number;
  unusedPacks: number;
}

export interface ImportDiffPack {
  name: string;
  action: "create" | "skip" | "conflict";
  localVersion?: StylePack;
  remoteVersion?: StylePack;
}

export interface ImportDiff {
  packs: ImportDiffPack[];
  newRules: Rule[];
  updatedRules: Array<{ local: Rule; remote: Rule }>;
  unchangedRules: Rule[];
  conflicts: ImportConflict[];
  suggestions: ImportSuggestion[];
}

export interface ImportConflict {
  localRule: Rule;
  remoteRule: Rule;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
}

export interface ImportSuggestion {
  type: "merge" | "replace" | "keep_local" | "keep_remote";
  ruleId: string;
  ruleTitle: string;
  reason: string;
}

export interface RuleExplanation {
  path: string;
  pack: StylePackSummary;
  matchedRules: ResolvedRuleExplanation[];
  alwaysApplyRules: ResolvedRuleExplanation[];
  totalMatched: number;
}

export interface ResolvedRuleExplanation extends ResolvedRule {
  whyItApplies: string;
  precedence: number;
}

export interface DigestReport {
  generatedAt: string;
  storeDir: string;
  packCount: number;
  ruleCount: number;
  totalRuleMatches: number;
  mostMatchedRules: RuleActivitySummary[];
  leastMatchedRules: RuleActivitySummary[];
  rulesWithNoMatches: string[];
  recentlyActiveRules: RuleActivitySummary[];
  staleRules: RuleActivitySummary[];
  healthScore: number;
}

export interface RuleActivitySummary {
  ruleId: string;
  title: string;
  packName: string;
  matchCount: number;
  lastMatchedAt: string | null;
  lastMatchedPath: string | null;
}

export interface StoreStats {
  packCount: number;
  ruleCount: number;
  totalMatches: number;
  rulesWithNoMatches: number;
}
