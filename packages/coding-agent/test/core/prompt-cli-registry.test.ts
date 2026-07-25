/**
 * The operator surface over the prompt registry: the list has to be reachable.
 *
 * Owning every prompt in one module is only useful if somebody can see the list.
 * Before the registry, "which prompts does this thing send" was answerable only
 * by grepping for `systemPrompt` and following each template import by hand,
 * which is exactly why an earlier count came out at 23 when the real number was
 * 143.
 *
 * These tests cover the two reads an operator actually performs, list them all
 * and then look at one, plus the failure path between them: a typo in a prompt
 * id must not print an empty description that reads like a prompt with nothing
 * in it.
 */
import { describe, expect, it } from "bun:test";
import { runPromptCommand } from "@veyyon/coding-agent/cli/prompt-cli";
import { PROMPT_IDS, PROMPTS } from "@veyyon/coding-agent/prompts/registry";

describe("listing every prompt", () => {
	it("names every registered prompt", async () => {
		// The whole point of the list is completeness. Asserted against the registry
		// rather than a fixed count, so adding a prompt cannot silently go unlisted.
		const { output, exitCode } = await runPromptCommand({ prompts: true });

		expect(exitCode).toBe(0);
		for (const id of PROMPT_IDS) expect(output, `${id} is missing from the list`).toContain(id);
	});

	it("points at the assembled system prompt, which is inspected rather than described", async () => {
		// `system/system-prompt` is registered like the rest, but the useful view of
		// it is the live assembly with its per-section costs, not the raw template.
		// The list says so, so the one prompt everyone cares about is not the only
		// one you cannot get at from here.
		const { output } = await runPromptCommand({ prompts: true });

		expect(output).toContain("system");
		expect(output).toContain("--sections");
	});

	it("says what each prompt is for", async () => {
		// A list of bare ids answers "what exists" and not "which one do I want".
		const { output } = await runPromptCommand({ prompts: true });

		for (const id of PROMPT_IDS) {
			expect(output, `${id} is listed without saying what it is for`).toContain(PROMPTS[id].purpose);
		}
	});
});

describe("describing one prompt", () => {
	it("reports the subagent prompt's sections and which are optional", async () => {
		// The distinction is what lets a reader tell a subagent that rendered three
		// of five sections from one that lost two.
		const { output, exitCode } = await runPromptCommand({ prompt: "subagent/system-prompt" });

		expect(exitCode).toBe(0);
		expect(output).toContain("role");
		expect(output).toContain("optional");
		expect(output).toContain("packages/coding-agent/src/prompts/subagent/system-prompt.md");
	});

	it("describes a single-region prompt without pretending it has structure", async () => {
		const { output, exitCode } = await runPromptCommand({ prompt: "tools/web-search-system" });

		expect(exitCode).toBe(0);
		expect(output).toContain("body");
	});

	it("fails loudly on an unknown id, saying how ids are formed", async () => {
		// A silent empty description would read as a prompt that legitimately has
		// nothing in it, which is the same silent-failure shape the section
		// override refuses. With 163 prompts, listing them all in the error would
		// bury the answer, so the message states the rule that produces an id
		// instead.
		const { output, exitCode } = await runPromptCommand({ prompt: "system/subagnet-system-prompt" });

		expect(exitCode).toBe(1);
		expect(output).toContain('unknown prompt "system/subagnet-system-prompt"');
		expect(output).toContain("ids are the path under src/prompts without .md");
	});

	it("still inspects the assembled system prompt when asked for it by name", async () => {
		// `--prompt system` must reach the real assembly rather than the registry
		// description, or the default and the explicit spelling would disagree.
		const { output, exitCode } = await runPromptCommand({ prompt: "system", sections: true });

		expect(exitCode).toBe(0);
		expect(output).toContain("conventions");
		expect(output).toContain("TOTAL");
	});
});
