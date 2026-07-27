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
 *
 * AND IT SPANS EVERY REGISTRY. A package owns its own prompts, so there is one registry
 * per package that ships them, and this command showed one of the four: the compaction
 * prompts that rewrite a session's entire history were absent, so was every dialect
 * format guide that teaches a model to write a tool call, and so was the hashline patch
 * language. A list that looks complete and is not is worse than no list, so completeness
 * is asserted against every registry rather than the coding agent's.
 *
 * NO DIRECTORY IS SPELLED OUT HERE. Each registry states its own, once, and this suite
 * reads it off the descriptor. Four consumers used to restate all four paths and one of
 * them had already gone stale, which is the same defect one level up from the one the
 * registry replaced.
 */
import { describe, expect, it } from "bun:test";
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { runPromptCommand } from "@veyyon/coding-agent/cli/prompt-cli";
import { codingAgentPrompts } from "@veyyon/coding-agent/prompts/registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import type { PromptEntry, PromptRegistryView } from "@veyyon/utils";

/**
 * The registries the command is expected to know about.
 *
 * The coding agent's first, because a miss is reported against it and several checks name
 * it as the owner an operator most likely meant.
 */
const REGISTRIES: readonly PromptRegistryView[] = [codingAgentPrompts, agentCorePrompts, aiPrompts, hashlinePrompts];

/** Every prompt the command is expected to know about, from all of them. */
const EVERY_ENTRY: ReadonlyArray<readonly [string, PromptEntry]> = REGISTRIES.flatMap(registry =>
	registry.ids.map(id => [id, registry.require(id)] as const),
);
const EVERY_ID = EVERY_ENTRY.map(([id]) => id);

describe("listing every prompt", () => {
	it("names every registered prompt", async () => {
		// The whole point of the list is completeness. Asserted against the registry
		// rather than a fixed count, so adding a prompt cannot silently go unlisted.
		const { output, exitCode } = await runPromptCommand({ prompts: true });

		expect(exitCode).toBe(0);
		for (const id of EVERY_ID) expect(output, `${id} is missing from the list`).toContain(id);
	});

	it("names the directory each registry's prompts live in", async () => {
		// The id is the path under its owner's directory, so the two lines together are
		// the file. Without the heading a reader has to already know which package owns
		// a prompt in order to open it.
		const { output } = await runPromptCommand({ prompts: true });

		for (const { dir } of REGISTRIES) {
			expect(output, `${dir} is not named in the list`).toContain(dir);
		}
	});

	it("keeps ids unique across the registries, so a lookup needs no package", async () => {
		// The property the cross-registry lookup rests on. Two registries claiming one
		// id would make `--prompt <id>` answer with whichever is searched first, and the
		// operator would have no way to ask for the other.
		const seen = new Map<string, string>();
		const collisions: string[] = [];
		for (const { dir, ids } of REGISTRIES) {
			for (const id of ids) {
				const previous = seen.get(id);
				if (previous) collisions.push(`${id} is registered by both ${previous} and ${dir}`);
				seen.set(id, dir);
			}
		}

		expect(collisions.sort()).toEqual([]);
		expect(seen.size).toBe(EVERY_ID.length);
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

		for (const [id, entry] of EVERY_ENTRY) {
			expect(output, `${id} is listed without saying what it is for`).toContain(entry.purpose);
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
		expect(output).toContain("an id is the path under that directory without .md");
		// The directory is named because three registries are listed now, so "src/prompts"
		// alone no longer identifies a tree.
		expect(output).toContain("packages/coding-agent/src/prompts");
	});

	it("names the near miss rather than leaving 163 ids to search", async () => {
		// The reason the message does not list every id: the one the operator nearly
		// typed is the only one worth printing, and it turns the error into the fix.
		const { output, exitCode } = await runPromptCommand({ prompt: "subagent/system-promt" });

		expect(exitCode).toBe(1);
		expect(output).toContain('Did you mean "subagent/system-prompt"');
	});

	it("describes a prompt owned by another package, with its own file path", async () => {
		// The list spans three registries, so a lookup has to as well. It did not: an id
		// from `@veyyon/agent-core` was listed and then refused as unknown, which is a
		// worse answer than not listing it at all.
		const { output, exitCode } = await runPromptCommand({ prompt: "compaction/summarization-system" });

		expect(exitCode).toBe(0);
		expect(output).toContain("packages/agent/src/prompts/compaction/summarization-system.md");
	});

	it("describes a dialect format guide from @veyyon/ai", async () => {
		const { output, exitCode } = await runPromptCommand({ prompt: "dialect/gemma" });

		expect(exitCode).toBe(0);
		expect(output).toContain("packages/ai/src/prompts/dialect/gemma.md");
	});

	it("describes the edit tool's patch language, which lives in @veyyon/hashline", async () => {
		// The one tool description that was absent from a list holding every other one,
		// because hashline publishes it as a package asset and nothing registered it.
		const { output, exitCode } = await runPromptCommand({ prompt: "prompt" });

		expect(exitCode).toBe(0);
		expect(output).toContain("packages/hashline/src/prompt.md");
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
