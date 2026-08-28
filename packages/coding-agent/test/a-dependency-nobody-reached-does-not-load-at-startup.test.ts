/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `slash-commands/helpers/stats-dashboard.ts` held a
 * top-level `import * as stats from "@veyyon/stats"`, and the builtin slash
 * command registry imports that helper, and `main.ts` imports the registry. So
 * every interactive session evaluated the stats aggregator, its SQLite layer,
 * its parser and the embedded dashboard client — 16 MB of resident heap and
 * ~20 ms — to answer a `/stats` nobody typed. Nothing about `/stats` was
 * broken, which is why no functional test could see it.
 *
 * THE CLASS. A dependency reachable only behind a setting, a slash command, a
 * tool, or an input shape must not be in the startup import graph. Members of
 * the same class already shipped correctly and must stay that way: `mupdf`
 * (86 MB, reached when a read hits a PDF), `puppeteer-core` (12 MB, the browser
 * tool), `linkedom` (8.7 MB, web search providers), `@veyyon/mnemopi` (41 MB,
 * `memory.backend: mnemopi`), `@xterm/headless`, `@babel/parser`, and the React
 * renderers used by HTML export.
 *
 * HOW IT FAILS BY DEFAULT. The dependency list is read from
 * `packages/coding-agent/package.json` at run time, the graph is walked from the
 * real CLI entry, and the eager subset is pinned by exact equality. Adding a
 * dependency to the startup graph — directly, or by importing a module that
 * imports it — turns this red until someone records the decision here. Adding a
 * lazily loaded dependency leaves it green.
 *
 * WHY A STATIC WALK. Static reachability decides startup evaluation: `await
 * import(...)` evaluates nothing until it is called. Tracing real evaluation
 * would need a Bun loader plugin, which must return module contents and so
 * re-parses third-party CommonJS as ESM (`handlebars` throws under it), and it
 * would leak into every other file in the test process.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about a module loaded later in a live
 * session, nothing about how much a graph costs, and nothing about a dependency
 * pulled in by a worker entry or a subprocess. A truncated walk would be green
 * for the wrong reason, so the walk asserts its own completeness below.
 */
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { buildStartupImportGraph, declaredDependencies } from "./helpers/startup-import-graph";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "coding-agent", "src", "main.ts");

/**
 * The dependencies the CLI evaluates before it has done anything. Every entry is
 * a decision: it is reached by argument parsing, settings, the model registry,
 * the session store or the TUI, none of which a session can skip.
 */
const EAGER_AT_STARTUP = [
	"@opentelemetry/api",
	"@veyyon/agent-core",
	"@veyyon/ai",
	"@veyyon/catalog",
	"@veyyon/hashline",
	"@veyyon/natives",
	"@veyyon/tui",
	"@veyyon/utils",
	"@veyyon/wire",
	"argot",
	"arktype",
	"chalk",
	"diff",
	"handlebars",
	"lru-cache",
	"marked",
	"smol-toml",
	"yaml",
	"zod",
];

const graph = buildStartupImportGraph(REPO_ROOT, CLI_ENTRY);
const declared = declaredDependencies(REPO_ROOT);

describe("startup import graph", () => {
	test("evaluates exactly the dependencies recorded as unavoidable", () => {
		const eager = declared.filter(dependency => graph.packages.has(dependency));
		expect(eager).toEqual(EAGER_AT_STARTUP);
	});

	test("is complete enough to judge by", () => {
		// A walk that gave up early would report an empty eager set and pass the
		// pin above for the wrong reason. `scanImports` throws on a file whose
		// loader is wrong (a `.ts` file read as `.tsx`, a shebang left in place),
		// and that is exactly how this suite was nearly written green.
		expect(graph.unscannable).toEqual([]);
		expect(graph.files.size).toBeGreaterThan(1_000);
	});

	test("keeps the stats dashboard out of a session that never opens it", () => {
		expect(graph.packages.has("@veyyon/stats")).toBe(false);
	});

	test("keeps every feature behind a setting, a tool or an input shape out", () => {
		const gated = [
			"@veyyon/mnemopi",
			"@babel/parser",
			"@mozilla/readability",
			"@puppeteer/browsers",
			"@xterm/headless",
			"linkedom",
			"mammoth",
			"mupdf",
			"puppeteer-core",
			"react",
			"react-dom",
			"turndown",
		];
		const leaked = gated.filter(dependency => graph.packages.has(dependency));
		expect(leaked).toEqual([]);
	});

	test("pins names that still exist", () => {
		// A dependency renamed or dropped upstream would silently retire its pin.
		const declaredSet = new Set(declared);
		expect(EAGER_AT_STARTUP.filter(dependency => !declaredSet.has(dependency))).toEqual([]);
	});
});
