/**
 * Plugin CLI error output must format thrown values through `errorMessage`, not
 * raw `${err}` interpolation.
 *
 * WHY THIS SUITE EXISTS. A `catch (err)` block whose message template writes
 * `${err}` stringifies an Error as `Error: <message>`, so the user sees a doubled
 * prefix: `Failed to install foo: Error: <message>`. `errorMessage(err)` returns
 * the bare `.message` (locked by type-guards.test.ts), so routing every error
 * through it drops the stray `Error:`. plugin-cli.ts had fifteen raw `${err}` /
 * `${error}` sites across its marketplace, install, uninstall, link, and toggle
 * paths; this is the same doubled-prefix bug update-cli.ts documents inline
 * ("errorMessage(err), not `${err}`"). This is a source-lock in the style the
 * repo already uses (the atomic-write and inline-errorMessage locks): it scans
 * the shipped source so a new raw interpolation cannot silently reintroduce the
 * doubled prefix, which a behavior test on one path would not catch for the
 * other fourteen.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLUGIN_CLI = fileURLToPath(new URL("../src/cli/plugin-cli.ts", import.meta.url));

// A console write (error/log/warn) whose template interpolates the bare caught
// binding. The `}` immediately after the name is what makes it a raw stringify;
// `${errorMessage(err)}` does not match because `err`/`error` is followed by `)`.
const RAW_ERROR_INTERPOLATION = /console\.(?:error|log|warn)\([^)]*\$\{(?:err|error)\}/;

describe("plugin-cli error output routes through errorMessage", () => {
	it("interpolates no raw ${err}/${error} in any console call (no doubled 'Error:' prefix)", () => {
		const source = readFileSync(PLUGIN_CLI, "utf8");
		const offenders = source
			.split("\n")
			.map((line, index) => ({ line: line.trim(), number: index + 1 }))
			.filter(({ line }) => RAW_ERROR_INTERPOLATION.test(line));

		expect(
			offenders,
			"raw ${err}/${error} in a console call doubles the 'Error:' prefix — wrap it in errorMessage(...) from @veyyon/utils",
		).toEqual([]);
	});

	it("still formats caught errors — the file calls errorMessage on them", () => {
		// The negative twin: prove the fix is present (calls exist), not that the
		// error handling was deleted to satisfy the lock above.
		const source = readFileSync(PLUGIN_CLI, "utf8");
		const calls = source.match(/errorMessage\((?:err|error)\)/g) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(15);
	});
});
