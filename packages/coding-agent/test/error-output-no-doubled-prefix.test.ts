/**
 * User-facing error output must format thrown values through `errorMessage`, not
 * raw `${err}` / `${error}` interpolation.
 *
 * WHY THIS SUITE EXISTS. A message template that writes `${err}` stringifies an
 * Error as `Error: <message>`, so the user reads a doubled prefix:
 * `Failed to install foo: Error: <message>`, `Plugin error: Error: <message>`.
 * `errorMessage(err)` (from `@veyyon/utils`, contract-locked by
 * type-guards.test.ts) returns the bare `.message`, dropping the stray `Error:`.
 * update-cli.ts documents this inline ("errorMessage(err), not `${err}`"), yet
 * the same bug had crept into plugin-cli.ts (15 sites), builtin-registry.ts, and
 * selector-controller.ts. A behavior test on one path cannot catch the others,
 * so this is a source-lock in the style the repo already uses (the atomic-write
 * and inline-errorMessage locks): it scans every shipped `coding-agent` source
 * so a new raw interpolation in any user-facing output cannot silently
 * reintroduce the doubled prefix.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

// A user-facing output sink whose argument interpolates the bare caught binding.
// The `}` immediately after `err`/`error` is what makes it a raw stringify;
// `${errorMessage(err)}` never matches because the name is followed by `)`. The
// sinks are the ways coding-agent shows a message to a person: the console, the
// interactive `output(...)`, and the TUI `show*` helpers.
const RAW_ERROR_INTERPOLATION =
	/(?:console\.(?:error|log|warn)|\boutput|\bshowError|\bshowWarning|\bshowStatus|\bshowInfo)\([^)]*\$\{(?:err|error)\}/;

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("user-facing error output routes through errorMessage", () => {
	it("interpolates no raw ${err}/${error} in any console/output/show* call across coding-agent src", () => {
		const offenders: string[] = [];
		for (const file of collectSourceFiles(SRC_ROOT)) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				if (RAW_ERROR_INTERPOLATION.test(line)) {
					offenders.push(`${file.slice(SRC_ROOT.length + 1)}:${index + 1}`);
				}
			});
		}
		expect(
			offenders,
			"raw ${err}/${error} in a user-facing output doubles the 'Error:' prefix — wrap it in errorMessage(...) from @veyyon/utils",
		).toEqual([]);
	});
});
