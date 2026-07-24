/**
 * Locks the boot-path weight contract for `tools/renderers.ts` (PERF-6).
 *
 * Why this suite exists: `tool-execution.ts` (loaded on every interactive
 * boot) imports the renderer barrel, so anything the barrel pulls is paid at
 * startup. The lazy-factory design in `tools/index.ts` keeps tool
 * IMPLEMENTATIONS off the boot path, but a renderer that lives inside its
 * tool module silently defeats that: `createVibeToolRenderer` in `vibe.ts`
 * dragged the whole vibe session runtime (plus the agent registry) into every
 * boot, ~125ms of pure module parse. The renderer now lives in the light
 * `vibe-render.ts`; this test proves the heavy modules stay unloaded when the
 * barrel is imported, so the next co-located renderer fails here instead of
 * shipping a slower boot.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..", "..");

/**
 * Modules that must NOT load when the renderer barrel is imported. These are
 * the heavy halves the `vibe-render.ts` / `irc-render.ts` splits carved off:
 * the vibe session runtime, the irc bus, the live agent session, and the tool
 * modules that import them. `registry/agent-registry` is deliberately NOT
 * banned: `internal-urls/local-protocol` (reached via the file tools) uses it
 * as a value, and its own import graph is entirely shared with modules the
 * barrel already loads, so it adds zero marginal boot cost.
 */
const BANNED_ON_BOOT = [
	"src/vibe/runtime",
	"src/tools/vibe.ts",
	"src/tools/irc.ts",
	"src/irc/bus",
	"src/session/agent-session",
];

describe("tools/renderers boot-path weight (PERF-6)", () => {
	test("importing the renderer barrel does not load the vibe runtime", async () => {
		// A clean subprocess is required: this test file's own runner has other
		// suites' imports in its module registry, which would false-positive.
		const script = `
			await import(${JSON.stringify(path.join(repoRoot, "packages/coding-agent/src/tools/renderers.ts"))});
			console.log(JSON.stringify(Object.keys(import.meta.require.cache)));
		`;
		const proc = Bun.spawn(["bun", "-e", script], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, `renderer barrel failed to import: ${err}`).toBe(0);
		const loaded: string[] = JSON.parse(out.trim().split("\n").at(-1) ?? "[]");
		expect(loaded.length).toBeGreaterThan(50); // sanity: the barrel graph did load
		for (const banned of BANNED_ON_BOOT) {
			const hits = loaded.filter(key => key.includes(banned));
			expect(hits, `${banned} loaded at boot via the renderer barrel: ${hits.join(", ")}`).toEqual([]);
		}
	});
});
