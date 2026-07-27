/**
 * Tool names are named constants, and the places that select tools do not spell them by hand.
 *
 * WHY THIS SUITE EXISTS. A tool name used to be a bare string literal at every site that selected,
 * appended, or compared one: `requestedTools.includes("yield")`, `name === "retain"`, `new
 * Set(["ask", "resolve"])`. That is a class of failure no ordinary test catches, because renaming a
 * tool leaves every literal compiling and simply not matching any more: the code still runs, the
 * session still starts, and the tool is quietly absent. The `yield` handler broke exactly this way.
 *
 * `TOOL` in `src/tools/builtin-names.ts` is the one owner. It is derived from `BUILTIN_TOOL_NAMES`
 * and `HIDDEN_TOOL_NAMES` rather than written out a third time, so a rename removes the key and
 * every consumer stops compiling.
 *
 * The greps below are the durable part. A constant only stays the single owner if new code cannot
 * quietly reintroduce a literal beside it, and the selection sites are large files where a reviewer
 * will not notice one. They read the source rather than exercise behaviour on purpose: what is being
 * locked out is a spelling, and no runtime assertion can see a spelling.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, TOOL } from "@veyyon/coding-agent/tools/builtin-names";

const SRC = join(import.meta.dir, "..", "..", "src");

/** The files that decide WHICH tools a session gets. Each one compared names by hand before. */
const SELECTION_SITES = [
	"tools/index.ts",
	"task/index.ts",
	"sdk.ts",
	"discovery/helpers.ts",
	"session/agent-session.ts",
	"task/subprocess-tool-registry.ts",
] as const;

const ALL_NAMES = [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES];

function read(relative: string): string {
	return readFileSync(join(SRC, relative), "utf-8");
}

/**
 * Occurrences of a bare quoted tool name in VALUE position.
 *
 * Deliberately blind to four things that are not tool-name selection and must keep their literals:
 * a literal TYPE (`toolName: "checkpoint"` inside a type declaration), a settings key (always
 * dotted, e.g. `"todo.enabled"`, so never an exact match), a comment, and a line carrying the
 * `not-a-tool-name:` marker.
 *
 * The marker exists because a handful of strings share a spelling with a tool while naming
 * something else entirely: `"task"` is also an agent id and an async job kind, `"write"` is also an
 * approval tier, `"job"` is also an English word. Silently allowlisting them by pattern would let a
 * real leak in through the same hole, so each one carries a one-line reason a reviewer reads at the
 * site. Adding a marker is the deliberate act; forgetting one fails this suite.
 */
function bareToolNameLiterals(source: string): { line: number; text: string; name: string }[] {
	const found: { line: number; text: string; name: string }[] = [];
	const lines = source.split("\n");
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
		if (line.includes("not-a-tool-name:")) continue;
		for (const name of ALL_NAMES) {
			if (!line.includes(`"${name}"`)) continue;
			// A type-position literal is a property signature or a union member, never a call
			// argument or a comparison. Both spellings below are types, not values.
			if (new RegExp(`toolName: "${name}"`).test(line)) continue;
			if (/^type |^\s*readonly |: "(\w+)" \| "/.test(line)) continue;
			found.push({ line: index + 1, text: line, name });
		}
	}
	return found;
}

describe("the owner", () => {
	/**
	 * `TOOL` is derived, not typed out. If somebody adds a name to one of the two lists and forgets
	 * the map, this fails; there is no third list to keep in step.
	 */
	it("names every built-in and hidden tool exactly once", () => {
		expect(Object.keys(TOOL).sort()).toEqual(ALL_NAMES.slice().sort());
		for (const name of ALL_NAMES) {
			expect(TOOL[name as keyof typeof TOOL]).toBe(name as never);
		}
	});

	/** The two lists are disjoint: a tool is offered by default or it is hidden, never both. */
	it("keeps the built-in and hidden lists disjoint", () => {
		const overlap = BUILTIN_TOOL_NAMES.filter(name => (HIDDEN_TOOL_NAMES as readonly string[]).includes(name));
		expect(overlap).toEqual([]);
	});

	/** The hidden list is the exact set, so a reader can see what is not offered by default. */
	it("lists the five hidden tools", () => {
		expect([...HIDDEN_TOOL_NAMES]).toEqual(["yield", "report_finding", "report_tool_issue", "resolve", "goal"]);
	});
});

describe("the selection sites", () => {
	/**
	 * The regression this suite exists for. Each of these files decides whether a tool is present,
	 * and each used to do it by comparing against a hand-written string.
	 */
	for (const site of SELECTION_SITES) {
		it(`spells no tool name by hand in ${site}`, () => {
			const offenders = bareToolNameLiterals(read(site)).map(hit => `${site}:${hit.line}: ${hit.text}`);
			expect(offenders).toEqual([]);
		});
	}

	/** And the constant is actually reached from each of them, so the check above is not vacuous. */
	for (const site of SELECTION_SITES) {
		it(`imports the owner in ${site}`, () => {
			expect(read(site)).toContain("builtin-names");
		});
	}
});

describe("what the constant must not change", () => {
	/**
	 * `tools/index.ts` is on the CLI boot path and imports no tool implementation: every factory
	 * dynamic-imports its module on first construction, so starting a session does not parse the
	 * browser tool or the LSP client. Naming a tool must stay free, which is why `HIDDEN_TOOL_NAMES`
	 * lives in the leaf and not in this file.
	 */
	it("loads every tool module dynamically and none of them eagerly", () => {
		const source = read("tools/index.ts");
		const registries = source.slice(
			source.indexOf("export const BUILTIN_TOOLS"),
			source.indexOf("export type ToolName"),
		);

		const dynamic = new Set([...registries.matchAll(/await import\("([^"]+)"\)/g)].map(match => match[1]));
		// One per registered tool, minus the pairs that share a module (checkpoint/rewind, the two
		// Argot tools, the three memory tools each having their own).
		expect(dynamic.size).toBeGreaterThanOrEqual(30);
		expect(dynamic.has("./bash")).toBe(true);
		expect(dynamic.has("../lsp")).toBe(true);

		// The contract: a module a factory imports on demand must not also be imported at the top of
		// the file, or the boot path pays for it anyway and the indirection buys nothing. `import
		// type` is erased, so only value imports count.
		const eager = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";$/gm)].map(match => match[1]);
		expect(eager.filter(specifier => dynamic.has(specifier))).toEqual([]);
	});

	/** The leaf itself must not pull a tool module in, or the point above is lost one level down. */
	it("keeps the owner free of tool-module imports", () => {
		const source = read("tools/builtin-names.ts");
		const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]);

		expect(imports).toEqual(["argot"]);
	});

	/**
	 * `subagent.output: "yield"` is a SETTING VALUE that happens to share a spelling with the tool.
	 * It selects how a subagent reports, not which tool exists, and folding the two together would
	 * mean renaming the tool silently changed a user's configuration file.
	 */
	it("leaves the subagent.output yield VALUE a literal", () => {
		const providers = read("config/settings-domains/providers.ts");

		expect(providers).toContain('"yield"');
		expect(providers).not.toContain("TOOL.yield");
	});
});
