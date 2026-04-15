export interface OpencodeExport {
  readonly info: {
    readonly id: string;
    readonly slug?: string;
    readonly projectID?: string;
    readonly directory?: string;
    readonly title?: string;
    readonly version?: string;
    readonly summary?: Record<string, unknown>;
    readonly time?: {
      readonly created?: number;
      readonly updated?: number;
    };
  };
  readonly messages: OpencodeMessage[];
}

export interface OpencodeMessage {
  readonly info: Record<string, unknown>;
  readonly parts: Record<string, unknown>[];
}
