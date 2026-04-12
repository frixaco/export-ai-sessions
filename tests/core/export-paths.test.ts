import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultExportDir } from "../../core/export-paths.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("createDefaultExportDir", () => {
	it("uses millisecond precision in the default directory name", () => {
		const outputRoot = createTempDir();
		const result = createDefaultExportDir(outputRoot, new Date("2026-01-01T00:00:00.123Z"));
		expect(result).toBe(join(outputRoot, "2026-01-01T00-00-00-123Z"));
	});

	it("adds a suffix when the default directory already exists", () => {
		const outputRoot = createTempDir();
		const base = join(outputRoot, "2026-01-01T00-00-00-123Z");
		mkdirSync(base, { recursive: true });

		const result = createDefaultExportDir(outputRoot, new Date("2026-01-01T00:00:00.123Z"));
		expect(result).toBe(join(outputRoot, "2026-01-01T00-00-00-123Z-1"));
	});
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-brain-export-paths-"));
	tempDirs.push(dir);
	return dir;
}
