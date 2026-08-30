/**
 * The launch card states what the last launch of this project knew, and never what another one did.
 *
 * WHY THIS SUITE EXISTS. The card paints at ~48ms and the session lands at ~650ms. Three things on
 * that card cannot be computed inside the first budget at any price: a model's display name needs
 * the catalog, the dirty marker needs a `git status` costing 130ms, and the context gauge needs a
 * prompt that has not been assembled. Rendered as placeholders they were not blank but WRONG — the
 * hero announced `no model yet · /login` to an operator who is logged in, and the status row
 * printed a raw `provider/vendor/model-id` so wide that the justifier dropped the profile segment.
 * Both corrected themselves 600ms later, and that repaint is what a person sees.
 *
 * THE CLASS, NOT THE INCIDENT. The defect is not "the card shows `?`" or "the card says /login".
 * It is "the card states a fact taken under conditions that no longer hold". So every input a fact
 * depends on gets a case, and each fact is invalidated by ITS OWN key and no other: a dirty tree
 * survives a model change, a display name does not. A suite that only proved the happy path would
 * stay green while the card confidently printed the previous model's name.
 *
 * The write path is covered for the same reason. Every redraw of an idle session reaches the
 * recorder, so an unchanged write must collapse; but a guard watching the VALUES rather than the
 * whole record would skip a write whose key moved, leaving the file keyed to a model the operator
 * has left — and the next launch, finding no match, back to the placeholder this cache removes.
 *
 * WHAT IT DOES NOT CATCH. Facts age between launches: committing from another terminal, editing an
 * `AGENTS.md`, installing a skill. The key does not move, so the card states the previous answer
 * and the session corrects it in place — one changed row rather than the whole screen. That is a
 * recorded trade, not an oversight. This suite pins the keys that DO invalidate, so a future input
 * that ought to invalidate shows up as a hole here rather than as a confident wrong value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import {
	type LaunchFacts,
	type LaunchFactsUpdate,
	launchModelLabel,
	readLaunchFacts,
	recordLaunchFacts,
	resetLaunchFactsForTest,
} from "@veyyon/coding-agent/modes/launch-facts";
import { LaunchComposerFoot } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import {
	factsAtLaunch,
	launchSegmentContext,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/session-facts";
import { paintFirstFrame, takeFirstFrame } from "@veyyon/coding-agent/modes/terminal/first-frame";
import { resetGroundTintsForTest } from "@veyyon/coding-agent/theme/ground-tints";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { GitStatusSummary } from "@veyyon/coding-agent/utils/git";
import { getLaunchFactsCachePath, stripAnsi } from "@veyyon/utils";
import * as atomicWrite from "@veyyon/utils/atomic-write";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { makeStatusLineSession, type StubSessionOptions } from "./helpers/status-line-session";

const DIRTY: GitStatusSummary = { staged: 1, unstaged: 2, untracked: 3, truncated: false };
const CLEAN: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, truncated: false };

const MODEL_A = "anthropic/claude-sonnet-4";
const MODEL_B = "openai/gpt-5";

/**
 * A config root in the OS temp directory, per test.
 *
 * `VEYYON_CONFIG_DIR` is read at process start and `os.homedir()` is cached by the runtime, so
 * setting either by hand does NOT move this cache — it resolves to the developer's real
 * `~/.veyyon/profiles/<name>/cache/`, and a suite that writes there is editing the machine it runs
 * on. `enterIsolatedConfigRoot` is the one helper that redirects all of it and puts it back.
 */
let isolated: IsolatedConfigRoot;

/**
 * Record facts and wait for the write the recorder hands back.
 *
 * The product discards that promise — a launch fact is worth one frame — but it is the completion
 * signal, so a test awaits it rather than sleeping on a guess. The memo is dropped first so each
 * call re-reads the file, which is what a fresh process does.
 */
async function record(update: LaunchFactsUpdate): Promise<void> {
	resetLaunchFactsForTest();
	await recordLaunchFacts(update);
	resetLaunchFactsForTest();
}

/** What is on disk right now, parsed. */
function onDisk(): Record<string, unknown> {
	return JSON.parse(readFileSync(getLaunchFactsCachePath(), "utf8")) as Record<string, unknown>;
}

/** Overwrite the file and forget anything this process cached about it. */
function planted(content: unknown): void {
	writeFileSync(getLaunchFactsCachePath(), typeof content === "string" ? content : JSON.stringify(content));
	resetLaunchFactsForTest();
}

/** The card's own status-row context, which is what the segments actually render from. */
function cardContext() {
	return launchSegmentContext({
		width: 120,
		options: {},
		compactThinkingLevel: false,
		branch: "main",
		autoCompactEnabled: true,
	});
}

/** The gauge, as either preset draws it: the bar, or the words when the bar has been shed. */
const GAUGE = /▰|left/;

/** The card's footline at `width`, from the component that paints it, styling removed. */
function cardFootRow(width: number): string {
	const rows = new LaunchComposerFoot().render(width);
	return stripAnsi(rows.find(line => stripAnsi(line).trim().length > 0) ?? "");
}

/**
 * The narrowest terminal whose card row still carries a gauge, for the role configured right now.
 *
 * Measured, because the row's spare room is whatever the project path leaves it, and this suite's
 * project is a temp directory whose length is not ours to know. Throws rather than returning a
 * bound: a role that never draws a gauge at any width is a broken fixture, and a test that silently
 * calibrated against one would pass forever.
 */
function narrowestWidthWithGauge(): number {
	for (let width = 40; width <= 400; width += 1) {
		if (GAUGE.test(cardFootRow(width))) return width;
	}
	throw new Error("the launch row drew no gauge at any width between 40 and 400 columns");
}

beforeEach(async () => {
	isolated = enterIsolatedConfigRoot("launch-facts", { defaultProfile: true });
	resetSettingsForTest();
	resetLaunchFactsForTest();
	await Settings.init({ cwd: isolated.root });
	settings.setModelRole("default", MODEL_A);
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	isolated.restore();
});

describe("what the launch card knows before a session exists", () => {
	/** Every first launch in a project: no file, and each fact absent as itself. */
	it("knows nothing before anything has been recorded", () => {
		expect(readLaunchFacts()).toEqual({
			gitStatus: null,
			modelName: null,
			providerName: null,
			contextPercent: null,
		});
	});

	/** The round trip, through the real file, for every fact the card draws. */
	it("states each fact the last launch recorded", async () => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic", contextPercent: 17.6, gitStatus: DIRTY });

		expect(readLaunchFacts()).toEqual({
			gitStatus: DIRTY,
			modelName: "Claude Sonnet 4",
			providerName: "anthropic",
			// Whole percent because that is what the gauge prints; a stored fraction would rewrite
			// the file on every redraw of an idle session for a difference nobody can see.
			contextPercent: 18,
		});
	});

	/**
	 * The seams that made the card wrong. Reading the module is not enough: the hero renders from
	 * `readLaunchFacts` directly, and the row renders from these two, so a fact that never reaches
	 * them is a fact the operator never sees.
	 */
	it("reaches the model segment's facts", async () => {
		await record({ modelName: "Claude Sonnet 4" });

		expect(factsAtLaunch().model).toEqual({ id: MODEL_A, name: "Claude Sonnet 4", supportsThinking: false });
	});

	it("reaches the card's gauge and branch", async () => {
		await record({ contextPercent: 40, gitStatus: DIRTY });

		const context = cardContext();

		expect(context.contextPercent).toBe(40);
		expect(context.git).toEqual({ branch: "main", status: DIRTY, pr: null });
	});

	/**
	 * A clean tree is a RECORDED clean tree, not the absence of a record. Both render no marker, so
	 * only the file tells them apart — and a recorder that dropped a zeroed summary as falsy would
	 * leave the previous dirty one in place and mark a clean tree.
	 */
	it("records a clean tree as a fact, not as an absence", async () => {
		await record({ gitStatus: DIRTY });
		await record({ gitStatus: CLEAN });

		expect(readLaunchFacts().gitStatus).toEqual(CLEAN);
	});

	/**
	 * THE INVALIDATION CASES, each naming one input a fact was taken under, and each proving what
	 * SURVIVES as well as what drops. Carrying a fact onto a key it was not taken under is the
	 * defect; dropping one that is still valid is a needless placeholder.
	 */
	it("drops the model's facts when the model changed, and keeps the tree's", async () => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic", contextPercent: 40, gitStatus: DIRTY });

		settings.setModelRole("default", MODEL_B);

		expect(readLaunchFacts()).toEqual({
			gitStatus: DIRTY,
			modelName: null,
			providerName: null,
			contextPercent: null,
		});
	});

	it("drops every fact when the project changed", async () => {
		await record({ modelName: "Claude Sonnet 4", contextPercent: 40, gitStatus: DIRTY });
		const file = onDisk();

		planted({
			...file,
			projectKey: `${String(file.projectKey)}-elsewhere`,
			modelKey: `${String(file.modelKey)}-elsewhere`,
		});

		expect(readLaunchFacts()).toEqual({
			gitStatus: null,
			modelName: null,
			providerName: null,
			contextPercent: null,
		});
	});

	it("drops every fact when the release changed", async () => {
		await record({ modelName: "Claude Sonnet 4", contextPercent: 40, gitStatus: DIRTY });
		const file = onDisk();

		planted({
			...file,
			projectKey: `0.0.0-other|${String(file.projectKey)}`,
			modelKey: `0.0.0-other|${String(file.modelKey)}`,
		});

		expect(readLaunchFacts()).toEqual({
			gitStatus: null,
			modelName: null,
			providerName: null,
			contextPercent: null,
		});
	});

	/**
	 * A file truncated by a crash mid-write, hand-edited, or replaced with the wrong shape. The
	 * card must fall back to placeholders rather than throw on the frame it is painting.
	 */
	it("knows nothing from a damaged file, whatever the damage", async () => {
		await record({ modelName: "Claude Sonnet 4", contextPercent: 40, gitStatus: DIRTY });
		const { projectKey, modelKey } = onDisk();

		for (const damaged of [
			"",
			"{",
			"null",
			"[]",
			'"40"',
			JSON.stringify({ projectKey }),
			JSON.stringify({ modelKey }),
			JSON.stringify({ projectKey: 7, modelKey }),
		]) {
			planted(damaged);

			expect(readLaunchFacts()).toEqual({
				gitStatus: null,
				modelName: null,
				providerName: null,
				contextPercent: null,
			});
		}
	});

	/**
	 * A summary that parses but is not one. It reaches `isTreeDirty`, which compares each count
	 * against zero — a string there decides dirtiness on a comparison nobody intended.
	 */
	it("rejects a git summary that is not one", async () => {
		await record({ gitStatus: DIRTY });
		const { projectKey, modelKey } = onDisk();

		for (const bad of [
			{ staged: "1", unstaged: 0, untracked: 0, truncated: false },
			{ staged: 1, unstaged: 0, untracked: 0 },
			{ staged: -1, unstaged: 0, untracked: 0, truncated: false },
			{ staged: Number.NaN, unstaged: 0, untracked: 0, truncated: false },
			"dirty",
			[],
		]) {
			planted({ projectKey, modelKey, gitStatus: bad });

			expect(readLaunchFacts().gitStatus).toBeNull();
		}
	});

	/**
	 * A percentage outside the band is a damaged file that still parses. Clamped rather than
	 * rejected, because the bar derives its filled cells from it and 140 would draw past them.
	 */
	it("clamps a percentage from outside the band", async () => {
		await record({ contextPercent: 40 });
		const { projectKey, modelKey } = onDisk();

		planted({ projectKey, modelKey, contextPercent: 140 });
		expect(readLaunchFacts().contextPercent).toBe(100);

		planted({ projectKey, modelKey, contextPercent: -20 });
		expect(readLaunchFacts().contextPercent).toBe(0);
	});

	/**
	 * Facts arrive from different places at different moments. An update carrying one must not
	 * erase the others, or the last writer before exit would decide which single fact the next
	 * card gets.
	 */
	it("keeps the facts an update does not mention", async () => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic", gitStatus: DIRTY });

		await record({ contextPercent: 55 });

		expect(readLaunchFacts()).toEqual({
			gitStatus: DIRTY,
			modelName: "Claude Sonnet 4",
			providerName: "anthropic",
			contextPercent: 55,
		});
	});

	/**
	 * An idle session redraws continuously and every redraw reaches the recorder with the same
	 * facts. The write has to stop at the first.
	 *
	 * Counted at the filesystem call rather than inferred from the file's contents: a recorder
	 * that rewrote identical bytes fifty times would leave a file indistinguishable from one
	 * written once, so only the call count can see the amplification.
	 */
	it("writes once for facts that have not changed", async () => {
		await record({ contextPercent: 40, gitStatus: DIRTY });
		const writes = vi.spyOn(atomicWrite, "atomicWriteJson");

		for (let redraw = 0; redraw < 50; redraw++) await recordLaunchFacts({ contextPercent: 40, gitStatus: DIRTY });

		expect(writes).toHaveBeenCalledTimes(0);
	});

	/**
	 * The guard watches the whole record, not the values in it.
	 *
	 * Switching models is one keystroke and two models can share a context window, so the values
	 * are unchanged while the key beneath them is not. A guard comparing only values skipped this
	 * write and left the file keyed to the model just left behind — and the next launch, finding no
	 * match, went back to the placeholder this cache exists to remove.
	 */
	it("writes again when the model changed and the values did not", async () => {
		await record({ contextPercent: 40, modelName: "Claude Sonnet 4" });

		settings.setModelRole("default", MODEL_B);
		await record({ contextPercent: 40, modelName: "Claude Sonnet 4" });

		expect(readLaunchFacts()).toEqual({
			gitStatus: null,
			modelName: "Claude Sonnet 4",
			providerName: null,
			contextPercent: 40,
		});
	});

	/**
	 * A fact recorded under the previous model is not carried onto the new one. Stating the old
	 * model's name beside the new model's id is worse than stating no name, because the card gives
	 * both the same confidence.
	 */
	it("never carries a model's facts onto another model", async () => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic", contextPercent: 40 });

		settings.setModelRole("default", MODEL_B);
		await record({ gitStatus: DIRTY });

		expect(readLaunchFacts()).toEqual({
			gitStatus: DIRTY,
			modelName: null,
			providerName: null,
			contextPercent: null,
		});
	});
});

/**
 * THE WIDTH OF A FACT IS PART OF THE FACT.
 *
 * A recorded display name is short because a catalog wrote it. The id config persists is not: a
 * role is stored qualified, and `nous-research/z-ai/glm-5.1` is twenty-six columns of an eighty
 * column row. Printed whole it did not overflow — the fitter sheds instead — so the first launch of
 * a project drew a row with no context gauge on it, and grew one when the session resolved a name
 * 600ms later. That is the same repaint this cache exists to remove, arriving through width rather
 * than through staleness, which is why proving the fact is CORRECT does not prove the row is.
 *
 * The sweep is over the shapes a role takes, not over one id: a bare id, a qualified one, a vendor
 * path, and each suffix a role may carry. They are listed because a role is free text in config
 * with no registry to enumerate, so the list is the honest boundary of the claim — a shape nobody
 * wrote down is a shape untested here.
 *
 * WHAT IT DOES NOT CATCH. A tail is not a display name. The first launch of a model still states
 * `glm-5.1` where the session will state `GLM 5.1`, and that one segment is rewritten in place when
 * the catalog answers. What it no longer does is spend the row's width on the vendor path, which
 * carries nothing the operator reads and cost the gauge every time. A tail that is ITSELF long
 * still can: `qwen2.5-coder-32b-instruct-abliterated:q4_K_M` is forty-three columns whatever this
 * derivation does, so the first launch of such a model may draw no gauge and grow one when the
 * catalog answers with something shorter. Capping the tail would trade that for the opposite
 * repaint, since the width the display name will take is the one thing this path cannot know, and
 * the launch after the first has the recorded name and changes nothing at all. Nothing here pins
 * the shedding ORDER either: the gauge went first, and a fitter that chose to drop the mode
 * instead would keep every case below green.
 */
describe("the row the card can afford", () => {
	/** Every shape a configured role takes, against the tail the card prints for it. */
	const ROLE_LABELS: ReadonlyArray<readonly [string, string]> = [
		["claude-sonnet-4-5", "claude-sonnet-4-5"],
		["anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"],
		["nous-research/z-ai/glm-5.1", "glm-5.1"],
		// Suffixes stay attached. Telling a thinking level from an Ollama tag needs the resolver
		// this path may not load, and the tail is inside the budget with them on.
		["openai/gpt-5:thinking", "gpt-5:thinking"],
		["openrouter/anthropic/claude-sonnet-4-5@bedrock", "claude-sonnet-4-5@bedrock"],
		["ollama/qwen2.5:7b", "qwen2.5:7b"],
	];

	for (const [role, label] of ROLE_LABELS) {
		it(`prints ${label} for a default role of ${role}`, () => {
			settings.setModelRole("default", role);

			expect(factsAtLaunch().model).toEqual({ id: role, name: label, supportsThinking: false });
		});
	}

	/**
	 * The property behind the table: whatever the shape, the card prints the last path segment and
	 * the id itself is untouched. A future shape that keeps a vendor path fails here even though
	 * nobody added a row for it, which is the case the table alone cannot cover.
	 */
	it("never prints a path on a row that pays by the column", () => {
		for (const [role] of ROLE_LABELS) {
			settings.setModelRole("default", role);
			const model = factsAtLaunch().model;

			expect(model?.name).not.toContain("/");
			expect(role.endsWith(model?.name ?? "")).toBe(true);
			expect(model?.id).toBe(role);
		}
	});

	/**
	 * The card's OWN row, from the component that paints it, at the narrowest terminal that still
	 * fits a gauge. The facts above can all be right while the row drops the gauge, because the
	 * fitter is what decides — so this is the case that goes red on the defect.
	 *
	 * The width is measured rather than written down. How much room the row has left over depends
	 * on the length of the project path, which is a temp directory here and the operator's checkout
	 * in life, so a fixed eighty columns sheds on one machine and fits on another. Calibrating
	 * against the tail asks the only question that has a stable answer: does the qualified id cost
	 * the row anything the tail did not.
	 */
	it("costs the row nothing that its tail did not", async () => {
		await initTheme(false);
		settings.setModelRole("default", "glm-5.1");
		const width = narrowestWidthWithGauge();
		const tailRow = cardFootRow(width);

		settings.setModelRole("default", "nous-research/z-ai/glm-5.1");

		// Byte-identical, not merely gauged: the qualified role prints the same label, so it
		// composes the same row. A row that kept the gauge by clipping the path instead would pass
		// a presence check and still be a row the operator watched change.
		expect(cardFootRow(width)).toBe(tailRow);
		expect(tailRow).toMatch(GAUGE);
	});

	/**
	 * The hero is the row's other reader, and it fails differently: it does not shed a segment, it
	 * prints `no model yet · /login` at an operator who is logged in. Painted through the real
	 * entrypoint, because the label reaching one caller proves nothing about the other — that is
	 * exactly how the two disagreed before.
	 */
	it("states the configured model in the hero rather than offering a login", async () => {
		await initTheme(false);
		settings.setModelRole("default", "nous-research/z-ai/glm-5.1");

		const frame = paintFirstFrame("1.1.1");
		try {
			const hero = stripAnsi(frame.hero.render(80).join("\n"));

			expect(hero).toContain("glm-5.1");
			expect(hero).not.toContain("no model yet");
		} finally {
			frame.release();
			frame.ui.stop();
			takeFirstFrame();
			// The paint caches the terminal's ground module-wide, and a cached black ground would
			// change every band and card rendered after this file in the same process.
			resetGroundTintsForTest();
		}
	});

	/** A recorded display name is what a catalog said, and it outranks a tail derived from an id. */
	it("prefers the recorded display name to the id it was recorded for", async () => {
		await record({ modelName: "Claude Sonnet 4" });

		expect(factsAtLaunch().model?.name).toBe("Claude Sonnet 4");
	});

	/**
	 * No role configured is the one case where `no model yet · /login` is TRUE, and the hero reaches
	 * it through an empty label. A tail invented for an absent role would replace an accurate
	 * placeholder with a fabricated model.
	 */
	it("states no model when none is configured", () => {
		settings.setModelRole("default", "");

		expect(factsAtLaunch().model).toBeNull();
		expect(launchModelLabel()).toBe("");
	});
});

/**
 * A FACT IS RECORDED UNDER THE MODEL THAT MEASURED IT, OR IT IS NOT RECORDED.
 *
 * The reader above validates facts against the key they were filed under, which is only half of it:
 * the writer decides what goes under that key, and it files under the configured DEFAULT ROLE
 * because that is the string the next launch has before a session exists. A session does not always
 * run that role — `--model` names another, `/model` switches before anything is sent, and a role
 * that will not resolve falls back — and a percentage is a fraction of the window of whichever
 * model measured it. Filed under the role regardless, the next launch draws a gauge against a
 * window its model does not have, and every key check in this file passes while it does.
 *
 * Driven through the real component and its real render, because the recorder runs inside the
 * segment build: a suite calling the module directly would prove the merge and never the guard.
 */
describe("what a running session records for the next launch", () => {
	/** The default role, and the session model that satisfies it. */
	const ROLE = "anthropic/claude-sonnet-4";
	const RUNS_THE_ROLE = { modelId: "claude-sonnet-4", modelProvider: "anthropic", modelName: "Claude Sonnet 4" };

	/** Render the row for `session`, which is what reaches the recorder, and report what it left. */
	function recordedAfterRender(options: StubSessionOptions): LaunchFacts {
		const session = makeStatusLineSession({
			contextUsage: { tokens: 32_000, contextWindow: 128_000 },
			...options,
		});
		new StatusLineComponent(session).renderQuietLine(120);
		return readLaunchFacts();
	}

	beforeEach(async () => {
		await initTheme(false);
		settings.setModelRole("default", ROLE);
	});

	it("records the reading and the name of the model the role names", () => {
		const recorded = recordedAfterRender(RUNS_THE_ROLE);

		expect(recorded.modelName).toBe("Claude Sonnet 4");
		expect(recorded.providerName).toBe("anthropic");
		// The record holds the percentage SPENT, which is what the gauge subtracts from to print
		// "75% left": 32k of a 128k window.
		expect(recorded.contextPercent).toBe(25);
	});

	/**
	 * The case the percentage guard exists for. A fallback model's window is not the role's, and
	 * the id here shares no prefix with it at all.
	 */
	it("records no reading measured by a model the role does not name", () => {
		const recorded = recordedAfterRender({ modelId: "deepseek-r1", modelName: "DeepSeek-R1" });

		expect(recorded).toEqual({ gitStatus: null, modelName: null, providerName: null, contextPercent: null });
	});

	/** A role carrying a thinking level or a route still names the same model, and still records. */
	it("records for a role that carries a suffix", () => {
		settings.setModelRole("default", `${ROLE}:thinking`);

		expect(recordedAfterRender(RUNS_THE_ROLE).contextPercent).toBe(25);
	});

	/**
	 * The prefix trap. `anthropic/claude-sonnet-45` starts with `anthropic/claude-sonnet-4`, and a
	 * match written as a bare `startsWith` would file a 45's reading under the 4's key — the exact
	 * cross-model leak the keys exist to prevent, arriving through the writer instead of the reader.
	 */
	it("records nothing for a role whose id merely starts with the model's", () => {
		settings.setModelRole("default", "anthropic/claude-sonnet-45");

		expect(recordedAfterRender(RUNS_THE_ROLE).contextPercent).toBeNull();
	});
});
