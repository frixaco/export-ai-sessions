import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Build a default export directory that will not collide with an existing
 * export written in the same second.
 */
export function createDefaultExportDir(
  baseDir = join(".pi-private-data", "exports"),
  now = new Date(),
): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  let candidate = join(baseDir, timestamp);
  let suffix = 1;

  while (existsSync(candidate)) {
    candidate = join(baseDir, `${timestamp}-${suffix}`);
    suffix += 1;
  }

  return candidate;
}
