/**
 * @file plugins/codex/index.ts
 *
 * Codex source plugin — reads JSONL rollout sessions from
 * ~/.codex/sessions/ (organized by date: YYYY/MM/DD/rollout-*.jsonl)
 * and ~/.codex/archived_sessions/ (flat directory of rollout-*.jsonl)
 *
 * Storage format: each line is a JSON envelope with {timestamp, type, payload}.
 * Entry types:
 * - "session_meta": session metadata (id, cwd, git info, model_provider)
 * - "event_msg": events with payload.type indicating kind
 *   (user_message, agent_message, agent_reasoning, token_count)
 * - "response_item": model response data with payload.type indicating kind
 *   (message with role+content[], function_call, function_call_output, reasoning)
 * - "turn_context": per-turn context (cwd, model, effort, sandbox_policy)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalMessage, CanonicalSession, SourcePlugin } from "../../core/index.js";
import {
  findExistingDirs,
  findFiles,
  home,
  parseJsonlString,
  sessionIdFromPath,
} from "../helpers.js";

function getCodexDirs(): string[] {
  const h = home();
  return findExistingDirs([join(h, ".codex"), join(h, ".codex-local")]);
}

export const codexPlugin: SourcePlugin = {
  name: "codex",

  async listSessions(): Promise<string[]> {
    const dirs = getCodexDirs();
    const files: string[] = [];
    for (const dir of dirs) {
      // Sessions organized by date: sessions/YYYY/MM/DD/*.jsonl
      files.push(...findFiles(join(dir, "sessions"), (name) => name.endsWith(".jsonl")));
      // Archived sessions: archived_sessions/*.jsonl
      files.push(...findFiles(join(dir, "archived_sessions"), (name) => name.endsWith(".jsonl")));
    }
    return files;
  },

  async loadSession(ref: string): Promise<CanonicalSession> {
    const content = readFileSync(ref, "utf-8");
    const entries = parseJsonlString(content);
    return codexEntriesToCanonical(entries, ref);
  },
};

/**
 * Extract text from a response_item content array.
 * Content blocks use {type: "input_text" | "output_text", text: string}.
 */
function extractTextFromContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, any>;
    if (b.type === "input_text" || b.type === "output_text") {
      const text = (b.text ?? "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function extractReasoningSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return "";

  return summary
    .map((item) => {
      const entry = item as Record<string, any>;
      return entry.type === "summary_text" ? (entry.text ?? "").trim() : "";
    })
    .filter(Boolean)
    .join("\n");
}

function codexEntriesToCanonical(entries: unknown[], filePath: string): CanonicalSession {
  const responseMessages: CanonicalMessage[] = [];
  const eventMessages: CanonicalMessage[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let createdAt: string | undefined;

  for (const entry of entries) {
    const e = entry as Record<string, any>;

    // -- session_meta: session-level metadata --
    if (e.type === "session_meta") {
      const payload = e.payload ?? {};
      sessionId = payload.id;
      cwd = payload.cwd;
      createdAt = payload.timestamp ?? e.timestamp;
      continue;
    }

    // -- turn_context: per-turn context with model info --
    if (e.type === "turn_context") {
      const payload = e.payload ?? {};
      // Use the most recent model and cwd
      if (payload.model) model = payload.model;
      if (payload.cwd) cwd = payload.cwd;
      continue;
    }

    // -- response_item: model response data --
    if (e.type === "response_item") {
      const payload = e.payload ?? {};
      const payloadType = payload.type;

      if (payloadType === "message") {
        const role = normalizeCodexRole(payload.role);
        const content = Array.isArray(payload.content)
          ? extractTextFromContent(payload.content)
          : "";
        if (!content || !role) continue;

        responseMessages.push({
          role,
          content,
          timestamp: e.timestamp,
          model: role === "assistant" ? model : undefined,
        });
      } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        // Tool invocation by the assistant
        const args = payload.arguments ?? payload.input ?? "";
        const name = payload.name ?? "unknown";
        responseMessages.push({
          role: "assistant",
          content: `[Tool call: ${name}] ${typeof args === "string" ? args : JSON.stringify(args)}`,
          timestamp: e.timestamp,
          model,
          toolName: name,
          toolCallId: payload.call_id,
        });
      } else if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output"
      ) {
        // Tool result
        const output = payload.output ?? "";
        responseMessages.push({
          role: "tool-result",
          content: typeof output === "string" ? output : JSON.stringify(output),
          timestamp: e.timestamp,
          toolCallId: payload.call_id,
        });
      } else if (payloadType === "reasoning") {
        const content = extractReasoningSummary(payload.summary);
        if (!content) continue;

        responseMessages.push({
          role: "reasoning",
          content,
          timestamp: e.timestamp,
          model,
        });
      }
      continue;
    }

    // -- event_msg: streaming events --
    if (e.type === "event_msg") {
      const payload = e.payload ?? {};
      const payloadType = payload.type;

      if (payloadType === "user_message") {
        const text = (payload.message ?? "").trim();
        if (text) {
          eventMessages.push({
            role: "user",
            content: text,
            timestamp: e.timestamp,
          });
        }
      } else if (payloadType === "agent_message") {
        const text = (payload.message ?? "").trim();
        if (text) {
          eventMessages.push({
            role: "assistant",
            content: text,
            timestamp: e.timestamp,
            model: payload.model ?? model,
          });
        }
      } else if (payloadType === "agent_reasoning") {
        const text = (payload.text ?? "").trim();
        if (text) {
          eventMessages.push({
            role: "reasoning",
            content: text,
            timestamp: e.timestamp,
            model,
          });
        }
      }
      // Skip token_count and other telemetry events
    }
  }

  const messages = responseMessages.length > 0 ? responseMessages : eventMessages;

  if (messages.length === 0) {
    throw new Error(`No messages found in Codex session: ${filePath}`);
  }

  return {
    id: sessionId ?? sessionIdFromPath(filePath),
    source: "codex",
    messages,
    projectPath: cwd,
    createdAt,
    metadata: { sessionFile: filePath },
  };
}

function normalizeCodexRole(role: unknown): CanonicalMessage["role"] | null {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "developer":
    case "system":
      return "system";
    default:
      return null;
  }
}

export default codexPlugin;
