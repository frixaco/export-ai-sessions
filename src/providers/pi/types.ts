export interface PiEntry {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string | null;
  readonly timestamp?: string;
  readonly message?: Record<string, unknown>;
  readonly [key: string]: unknown;
}
