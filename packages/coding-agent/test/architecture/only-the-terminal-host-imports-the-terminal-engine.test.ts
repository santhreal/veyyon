/**
 * WHY: `@veyyon/tui` is the TERMINAL host's rendering engine, and it is now
 * `hosts/terminal/engine` in the tree. A module outside the terminal host that
 * names it is a module a second host cannot reuse: a GUI attaching to this engine
 * has to either link a terminal renderer or fork the module.
 *
 * The defect class: a tool, a picker, a debug surface or a theme helper reaches
 * for a `Component` because that is what the terminal wanted, and the reach is
 * invisible - nothing fails, the module keeps working, and the count of modules a
 * GUI cannot reuse goes up by one.
 *
 * The ledger is SHRINK-ONLY and pinned by exact equality, never by a count: a row
 * leaves when its import is cut, and a new row is a red test, not an edit. The
 * two numbers at the bottom are the measured size of the remaining work.
 *
 * Runtime and type-only edges are separate claims. A type edge is erased at
 * runtime and blocks no front end; a runtime edge puts the terminal renderer in
 * the module's graph, so a host that draws no terminal still loads it.
 *
 * WHAT IT DOES NOT CATCH: a module that reaches the engine indirectly through a
 * sibling already on the ledger, and a module that copies a rendering concern
 * instead of importing one. `session-does-not-import-the-ui.test.ts` covers the
 * conversation engine's own graph and print mode's; this covers the whole package
 * outside the terminal host.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn, typeOnlyModuleSpecifiersIn } from "@veyyon/utils/module-reach";

const SRC = path.join(import.meta.dir, "..", "..", "src");

/** Every shipped module under `src/`, excluding the terminal host and test files. */
function modulesOutsideTheTerminalHost(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(SRC, full).replace(/\\/g, "/");
			if (entry.isDirectory()) {
				if (rel === "modes/terminal" || entry.name === "node_modules" || entry.name === "__tests__") continue;
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
			if (entry.name.endsWith(".d.ts") || entry.name.includes(".test.")) continue;
			out.push(rel);
		}
	};
	walk(SRC);
	return out.sort();
}

/** Modules naming the engine package, as `src`-relative paths. */
function enginePackageImporters(kind: "any" | "runtime"): string[] {
	const out: string[] = [];
	for (const rel of modulesOutsideTheTerminalHost()) {
		const source = fs.readFileSync(path.join(SRC, rel), "utf-8");
		const erased = new Set(typeOnlyModuleSpecifiersIn(source));
		const reaching = moduleSpecifiersIn(source).filter(specifier => specifier.startsWith("@veyyon/tui"));
		if (reaching.length === 0) continue;
		if (kind === "runtime" && reaching.every(specifier => erased.has(specifier))) continue;
		out.push(rel);
	}
	return out;
}

/**
 * Every module outside the terminal host that names the engine package, runtime or
 * type-only. Shrink-only.
 */
const ENGINE_IMPORTERS = [
	"autoresearch/dashboard.ts",
	"cli/rollback-picker-host.ts",
	"cli/session-picker.ts",
	"cli/setup-model-picker.ts",
	"commit/agentic/agent.ts",
	"debug/index.ts",
	"debug/protocol-probe.ts",
	"debug/raw-sse.ts",
	"debug/terminal-info.ts",
	"extensibility/legacy-pi-coding-agent-shim.ts",
	"extensibility/legacy-pi-tui-shim.ts",
	"index.ts",
	"lsp/render.ts",
	"slash-commands/builtin-registry.ts",
	"slash-commands/helpers/secret.ts",
	"task/render.ts",
	"theme/theme-class.ts",
	"theme/theme.ts",
	"tools/ask-render.ts",
	"tools/ast-edit-render.ts",
	"tools/bash-render.ts",
	"tools/browser/render.ts",
	"tools/debug-render.ts",
	"tools/eval-render.ts",
	"tools/fetch-render.ts",
	"tools/file-search-render.ts",
	"tools/gh-renderer.ts",
	"tools/inspect-image-renderer.ts",
	"tools/job-render.ts",
	"tools/launch-render.ts",
	"tools/memory-render.ts",
	"tools/read-render.ts",
	"tools/resolve-render.ts",
	"tools/review.ts",
	"tools/search-renderer.ts",
	"tools/search-tool-bm25-render.ts",
	"tools/set-cwd-render.ts",
	"tools/structure-search-render.ts",
	"tools/text-search-render.ts",
	"tools/todo-render.ts",
	"tools/vibe-render.ts",
	"tui/code-cell.ts",
	"tui/draw-tool-view.ts",
	"tui/hyperlink.ts",
	"tui/output-block.ts",
	"tui/width-aware-text.ts",
	"web/search/render.ts",
];

/**
 * The subset whose edge is a runtime one, so the engine sits in their graph. This
 * is the number that costs a second host something.
 */
const RUNTIME_ENGINE_IMPORTERS = [
	"autoresearch/dashboard.ts",
	"cli/rollback-picker-host.ts",
	"cli/session-picker.ts",
	"cli/setup-model-picker.ts",
	"commit/agentic/agent.ts",
	"debug/index.ts",
	"debug/protocol-probe.ts",
	"debug/raw-sse.ts",
	"debug/terminal-info.ts",
	"extensibility/legacy-pi-coding-agent-shim.ts",
	"extensibility/legacy-pi-tui-shim.ts",
	"index.ts",
	"lsp/render.ts",
	"slash-commands/builtin-registry.ts",
	"slash-commands/helpers/secret.ts",
	"theme/theme-class.ts",
	"tools/ask-render.ts",
	"tools/debug-render.ts",
	"tools/fetch-render.ts",
	"tools/gh-renderer.ts",
	"tui/code-cell.ts",
	"tui/draw-tool-view.ts",
	"tui/hyperlink.ts",
	"tui/width-aware-text.ts",
];

describe("only the terminal host imports the terminal engine", () => {
	/**
	 * Anti-vacuity. Every case below is an equality against a list this walker
	 * produces, so a walker that read nothing would pass an empty ledger. Both
	 * positive controls really do import the package.
	 */
	it("reads the package and does find engine imports where they exist", () => {
		expect(modulesOutsideTheTerminalHost().length).toBeGreaterThan(400);
		expect(modulesOutsideTheTerminalHost().some(rel => rel.startsWith("modes/terminal/"))).toBe(false);
		expect(enginePackageImporters("any")).toContain("task/render.ts");
		expect(enginePackageImporters("runtime")).toContain("theme/theme-class.ts");
	});

	it("names the engine package only where recorded", () => {
		expect(enginePackageImporters("any")).toEqual(ENGINE_IMPORTERS);
	});

	it("instantiates the engine package only where recorded", () => {
		expect(enginePackageImporters("runtime")).toEqual(RUNTIME_ENGINE_IMPORTERS);
	});

	/**
	 * The ratchet. Cutting an edge never fails a test; adding one does, in both the
	 * ledger above and the ceiling here.
	 */
	it("does not grow the count of modules a second host cannot reuse", () => {
		expect(enginePackageImporters("any").length).toBeLessThanOrEqual(47);
		expect(enginePackageImporters("runtime").length).toBeLessThanOrEqual(24);
	});
});
