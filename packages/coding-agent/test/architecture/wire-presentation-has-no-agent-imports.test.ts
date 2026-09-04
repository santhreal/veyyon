/**
 * WHY: the presentation contract is the boundary between the agent runtime and
 * whatever draws it, and it only works in one direction. A `TranscriptBlock`
 * that carries an `AgentMessage`, a `ToolResultMessage`, a provider payload or a
 * `Model` stops being a view-model and becomes a window into the runtime: a
 * browser client would need the whole agent to render a line of text, and a
 * change to a provider's message shape would break every renderer.
 *
 * The defect class is a type import added for expedience — "it is only a type" —
 * which is exactly how the boundary was lost before it existed. Type-only or
 * not, the edge is in the graph and the declaration file is required to build.
 *
 * What it does NOT catch: a field whose *shape* mirrors a runtime type without
 * importing it. That is a design review, not a graph rule.
 */

import { describe, expect, test } from "bun:test";
import { forbiddenEdges, isDirectory, repoPath, typeScriptFiles } from "./helpers/module-graph";

const PRESENTATION = repoPath("contracts/wire/src/presentation");

/** Runtime packages whose types must not cross into the contract. */
const RUNTIME_PACKAGES = [
	"@veyyon/agent-core",
	"@veyyon/ai",
	"@veyyon/catalog",
	"@veyyon/coding-agent",
	"@veyyon/mnemopi",
];

function isRuntimeImport(specifier: string): boolean {
	if (RUNTIME_PACKAGES.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) return true;
	// A relative escape out of the wire package reaches whatever is beside it,
	// including the session; the contract has no business outside its own tree.
	return specifier.includes("../../../");
}

describe("the presentation contract does not depend on the agent runtime", () => {
	test("the directory exists and holds modules to check", () => {
		expect(isDirectory(PRESENTATION)).toBe(true);
		expect(typeScriptFiles(PRESENTATION).length).toBeGreaterThan(4);
	});

	test("no file imports an agent runtime package, type-only or otherwise", () => {
		expect(forbiddenEdges(PRESENTATION, isRuntimeImport)).toEqual([]);
	});

	test("no file reaches the coding-agent session by relative path", () => {
		expect(forbiddenEdges(PRESENTATION, specifier => specifier.includes("session/"))).toEqual([]);
	});
});
