export interface ClaudeEntry {
  readonly type: string;
  readonly timestamp?: string;
  readonly uuid?: string;
  readonly parentUuid?: string | null;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly version?: string;
  readonly message?: Record<string, unknown>;
  readonly [key: string]: unknown;
}
