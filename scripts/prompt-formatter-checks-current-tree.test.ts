/**
 * The coding-agent prompt formatter scans the prompt tree that owns every registered prompt.
 *
 * The old formatter retained two directories after commit prompts moved into `src/prompts`.
 * `bun run fmt:ts` then failed with ENOENT after formatting the rest of the workspace.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** The formatter must complete against the current prompt layout without writing in check mode. */
test("the prompt formatter checks the live prompt tree", () => {
	const result = Bun.spawnSync([process.execPath, "packages/coding-agent/scripts/format-prompts.ts", "--check"], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${result.stdout.toString()}${result.stderr.toString()}`;

	expect(result.exitCode, output).toBe(0);
	expect(output).toContain("All prompt files are formatted.");
});
