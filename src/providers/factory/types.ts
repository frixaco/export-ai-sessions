export interface FactoryEntry {
  readonly type: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly parentId?: string | null;
  readonly compactionSummaryId?: string;
  readonly [key: string]: unknown;
}
