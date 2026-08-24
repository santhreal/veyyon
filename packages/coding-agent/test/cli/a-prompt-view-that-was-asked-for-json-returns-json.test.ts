/**
 * WHY THIS SUITE EXISTS.
 *
 * `veyyon prompt --prompts --json` printed a padded human table and exited 0. So did
 * `--prompt <id> --json`, `--tools --json`, `--section <id> --json` and
 * `--statement <id> --json`. The command was a chain of early returns in flag order and
 * the `flags.json` line sat fifth, so five of the six views returned before it was ever
 * read: a consumer that asked for JSON got columns, a parse error, and nothing anywhere
 * saying the flag had been dropped. A flag that is accepted and ignored is worse than one
 * that is rejected, because the caller has no way to find out.
 *
 * THE CLASS, NOT THE INCIDENT. This is not "--prompts must emit JSON". It is that EVERY
 * view the command can produce answers in the format it was asked for. `selectPromptView`
 * is now the one owner of which view an invocation means, `PROMPT_VIEW_KINDS` is the
 * runtime half of its union, and the sweep below keys a TOTAL `Record` off that list: a
 * view added to the union without a row here stops compiling, and a view that forgets its
 * JSON branch turns this red. That is the only way a per-view table stays honest.
 *
 * THE REFUSALS ARE PART OF THE CONTRACT. An unknown id, and a rule that is off in this
 * configuration, are the answers a machine consumer most needs to read, and they are
 * exactly the paths that returned prose. Each keeps its exit code and gains a parseable
 * body.
 *
 * WHAT IT DOES NOT CATCH. Whether a field CARRIES the right value for every view — the
 * `--json` full inspection has its own coverage — and the text forms, which are asserted
 * only to still be text. It also runs against this repository's own configuration, so a
 * view whose JSON is correct here and wrong under some other settings is not seen.
 */
import { describe, expect, it } from "bun:test";
import {
	PROMPT_VIEW_KINDS,
	type PromptCommandFlags,
	type PromptView,
	runPromptCommand,
	selectPromptView,
} from "@veyyon/coding-agent/cli/prompt-cli";

type PromptViewKind = PromptView["kind"];

/**
 * One invocation per view, and a second one per view that can refuse.
 *
 * A total `Record` rather than an array: adding a kind to `PromptView` without a row is a
 * type error, which is the fail-closed half a runtime sweep cannot provide.
 */
const REACHES: Record<PromptViewKind, PromptCommandFlags> = {
	prompts: { prompts: true },
	prompt: { prompt: "tools/bash" },
	statement: { statement: "conventions/conventions" },
	tools: { tools: true },
	section: { section: "role" },
	inspection: {},
};

/** The same views asked a question they must refuse, or answer with an absence. */
const REFUSES: Partial<Record<PromptViewKind, PromptCommandFlags>> = {
	prompt: { prompt: "no-such-registry/no-such-prompt" },
	statement: { statement: "no-such-section/no-such-statement" },
	section: { section: "no-such-section" },
};

describe("selectPromptView", () => {
	it.each([...PROMPT_VIEW_KINDS])("is reachable as %s", kind => {
		expect(selectPromptView(REACHES[kind]).kind).toBe(kind);
	});

	it("reads the flags in the order the command has always read them", () => {
		// Precedence is behaviour: `--tools --statement x` printed the statement before this
		// function existed, and a reordering here would silently change which view an existing
		// script gets.
		expect(selectPromptView({ prompts: true, prompt: "tools/bash", tools: true }).kind).toBe("prompts");
		expect(selectPromptView({ prompt: "tools/bash", statement: "a/b", tools: true }).kind).toBe("prompt");
		expect(selectPromptView({ statement: "a/b", tools: true, section: "role" }).kind).toBe("statement");
		expect(selectPromptView({ tools: true, section: "role" }).kind).toBe("tools");
		expect(selectPromptView({ section: "role", statements: true }).kind).toBe("section");
		expect(selectPromptView({ statements: true, sections: true }).kind).toBe("inspection");
	});

	it("treats --prompt system as the assembled prompt, not a template lookup", () => {
		// `system` is the default and names the live assembly; routing it to the template
		// describer would answer a different question with a straight face.
		expect(selectPromptView({ prompt: "system" }).kind).toBe("inspection");
	});
});

describe("every view answers in the format it was asked for", () => {
	it.each([...PROMPT_VIEW_KINDS])("returns parseable JSON for %s", async kind => {
		const result = await runPromptCommand({ ...REACHES[kind], json: true });

		expect(() => JSON.parse(result.output)).not.toThrow();
		expect(JSON.parse(result.output)).toBeInstanceOf(Object);
		expect(result.exitCode).toBe(0);
	});

	it.each([...PROMPT_VIEW_KINDS])("returns text for %s when JSON was not asked for", async kind => {
		const result = await runPromptCommand(REACHES[kind]);

		// The negative control: if a view emitted JSON either way, the case above would pass
		// while proving nothing about the flag.
		expect(() => JSON.parse(result.output)).toThrow();
	});

	it.each(Object.keys(REFUSES) as PromptViewKind[])("refuses %s in JSON, keeping its exit code", async kind => {
		const flags = REFUSES[kind];
		if (flags === undefined) throw new Error(`no refusing invocation for ${kind}`);

		const asText = await runPromptCommand(flags);
		const asJson = await runPromptCommand({ ...flags, json: true });

		expect(asText.exitCode).toBe(1);
		expect(asJson.exitCode).toBe(asText.exitCode);
		expect(JSON.parse(asJson.output).error).toBe(asText.output);
	});

	it("reports a rule this configuration leaves out as present:false rather than as an error", async () => {
		// A rule that is off is not a failure, and a consumer that cannot tell it from a typo
		// has the ambiguity the text form was written to remove.
		const result = await runPromptCommand({ statement: "runtime/skills", json: true });
		const parsed = JSON.parse(result.output);

		expect(result.exitCode).toBe(0);
		expect(parsed.present).toBe(false);
		expect(parsed.text).toBeNull();
		expect(typeof parsed.condition).toBe("string");
	});

	it("lists every registered prompt with the file it ships in", async () => {
		const parsed = JSON.parse((await runPromptCommand({ prompts: true, json: true })).output);

		// The text list groups by registry directory and carries a pointer row for `system`;
		// the JSON carries the registered prompts themselves, so `session/system-prompt` has to
		// be among them or the pointer row lost data on the way out.
		const ids = parsed.prompts.map((entry: { id: string }) => entry.id);
		expect(ids).toContain("session/system-prompt");
		expect(ids).toContain("tools/bash");
		expect(parsed.prompts.every((entry: { template: string }) => entry.template.length > 0)).toBe(true);
	});
});
