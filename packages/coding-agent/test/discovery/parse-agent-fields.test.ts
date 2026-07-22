import { describe, expect, it } from "bun:test";
import { parseAgentFields } from "@veyyon/coding-agent/discovery/helpers";
import { parseConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";

/**
 * parseAgentFields turns raw agent frontmatter (from a bundled `.md`, a discovered project agent, or a
 * foreign tool's config) into the validated ParsedAgentFields shape every agent loader relies on. It is
 * the single normalization point for an agent's identity and capabilities, and several of its rules are
 * load-bearing yet were previously unasserted:
 *   - a missing or non-string `name`/`description` makes the whole definition invalid (returns null), so
 *     the loader rejects it instead of registering a half-formed agent;
 *   - tool names are lower-cased, legacy-aliased (search->grep, find->glob) and de-duplicated, and an
 *     explicit tool list always gains `yield` (a subagent with a fixed toolset must still be able to
 *     return control);
 *   - `spawns` accepts the literal "*", a CSV string, or an array, and is inferred to "*" when the tools
 *     include `task` (backward compatibility with older agents that only declared the tool);
 *   - `thinkingLevel` falls back to the legacy `thinking` key; booleans accept "true"/"false" strings.
 * A regression in any of these silently changes which tools an agent gets, whether it can spawn, or
 * whether an invalid agent loads, so each rule gets a direct assertion here.
 */
describe("parseAgentFields identity validation", () => {
	it("returns null when name is missing, so an unnamed agent never registers", () => {
		expect(parseAgentFields({ description: "d" })).toBeNull();
	});

	it("returns null when description is missing", () => {
		expect(parseAgentFields({ name: "n" })).toBeNull();
	});

	it("returns null when name is present but not a string (a non-string is not a valid identity)", () => {
		expect(parseAgentFields({ name: 5, description: "d" })).toBeNull();
	});

	it("accepts a minimal name+description and leaves every optional capability undefined", () => {
		const fields = parseAgentFields({ name: "n", description: "d" });
		expect(fields).not.toBeNull();
		expect(fields?.name).toBe("n");
		expect(fields?.description).toBe("d");
		expect(fields?.tools).toBeUndefined();
		expect(fields?.spawns).toBeUndefined();
		expect(fields?.model).toBeUndefined();
		expect(fields?.thinkingLevel).toBeUndefined();
		expect(fields?.blocking).toBeUndefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});
});

describe("parseAgentFields tools normalization", () => {
	it("lower-cases, applies legacy aliases (search->grep, find->glob), and always appends yield", () => {
		const fields = parseAgentFields({ name: "n", description: "d", tools: "Read, search, find" });
		expect(fields?.tools).toEqual(["read", "grep", "glob", "yield"]);
	});

	it("de-duplicates case-insensitively while preserving first-seen order and keeps a single yield", () => {
		const fields = parseAgentFields({ name: "n", description: "d", tools: ["Read", "read", "yield"] });
		expect(fields?.tools).toEqual(["read", "yield"]);
	});
});

describe("parseAgentFields spawns resolution", () => {
	it('infers spawns "*" when the tools include task, even with no explicit spawns', () => {
		expect(parseAgentFields({ name: "n", description: "d", tools: "task" })?.spawns).toBe("*");
	});

	it("passes the literal wildcard through", () => {
		expect(parseAgentFields({ name: "n", description: "d", spawns: "*" })?.spawns).toBe("*");
	});

	it("parses a CSV spawns string into a trimmed array", () => {
		expect(parseAgentFields({ name: "n", description: "d", spawns: "a, b" })?.spawns).toEqual(["a", "b"]);
	});

	it("passes a spawns array through", () => {
		expect(parseAgentFields({ name: "n", description: "d", spawns: ["x", "y"] })?.spawns).toEqual(["x", "y"]);
	});
});

describe("parseAgentFields scalar and list fields", () => {
	it("parses a CSV model list into a prioritized array preserving order", () => {
		expect(parseAgentFields({ name: "n", description: "d", model: "gpt, @task" })?.model).toEqual(["gpt", "@task"]);
	});

	it("falls back from the missing thinkingLevel to the legacy thinking key", () => {
		const high = parseConfiguredThinkingLevel("high");
		expect(high).toBeDefined();
		expect(parseAgentFields({ name: "n", description: "d", thinking: "high" })?.thinkingLevel).toBe(high);
	});

	it("reads a boolean from a case-insensitive string for blocking", () => {
		expect(parseAgentFields({ name: "n", description: "d", blocking: "TRUE" })?.blocking).toBe(true);
	});

	it("keeps an explicit false readSummarize (does not coerce it to undefined)", () => {
		expect(parseAgentFields({ name: "n", description: "d", readSummarize: false })?.readSummarize).toBe(false);
	});

	it("trims autoloadSkills entries and drops empty ones", () => {
		expect(parseAgentFields({ name: "n", description: "d", autoloadSkills: " a , , b " })?.autoloadSkills).toEqual([
			"a",
			"b",
		]);
	});
});
