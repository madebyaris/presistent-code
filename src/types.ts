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
