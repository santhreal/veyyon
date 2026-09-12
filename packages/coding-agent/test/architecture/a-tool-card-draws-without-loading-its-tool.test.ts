/**
 * WHY. A transcript is drawn by a host that never runs a tool: print mode, the HTML export, the
 * collab relay and the GUI each read `tools/view-registry.ts` and nothing else of `tools/`. Two
 * cards broke that by value-importing one constant from the tool beside them, and each constant's
 * module imported the web manifest, which imported the browser, the eval bridge, the task executor,
 * `sdk.ts` and from there the whole terminal: a mode that renders nothing loaded 1647 files and 120
 * `@veyyon/tui` edges instead of 476 and 4. A third card imported a label accessor from the provider
 * registry, whose lazy `import()` table is still an edge, so drawing one search card named every
 * search provider and the stealth scripts the browser page injects.
 *
 * THE CLASS. A card shares a constant, a label or a sentence with the tool that produced what it
 * draws. The shared value belongs in a leaf both import (`search-card-limits.ts`,
 * `web/search/types.ts`) or in the card itself with the tool re-exporting it, never in the tool.
 * Both halves of the rule are stated here: no card value-imports its execution twin (pinned by
 * exact equality, with the one recorded exception), and the registry's whole value closure reaches
 * no manifest, no entrypoint and no terminal component.
 *
 * NOT CAUGHT. A card that reaches an execution module through a helper that is neither its twin
 * nor on the heavy list (`todo-view.ts -> todo.ts` reads the tool's own text helpers and is the
 * recorded row). A type-only edge, which is erased and is not a load. A tool that grows a heavy
 * import is caught only once a card reaches it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRelative, resolveSpecifier, valueImportSpecifiers } from "./helpers/module-graph";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const TOOLS = path.join(SRC, "tools");
const REGISTRY = path.join(TOOLS, "view-registry.ts");

/** Every `.ts` file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** A card file's execution twin: `x-view.ts` beside `x.ts`, or a directory's `view.ts` beside its `index.ts`. */
function executionTwin(card: string): string | undefined {
	const dir = path.dirname(card);
	const base = path.basename(card);
	const twin = base === "view.ts" ? path.join(dir, "index.ts") : path.join(dir, base.replace(/-view\.ts$/, ".ts"));
	return fs.existsSync(twin) ? twin : undefined;
}

/** Files the value closure of `root` loads, by the walker the print-mode ledger uses. */
function valueClosure(root: string): Set<string> {
	const files = new Set<string>();
	const pending = [root];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || files.has(file)) continue;
		files.add(file);
		for (const specifier of valueImportSpecifiers(file)) {
			const target = resolveSpecifier(file, specifier);
			if (target !== undefined) pending.push(target);
		}
	}
	return files;
}

/** Modules a card must never load: a tool domain's manifest, an entrypoint, a terminal component. */
function isExecutionSurface(file: string): boolean {
	const rel = path.relative(SRC, file).split(path.sep).join("/");
	return (
		/^tools\/[^/]+\/manifest\.ts$/.test(rel) ||
		rel === "sdk.ts" ||
		rel === "main.ts" ||
		rel === "index.ts" ||
		rel === "cli.ts" ||
		rel.startsWith("modes/terminal/components/") ||
		rel.startsWith("session/agent-session")
	);
}

describe("a tool card draws without loading its tool", () => {
	const cards = filesUnder(TOOLS)
		.filter(file => file.endsWith("-view.ts") || path.basename(file) === "view.ts")
		.sort();

	/**
	 * The one card that value-imports its twin. `todo.ts` is the owner of the task text helpers
	 * (`todoStrikeSplit`, `boundedTodoPreviewText`, the preview widths) and imports no manifest, so
	 * the row is recorded rather than cut. Shrink-only: a row leaves when the edge is cut, and a new
	 * card reaching its tool reds this.
	 */
	const TWIN_EDGES = ["packages/coding-agent/src/tools/agent/todo-view.ts -> ./todo"];

	it("enumerates the cards from the tree and finds a twin for most of them", () => {
		expect(cards.length).toBeGreaterThan(20);
		expect(cards.filter(card => executionTwin(card) !== undefined).length).toBeGreaterThan(20);
	});

	it("value-imports its execution twin from no card but the recorded one", () => {
		const rows: string[] = [];
		for (const card of cards) {
			const twin = executionTwin(card);
			if (twin === undefined) continue;
			for (const specifier of valueImportSpecifiers(card)) {
				if (resolveSpecifier(card, specifier) === twin) rows.push(`${repoRelative(card)} -> ${specifier}`);
			}
		}
		expect(rows.sort()).toEqual(TWIN_EDGES);
	});

	/**
	 * Anti-vacuity for the closure walk: the tool dispatch table reaches every manifest through its
	 * lazy `import()` rows, and the walker counts those, so an empty result below is a fact about the
	 * registry rather than about the reader.
	 */
	it("walks a graph in which the dispatch table does reach a manifest", () => {
		const reached = [...valueClosure(path.join(TOOLS, "index.ts"))].filter(isExecutionSurface);
		expect(reached.some(file => /\/tools\/[^/]+\/manifest\.ts$/.test(file))).toBe(true);
	});

	it("reaches no manifest, entrypoint, session runtime or terminal component from the view registry", () => {
		const closure = valueClosure(REGISTRY);
		expect(closure.size).toBeGreaterThan(40);
		expect([...closure].filter(isExecutionSurface).map(repoRelative).sort()).toEqual([]);
	});

	it("names the TUI package nowhere in the view registry's closure", () => {
		const edges: string[] = [];
		for (const file of valueClosure(REGISTRY)) {
			for (const specifier of valueImportSpecifiers(file)) {
				if (specifier.startsWith("@veyyon/tui")) edges.push(`${repoRelative(file)} -> ${specifier}`);
			}
		}
		expect(edges.sort()).toEqual([]);
	});
});
