import { readFileSync } from "node:fs";

import type { UnifiedSession, UnifiedSource } from "../schema/unified-session.js";
import { assertUnifiedSession } from "../schema/validate-unified-session.js";
import { claudeConverter } from "../providers/claude/convert.js";
import { codexConverter } from "../providers/codex/convert.js";
import { factoryConverter } from "../providers/factory/convert.js";
import { opencodeConverter } from "../providers/opencode/convert.js";
import { piConverter } from "../providers/pi/convert.js";

export interface SessionConverter<TPayload> {
  readonly source: UnifiedSource;
  parse(input: string, filePath?: string): TPayload;
  normalize(payload: TPayload): UnifiedSession;
}

const converterBySource = {
  claude: claudeConverter,
  codex: codexConverter,
  factory: factoryConverter,
  opencode: opencodeConverter,
  pi: piConverter,
} as const satisfies Record<UnifiedSource, SessionConverter<unknown>>;

export function getConverter<TPayload = unknown>(
  source: UnifiedSource,
): SessionConverter<TPayload> {
  return converterBySource[source] as SessionConverter<TPayload>;
}

export function convertSessionText(
  source: UnifiedSource,
  input: string,
  filePath?: string,
): UnifiedSession {
  const converter = getConverter(source);
  const payload = converter.parse(input, filePath);
  const session = converter.normalize(payload);
  return assertUnifiedSession(session);
}

export function convertSessionFile(source: UnifiedSource, filePath: string): UnifiedSession {
  const input = readFileSync(filePath, "utf8");
  return convertSessionText(source, input, filePath);
}
