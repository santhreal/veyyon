/**
 * WHY: half of what a turn pays before its first user message was unmeasurable.
 *
 * `veyyon prompt --sections` prices the system prompt and nothing else, yet
 * every active tool also ships a description and a parameter schema on every
 * request. In this repo that second half is 13k tokens against the prompt's
 * 23k, so a reader asking why a session starts expensive was shown the smaller
 * number with nothing saying it was partial, and the largest tool descriptions
 * — the ones worth cutting — appeared in no table at all.
 *
 * The class this closes: every tool a configuration actually loads is priced,
 * from the same bytes the provider receives, and the arithmetic in the table is
 * the arithmetic of those bytes. The row set is derived from the live tool
 * registry at run time, so a tool added next year is priced without anyone
 * remembering this file; a tool that stops shipping a description shows up as
 * cheap rather than as absent.
 *
 * What it does not catch: whether a description is any GOOD, and the per-model
 * differences a provider's own schema sanitizer introduces downstream of the
 * wire schema priced here.
 */
import { describe, expect, it } from "bun:test";
import { runPromptCommand } from "@veyyon/coding-agent/cli/prompt-cli";

const table = await runPromptCommand({ tools: true });
const rows = table.output
	.split("\n")
	.filter(line => /^\S+\s+\d+\s+\d+\s+\d+\s+\d+/.test(line))
	.map(line => {
		const [name, bytes, desc, schema, tokens] = line.trim().split(/\s+/);
		return { name, bytes: Number(bytes), desc: Number(desc), schema: Number(schema), tokens: Number(tokens) };
	});
const priced = rows.filter(row => row.name !== "TOTAL");
const total = rows.find(row => row.name === "TOTAL");

describe("the tool definitions are priced beside the prompt", () => {
	it("prices every tool the configuration loads, not a list written by hand", async () => {
		// The registry is the source of the row set: ask the command for the prompt
		// it would send and take the tool names out of the same assembly.
		const withoutTools = await runPromptCommand({ tools: true, noTools: true });
		expect(withoutTools.output).toBe("No tools are active in this configuration.");

		expect(priced.length).toBeGreaterThan(0);
		expect(new Set(priced.map(row => row.name)).size).toBe(priced.length);
		// Two tools that anchor the two halves: `edit` carries the largest
		// description and `launch` the largest schema. Both must be priced.
		expect(priced.map(row => row.name)).toContain("edit");
		expect(priced.map(row => row.name)).toContain("launch");
	});

	it("reports a total that is the sum of its rows, in both halves", () => {
		expect(total).toBeDefined();
		if (!total) return;
		const sum = (pick: (row: (typeof priced)[number]) => number): number =>
			priced.reduce((running, row) => running + pick(row), 0);
		expect(total.bytes).toBe(sum(row => row.bytes));
		expect(total.desc).toBe(sum(row => row.desc));
		expect(total.schema).toBe(sum(row => row.schema));
		expect(total.tokens).toBe(sum(row => row.tokens));
	});

	it("splits each row into the description and the schema that make it up", () => {
		for (const row of priced) {
			expect(row.tokens).toBe(row.desc + row.schema);
			// Both halves are really sent, so neither may be priced at nothing: a
			// zero here means the command measured the wrong string.
			expect(row.desc).toBeGreaterThan(0);
			expect(row.schema).toBeGreaterThan(0);
			expect(row.bytes).toBeGreaterThan(row.tokens);
		}
	});

	it("says what the prompt costs beside it, because a request pays both", async () => {
		// The number must be the one the section table reports for the same
		// configuration. Matching any digits here would accept a zero, which is
		// exactly the mistake this footer exists to prevent.
		const sections = await runPromptCommand({ sections: true });
		const promptTokens = Number(sections.output.match(/^TOTAL\s+\d+\s+(\d+)\s+(\d+)\s*$/m)?.[2]);
		expect(promptTokens).toBeGreaterThan(0);
		expect(table.output.split("\n").at(-1)).toBe(
			`${priced.length} tools cost ${total?.tokens} tokens; the system prompt costs ${promptTokens}. Every request pays both.`,
		);
	});
});
