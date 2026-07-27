/**
 * A mistyped `--system-prompt` path must not become the system prompt.
 *
 * WHY THIS SUITE EXISTS. `resolvePromptInput` backs `--system-prompt`,
 * `--append-system-prompt` and the title prompt, each of which accepts either a file
 * path or the prompt text itself. It used to answer ANY read failure by returning the
 * input unchanged, and `ENOENT` was explicitly excluded from the warning, so a typo
 * in the path was completely silent: `--system-prompt ./promtps/main.md` handed the
 * model a system prompt whose entire content was the string `./promtps/main.md`.
 *
 * That is not a degraded prompt, it is no prompt. Every rule, tool policy, exploration
 * guideline and workflow the agent depends on is gone; the session behaves nothing
 * like it should; and there is nothing on screen connecting the behaviour to a
 * misspelled directory. It is the highest-cost silent fallback in the product, on the
 * single most important input the model receives (Law 10).
 *
 * Both directions are held here, because the fix is only correct if it is narrow. A
 * check that refused every unreadable string would break the supported way to pass a
 * prompt inline: a one-line instruction can contain a slash ("in the style of
 * Strunk/White") or end in a word with a dot, and those are prose, not paths.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePromptInput } from "@veyyon/coding-agent/system-prompt";

const scratch = await mkdtemp(join(tmpdir(), "veyyon-prompt-input-"));

describe("a value that names a file", () => {
	/** The ordinary case: a real path resolves to its contents, not to itself. */
	it("reads the file it points at", async () => {
		const file = join(scratch, "main.md");
		await writeFile(file, "ROLE\n====\nYou are a pirate.\n");

		expect(await resolvePromptInput(file, "system prompt")).toBe("ROLE\n====\nYou are a pirate.\n");
	});

	/**
	 * The bug, stated directly. A path with a typo in it must not silently become the
	 * prompt, and the error has to carry the path so the typo is visible in it.
	 */
	it("refuses a path that does not exist, naming the path", async () => {
		const missing = join(scratch, "promtps", "main.md");

		await expect(resolvePromptInput(missing, "system prompt")).rejects.toThrow(
			new RegExp(`cannot read ${missing.replace(/[/\\]/g, "\\$&")}`),
		);
	});

	/** And the option, since three different flags resolve through this one function. */
	it("names the option that was wrong", async () => {
		await expect(resolvePromptInput(join(scratch, "nope", "x.md"), "append system prompt")).rejects.toThrow(
			/^append system prompt:/,
		);
	});

	/**
	 * A bare filename with a prompt-file extension is a path even with no separator —
	 * `--system-prompt SYSTEM.md` in the wrong directory is exactly the typo this
	 * exists to catch, and it has nothing that looks like prose in it.
	 */
	it("treats a bare filename with a prompt extension as a path", async () => {
		await expect(resolvePromptInput("SYSTEM.md", "system prompt")).rejects.toThrow(/cannot read SYSTEM\.md/);
	});

	/** The message has to say what to do, not only what failed. */
	it("explains why it was read as a path and how to force literal text", async () => {
		const failure = await resolvePromptInput(join(scratch, "gone.md"), "system prompt").catch(
			(error: Error) => error.message,
		);

		expect(failure).toContain("taken as a file path");
		expect(failure).toContain("pass the prompt text directly");
	});

	/** A path containing spaces still resolves, because the read is tried first. */
	it("reads a path with spaces in it", async () => {
		const file = join(scratch, "my prompts.md");
		await writeFile(file, "spaced path content");

		expect(await resolvePromptInput(file, "system prompt")).toBe("spaced path content");
	});
});

describe("a value that is the prompt itself", () => {
	/** Plain prose is used as written and never opened. */
	it("passes a one-line instruction through", async () => {
		expect(await resolvePromptInput("You are a terse assistant.", "system prompt")).toBe(
			"You are a terse assistant.",
		);
	});

	/**
	 * The narrowness that keeps the fix from being a regression. A slash in a sentence
	 * is punctuation, not a path separator, and refusing it would break a supported way
	 * to pass a prompt inline.
	 */
	it("passes prose containing a slash through", async () => {
		expect(await resolvePromptInput("Write in the style of Strunk/White.", "system prompt")).toBe(
			"Write in the style of Strunk/White.",
		);
	});

	/** Same for a sentence that happens to end in something extension-shaped. */
	it("passes prose ending in a dotted word through", async () => {
		expect(await resolvePromptInput("Always mention config.md", "system prompt")).toBe("Always mention config.md");
	});

	/** Multi-line text is prose by definition: no path contains a newline. */
	it("passes multi-line text through without touching the disk", async () => {
		const text = "ROLE\n====\nYou are a pirate.";

		expect(await resolvePromptInput(text, "system prompt")).toBe(text);
	});

	/** Nothing in means nothing out, rather than an empty string. */
	it("returns undefined for no input", async () => {
		expect(await resolvePromptInput(undefined, "system prompt")).toBeUndefined();
		expect(await resolvePromptInput("", "system prompt")).toBeUndefined();
	});
});
