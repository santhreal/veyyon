/**
 * Locks the cross-compile/bytecode contract for release binaries.
 *
 * Why this suite exists: Bun standalone executables cross-compiled with
 * bytecode enabled segfault in JSC bytecode decoding the moment they launch on
 * the target OS (oven-sh/bun#18416, still open as of Bun 1.3.14). veyyon
 * shipped exactly this bug: the windows-x64 exe (cross-compiled on
 * ubuntu-22.04) died in `llint_entry` on `--version` for v1.0.36 AND v1.0.37 —
 * every Windows user got a binary that crashed at startup. The fix is
 * per-target `bytecode: false` for any target built on a runner whose OS
 * differs from the target OS. This suite re-derives the runner→target mapping
 * from ci.yml itself, so moving a target to a native runner legitimately
 * re-enables bytecode, while re-enabling it on a cross-compile fails loudly.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { targets } from "./ci-release-build-binaries";

const ciYamlPath = path.join(import.meta.dir, "..", ".github", "workflows", "ci.yml");
const ciYaml = await Bun.file(ciYamlPath).text();

/** Runner-OS prefix → the platform a binary built there runs natively on. */
function runnerPlatform(os: string): "linux" | "darwin" | "win32" {
	if (os.startsWith("ubuntu")) return "linux";
	if (os.startsWith("macos")) return "darwin";
	if (os.startsWith("windows")) return "win32";
	throw new Error(`Unknown runner OS in ci.yml release_binary matrix: ${os}`);
}

/** Parse `{ os: ..., target_id: ... }` pairs out of the release_binary matrix. */
function parseReleaseMatrix(yaml: string): Map<string, string> {
	const matrix = new Map<string, string>();
	const entryPattern = /os:\s*([\w.-]+),\s*platform:\s*\w+,\s*arch:\s*\w+,\s*target_id:\s*([\w-]+),/g;
	for (const match of yaml.replace(/\n\s+/g, " ").matchAll(entryPattern)) {
		matrix.set(match[2]!, match[1]!);
	}
	return matrix;
}

describe("release binary bytecode contract (oven-sh/bun#18416)", () => {
	const matrix = parseReleaseMatrix(ciYaml);

	test("ci.yml release_binary matrix covers every build target", () => {
		// If this fails the matrix parser or the workflow drifted; the
		// cross-compile checks below would silently skip the missing target.
		for (const target of targets) {
			expect(matrix.has(target.id), `ci.yml release_binary matrix has no entry for ${target.id}`).toBe(true);
		}
		expect(matrix.size).toBe(targets.length);
	});

	test("every cross-compiled target ships without bytecode", () => {
		// The regression this locks out: win32-x64 built on ubuntu-22.04 with
		// bytecode on → published exe segfaults on launch (v1.0.36, v1.0.37).
		for (const target of targets) {
			const runnerOs = matrix.get(target.id);
			if (!runnerOs) continue; // covered by the matrix test above
			const crossCompiled = runnerPlatform(runnerOs) !== target.platform;
			if (crossCompiled) {
				expect(
					target.bytecode,
					`${target.id} is cross-compiled on ${runnerOs} but has bytecode enabled — ` +
						`the published binary will segfault at launch on ${target.platform} (oven-sh/bun#18416)`,
				).toBe(false);
			}
		}
	});

	test("win32-x64 is the cross-compiled target and stays bytecode-free while built on Linux", () => {
		// Pin the concrete instance so the generic check above can't be defeated
		// by a matrix-parser regression that drops the win32 row.
		const win32 = targets.find(target => target.id === "win32-x64");
		expect(win32).toBeDefined();
		const runnerOs = matrix.get("win32-x64");
		if (runnerOs !== undefined && runnerPlatform(runnerOs) !== "win32") {
			expect(win32!.bytecode).toBe(false);
		}
	});

	test("natively built targets keep bytecode on (cold-start optimization is intentional)", () => {
		// Bytecode is a real startup win; only cross-compiles must give it up.
		// This guards against an overcorrection that quietly disables it fleet-wide.
		for (const target of targets) {
			const runnerOs = matrix.get(target.id);
			if (!runnerOs) continue;
			if (runnerPlatform(runnerOs) === target.platform) {
				expect(target.bytecode, `${target.id} builds natively on ${runnerOs}; bytecode should stay on`).toBe(true);
			}
		}
	});
});
