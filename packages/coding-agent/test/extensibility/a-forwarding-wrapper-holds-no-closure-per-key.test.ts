/**
 * A wrapper `applyToolProxy` makes forward to a tool holds no closure and no scope per forwarded key:
 * every wrapper that forwards a key reads it through one shared accessor.
 *
 * WHY: every live agent wraps each of its tools, one extension wrapper per tool and an adapter under
 * it for a registered tool, and each wrapper defined a getter closing over the tool and the key for
 * every key of the tool. Forty live subagents held 658 wrappers and about 12,000 of those getters
 * with a scope each. `applyToolProxy` is the one place every wrapper class (extension tools,
 * registered tools, custom tools, RPC host tools) defines its forwarding, so the suite counts there.
 *
 * Cells are counted in a fresh process (`fixtures/tool-proxy-wrapper-cells.ts`), since in the test
 * runner cells other files left behind die inside the counted window. The per-key-closure arm defines
 * one closure getter per key, which proves the count sees them. The accessor pair each forwarded
 * property needs is counted and must stay at one per key. The shared accessors outlive every wrapper,
 * so the accessor for a symbol key must go once the symbol does: a tool built with a symbol of its own
 * would otherwise pin one accessor for the life of the process.
 *
 * NOT CAUGHT: a wrapper class that forwards through its own getters instead of `applyToolProxy`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { WrapperCells } from "../fixtures/tool-proxy-wrapper-cells";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "tool-proxy-wrapper-cells.ts");

/** Four full collections in a process that loads the tool proxy. */
const COUNTED_TIMEOUT_MS = 30_000;

let cells: WrapperCells;

beforeAll(async () => {
	const { stdout, stderr } = await run(process.execPath, [FIXTURE], {
		timeout: COUNTED_TIMEOUT_MS - 5_000,
		killSignal: "SIGKILL",
	});
	expect(stderr).toBe("");
	cells = JSON.parse(stdout) as WrapperCells;
}, COUNTED_TIMEOUT_MS);

describe("a forwarding wrapper holds no closure per key", () => {
	it("sees a closure and a scope per key in the per-key-closure arm", () => {
		expect(cells.perKeyClosures.Function).toBeGreaterThan(cells.keys / 2);
		expect(cells.perKeyClosures.JSLexicalEnvironment).toBeGreaterThan(cells.keys / 2);
	});

	it("holds no closure and no scope per forwarded key", () => {
		expect(cells.applyToolProxy.Function).toBeLessThan(0.5);
		expect(cells.applyToolProxy.JSLexicalEnvironment).toBeLessThan(0.5);
	});

	it("holds one accessor pair per forwarded key", () => {
		expect(cells.applyToolProxy.GetterSetter).toBe(cells.keys);
	});

	it("keeps no accessor for a symbol key once the symbol is dropped", () => {
		expect(cells.droppedSymbolKeyFunctions).toBeLessThan(0.5);
	});
});
