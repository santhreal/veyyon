/**
 * `set_cwd` reports which rule files changed, and inlines the ones that newly
 * apply.
 *
 * WHY THIS SUITE EXISTS. Rule files (AGENTS.md, CLAUDE.md and the other context
 * layers) are found by walking UP from the session working directory, and they
 * are baked into the system prompt once, when the session starts. Re-rooting
 * mid-session moves the walk's starting point, so the set of files that ought to
 * govern the work changes immediately while the system prompt still describes the
 * directory the session left.
 *
 * Only the interactive TUI ever repaired that. Its `cwd_changed` handler runs
 * `applyCwdChange`, which reloads project settings and rebuilds the base system
 * prompt for the new directory. An SDK session, an ACP session, a headless run
 * and every subagent re-rooted with no rule reload at all, so they kept following
 * the previous project's instructions for the rest of the session, and nothing in
 * the transcript said so. Even in the TUI the repair lands on the NEXT prompt,
 * after the turn that called `set_cwd` has already continued working under the
 * old rules.
 *
 * The fix puts the delta in the tool result, because a tool result is the one
 * channel every mode already has and the model reads it in the same turn it made
 * the call. It is also free in prompt-cache terms: appending to the transcript
 * leaves the cached prefix intact, where rebuilding the system prompt invalidates
 * it.
 *
 * These tests pin the behaviour that makes the result trustworthy: the newly
 * applicable rules are inlined verbatim (a list of paths is not an injection),
 * the dropped ones are named so the model stops following them, an oversized file
 * is reported rather than quietly omitted, and a failure to read rules does not
 * masquerade as a failed re-root.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { SetCwdTool, type SetCwdToolDetails, setCwdToolRenderer } from "@veyyon/coding-agent/tools/set-cwd";
import type { Component } from "@veyyon/tui";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * The renderer's own bytes, with styling stripped. Asserting on the rendered
 * string is the sanctioned way to check a visual change: a terminal capture would
 * not survive review, and would not tell us anything about the text anyway.
 */
async function renderToText(component: Component | undefined): Promise<string> {
	return component ? Bun.stripANSI(component.render(120).join("\n")) : "";
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

describe("set_cwd rule reporting", () => {
	let root: string;
	let outer: string;
	let inner: string;
	let sibling: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "setcwd-rules-"));
		outer = path.join(root, "outer");
		inner = path.join(outer, "inner");
		sibling = path.join(root, "sibling");
		await fs.mkdir(inner, { recursive: true });
		await fs.mkdir(sibling, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	function toolAt(cwd: string) {
		const manager = SessionManager.inMemory(cwd);
		const session = makeToolSession({
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated({}),
			getSessionSpawns: () => "*",
			setCwd: (resolved, options) => manager.setCwd(resolved, options),
		});
		Object.defineProperty(session, "cwd", { get: () => manager.getCwd(), configurable: true });
		return { tool: new SetCwdTool(session as never), manager };
	}

	it("names a rule file that newly applies, without inlining its content", async () => {
		// NAMES ONLY. An earlier version inlined the text of every newly applicable
		// rule file, which was the wrong instinct: `loadProjectContextFiles` walks up
		// from cwd, so the next system-prompt build carries the new project's rules by
		// itself, in the `<context>` block where they are cached. Paying for them a
		// second time in a tool result buys nothing and crowds out the work.
		const body = "Never run the formatter on generated output.";
		await fs.writeFile(path.join(inner, "AGENTS.md"), body);

		const { tool } = toolAt(outer);
		const text = textOf(await tool.execute("s1", { path: inner }));

		expect(text).toContain(path.join(inner, "AGENTS.md"));
		expect(text).toContain("now in effect");
		expect(text).not.toContain(body);
	});

	it("records the newly applicable path in details for the renderer", async () => {
		await fs.writeFile(path.join(inner, "AGENTS.md"), "Inner project rule.");

		const { tool } = toolAt(outer);
		const details = (await tool.execute("s1", { path: inner })).details as SetCwdToolDetails;

		expect(details.rulesApplied).toEqual([path.join(inner, "AGENTS.md")]);
		expect(details.rulesDropped).toEqual([]);
	});

	it("names a rule file that no longer applies after moving to a sibling", async () => {
		// Moving OUT of a directory is the case that silently went wrong: the model
		// kept obeying instructions belonging to a project it had left, and nothing
		// told it to stop.
		await fs.writeFile(path.join(outer, "AGENTS.md"), "Outer project rule.");

		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: sibling });
		const text = textOf(result);
		const details = result.details as SetCwdToolDetails;

		expect(text).toContain("No longer in effect");
		expect(text).toContain(path.join(outer, "AGENTS.md"));
		expect(details.rulesDropped).toEqual([path.join(outer, "AGENTS.md")]);
	});

	it("keeps an ancestor's rules and does not report them as new", async () => {
		// Narrowing into a subdirectory keeps every ancestor rule, because the walk
		// still passes through it. Re-inlining those would spend tokens repeating
		// instructions the model is already following, which is the reason the result
		// reports a delta rather than the full set.
		await fs.writeFile(path.join(outer, "AGENTS.md"), "Outer project rule.");

		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: inner });
		const details = result.details as SetCwdToolDetails;

		expect(details.rulesApplied).toEqual([]);
		expect(details.rulesDropped).toEqual([]);
		expect(textOf(result)).toContain("unchanged");
	});

	it("stays the same size no matter how large the rule file is", async () => {
		// The reason names beat content. A 40 KB AGENTS.md is common, and a result that
		// grew with it would spend the context the re-root was supposed to save. The
		// result is a few lines whatever the file weighs.
		await fs.writeFile(path.join(inner, "AGENTS.md"), `HUGE RULE\n${"x".repeat(40_000)}`);

		const { tool } = toolAt(outer);
		const text = textOf(await tool.execute("s1", { path: inner }));

		expect(text.length).toBeLessThan(1_000);
		expect(text).toContain(path.join(inner, "AGENTS.md"));
	});

	it("says plainly that nothing changed when neither directory has project rules", async () => {
		// Both directories still inherit whatever user-level and global rules exist on
		// the machine, so the assertion is about the DELTA being empty, not about the
		// absence of every rule. A test that demanded zero files would pass or fail
		// depending on whether the developer running it happens to have a
		// `~/.veyyon/AGENTS.md`, which is not a property of this code.
		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: sibling });
		const details = result.details as SetCwdToolDetails;

		expect(details.rulesApplied).toEqual([]);
		expect(details.rulesDropped).toEqual([]);
		expect(textOf(result)).toContain("unchanged");
		expect(textOf(result)).not.toContain("now in effect");
	});

	it("reports both halves when a move swaps one project's rules for another's", async () => {
		// The move that motivated the whole change: leaving a project and entering a
		// different one. Both lists must be right in the same result, because acting on
		// only one of them leaves the model either following rules it has left or
		// missing the ones it has arrived at.
		await fs.writeFile(path.join(outer, "AGENTS.md"), "Outer rule: use tabs.");
		await fs.writeFile(path.join(sibling, "AGENTS.md"), "Sibling rule: use spaces.");

		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: sibling });
		const text = textOf(result);
		const details = result.details as SetCwdToolDetails;

		expect(details.rulesApplied).toEqual([path.join(sibling, "AGENTS.md")]);
		expect(details.rulesDropped).toEqual([path.join(outer, "AGENTS.md")]);
		expect(text).toContain("now in effect");
		expect(text).toContain("No longer in effect");
		// Names, not bodies: neither project's rule text appears.
		expect(text).not.toContain("use spaces");
		expect(text).not.toContain("use tabs");
	});

	it("still reports the re-root itself alongside the rule change", async () => {
		// The rule block is additive. A result that dropped the "cwd is now X" sentence
		// would break the loop-avoidance wording that exists so a model can confirm the
		// path it sent was the path that arrived.
		await fs.writeFile(path.join(inner, "AGENTS.md"), "Inner rule.");

		const { tool } = toolAt(outer);
		const text = textOf(await tool.execute("s1", { path: inner }));

		expect(text).toContain(`Moved cwd: ${path.resolve(outer)} → ${path.resolve(inner)}`);
	});

	it("shows the rule counts on the status line, not only in the model's copy", async () => {
		// The rule delta is the part of a re-root that changes how the agent behaves.
		// A move that silently swapped the governing AGENTS.md rendered identically to
		// one that changed nothing, so the human watching had no signal either.
		await fs.writeFile(path.join(outer, "AGENTS.md"), "Outer rule.");
		await fs.writeFile(path.join(sibling, "AGENTS.md"), "Sibling rule.");

		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: sibling });
		const theme = (await getThemeByName("titanium"))!;
		const rendered = await renderToText(setCwdToolRenderer.renderResult(result, {} as never, theme));

		expect(rendered).toContain("+1 -1 rule files");
	});

	it("says one rule file, not two, when only one side changed", async () => {
		// Pluralization is on the TOTAL of both counts, so a single-file move reads as
		// a single file.
		await fs.writeFile(path.join(sibling, "AGENTS.md"), "Sibling rule.");

		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: sibling });
		const theme = (await getThemeByName("titanium"))!;
		const rendered = await renderToText(setCwdToolRenderer.renderResult(result, {} as never, theme));

		expect(rendered).toContain("+1 rule file");
		expect(rendered).not.toContain("rule files");
	});

	it("reports a no-op re-root as unchanged rules without loading anything", async () => {
		// `previous === cwd` means the walk starts in the same place, so there is no
		// delta by construction. Saying so closes the retry loop the no-op wording
		// exists to prevent.
		await fs.writeFile(path.join(outer, "AGENTS.md"), "Outer rule.");

		const { tool } = toolAt(outer);
		const result = await tool.execute("s1", { path: outer });
		const details = result.details as SetCwdToolDetails;

		expect(textOf(result)).toContain("The rule files in effect are unchanged.");
		expect(textOf(result)).toContain("do not retry it");
		expect(details.rulesApplied).toEqual([]);
	});

	it("inlines a deeper rule file without re-inlining the ancestor it overrides", async () => {
		// Descending into a subproject that has its own rules. The ancestor still
		// applies and the model is already following it, so repeating it would spend
		// tokens restating instructions that never left; only the newly-governing file
		// is inlined. The ordering promise ("deeper overrides higher") is what makes
		// that safe.
		await fs.writeFile(path.join(outer, "AGENTS.md"), "Outer rule: use tabs.");
		await fs.writeFile(path.join(inner, "AGENTS.md"), "Inner rule: this package uses spaces.");

		const { tool } = toolAt(outer);
		const text = textOf(await tool.execute("s1", { path: inner }));

		expect(text).toContain(path.join(inner, "AGENTS.md"));
		expect(text).not.toContain(path.join(outer, "AGENTS.md"));
	});
});
