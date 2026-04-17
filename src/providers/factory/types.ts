export interface FactoryEntry {
  readonly type: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly parentId?: string | null;
  readonly compactionSummaryId?: string;
  readonly message?: Record<string, unknown>;
  readonly [key: string]: unknown;
}
