import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CanonicalSession, SourcePlugin } from "../core/index.js";
import { claudePlugin } from "../plugins/claude/index.js";
import { codexPlugin } from "../plugins/codex/index.js";
import { factoryPlugin } from "../plugins/factory/index.js";
import { piPlugin } from "../plugins/pi/index.js";

type ProviderName = "claude" | "codex" | "factory" | "pi";
type AuditRole = "user" | "assistant" | "tool-result" | "system" | "reasoning";

interface AuditUnit {
	role: AuditRole;
	content: string;
	timestamp?: string;
	toolName?: string;
	toolCallId?: string;
}

interface RawSession {
	id: string;
	filePath: string;
	units: AuditUnit[];
	exportable: boolean;
	blockTypes: Record<string, number>;
}

interface CountSummary {
	total: number;
	user: number;
	assistant: number;
	system: number;
	toolResults: number;
	toolCalls: number;
	reasoning: number;
}

interface SessionMismatch {
	filePath: string;
	sessionId: string;
	raw: CountSummary;
	canonical: CountSummary;
	firstDiff?: {
		index: number;
		raw?: string;
		canonical?: string;
	};
}

interface ProviderAudit {
	provider: ProviderName;
	sourceFiles: number;
	exportableRawSessions: number;
	pluginSessions: number;
	rawCounts: CountSummary;
	canonicalCounts: CountSummary;
	blockTypes: Record<string, number>;
	mismatchedSessions: SessionMismatch[];
	longSessionChecks: SessionMismatch[];
	exportRun: {
		ok: boolean;
		outputDir?: string;
		exportedSessions?: number;
		exportedMessages?: number;
		sourceChangedFiles: string[];
		note?: string;
	};
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIST_CLI = join(REPO_ROOT, "dist", "cli.js");

const PROVIDERS: Record<ProviderName, SourcePlugin> = {
	claude: claudePlugin,
	codex: codexPlugin,
	factory: factoryPlugin,
	pi: piPlugin,
};

async function main() {
	const providerNames = (
		process.argv
			.slice(2)
			.filter((arg) => ["claude", "codex", "factory", "pi"].includes(arg)) as ProviderName[]
	).filter(Boolean);
	const targets =
		providerNames.length > 0 ? providerNames : (Object.keys(PROVIDERS) as ProviderName[]);

	const results: ProviderAudit[] = [];
	for (const provider of targets) {
		console.log(`\n=== ${provider.toUpperCase()} ===`);
		results.push(await auditProvider(provider, PROVIDERS[provider]));
	}

	console.log("\n=== SUMMARY ===");
	for (const result of results) {
		console.log(
			[
				`${result.provider}: raw=${result.exportableRawSessions}`,
				`plugin=${result.pluginSessions}`,
				`mismatches=${result.mismatchedSessions.length}`,
				`exportChanged=${result.exportRun.sourceChangedFiles.length}`,
			].join("  "),
		);
	}

	console.log(`\nJSON:\n${JSON.stringify(results, null, 2)}`);
}

async function auditProvider(provider: ProviderName, plugin: SourcePlugin): Promise<ProviderAudit> {
	const files = listProviderFiles(provider);
	const rawSessions: RawSession[] = [];
	const blockTypes: Record<string, number> = {};
	const mismatchedSessions: SessionMismatch[] = [];

	let pluginSessions = 0;
	let rawCounts = emptyCounts();
	let canonicalCounts = emptyCounts();

	for (const filePath of files) {
		const rawSession = parseRawSession(provider, filePath);
		mergeCounts(blockTypes, rawSession.blockTypes);
		rawSessions.push(rawSession);
		if (!rawSession.exportable) continue;

		rawCounts = addCountSummaries(rawCounts, summarizeUnits(rawSession.units));

		let canonical: CanonicalSession;
		try {
			canonical = await plugin.loadSession(filePath);
		} catch (error) {
			mismatchedSessions.push({
				filePath,
				sessionId: rawSession.id,
				raw: summarizeUnits(rawSession.units),
				canonical: emptyCounts(),
				firstDiff: {
					index: 0,
					raw: `plugin failed: ${formatError(error)}`,
				},
			});
			continue;
		}

		pluginSessions++;
		const canonicalSummary = summarizeCanonical(canonical);
		canonicalCounts = addCountSummaries(canonicalCounts, canonicalSummary);

		const mismatch = compareSession(rawSession, canonical);
		if (mismatch) mismatchedSessions.push(mismatch);
	}

	const exportableRawSessions = rawSessions.filter((session) => session.exportable).length;
	const longestSessions = rawSessions
		.filter((session) => session.exportable)
		.sort((a, b) => b.units.length - a.units.length)
		.slice(0, 3);
	const longSessionChecks: SessionMismatch[] = [];
	for (const session of longestSessions) {
		try {
			const canonical = await plugin.loadSession(session.filePath);
			const mismatch = compareSession(session, canonical);
			if (mismatch) {
				longSessionChecks.push(mismatch);
			} else {
				longSessionChecks.push({
					filePath: session.filePath,
					sessionId: session.id,
					raw: summarizeUnits(session.units),
					canonical: summarizeCanonical(canonical),
				});
			}
		} catch (error) {
			longSessionChecks.push({
				filePath: session.filePath,
				sessionId: session.id,
				raw: summarizeUnits(session.units),
				canonical: emptyCounts(),
				firstDiff: {
					index: 0,
					raw: `plugin failed: ${formatError(error)}`,
				},
			});
		}
	}

	const exportRun = runExportAudit(provider);

	console.log(`files=${files.length} exportable=${exportableRawSessions} plugin=${pluginSessions}`);
	console.log(
		[
			`raw messages=${rawCounts.total}`,
			`plugin messages=${canonicalCounts.total}`,
			`mismatched sessions=${mismatchedSessions.length}`,
		].join("  "),
	);
	console.log(
		[
			`raw toolCalls=${rawCounts.toolCalls}`,
			`plugin toolCalls=${canonicalCounts.toolCalls}`,
			`raw reasoning=${rawCounts.reasoning}`,
			`plugin reasoning=${canonicalCounts.reasoning}`,
		].join("  "),
	);

	return {
		provider,
		sourceFiles: files.length,
		exportableRawSessions,
		pluginSessions,
		rawCounts,
		canonicalCounts,
		blockTypes,
		mismatchedSessions,
		longSessionChecks,
		exportRun,
	};
}

function listProviderFiles(provider: ProviderName): string[] {
	const home = homedir();
	switch (provider) {
		case "claude":
			return [
				...listJsonlFiles(join(home, ".claude", "projects")),
				...listJsonlFiles(join(home, ".claude-code", "projects")),
				...listJsonlFiles(join(home, ".claude-local", "projects")),
			];
		case "codex":
			return [
				...listJsonlFiles(join(home, ".codex", "sessions"), "rollout-"),
				...listJsonlFiles(join(home, ".codex", "archived_sessions"), "rollout-"),
				...listJsonlFiles(join(home, ".codex-local", "sessions"), "rollout-"),
				...listJsonlFiles(join(home, ".codex-local", "archived_sessions"), "rollout-"),
			];
		case "factory":
			return listJsonlFiles(join(home, ".factory", "sessions"));
		case "pi":
			return listJsonlFiles(join(home, ".pi", "agent", "sessions"));
	}
}

function listJsonlFiles(root: string, namePrefix?: string): string[] {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const nextPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(nextPath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".jsonl")) continue;
			if (namePrefix && !entry.name.startsWith(namePrefix)) continue;
			result.push(nextPath);
		}
	}
	result.sort();
	return result;
}

function parseRawSession(provider: ProviderName, filePath: string): RawSession {
	const entries = parseJsonl(filePath);
	switch (provider) {
		case "claude":
			return parseClaudeRaw(entries, filePath);
		case "codex":
			return parseCodexRaw(entries, filePath);
		case "factory":
			return parseFactoryRaw(entries, filePath);
		case "pi":
			return parsePiRaw(entries, filePath);
	}
}

function parseClaudeRaw(entries: any[], filePath: string): RawSession {
	const units: AuditUnit[] = [];
	const blockTypes: Record<string, number> = {};
	let sessionId = fileStem(filePath);

	for (const entry of entries) {
		if (entry?.sessionId && sessionId === fileStem(filePath)) {
			sessionId = entry.sessionId;
		}
		if (entry?.type === "user") {
			units.push(
				...parseMessageContent(entry.message?.content, "user", blockTypes, entry.timestamp),
			);
		} else if (entry?.type === "assistant") {
			units.push(
				...parseMessageContent(entry.message?.content, "assistant", blockTypes, entry.timestamp, {
					model: entry.message?.model,
				}),
			);
		}
	}

	return {
		id: sessionId,
		filePath,
		units,
		exportable: units.length > 0,
		blockTypes,
	};
}

function parseCodexRaw(entries: any[], filePath: string): RawSession {
	const responseUnits: AuditUnit[] = [];
	const eventUnits: AuditUnit[] = [];
	const blockTypes: Record<string, number> = {};
	let sessionId = fileStem(filePath);

	for (const entry of entries) {
		if (entry?.type === "session_meta") {
			sessionId = entry.payload?.id ?? sessionId;
			continue;
		}

		if (entry?.type === "response_item") {
			const payload = entry.payload ?? {};
			const payloadType = String(payload.type ?? "");
			increment(blockTypes, `response_item:${payloadType}`);

			if (payloadType === "message") {
				const role = normalizeCodexRawRole(payload.role);
				const text = extractCodexMessageText(payload.content);
				if (role && text) {
					responseUnits.push({
						role,
						content: text,
						timestamp: entry.timestamp,
					});
				}
				continue;
			}

			if (payloadType === "function_call" || payloadType === "custom_tool_call") {
				const name = payload.name ?? "unknown";
				const args = payload.arguments ?? payload.input;
				responseUnits.push({
					role: "assistant",
					content: formatToolCall(name, args),
					timestamp: entry.timestamp,
					toolName: name,
					toolCallId: payload.call_id,
				});
				continue;
			}

			if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
				const output = payload.output;
				const content =
					typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(output);
				if (content) {
					responseUnits.push({
						role: "tool-result",
						content,
						timestamp: entry.timestamp,
						toolCallId: payload.call_id,
					});
				}
				continue;
			}

			if (payloadType === "reasoning") {
				const reasoning = extractCodexReasoningText(payload.summary);
				if (reasoning) {
					responseUnits.push({
						role: "reasoning",
						content: reasoning,
						timestamp: entry.timestamp,
					});
				}
			}

			continue;
		}

		if (entry?.type === "event_msg") {
			const payload = entry.payload ?? {};
			const payloadType = String(payload.type ?? "");
			increment(blockTypes, `event_msg:${payloadType}`);

			if (payloadType === "user_message" && payload.message) {
				eventUnits.push({
					role: "user",
					content: String(payload.message),
					timestamp: entry.timestamp,
				});
				continue;
			}

			if (payloadType === "agent_message" && payload.message) {
				eventUnits.push({
					role: "assistant",
					content: String(payload.message),
					timestamp: entry.timestamp,
				});
				continue;
			}

			if (payloadType === "agent_reasoning" && payload.text) {
				eventUnits.push({
					role: "reasoning",
					content: String(payload.text),
					timestamp: entry.timestamp,
				});
			}
		}
	}

	const hasStructuredResponse = responseUnits.some((unit) => unit.role !== "reasoning");
	const units = hasStructuredResponse ? responseUnits : eventUnits;

	return {
		id: sessionId,
		filePath,
		units,
		exportable: units.length > 0,
		blockTypes,
	};
}

function parseFactoryRaw(entries: any[], filePath: string): RawSession {
	const blockTypes: Record<string, number> = {};
	const messageEntries = entries.filter((entry) => entry?.type === "message");
	const branch = buildBranch(messageEntries);
	const units: AuditUnit[] = [];
	const header = entries.find((entry) => entry?.type === "session_start");

	for (const entry of branch) {
		units.push(
			...parseMessageContent(
				entry.message?.content,
				entry.message?.role,
				blockTypes,
				iso(entry.timestamp),
			),
		);
	}

	return {
		id: header?.id ?? fileStem(filePath),
		filePath,
		units,
		exportable: units.length > 0,
		blockTypes,
	};
}

function parsePiRaw(entries: any[], filePath: string): RawSession {
	const blockTypes: Record<string, number> = {};
	const header = entries.find((entry) => entry?.type === "session");
	const messageEntries = entries.filter((entry) => entry?.type === "message");
	const branch = buildBranch(messageEntries);
	const units: AuditUnit[] = [];

	for (const entry of branch) {
		units.push(
			...parseMessageContent(
				entry.message?.content,
				entry.message?.role,
				blockTypes,
				entry.timestamp,
			),
		);
	}

	return {
		id: header?.id ?? fileStem(filePath),
		filePath,
		units,
		exportable: units.length > 0,
		blockTypes,
	};
}

function buildBranch(messageEntries: any[]): any[] {
	if (messageEntries.length === 0) return [];
	const idEntries = messageEntries.filter((entry) => typeof entry?.id === "string");
	if (idEntries.length === 0) return messageEntries;

	const byId = new Map<string, any>();
	for (const entry of idEntries) {
		byId.set(entry.id, entry);
	}

	let leaf = idEntries[idEntries.length - 1];
	for (let index = idEntries.length - 1; index >= 0; index--) {
		if (idEntries[index]?.id) {
			leaf = idEntries[index];
			break;
		}
	}

	const branch: any[] = [];
	let current: any = leaf;
	while (current) {
		branch.unshift(current);
		if (!current.parentId) break;
		current = byId.get(current.parentId);
	}

	return branch;
}

function parseMessageContent(
	content: unknown,
	role: string | undefined,
	blockTypes: Record<string, number>,
	timestamp?: string,
): AuditUnit[] {
	if (typeof role !== "string") return [];
	if (role === "toolResult") {
		const text = extractBlockText(content);
		return text
			? [
					{
						role: "tool-result",
						content: text,
						timestamp,
					},
				]
			: [];
	}
	if (typeof content === "string") {
		return content ? [{ role: normalizeAuditRole(role), content, timestamp }] : [];
	}

	if (!Array.isArray(content)) return [];

	const units: AuditUnit[] = [];
	let textParts: string[] = [];

	const flushText = () => {
		const text = textParts.join("\n");
		if (!text) return;
		units.push({
			role: normalizeAuditRole(role),
			content: text,
			timestamp,
		});
		textParts = [];
	};

	for (const block of content) {
		const type = String(block?.type ?? "unknown");
		increment(blockTypes, `${role}:${type}`);

		if (type === "text" && typeof block?.text === "string" && block.text) {
			textParts.push(block.text);
			continue;
		}

		if (type === "input_text" || type === "output_text") {
			const text = typeof block?.text === "string" ? block.text : "";
			if (text) textParts.push(text);
			continue;
		}

		flushText();

		if (type === "tool_use" || type === "toolCall") {
			const name = block?.name ?? "unknown";
			const args = block?.input ?? block?.arguments;
			units.push({
				role: "assistant",
				content: formatToolCall(name, args),
				timestamp,
				toolName: name,
				toolCallId: block?.id,
			});
			continue;
		}

		if (type === "tool_result" || type === "toolResult") {
			const result = extractBlockText(block?.content);
			if (!result) continue;
			units.push({
				role: "tool-result",
				content: result,
				timestamp,
				toolCallId: block?.tool_use_id ?? block?.toolCallId,
			});
			continue;
		}

		if (type === "thinking") {
			const thinking = typeof block?.thinking === "string" ? block.thinking : "";
			if (!thinking) continue;
			units.push({
				role: "reasoning",
				content: thinking,
				timestamp,
			});
		}
	}

	flushText();
	return units;
}

function compareSession(
	rawSession: RawSession,
	canonical: CanonicalSession,
): SessionMismatch | null {
	const rawSummary = summarizeUnits(rawSession.units);
	const canonicalSummary = summarizeCanonical(canonical);

	if (!sameCounts(rawSummary, canonicalSummary)) {
		return {
			filePath: rawSession.filePath,
			sessionId: rawSession.id,
			raw: rawSummary,
			canonical: canonicalSummary,
			firstDiff: findFirstSequenceDiff(rawSession.units, canonical.messages),
		};
	}

	const sequenceDiff = findFirstSequenceDiff(rawSession.units, canonical.messages);
	if (sequenceDiff) {
		return {
			filePath: rawSession.filePath,
			sessionId: rawSession.id,
			raw: rawSummary,
			canonical: canonicalSummary,
			firstDiff: sequenceDiff,
		};
	}

	return null;
}

function findFirstSequenceDiff(
	rawUnits: AuditUnit[],
	canonicalMessages: CanonicalSession["messages"],
): SessionMismatch["firstDiff"] | undefined {
	const canonicalUnits = canonicalMessages.map((message) => canonicalMessageLabel(message));
	const rawLabels = rawUnits.map((unit) => auditUnitLabel(unit));
	const limit = Math.max(rawLabels.length, canonicalUnits.length);
	for (let index = 0; index < limit; index++) {
		if (rawLabels[index] !== canonicalUnits[index]) {
			return {
				index,
				raw: rawLabels[index],
				canonical: canonicalUnits[index],
			};
		}
	}
	return undefined;
}

function summarizeUnits(units: AuditUnit[]): CountSummary {
	const summary = emptyCounts();
	for (const unit of units) {
		summary.total++;
		if (unit.role === "user") summary.user++;
		if (unit.role === "assistant") {
			summary.assistant++;
			if (unit.toolName || unit.toolCallId) summary.toolCalls++;
		}
		if (unit.role === "system") summary.system++;
		if (unit.role === "tool-result") summary.toolResults++;
		if (unit.role === "reasoning") summary.reasoning++;
	}
	return summary;
}

function summarizeCanonical(session: CanonicalSession): CountSummary {
	const summary = emptyCounts();
	for (const message of session.messages) {
		summary.total++;
		if (message.role === "user") summary.user++;
		if (message.role === "assistant") {
			summary.assistant++;
			if (message.toolName || message.toolCallId) summary.toolCalls++;
		}
		if (message.role === "system") summary.system++;
		if (message.role === "tool-result") summary.toolResults++;
		if (message.role === "reasoning") summary.reasoning++;
	}
	return summary;
}

function runExportAudit(provider: ProviderName): ProviderAudit["exportRun"] {
	const sourceFiles = listProviderFiles(provider);
	const before = hashFiles(sourceFiles);
	const run = spawnSync("node", [DIST_CLI, "export", provider, "--raw"], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	});

	const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
	const match = output.match(/Exported to (.+?)\/\s*$/m);
	const outputDir = match?.[1]?.trim();

	let exportedSessions: number | undefined;
	let exportedMessages: number | undefined;
	if (outputDir && existsSync(join(outputDir, "sessions.jsonl"))) {
		const exported = parseJsonl(join(outputDir, "sessions.jsonl"));
		exportedSessions = exported.length;
		exportedMessages = exported.reduce(
			(sum, session) => sum + (Array.isArray(session?.messages) ? session.messages.length : 0),
			0,
		);
	}

	const after = hashFiles(sourceFiles);
	const changedFiles = diffHashes(before, after);
	let note: string | undefined;

	if (provider === "codex" && changedFiles.length > 0) {
		const latestChanged = changedFiles
			.map((filePath) => ({ filePath, mtimeMs: statSync(filePath).mtimeMs }))
			.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
		if (latestChanged) {
			note = `Codex source changes may include the currently active rollout log: ${latestChanged.filePath}`;
		}
	}

	if (outputDir && existsSync(outputDir)) {
		rmSync(outputDir, { recursive: true, force: true });
	}

	return {
		ok: run.status === 0,
		outputDir,
		exportedSessions,
		exportedMessages,
		sourceChangedFiles: changedFiles,
		note,
	};
}

function hashFiles(files: string[]): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const filePath of files) {
		const data = readFileSync(filePath);
		hashes.set(filePath, createHash("sha256").update(data).digest("hex"));
	}
	return hashes;
}

function diffHashes(before: Map<string, string>, after: Map<string, string>): string[] {
	const changed: string[] = [];
	for (const [filePath, beforeHash] of before.entries()) {
		if (after.get(filePath) !== beforeHash) changed.push(filePath);
	}
	return changed;
}

function parseJsonl(filePath: string): any[] {
	const content = readFileSync(filePath, "utf-8");
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function extractCodexMessageText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "input_text" || block?.type === "output_text")
		.map((block) => String(block?.text ?? ""))
		.filter(Boolean)
		.join("\n");
}

function extractCodexReasoningText(summary: unknown): string {
	if (!Array.isArray(summary)) return "";
	return summary
		.filter((item) => item?.type === "summary_text" && item.text)
		.map((item) => String(item.text))
		.join("\n");
}

function extractBlockText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.filter((item) => item?.type === "text" && item.text)
			.map((item) => String(item.text))
			.join("\n");
	}
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

function normalizeCodexRawRole(role: unknown): AuditRole | null {
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

function normalizeAuditRole(role: string): AuditRole {
	switch (role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "developer":
		case "system":
			return "system";
		default:
			return "assistant";
	}
}

function canonicalMessageLabel(message: CanonicalSession["messages"][number]): string {
	const kind =
		message.role === "assistant" && (message.toolName || message.toolCallId)
			? "assistant-tool-call"
			: message.role;
	return `${kind}:${normalizeComparableText(message.content)}`;
}

function auditUnitLabel(unit: AuditUnit): string {
	const kind =
		unit.role === "assistant" && (unit.toolName || unit.toolCallId)
			? "assistant-tool-call"
			: unit.role;
	return `${kind}:${normalizeComparableText(unit.content)}`;
}

function formatToolCall(name: unknown, input: unknown): string {
	const toolName = typeof name === "string" && name ? name : "unknown";
	if (input === undefined || input === null) return `[Tool call: ${toolName}]`;
	if (typeof input === "object" && Object.keys(input as Record<string, unknown>).length === 0) {
		return `[Tool call: ${toolName}]`;
	}
	return `[Tool call: ${toolName}] ${typeof input === "string" ? input : JSON.stringify(input)}`;
}

function increment(target: Record<string, number>, key: string) {
	target[key] = (target[key] ?? 0) + 1;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>) {
	for (const [key, value] of Object.entries(source)) {
		target[key] = (target[key] ?? 0) + value;
	}
}

function addCountSummaries(left: CountSummary, right: CountSummary): CountSummary {
	return {
		total: left.total + right.total,
		user: left.user + right.user,
		assistant: left.assistant + right.assistant,
		system: left.system + right.system,
		toolResults: left.toolResults + right.toolResults,
		toolCalls: left.toolCalls + right.toolCalls,
		reasoning: left.reasoning + right.reasoning,
	};
}

function emptyCounts(): CountSummary {
	return {
		total: 0,
		user: 0,
		assistant: 0,
		system: 0,
		toolResults: 0,
		toolCalls: 0,
		reasoning: 0,
	};
}

function sameCounts(left: CountSummary, right: CountSummary): boolean {
	return (
		left.total === right.total &&
		left.user === right.user &&
		left.assistant === right.assistant &&
		left.system === right.system &&
		left.toolResults === right.toolResults &&
		left.toolCalls === right.toolCalls &&
		left.reasoning === right.reasoning
	);
}

function fileStem(filePath: string): string {
	return filePath.replace(/^.*\//, "").replace(/\.jsonl$/, "");
}

function iso(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return new Date(value).toISOString();
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeComparableText(value: string): string {
	return value.replace(/\r\n/g, "\n").trimEnd();
}

void main();
