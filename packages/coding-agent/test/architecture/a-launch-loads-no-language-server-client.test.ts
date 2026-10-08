/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. The streaming edit guard previews a patch on every session, and it imported
 * `previewPatch` from `edit/modes/patch.ts`, which also held the edit tool's write path. That module
 * imported the LSP writethrough, the LSP client and the ACP bridge, so every launch evaluated the
 * language-server client, its server table (`lsp/defaults.json`), the linter clients and the JSON-RPC
 * framing: 21 modules, none of which runs before the first edit or `lsp` call.
 *
 * THE CLASS. A module under `src/lsp/`, or the ACP write bridge, reaches the launch graph. The `lsp/`
 * directory is read at run time and the subset `main.ts` and `sdk.ts` reach statically is pinned by
 * exact equality, so a new LSP module imported from anything a launch evaluates turns this red until it
 * is recorded below. The edit tool and the `lsp` tool reaching the client is asserted too, so the cut
 * cannot pass by the client going missing from the tools that use it.
 *
 * WHAT IT DOES NOT CATCH. The walk is static: a module loaded through `await import(...)` is outside it
 * by design. That an edit still publishes diagnostics through the writethrough is the edit suites'
 * contract (`edit-acp-bridge.test.ts`, `edit-patch-unchanged-error.test.ts`).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleReach } from "@veyyon/utils/module-reach";
import { CACHE, RESOLUTION, SRC } from "../helpers/module-reach-gate";

const LSP = path.join(SRC, "lsp");
const ACP_BRIDGE = path.join(SRC, "tools", "core", "acp-bridge.ts");

/** Every module file under `src/lsp/`, relative to it, sorted. */
function lspModules(): string[] {
	return fs
		.readdirSync(LSP, { recursive: true, encoding: "utf8" })
		.filter(name => /\.(ts|json)$/.test(name))
		.sort();
}

function reachedLsp(entry: string): string[] {
	const reached = moduleReach(path.join(SRC, entry), RESOLUTION, CACHE);
	return lspModules().filter(name => reached.has(path.join(LSP, name)));
}

describe("a launch loads no language-server client", () => {
	it("reads an lsp directory worth judging", () => {
		expect(lspModules()).toContain("client.ts");
		expect(lspModules()).toContain("defaults.json");
		expect(lspModules().length).toBeGreaterThan(10);
	});

	for (const entry of ["main.ts", "sdk.ts"]) {
		it(`${entry} reaches only the lsp modules a session needs before its first edit`, () => {
			expect(reachedLsp(entry)).toEqual([
				// The channel name startup publishes server status on; it imports `./index` for a type only.
				"startup-events.ts",
			]);
		});

		it(`${entry} does not reach the ACP write bridge`, () => {
			expect(moduleReach(path.join(SRC, entry), RESOLUTION, CACHE).has(ACP_BRIDGE)).toBe(false);
		});
	}

	for (const tool of ["edit/index.ts", "lsp/index.ts"]) {
		it(`${tool} still reaches the client, the server table and the writethrough`, () => {
			expect(reachedLsp(tool)).toEqual(
				expect.arrayContaining(["client.ts", "config.ts", "defaults.json", "index.ts"]),
			);
		});
	}

	it("the edit tool still reaches the ACP write bridge", () => {
		expect(moduleReach(path.join(SRC, "edit/index.ts"), RESOLUTION, CACHE).has(ACP_BRIDGE)).toBe(true);
	});
});
