/**
 * The orchestratez keyword: what triggers it, what paints it, and the ordinary
 * English verb that must never do either.
 *
 * WHY THE VERB ROWS EXIST. The trigger used to be `orchestrate`, which is a word
 * operators write all day, and the notice it appends tells the model to drive the
 * work as a multi-phase parallel subagent run and to override any tendency to do
 * it inline. So "orchestrate the release" and even "do not orchestrate anything,
 * just fix it" changed how the turn ran, invisibly, because the notice does not
 * display. Those sentences are pinned here as NON-triggers.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { containsOrchestrate, highlightOrchestrate, ORCHESTRATE_NOTICE } from "@veyyon/coding-agent/modes/orchestrate";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { containsUltrathink, highlightUltrathink } from "@veyyon/coding-agent/modes/ultrathink";
import { clearBundledCommandsCache, loadBundledCommands } from "@veyyon/coding-agent/task/commands";

beforeAll(() => {
	// highlightOrchestrate/highlightUltrathink read the global theme's color mode.
	initTheme();
});

describe("orchestratez keyword detection", () => {
	it("matches the lowercase word delimited by whitespace or a string edge", () => {
		expect(containsOrchestrate("orchestratez")).toBe(true);
		expect(containsOrchestrate("please orchestratez this rollout")).toBe(true);
		expect(containsOrchestrate("orchestratez the rollout")).toBe(true);
		// A newline is whitespace, and end-of-string is a valid right boundary.
		expect(containsOrchestrate("do it now\norchestratez")).toBe(true);
	});

	it("matches the lowercase word beside prose punctuation and quotes", () => {
		for (const text of ["do it. orchestratez.", "please orchestratez, then report", 'say "orchestratez" now']) {
			expect(containsOrchestrate(text)).toBe(true);
		}
	});

	/**
	 * THE regression. Every sentence here is ordinary operator prose, and every
	 * one of them appended the hidden orchestration contract before the token
	 * carried its `z`.
	 */
	it("never triggers on the ordinary verb", () => {
		for (const text of [
			"orchestrate",
			"orchestrate the release",
			"please orchestrate this migration yourself",
			"do not orchestrate anything, just fix the one file",
			"we need to orchestrate a rollback plan",
			'say "orchestrate" now',
			"do it now\norchestrate",
		]) {
			expect(containsOrchestrate(text)).toBe(false);
		}
	});

	it("ignores casing, inflections, and path-embedded forms", () => {
		expect(containsOrchestrate("Orchestratez")).toBe(false);
		expect(containsOrchestrate("ORCHESTRATEZ")).toBe(false);
		expect(containsOrchestrate("orchestratezed the build")).toBe(false);
		expect(containsOrchestrate("orchestratezing now")).toBe(false);
		expect(containsOrchestrate("reorchestratez everything")).toBe(false);
		// A path/extension must not trigger even though sentence punctuation does.
		expect(containsOrchestrate("packages/coding-agent/src/modes/orchestratez.ts")).toBe(false);
		expect(containsOrchestrate("nothing to see here")).toBe(false);
	});

	it("ignores keywords inside code spans, fenced blocks, and XML sections", () => {
		expect(containsOrchestrate("use `orchestratez` here")).toBe(false);
		expect(containsOrchestrate("```\norchestratez\n```")).toBe(false);
		expect(containsOrchestrate("<note>orchestratez</note>")).toBe(false);
		// A real prose request alongside code still triggers.
		expect(containsOrchestrate("run `setup` then orchestratez the rollout")).toBe(true);
	});
});

describe("orchestratez keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const decorated = highlightOrchestrate("please orchestratez this");
		expect(decorated).not.toBe("please orchestratez this");
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe("please orchestratez this");
	});

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "orchestratez," then continue';
		const decorated = highlightOrchestrate(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightOrchestrate("nothing here")).toBe("nothing here");
		// The editor must not glow on the ordinary verb either: the glow is the
		// only warning that a hidden notice is about to be attached.
		expect(highlightOrchestrate("orchestrate the release")).toBe("orchestrate the release");
		// Probe hits the substring but token/path boundaries fail — no decoration.
		expect(highlightOrchestrate("orchestratezed builds")).toBe("orchestratezed builds");
		expect(highlightOrchestrate("Orchestratez this")).toBe("Orchestratez this");
		// The reported bug: a filename must not be painted.
		const filePath = "packages/coding-agent/src/modes/orchestratez.ts";
		expect(highlightOrchestrate(filePath)).toBe(filePath);
	});

	it("does not cross-trigger with the ultrathink highlighter", () => {
		expect(highlightOrchestrate("ultrathink")).toBe("ultrathink");
		expect(highlightUltrathink("orchestratez")).toBe("orchestratez");
		expect(containsUltrathink("orchestratez")).toBe(false);
		expect(containsOrchestrate("ultrathink")).toBe(false);
	});
});

describe("orchestratez notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		expect(ORCHESTRATE_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(ORCHESTRATE_NOTICE.endsWith("</system-notice>")).toBe(true);
		expect(ORCHESTRATE_NOTICE).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(ORCHESTRATE_NOTICE).not.toContain("$@");
	});
});

describe("orchestrate slash command removal", () => {
	it("is no longer bundled as a slash command", () => {
		clearBundledCommandsCache();
		const names = loadBundledCommands().map(command => command.name);
		expect(names).not.toContain("orchestrate");
		expect(names).toContain("init");
	});
});
