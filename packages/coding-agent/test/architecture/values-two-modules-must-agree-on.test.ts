/**
 * Values where one module produces and another matches, each of which was declared twice.
 *
 * Why these are grouped: they are one failure shape, not one subject. In every case below a value crosses a
 * module boundary and both sides had their own copy of it, so a drift does not raise anything. The producer
 * keeps producing, the matcher stops matching, and the feature quietly does nothing.
 *
 *   - `__isToolDefinition`, stamped by the legacy shim and read by `sdk.ts`. A miss means an already-converted
 *     tool is converted twice, which scrambles the order of the arguments `execute()` receives.
 *   - `local://PLAN.md`, reported by the ACP agent and matched by plan protection. A miss means plan mode says
 *     it is protecting the plan file while an edit to that exact path is allowed through.
 *   - The MCP protocol revision, sent by both the MCP client and the Z.ai search provider. A server answers a
 *     revision it does not know with the one it does, so a stale copy negotiates a silent downgrade.
 *   - `web_search`, Anthropic's server-side tool, declared by the search provider that asks for it and the
 *     provider that matches the blocks it returns. A miss means the search runs and nothing renders.
 *
 * Each now has one owner, and each owner is a leaf so importing it costs one module.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ANTHROPIC_WEB_SEARCH_TOOL } from "@veyyon/catalog/wire/anthropic";
import { LEGACY_TOOL_DEFINITION_MARKER } from "@veyyon/coding-agent/extensibility/legacy-tool-marker";
import { MCP_PROTOCOL_VERSION } from "@veyyon/coding-agent/mcp/protocol-version";
import { MAIN_CALL_SIGN } from "@veyyon/coding-agent/modes/components/agent-activity";
import { DEFAULT_PLAN_FILE_URL } from "@veyyon/coding-agent/plan-mode/plan-file-url";
import { MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

const SRC = path.resolve(import.meta.dir, "../../src");
const AI_SRC = path.resolve(import.meta.dir, "../../../ai/src");
const CATALOG_SRC = path.resolve(import.meta.dir, "../../../catalog/src");

describe("the legacy tool-definition marker", () => {
	/** The exact property name, since it is set with `defineProperty` and read by index. */
	it("names the marker property", () => {
		expect(LEGACY_TOOL_DEFINITION_MARKER).toBe("__isToolDefinition");
	});

	/**
	 * Locks out: the legacy shim stamping a string it spells itself, so an already-converted tool is
	 * converted twice and the order of the arguments `execute()` receives is scrambled.
	 *
	 * The tree-wide literal scan below forbids `"__isToolDefinition"` anywhere but the owner, with one
	 * exemption: `sdk.ts`'s `Symbol("__isToolDefinition")`, which is a deliberately DIFFERENT key (a
	 * symbol cannot collide with a property a user put on their own tool). So what is left to state
	 * here is that the shim names the owner rather than carrying its own copy.
	 *
	 * What used to be here instead was three searches of `sdk.ts` and the shim for exact expressions,
	 * including `marked[TOOL_DEFINITION_MARKER] !== true && marked[LEGACY_TOOL_DEFINITION_MARKER] !== true`.
	 * That passes with the condition inverted and fails when a local is renamed, which is the wrong way
	 * round on both counts.
	 */
	it("is stamped by the shim from the owner", () => {
		const shim = path.join(SRC, "extensibility/legacy-pi-coding-agent-shim.ts");

		expect(moduleSpecifiersIn(fs.readFileSync(shim, "utf-8"))).toContain("./legacy-tool-marker");
	});
});

describe("the default plan file URL", () => {
	/** The exact address, scheme included. */
	it("addresses the plan file under the local scheme", () => {
		expect(DEFAULT_PLAN_FILE_URL).toBe("local://PLAN.md");
		expect(DEFAULT_PLAN_FILE_URL.startsWith("local://")).toBeTrue();
	});

	/**
	 * It is a session-relative URL and not a filesystem path, which is what the scheme is for: resolving it as
	 * a path would look for a directory called `local:` .
	 */
	it("is not a filesystem path", () => {
		expect(path.isAbsolute(DEFAULT_PLAN_FILE_URL)).toBeFalse();
		expect(DEFAULT_PLAN_FILE_URL).toContain("://");
	});

	/**
	 * Locks out: the producer or the matcher keeping its own copy of the URL, so plan mode reports that
	 * it is protecting the plan file while an edit to that exact path is allowed through.
	 *
	 * The tree-wide literal scan forbids the bytes outside the owner; this states the other half, that
	 * both sides still name the owner. It used to assert two exact statements of code
	 * (`planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,`), which pins how the value is
	 * spelled at one call site and says nothing about whether it is the same value.
	 */
	it("is read by the ACP agent and by plan protection", () => {
		for (const [file, specifier] of [
			["modes/acp/acp-agent.ts", "../../plan-mode/plan-file-url"],
			["plan-mode/plan-protection.ts", "./plan-file-url"],
		] as const) {
			expect(moduleSpecifiersIn(fs.readFileSync(path.join(SRC, file), "utf-8")), file).toContain(specifier);
		}
	});
});

describe("the MCP protocol revision", () => {
	/** The revision, as a date string, which is how MCP versions its protocol. */
	it("declares a dated revision", () => {
		expect(MCP_PROTOCOL_VERSION).toBe("2025-03-26");
		expect(MCP_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// A real date, not a string that merely looks like one.
		expect(new Date(`${MCP_PROTOCOL_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(MCP_PROTOCOL_VERSION);
	});

	/**
	 * Locks out: one of the two MCP speakers keeping its own copy of the revision, which negotiates a
	 * silent protocol downgrade against a server that answers an unknown revision with its own.
	 *
	 * The tree-wide literal scan above already forbids the bytes outside the owner. What is left to
	 * state here is that both speakers really do NAME the owner, so neither has dropped the import and
	 * started sending something else.
	 */
	it("is sent by both MCP speakers from the one owner", () => {
		for (const [file, specifier] of [
			["mcp/client.ts", "./protocol-version"],
			["web/search/providers/zai.ts", "../../../mcp/protocol-version"],
		] as const) {
			expect(moduleSpecifiersIn(fs.readFileSync(path.join(SRC, file), "utf-8")), file).toContain(specifier);
		}
	});
});

describe("Anthropic's web-search tool name", () => {
	/** The wire name, which Anthropic decides and both packages must spell identically. */
	it("names the server-side search tool", () => {
		expect(ANTHROPIC_WEB_SEARCH_TOOL).toBe("web_search");
	});

	/** The asker and the matcher read one declaration, across two packages. */
	it("is read by the provider that asks and the one that matches", async () => {
		const search = await Bun.file(path.join(SRC, "web/search/providers/anthropic.ts")).text();
		const provider = await Bun.file(path.join(AI_SRC, "providers/anthropic.ts")).text();
		expect(search).toContain("name: ANTHROPIC_WEB_SEARCH_TOOL,");
		expect(search).toContain("stripClaudeToolPrefix(block.name) === ANTHROPIC_WEB_SEARCH_TOOL");
		expect(provider).toContain("name.toLowerCase() === ANTHROPIC_WEB_SEARCH_TOOL");
		for (const text of [search, provider])
			expect(moduleSpecifiersIn(text)).toContain("@veyyon/catalog/wire/anthropic");
	});
});

describe("each value is declared once", () => {
	const OWNERS = new Set([
		path.join(SRC, "extensibility/legacy-tool-marker.ts"),
		path.join(SRC, "plan-mode/plan-file-url.ts"),
		path.join(SRC, "mcp/protocol-version.ts"),
		path.join(CATALOG_SRC, "wire/anthropic.ts"),
	]);

	async function sources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
		const collected: Array<{ file: string; text: string }> = [];
		for (const root of [SRC, AI_SRC, CATALOG_SRC]) {
			for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
				const full = path.join(root, file);
				if (OWNERS.has(full)) continue;
				// In-source test directories are fixtures, not declarations of where a value comes from.
				if (file.includes("__tests__")) continue;
				collected.push({ file: path.relative(path.join(SRC, "../.."), full), text: await Bun.file(full).text() });
			}
		}
		return collected;
	}

	/**
	 * The ratchet, keyed on each literal ANYWHERE a string can appear, not only on a named declaration.
	 *
	 * The narrower form is what let a copy hide: `session/agent-session.ts` spelled `local://PLAN.md` four
	 * times, as a field initializer, as a `||` fallback, as a local, and again in a reset, and none of those is
	 * a `const NAME = "..."`. It was the module that DECIDES the value, so it had the most copies of all.
	 *
	 * `sdk.ts`'s `Symbol("__isToolDefinition")` is exempted by name below, since it is a deliberately different
	 * property key and not a copy of the string.
	 */
	it("spells none of the three tree-wide values outside its owner", async () => {
		const values = [LEGACY_TOOL_DEFINITION_MARKER, DEFAULT_PLAN_FILE_URL, MCP_PROTOCOL_VERSION];
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			for (const value of values) {
				const quoted = `"${value}"`;
				if (!text.includes(quoted)) continue;
				if (value === LEGACY_TOOL_DEFINITION_MARKER && text.includes(`Symbol(${quoted})`)) {
					// The sdk's symbol marker, which is the one deliberate second use of these bytes.
					const withoutSymbol = text.split(`Symbol(${quoted})`).join("");
					if (!withoutSymbol.includes(quoted)) continue;
				}
				offenders.push(`${file} spells ${value}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * `web_search` is ratcheted only across the modules that speak ANTHROPIC's protocol, and that limit is the
	 * interesting part of this suite.
	 *
	 * The same eight bytes appear elsewhere and mean different things, so a tree-wide scan for them would be
	 * wrong rather than merely noisy. `tools/builtin-names.ts` lists veyyon's OWN tool called `web_search`, the
	 * one the model calls; `ai/providers/openai-responses-wire.ts` has it as a member of an OpenAI wire type
	 * union, beside `web_search_2025_08_26`; `web/search/providers/xai.ts` and `.../codex.ts` each name their
	 * own vendor's server tool. Folding those into one constant would assert that four independent vendors and
	 * veyyon's own tool registry change together, and the day one of them renamed its tool the others would
	 * silently follow.
	 *
	 * What has to agree is narrower: the module that ASKS Anthropic for the tool and the module that MATCHES
	 * the blocks Anthropic returns.
	 */
	it("spells Anthropic's tool name only through the owner in the two modules that must agree", async () => {
		const speakers = [
			path.join(SRC, "web/search/providers/anthropic.ts"),
			path.join(AI_SRC, "providers/anthropic.ts"),
		];
		for (const file of speakers) {
			const text = await Bun.file(file).text();
			expect(text, file).toContain("ANTHROPIC_WEB_SEARCH_TOOL");
			expect(text, file).not.toContain(`"${ANTHROPIC_WEB_SEARCH_TOOL}"`);
		}
	});

	/**
	 * And the values that legitimately share those bytes are still there, asserted so the exemption above reads
	 * as a decision about four different contracts rather than as something overlooked.
	 */
	it("leaves the other vendors' identical tool names alone", async () => {
		const others: ReadonlyArray<[string, string]> = [
			[path.join(SRC, "tools/builtin-names.ts"), "veyyon's own tool"],
			[path.join(AI_SRC, "providers/openai-responses-wire.ts"), "OpenAI's wire type"],
			[path.join(SRC, "web/search/providers/xai.ts"), "xAI's server tool"],
		];
		for (const [file, what] of others) {
			const text = await Bun.file(file).text();
			expect(text, what).toContain(`"${ANTHROPIC_WEB_SEARCH_TOOL}"`);
			expect(text, what).not.toContain("ANTHROPIC_WEB_SEARCH_TOOL");
		}
	});

	/** Nor under one of the names the copies used. */
	it("declares none of the retired names", async () => {
		const retired = [
			"TOOL_DEFINITION_MARKER",
			"LOCAL_PLAN_ALIAS",
			"PROTOCOL_VERSION",
			"ZAI_MCP_PROTOCOL_VERSION",
			"WEB_SEARCH_TOOL_NAME",
			"UMANS_WEBSEARCH_TOOL_NAME",
		];
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			for (const name of retired) {
				// `sdk.ts` keeps `TOOL_DEFINITION_MARKER` for its symbol, which is a different key on purpose.
				if (name === "TOOL_DEFINITION_MARKER" && file.endsWith("coding-agent/src/sdk.ts")) continue;
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/** The non-vacuity twin: the scan reaches all three package trees and every module that held a copy. */
	it("scans all three packages including every former declarer", async () => {
		const files = (await sources()).map(entry => entry.file);
		expect(files.length).toBeGreaterThan(500);
		for (const declarer of [
			"coding-agent/src/sdk.ts",
			"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
			"coding-agent/src/modes/acp/acp-agent.ts",
			"coding-agent/src/plan-mode/plan-protection.ts",
			"coding-agent/src/session/agent-session.ts",
			"coding-agent/src/mcp/client.ts",
			"coding-agent/src/web/search/providers/zai.ts",
			"coding-agent/src/web/search/providers/anthropic.ts",
			"ai/src/providers/anthropic.ts",
		]) {
			expect(files).toContain(declarer);
		}
	});

	/**
	 * `"Main"` IS DECLARED TWICE ON PURPOSE, and this case is the record of that decision so the next scan
	 * does not refile it.
	 *
	 * `registry/agent-registry.ts` declares `MAIN_AGENT_ID`, the key the agent registry stores the driving
	 * session under. `modes/components/agent-activity.ts` declares `MAIN_CALL_SIGN`, the label a person reads
	 * in the Agent Hub and the dashboard. They share five bytes and nothing else: `agent-activity.ts` imports
	 * BOTH and maps one to the other explicitly (`if (ref.id === MAIN_AGENT_ID) callSign = MAIN_CALL_SIGN`),
	 * which is precisely the seam that lets them differ.
	 *
	 * Folding them would assert that renaming the label renames a registry key, and the label is UI text: it
	 * is rendered into a sentence in the dashboard's own help line. A registry key is not free to change with
	 * it, since parked agents are revived by id from disk.
	 */
	it("keeps the agent registry key and the displayed call sign apart", () => {
		expect(MAIN_AGENT_ID).toBe("Main");
		expect(MAIN_CALL_SIGN).toBe("Main");
		// The seam, as an IMPORT rather than as a search for one exact line of code: the UI module reads
		// the registry key and assigns its own label, so the two are free to diverge. The regex this
		// replaced (`ref.id === MAIN_AGENT_ID[\s\S]{0,120}callSign = MAIN_CALL_SIGN`) pinned 120
		// characters of unrelated statement layout and would have gone red on a reformat.
		expect(
			moduleSpecifiersIn(fs.readFileSync(path.join(SRC, "modes/components/agent-activity.ts"), "utf-8")),
		).toContain("../../registry/agent-registry");
	});

	/**
	 * Locks out: an owner growing an import, which is what makes importing it cheaper than retyping the
	 * value and is the entire reason these constants were centralised rather than left duplicated.
	 *
	 * Asserted through the import-graph walk rather than by regexing the file for `^\s*import`, which
	 * matched the word inside a doc comment and missed `export * from` entirely.
	 */
	it("has leaf owners", () => {
		for (const owner of OWNERS) {
			expect(moduleSpecifiersIn(fs.readFileSync(owner, "utf-8")), owner).toEqual([]);
		}
	});
});
