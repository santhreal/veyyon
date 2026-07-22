import { describe, expect, it } from "bun:test";
import { AgentParsingError, parseAgent } from "@veyyon/coding-agent/task/agents";

/**
 * parseAgent is the boundary that turns an agent markdown document (frontmatter + body) into the
 * AgentDefinition the runtime dispatches. It splits the frontmatter from the body, runs the frontmatter
 * through parseAgentFields (identity + capability normalization, covered separately), and stitches the
 * remaining body on as the systemPrompt together with the caller-supplied source and filePath. Two
 * contracts had no direct test: a valid document yields a definition whose systemPrompt is exactly the
 * post-frontmatter body (not the whole file, and not including the `---` fence), and a document missing
 * a required field (name/description) throws a typed AgentParsingError rather than returning a
 * half-formed definition that would later dispatch a nameless agent.
 */
describe("parseAgent", () => {
	const VALID = `---
name: scout
description: A scouting agent
tools: read, grep
---
You are a scout.
Find things.`;

	it("assembles a definition from frontmatter fields plus the body as the system prompt", () => {
		const def = parseAgent("embedded:scout.md", VALID, "bundled");
		expect(def.name).toBe("scout");
		expect(def.description).toBe("A scouting agent");
		// parseAgentFields lower-cases and always appends yield to an explicit tool list.
		expect(def.tools).toEqual(["read", "grep", "yield"]);
		expect(def.source).toBe("bundled");
		expect(def.filePath).toBe("embedded:scout.md");
		// systemPrompt is the body only — no frontmatter, no fence.
		expect(def.systemPrompt).toBe("You are a scout.\nFind things.");
	});

	it("throws a typed AgentParsingError when a required field is missing", () => {
		const missingName = `---
description: has no name
---
body text`;
		expect(() => parseAgent("embedded:bad.md", missingName, "bundled")).toThrow(AgentParsingError);
	});

	it("records the offending file path on the AgentParsingError for diagnostics", () => {
		const missingDescription = `---
name: nameonly
---
body`;
		try {
			parseAgent("embedded:nodesc.md", missingDescription, "bundled");
			throw new Error("expected parseAgent to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(AgentParsingError);
			expect((err as AgentParsingError).source).toBe("embedded:nodesc.md");
		}
	});
});
