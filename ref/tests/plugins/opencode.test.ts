import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";
import { opencodePlugin } from "../../plugins/opencode/index.js";

const require = createRequire(import.meta.url);
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

afterEach(() => {
	process.env.HOME = originalHome;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("opencode plugin", () => {
	it("loads legacy JSON storage sessions", async () => {
		const installDir = createOpencodeInstallDir();
		const sessionId = "ses_json_fixture";
		writeLegacyJsonFixture(installDir, sessionId);

		const refs = await opencodePlugin.listSessions();
		expect(refs).toEqual([`json:${installDir}:${sessionId}`]);

		const session = await opencodePlugin.loadSession(refs[0]);
		expect(session.id).toBe(sessionId);
		expect(session.source).toBe("opencode");
		expect(session.name).toBe("Legacy JSON fixture");
		expect(session.projectPath).toBe("/tmp/json-project");
		expect(session.messages).toEqual([
			{
				role: "user",
				content: "Inspect the legacy storage format",
				timestamp: new Date(1_770_000_000_000).toISOString(),
				model: undefined,
			},
			{
				role: "assistant",
				content: [
					"Legacy JSON storage is still supported.",
					"```ts",
					"console.log('json');",
					"```",
				].join("\n"),
				timestamp: new Date(1_770_000_000_500).toISOString(),
				model: "open-model",
			},
		]);
	});

	it("loads SQLite-backed sessions", async () => {
		const installDir = createOpencodeInstallDir();
		const sessionId = "ses_db_fixture";
		await writeSqliteFixture(installDir, sessionId);

		const refs = await opencodePlugin.listSessions();
		expect(refs).toEqual([`db:${installDir}:${sessionId}`]);

		const session = await opencodePlugin.loadSession(refs[0]);
		expect(session.id).toBe(sessionId);
		expect(session.source).toBe("opencode");
		expect(session.name).toBe("SQLite fixture");
		expect(session.projectPath).toBe("/tmp/db-project");
		expect(session.createdAt).toBe(new Date(1_770_000_100_000).toISOString());
		expect(session.messages).toEqual([
			{
				role: "user",
				content: "Inspect the database storage format",
				timestamp: new Date(1_770_000_100_100).toISOString(),
				model: "open-model",
			},
			{
				role: "assistant",
				content: [
					"SQLite-backed sessions are now supported.",
					"```ts",
					"console.log('sqlite');",
					"```",
				].join("\n"),
				timestamp: new Date(1_770_000_100_400).toISOString(),
				model: "open-model",
			},
		]);
		expect(session.metadata).toMatchObject({
			installDir,
			storage: "db",
		});
	});

	it("keeps legacy JSON discovery when a database is also present", async () => {
		const installDir = createOpencodeInstallDir();
		await writeSqliteFixture(installDir, "ses_db_fixture");
		writeLegacyJsonFixture(installDir, "ses_json_fixture");

		const refs = await opencodePlugin.listSessions();
		expect(refs).toEqual([
			`db:${installDir}:ses_db_fixture`,
			`json:${installDir}:ses_json_fixture`,
		]);
	});

	it("skips SQLite sessions with no messages during discovery", async () => {
		const installDir = createOpencodeInstallDir();
		await writeSqliteFixture(installDir, "ses_db_fixture");
		await writeSqliteFixture(installDir, "ses_empty_fixture", { withMessages: false });

		const refs = await opencodePlugin.listSessions();
		expect(refs).toEqual([`db:${installDir}:ses_db_fixture`]);
	});

	it("reads WAL-backed SQLite sessions when native sqlite is available", async () => {
		const nativeSqlite = await getNativeSqlite();
		if (!nativeSqlite) return;

		const installDir = createOpencodeInstallDir();
		const writer = writeWalSqliteFixture(nativeSqlite, installDir, "ses_wal_fixture");

		try {
			const refs = await opencodePlugin.listSessions();
			expect(refs).toEqual([`db:${installDir}:ses_wal_fixture`]);

			const session = await opencodePlugin.loadSession(refs[0]);
			expect(session.messages).toEqual([
				{
					role: "user",
					content: "hello from wal",
					timestamp: new Date(1_770_000_200_100).toISOString(),
					model: undefined,
				},
			]);
			expect(session.metadata).toMatchObject({
				installDir,
				storage: "db",
			});
		} finally {
			writer.close();
		}
	});
});

function createOpencodeInstallDir(): string {
	const homeDir = mkdtempSync(join(tmpdir(), "pi-brain-opencode-home-"));
	tempDirs.push(homeDir);
	process.env.HOME = homeDir;
	const installDir = join(homeDir, ".local", "share", "opencode");
	mkdirSync(installDir, { recursive: true });
	return installDir;
}

function writeLegacyJsonFixture(installDir: string, sessionId: string): void {
	const sessionDir = join(installDir, "storage", "session", "global");
	const messageDir = join(installDir, "storage", "message", sessionId);
	const partDir = join(installDir, "storage", "part");

	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(messageDir, { recursive: true });
	mkdirSync(join(partDir, "msg_json_user"), { recursive: true });
	mkdirSync(join(partDir, "msg_json_assistant"), { recursive: true });

	writeFileSync(
		join(sessionDir, `${sessionId}.json`),
		JSON.stringify({
			id: sessionId,
			directory: "/tmp/json-project",
			title: "Legacy JSON fixture",
			time: { created: 1_770_000_000_000 },
		}),
	);

	writeFileSync(
		join(messageDir, "msg_001.json"),
		JSON.stringify({
			id: "msg_json_user",
			role: "user",
			time: { created: 1_770_000_000_000 },
		}),
	);
	writeFileSync(
		join(messageDir, "msg_002.json"),
		JSON.stringify({
			id: "msg_json_assistant",
			role: "assistant",
			time: { created: 1_770_000_000_500 },
			modelID: "open-model",
		}),
	);

	writeFileSync(
		join(partDir, "msg_json_user", "prt_001.json"),
		JSON.stringify({
			type: "text",
			text: "Inspect the legacy storage format",
		}),
	);
	writeFileSync(
		join(partDir, "msg_json_assistant", "prt_001.json"),
		JSON.stringify({
			type: "text",
			text: "Legacy JSON storage is still supported.",
		}),
	);
	writeFileSync(
		join(partDir, "msg_json_assistant", "prt_002.json"),
		JSON.stringify({
			type: "code",
			language: "ts",
			text: "console.log('json');",
		}),
	);
}

async function writeSqliteFixture(
	installDir: string,
	sessionId: string,
	options: { withMessages?: boolean } = {},
): Promise<void> {
	const SQL = await initSqlJs({
		locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
	});
	const dbPath = join(installDir, "opencode.db");
	const db = new SQL.Database(
		existsSync(dbPath) ? new Uint8Array(readFileSync(dbPath)) : undefined,
	);

	db.run(`
		CREATE TABLE IF NOT EXISTS session (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			parent_id TEXT,
			slug TEXT NOT NULL,
			directory TEXT NOT NULL,
			title TEXT NOT NULL,
			version TEXT NOT NULL,
			share_url TEXT,
			summary_additions INTEGER,
			summary_deletions INTEGER,
			summary_files INTEGER,
			summary_diffs TEXT,
			revert TEXT,
			permission TEXT,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			time_compacting INTEGER,
			time_archived INTEGER,
			workspace_id TEXT
		);
		CREATE TABLE IF NOT EXISTS message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS part (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
	`);

	db.run(
		[
			"INSERT INTO session (",
			"id, project_id, parent_id, slug, directory, title, version, share_url,",
			"summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,",
			"time_created, time_updated, time_compacting, time_archived, workspace_id",
			") VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)",
		].join(" "),
		[
			sessionId,
			"project_db_fixture",
			"sqlite-fixture",
			"/tmp/db-project",
			"SQLite fixture",
			"1.2.23",
			1_770_000_100_000,
			1_770_000_100_900,
		],
	);

	if (options.withMessages === false) {
		writeFileSync(dbPath, Buffer.from(db.export()));
		db.close();
		return;
	}

	db.run(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
		[
			"msg_db_user",
			sessionId,
			1_770_000_100_100,
			1_770_000_100_150,
			JSON.stringify({
				role: "user",
				time: { created: 1_770_000_100_100 },
				model: { modelID: "open-model" },
			}),
		],
	);
	db.run(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
		[
			"msg_db_assistant",
			sessionId,
			1_770_000_100_400,
			1_770_000_100_800,
			JSON.stringify({
				role: "assistant",
				time: { created: 1_770_000_100_400 },
				modelID: "open-model",
				path: { cwd: "/tmp/db-project" },
			}),
		],
	);

	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
		[
			"prt_db_user_1",
			"msg_db_user",
			sessionId,
			1_770_000_100_110,
			1_770_000_100_110,
			JSON.stringify({
				type: "text",
				text: "Inspect the database storage format",
			}),
		],
	);
	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
		[
			"prt_db_assistant_1",
			"msg_db_assistant",
			sessionId,
			1_770_000_100_410,
			1_770_000_100_410,
			JSON.stringify({
				type: "text",
				text: "SQLite-backed sessions are now supported.",
			}),
		],
	);
	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
		[
			"prt_db_assistant_2",
			"msg_db_assistant",
			sessionId,
			1_770_000_100_420,
			1_770_000_100_420,
			JSON.stringify({
				type: "code",
				language: "ts",
				text: "console.log('sqlite');",
			}),
		],
	);

	writeFileSync(dbPath, Buffer.from(db.export()));
	db.close();
}

async function getNativeSqlite(): Promise<typeof import("node:sqlite") | null> {
	try {
		return await import("node:sqlite");
	} catch {
		return null;
	}
}

function writeWalSqliteFixture(
	sqlite: typeof import("node:sqlite"),
	installDir: string,
	sessionId: string,
): { close(): void } {
	const db = new sqlite.DatabaseSync(join(installDir, "opencode.db"));
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA wal_autocheckpoint = 0;
		CREATE TABLE session (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			parent_id TEXT,
			slug TEXT NOT NULL,
			directory TEXT NOT NULL,
			title TEXT NOT NULL,
			version TEXT NOT NULL,
			share_url TEXT,
			summary_additions INTEGER,
			summary_deletions INTEGER,
			summary_files INTEGER,
			summary_diffs TEXT,
			revert TEXT,
			permission TEXT,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			time_compacting INTEGER,
			time_archived INTEGER,
			workspace_id TEXT
		);
		CREATE TABLE message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
		CREATE TABLE part (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			time_created INTEGER NOT NULL,
			time_updated INTEGER NOT NULL,
			data TEXT NOT NULL
		);
	`);

	db.prepare(
		[
			"INSERT INTO session (",
			"id, project_id, parent_id, slug, directory, title, version, share_url,",
			"summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,",
			"time_created, time_updated, time_compacting, time_archived, workspace_id",
			") VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 0, 0, 0, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)",
		].join(" "),
	).run(
		sessionId,
		"project_wal_fixture",
		"wal-fixture",
		"/tmp/wal-project",
		"WAL fixture",
		"1.2.23",
		1_770_000_200_000,
		1_770_000_200_100,
	);

	db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
	).run(
		"msg_wal_user",
		sessionId,
		1_770_000_200_100,
		1_770_000_200_100,
		JSON.stringify({
			role: "user",
			time: { created: 1_770_000_200_100 },
		}),
	);

	db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		"prt_wal_user",
		"msg_wal_user",
		sessionId,
		1_770_000_200_101,
		1_770_000_200_101,
		JSON.stringify({
			type: "text",
			text: "hello from wal",
		}),
	);

	return {
		close(): void {
			db.close();
		},
	};
}
