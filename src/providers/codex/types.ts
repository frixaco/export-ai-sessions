export interface CodexEntry {
  readonly timestamp?: string;
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}
