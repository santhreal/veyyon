/**
 * WHY THIS SUITE EXISTS:
 *
 * The tool registry used to be one hand-written table in `tools/index.ts`, and splitting the tools
 * into domain directories moved each row next to the tool it constructs. That split can go wrong in
 * exactly three silent ways, and none of them fails a type check:
 *
 *   1. A domain's manifest drops a row the aggregate still declares (or the reverse), so a tool the
 *      model is offered cannot be constructed, or one no domain claims is unreachable.
 *   2. Two domains claim the same name. The later spread wins, so the model calls one tool and gets
 *      the other's implementation.
 *   3. A domain's renderer table draws a name that domain does not contribute, which paints one
 *      tool's card for another tool's result.
 *
 * The sweep derives the domain list from `BUILTIN_TOOL_DOMAINS` at run time, so a sixth domain is
 * covered the moment it is added rather than when someone remembers this file.
 *
 * WHAT IT DOES NOT CATCH: whether a factory constructs the right tool. Each factory is an async
 * dynamic import that reaches a session, and this suite compares identities and key sets rather
 * than constructing thirty-three tools. The renderer check likewise proves a renderer is registered
 * for a name that exists, not that it draws the right thing.
 */
import { describe, expect, it } from "bun:test";
import type { ToolDomainManifest } from "@veyyon/kernel/registry/tool-domain";
import { agentDomain } from "../../src/tools/agent/manifest";
import { agentRenderers } from "../../src/tools/agent/renderers";
import { VIBE_TOOL_NAMES } from "../../src/tools/agent/vibe";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "../../src/tools/core/builtin-names";
import { fsDomain } from "../../src/tools/fs/manifest";
import { fsRenderers } from "../../src/tools/fs/renderers";
import { BUILTIN_TOOL_DOMAINS, BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolFactory } from "../../src/tools/index";
import { toolRenderers } from "../../src/tools/renderers";
import { searchDomain } from "../../src/tools/search/manifest";
import { searchRenderers } from "../../src/tools/search/renderers";
import { shellDomain } from "../../src/tools/shell/manifest";
import { shellRenderers } from "../../src/tools/shell/renderers";
import { webDomain } from "../../src/tools/web/manifest";
import { webRenderers } from "../../src/tools/web/renderers";

/**
 * The renderer table each domain publishes, keyed by the domain name its manifest declares.
 *
 * A domain that draws nothing belongs here with an empty table rather than absent, so the
 * "every domain accounted for" assertion below stays exact.
 */
const DOMAIN_RENDERERS: Readonly<Record<string, Record<string, unknown>>> = {
	fs: fsRenderers,
	search: searchRenderers,
	shell: shellRenderers,
	web: webRenderers,
	agent: agentRenderers,
};

/** The aggregate table, keyed loosely so a name derived at run time can look a renderer up in it. */
const ALL_RENDERERS: Readonly<Record<string, unknown>> = toolRenderers;

/**
 * The tools whose implementation is not a domain directory, so no manifest claims them: the edit
 * tool is the hashline executor, `lsp` and `task` are subsystems, `web_search` is the provider
 * search client, and `goal` is a hidden tool over a view.
 */
const OUTSIDE_ANY_DOMAIN = ["edit", "lsp", "task", "web_search"] as const;
const HIDDEN_OUTSIDE_ANY_DOMAIN = ["goal"] as const;

/**
 * The manifest each domain directory publishes, in the order the aggregate spreads them.
 *
 * Read from the five modules rather than from the aggregate, so a domain whose manifest stops
 * reaching `BUILTIN_TOOL_DOMAINS` — or a sixth that arrives without a renderer table — fails here
 * instead of passing on a list that describes itself.
 */
const DECLARED_DOMAINS = [fsDomain, searchDomain, shellDomain, webDomain, agentDomain];

function rowsOf(manifest: ToolDomainManifest<ToolFactory>): [string, ToolFactory][] {
	return [...Object.entries(manifest.tools), ...Object.entries(manifest.hidden ?? {})];
}

describe("a tool domain declares what it contributes", () => {
	it("sweeps every domain the package ships", () => {
		expect(BUILTIN_TOOL_DOMAINS).toEqual(DECLARED_DOMAINS);
		expect(BUILTIN_TOOL_DOMAINS.map(domain => domain.domain).sort()).toEqual(Object.keys(DOMAIN_RENDERERS).sort());
		for (const manifest of BUILTIN_TOOL_DOMAINS) {
			expect(rowsOf(manifest).length).toBeGreaterThan(0);
		}
	});

	it("partitions the builtin names between the domains and the four outside them", () => {
		const claimed = BUILTIN_TOOL_DOMAINS.flatMap(manifest => Object.keys(manifest.tools));

		expect([...claimed, ...OUTSIDE_ANY_DOMAIN].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
		expect(claimed.length).toBe(new Set(claimed).size);
	});

	it("partitions the hidden names the same way", () => {
		const claimed = BUILTIN_TOOL_DOMAINS.flatMap(manifest => Object.keys(manifest.hidden ?? {}));

		expect([...claimed, ...HIDDEN_OUTSIDE_ANY_DOMAIN].sort()).toEqual([...HIDDEN_TOOL_NAMES].sort());
		expect(claimed.length).toBe(new Set(claimed).size);
	});

	it("registers each domain's own factory, not a copy of it", () => {
		for (const manifest of BUILTIN_TOOL_DOMAINS) {
			for (const [name, factory] of Object.entries(manifest.tools)) {
				expect(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS]).toBe(factory);
			}
			for (const [name, factory] of Object.entries(manifest.hidden ?? {})) {
				expect(HIDDEN_TOOLS[name as keyof typeof HIDDEN_TOOLS]).toBe(factory);
			}
		}
	});

	it("draws its own rows, plus exactly the session-constructed tools it declares", () => {
		const outsideManifest: string[] = [];
		for (const manifest of BUILTIN_TOOL_DOMAINS) {
			const contributed = new Set(rowsOf(manifest).map(([name]) => name));
			const drawn = Object.keys(DOMAIN_RENDERERS[manifest.domain] ?? {});

			outsideManifest.push(...drawn.filter(name => !contributed.has(name)));
			for (const name of drawn) {
				expect(ALL_RENDERERS[name]).toBe(DOMAIN_RENDERERS[manifest.domain]?.[name]);
			}
		}

		// The vibe tools reach a session through `createVibeTools` rather than a manifest, because a
		// subagent never gets them. Their renderers still ship with the domain that constructs them,
		// and this is the whole set: any other renderer for a name no manifest claims fails here.
		expect(outsideManifest.sort()).toEqual([...VIBE_TOOL_NAMES].sort());
	});

	it("renders no name that no tool answers to", () => {
		const known = new Set<string>([
			...BUILTIN_TOOL_NAMES,
			...HIDDEN_TOOL_NAMES,
			...VIBE_TOOL_NAMES,
			// The edit renderer under the name a provider-side patch call arrives as.
			"apply_patch",
		]);

		expect(Object.keys(toolRenderers).filter(name => !known.has(name))).toEqual([]);
	});
});
