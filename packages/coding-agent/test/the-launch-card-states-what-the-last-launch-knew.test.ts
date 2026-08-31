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
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { LaunchComposerFoot } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { factsAtLaunch, launchSegmentContext } from "@veyyon/coding-agent/modes/components/status-line/session-facts";
import { paintFirstFrame, takeFirstFrame } from "@veyyon/coding-agent/modes/first-frame";
import {
	type LaunchFacts,
	type LaunchFactsUpdate,
	launchModelLabel,
	readLaunchFacts,
	recordLaunchFacts,
	resetLaunchFactsForTest,
} from "@veyyon/coding-agent/modes/launch-facts";
import { resetGroundTintsForTest } from "@veyyon/coding-agent/modes/theme/ground-tints";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";
import type { GitStatusSummary } from "@veyyon/coding-agent/utils/git";
import { getLaunchFactsCachePath, stripAnsi } from "@veyyon/utils";
import * as atomicWrite from "@veyyon/utils/atomic-write";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { makeStatusLineSession, type StubSessionOptions } from "./helpers/status-line-session";

const DIRTY: GitStatusSummary = { staged: 1, unstaged: 2, untracked: 3, truncated: false };
const CLEAN: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, truncated: false };

/**
 * Every fact absent, which is what a first launch and an invalidated key both read as.
 *
 * Typed, so a fact added to {@link LaunchFacts} fails to compile here until someone states what
 * its absent value is, and every whole-shape assertion in this suite picks it up.
 */
const ABSENT: LaunchFacts = {
	gitStatus: null,
	modelName: null,
	providerName: null,
	contextPercent: null,
	thinking: null,
};

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

/** Overwrite this project's or this model's entry, keeping the file shape the reader needs. */
function plantedEntry(map: "projects" | "models", fields: Record<string, unknown>): void {
	const file = onDisk();
	const rows = file[map] as Record<string, Record<string, unknown>>;
	const key = Object.keys(rows)[0] as string;
	planted({ ...file, [map]: { ...rows, [key]: { ...rows[key], ...fields } } });
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
		expect(readLaunchFacts()).toEqual(ABSENT);
	});

	/** The round trip, through the real file, for every fact the card draws. */
	it("states each fact the last launch recorded", async () => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic", contextPercent: 17.6, gitStatus: DIRTY });

		expect(readLaunchFacts()).toEqual({
			...ABSENT,
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
	it("drops the gauge when the model changed, and keeps the tree's marker", async () => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic", contextPercent: 40, gitStatus: DIRTY });

		settings.setModelRole("default", MODEL_B);

		expect(readLaunchFacts()).toEqual({ ...ABSENT, gitStatus: DIRTY });
	});

	/**
	 * THE SCOPE SPLIT. A display name, its provider, the effort and the model's own resting cost
	 * describe the MODEL and are the same wherever it runs, so the first launch in a new project
	 * states them rather than printing a raw id, growing an effort tail, and drawing an empty bar
	 * when the session lands. The working tree is the one fact that stays absent, because a marker
	 * from another directory would be a claim about this one.
	 */
	it("states what the model knows in a project it has never been used in, and no tree marker", async () => {
		await record({
			modelName: "Claude Sonnet 4",
			providerName: "anthropic",
			thinking: ThinkingLevel.High,
			contextPercent: 40,
			gitStatus: DIRTY,
		});
		const file = onDisk();
		const projects = file.projects as Record<string, unknown>;
		const [key, entry] = Object.entries(projects)[0] as [string, unknown];

		planted({ ...file, projects: { [`${key}-elsewhere`]: entry } });

		expect(readLaunchFacts()).toEqual({
			...ABSENT,
			modelName: "Claude Sonnet 4",
			providerName: "anthropic",
			thinking: ThinkingLevel.High,
			contextPercent: 40,
		});
	});

	/**
	 * THE GAUGE IS NEVER UNKNOWN ONCE THIS MODEL HAS RESTED ANYWHERE. `? left` with an empty bar is
	 * the one placeholder that redraws the whole row when the session lands, and the reading it is
	 * standing in for is mostly the model's own: the system prompt, the tool schemas and the skills
	 * index cost the same wherever it runs. The project's own reading still wins where it exists,
	 * so the fallback is what an unmeasured project states and never an override of a measured one.
	 */
	it("prefers this project's reading to the model's, and states the model's when it has none", async () => {
		await record({ contextPercent: 40 });
		const file = onDisk();
		const projects = file.projects as Record<string, Record<string, unknown>>;
		const [key, entry] = Object.entries(projects)[0] as [string, Record<string, unknown>];

		// This project measured 55 while the model last rested at 40 somewhere else.
		planted({ ...file, projects: { [key]: { ...entry, contextPercent: 55 } } });
		expect(readLaunchFacts().contextPercent).toBe(55);

		// The same model, in a directory that has measured nothing.
		planted({ ...file, projects: { [`${key}-elsewhere`]: entry } });
		expect(readLaunchFacts().contextPercent).toBe(40);
	});

	/**
	 * The fallback answers to the model key like every other model fact. A reading taken against
	 * another model's window is not a smaller error than `?`, it is a bar drawn against a window
	 * this model does not have.
	 */
	it("states no reading at all when the model has never rested", async () => {
		await record({ contextPercent: 40, modelName: "Claude Sonnet 4" });

		settings.setModelRole("default", MODEL_B);

		expect(readLaunchFacts().contextPercent).toBeNull();
	});

	/**
	 * The release keys both maps, because every value in them was recorded by the code that shipped
	 * with it. An upgrade starts cold rather than replaying a fact whose meaning may have moved.
	 */
	it("drops every fact when the release changed", async () => {
		await record({
			modelName: "Claude Sonnet 4",
			thinking: ThinkingLevel.High,
			contextPercent: 40,
			gitStatus: DIRTY,
		});
		const file = onDisk();
		const rekey = (map: unknown): Record<string, unknown> =>
			Object.fromEntries(Object.entries(map as Record<string, unknown>).map(([k, v]) => [`0.0.0-other|${k}`, v]));

		planted({ ...file, projects: rekey(file.projects), models: rekey(file.models) });

		expect(readLaunchFacts()).toEqual(ABSENT);
	});

	/**
	 * The same rule from the other side. An entry filed under the bare role, which is what a model
	 * key without the release resolves to, is not this release's fact and is not read as one.
	 */
	it("reads no model entry that was filed without a release", async () => {
		await record({ modelName: "Claude Sonnet 4" });

		planted({
			version: 3,
			projects: {},
			models: { [MODEL_A]: { name: "Stale", thinking: ThinkingLevel.High, recordedAt: 1 } },
		});

		expect(readLaunchFacts()).toEqual(ABSENT);
	});

	/**
	 * THE DEFECT THIS CLOSES. The file held ONE project's facts, so a launch here erased what the
	 * project next door knew and the gauge read `?` on every start for anyone who works in two.
	 * Recording under a second project must leave the first's entry intact.
	 */
	it("keeps each project's facts when another project records its own", async () => {
		await record({ modelName: "Claude Sonnet 4", contextPercent: 40, gitStatus: DIRTY });
		const mine = onDisk();
		const projects = mine.projects as Record<string, unknown>;
		const [key, entry] = Object.entries(projects)[0] as [string, unknown];

		// A neighbouring project's entry, as its own launch would have written it.
		planted({ ...mine, projects: { [`${key}-next-door`]: entry, [key]: entry } });
		await record({ contextPercent: 55 });

		const after = (onDisk().projects as Record<string, Record<string, unknown>>) ?? {};
		expect(Object.keys(after).sort()).toEqual([key, `${key}-next-door`].sort());
		expect(after[`${key}-next-door`]?.contextPercent).toBe(40);
		expect(readLaunchFacts().contextPercent).toBe(55);
	});

	/**
	 * The maps are a cache, so they are bounded: a machine that opens hundreds of directories, or
	 * tries a hundred models, must not grow a file the first frame reads. The oldest WRITE leaves,
	 * not the oldest key, so what someone returns to stays and the one-off is what goes.
	 *
	 * Swept from the file rather than named, so a third map added later is bounded or red here.
	 */
	it("keeps every map in the file bounded, evicting the oldest write", async () => {
		await record({ contextPercent: 40, modelName: "Claude Sonnet 4" });
		const mine = onDisk();
		const maps = Object.keys(mine).filter(name => name !== "version");

		expect(maps.sort()).toEqual(["models", "projects"]);
		for (const map of maps) {
			const rows = mine[map] as Record<string, Record<string, unknown>>;
			const [key, entry] = Object.entries(rows)[0] as [string, Record<string, unknown>];
			const crowd: Record<string, unknown> = {};
			for (let i = 0; i < 60; i++) crowd[`${key}-other-${i}`] = { ...entry, recordedAt: 1_000 + i };

			planted({ ...mine, [map]: { ...crowd, [key]: { ...entry, recordedAt: 1 } } });
			await record({ contextPercent: 55, modelName: "Claude Sonnet 4.5" });

			const keys = Object.keys(onDisk()[map] as Record<string, unknown>);
			expect(keys.length, `${map} is unbounded`).toBeLessThanOrEqual(24);
			// This entry just wrote, so it survives however old its previous copy was, and the
			// oldest of the crowd is gone.
			expect(keys, `${map} evicted the entry it just wrote`).toContain(key);
			expect(keys, `${map} kept its oldest write`).not.toContain(`${key}-other-0`);
		}
		expect(readLaunchFacts().contextPercent).toBe(55);
		expect(readLaunchFacts().modelName).toBe("Claude Sonnet 4.5");
	});

	/**
	 * A file truncated by a crash mid-write, hand-edited, or replaced with the wrong shape. The
	 * card must fall back to placeholders rather than throw on the frame it is painting.
	 *
	 * Every shape a previous release wrote is in the list. Each parses, and each files a fact under
	 * a key this reader resolves differently — one project's facts with no map to look them up in,
	 * or a display name filed per project rather than per model — so a stale copy must be REJECTED
	 * rather than served.
	 */
	it("knows nothing from a damaged file, whatever the damage", async () => {
		await record({ modelName: "Claude Sonnet 4", contextPercent: 40, gitStatus: DIRTY });
		const key = Object.keys(onDisk().projects as Record<string, unknown>)[0] as string;

		for (const damaged of [
			"",
			"{",
			"null",
			"[]",
			'"40"',
			JSON.stringify({ projects: { [key]: { modelRole: MODEL_A, contextPercent: 40 } } }),
			JSON.stringify({ version: 1, projects: { [key]: { modelRole: MODEL_A, contextPercent: 40 } } }),
			JSON.stringify({ version: 3, projects: "not a map", models: {} }),
			JSON.stringify({ version: 3, projects: {}, models: "not a map" }),
			// A map the reader would index into without checking it is there.
			JSON.stringify({ version: 3, projects: {} }),
			JSON.stringify({ version: 3, models: {} }),
			// The shape before the model map: name, provider and effort filed under the project.
			JSON.stringify({
				version: 2,
				projects: { [key]: { modelRole: MODEL_A, modelName: "Stale", contextPercent: 40 } },
			}),
			// The shape before either map: one project's facts under top-level keys.
			JSON.stringify({ projectKey: key, modelKey: `${key}|${MODEL_A}`, contextPercent: 40, modelName: "Stale" }),
		]) {
			planted(damaged);

			expect(readLaunchFacts()).toEqual(ABSENT);
		}
	});

	/**
	 * A summary that parses but is not one. It reaches `isTreeDirty`, which compares each count
	 * against zero — a string there decides dirtiness on a comparison nobody intended.
	 */
	it("rejects a git summary that is not one", async () => {
		await record({ gitStatus: DIRTY });

		for (const bad of [
			{ staged: "1", unstaged: 0, untracked: 0, truncated: false },
			{ staged: 1, unstaged: 0, untracked: 0 },
			{ staged: -1, unstaged: 0, untracked: 0, truncated: false },
			{ staged: Number.NaN, unstaged: 0, untracked: 0, truncated: false },
			"dirty",
			[],
		]) {
			plantedEntry("projects", { gitStatus: bad });

			expect(readLaunchFacts().gitStatus).toBeNull();
		}
	});

	/**
	 * A name that is present and empty is not a name. Served as one it reaches the hero and the
	 * model segment as a blank where an id belongs, which reads as a model with no name rather than
	 * as the fallback the card has for exactly this.
	 */
	it.each(["name", "provider"] as const)("rejects an empty %s", async field => {
		await record({ modelName: "Claude Sonnet 4", providerName: "anthropic" });

		plantedEntry("models", { [field]: "" });

		const facts = readLaunchFacts();
		expect(field === "name" ? facts.modelName : facts.providerName).toBeNull();
	});

	/**
	 * A percentage outside the band is a damaged file that still parses. Clamped rather than
	 * rejected, because the bar derives its filled cells from it and 140 would draw past them.
	 */
	it("clamps a percentage from outside the band", async () => {
		await record({ contextPercent: 40 });

		plantedEntry("projects", { contextPercent: 140 });
		expect(readLaunchFacts().contextPercent).toBe(100);

		plantedEntry("projects", { contextPercent: -20 });
		expect(readLaunchFacts().contextPercent).toBe(0);
	});

	/**
	 * Nothing that is not a finite number is a reading. A percentage arrives from a file on disk
	 * that an editor, a truncated write or an older build may have left in any shape, and the bar
	 * derives its filled cells arithmetically: a string sails through a clamp and draws.
	 */
	it.each([["40"], [null], [{}], [true]])("states no reading for %p on disk", async damaged => {
		await record({ contextPercent: 40 });

		plantedEntry("projects", { contextPercent: damaged });
		plantedEntry("models", { contextPercent: damaged });

		expect(readLaunchFacts().contextPercent).toBeNull();
	});

	/**
	 * The model's copy of the reading merges like every other model fact. An update carrying only
	 * a display name must not erase it, or the next unmeasured project draws an empty bar because
	 * some later redraw mentioned something else.
	 */
	it("keeps the model's reading when a later update does not mention it", async () => {
		await record({ contextPercent: 40 });
		await record({ modelName: "Claude Sonnet 4" });

		const file = onDisk();
		const projects = file.projects as Record<string, unknown>;
		const [key, entry] = Object.entries(projects)[0] as [string, unknown];
		planted({ ...file, projects: { [`${key}-elsewhere`]: entry } });

		expect(readLaunchFacts().contextPercent).toBe(40);
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
			...ABSENT,
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
		const written: string[] = [];
		vi.spyOn(atomicWrite, "atomicWriteJson").mockImplementation(async (file: string) => {
			written.push(file);
		});

		for (let redraw = 0; redraw < 50; redraw++) await recordLaunchFacts({ contextPercent: 40, gitStatus: DIRTY });

		expect(written).toEqual([]);
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

		expect(readLaunchFacts()).toEqual({ ...ABSENT, modelName: "Claude Sonnet 4", contextPercent: 40 });
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

		expect(readLaunchFacts()).toEqual({ ...ABSENT, gitStatus: DIRTY });
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

		expect(recorded).toEqual(ABSENT);
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

/**
 * WHY THIS EXISTS. The status row prints the effort beside the model (`GLM-5.2 High @high`), and
 * the card could not: the level is resolved per model and then CLAMPED to the rungs that model
 * supports, so neither `defaultEffort` nor the role's `:thinking` suffix states what the row will
 * print. The card drew the model with no tail and grew one 600ms later, which shifted every
 * segment right of it.
 *
 * THE CLASS. Any fact whose value depends on the resolved model, recorded under a key that does
 * not name that model, or carried forward after the state that produced it went away. The effort
 * is the first one that can be turned OFF while its model stays, which is why it is the one fact
 * with an explicit clear.
 *
 * WHAT IT DOES NOT CATCH: whether the clamp itself is right. That belongs to the resolver; this
 * proves the card states whatever the row settled on and nothing else.
 */
describe("the effort the card prints before a session resolves one", () => {
	const ROLE = "anthropic/claude-sonnet-4";
	const THINKS = { modelId: "claude-sonnet-4", modelProvider: "anthropic", modelThinking: true };

	function recordedAfterRender(options: StubSessionOptions): LaunchFacts {
		new StatusLineComponent(makeStatusLineSession(options)).renderQuietLine(120);
		return readLaunchFacts();
	}

	beforeEach(async () => {
		await initTheme(false);
		settings.setModelRole("default", ROLE);
	});

	it("records the rung the row settled on", () => {
		expect(recordedAfterRender({ ...THINKS, thinkingLevel: ThinkingLevel.High }).thinking).toBe(ThinkingLevel.High);
	});

	/** `auto` is a mode: the rung it resolves to belongs to a turn, and no turn has run. */
	it("records auto as itself rather than the rung it happened to resolve to", () => {
		const recorded = recordedAfterRender({ ...THINKS, thinkingLevel: ThinkingLevel.High, autoThinking: true });

		expect(recorded.thinking).toBe(AUTO_THINKING);
	});

	/** Each way a row prints no tail, and each must read back as no tail rather than as unknown. */
	it.each([
		["a model with no controllable effort", { modelId: "claude-sonnet-4", modelProvider: "anthropic" }],
		["thinking turned off", { ...THINKS, thinkingLevel: ThinkingLevel.Off }],
	])("records nothing for %s", (_label, options) => {
		expect(recordedAfterRender(options as StubSessionOptions).thinking).toBeNull();
	});

	/**
	 * THE CLEAR, once per reason the tail can disappear. Every other fact is kept when an update
	 * omits it, because it describes something that exists and was merely unresolved. A row with no
	 * effort is a fact, and a recorder that treated it as silence would print `@high` on a row that
	 * no longer has one, forever. Both arms matter: the rung can be turned off while the ladder
	 * stays, and the ladder itself goes when a provider stops offering one for the same id.
	 */
	it.each([
		["the rung is turned off", { ...THINKS, thinkingLevel: ThinkingLevel.Off }],
		["the model loses its ladder", { modelId: "claude-sonnet-4", modelProvider: "anthropic" }],
	])("erases the rung it recorded when %s", async (_label, options) => {
		await record({ thinking: ThinkingLevel.High });

		expect(recordedAfterRender(options as StubSessionOptions).thinking).toBeNull();
	});

	/**
	 * The counterpart to the clear. A launch that resolves no effort at all — the row rendered
	 * before the session settled, a redraw that carried only a git summary — leaves the recorded
	 * one alone, or the card would lose the tail to every write that was not about it.
	 */
	it("keeps the rung when a later update does not mention it", async () => {
		await record({ thinking: ThinkingLevel.High });
		await record({ contextPercent: 40 });

		expect(readLaunchFacts().thinking).toBe(ThinkingLevel.High);
	});

	/**
	 * The same key discipline the gauge has, from the writer's side: an effort measured on a
	 * fallback model, or on one `/model` switched to without persisting, is filed under the role's
	 * key by a recorder that skips the gate, and the next launch prints a rung its model may not
	 * have.
	 */
	it("records no rung resolved on a model the role does not name", () => {
		const recorded = recordedAfterRender({
			modelId: "deepseek-r1",
			modelThinking: true,
			thinkingLevel: ThinkingLevel.High,
		});

		expect(recorded.thinking).toBeNull();
	});

	/** Model-scoped like the gauge: a rung is clamped to one model's ladder and states nothing of another's. */
	it("drops the rung when the role names another model", () => {
		recordedAfterRender({ ...THINKS, thinkingLevel: ThinkingLevel.High });
		settings.setModelRole("default", "openai/gpt-5");

		expect(readLaunchFacts().thinking).toBeNull();
	});

	/**
	 * The row prints this value through a theme table keyed by the rung. A file someone edited, or
	 * one written by a release with a rung this one dropped, must not put its own text on the row.
	 */
	it.each(["ultra", "", "high ", "HIGH", 4, null, {}])("rejects %p from a damaged file", async damaged => {
		await record({ thinking: ThinkingLevel.High });
		plantedEntry("models", { thinking: damaged });

		expect(readLaunchFacts().thinking).toBeNull();
	});

	/**
	 * The seam that made the row shift. The recorded rung has to reach the segment context the
	 * card renders from, and `supportsThinking` has to come with it: the segment gates the tail on
	 * that flag, so a replayed rung with the flag left false prints nothing and proves nothing.
	 */
	it("reaches the row the card paints", async () => {
		await record({ thinking: ThinkingLevel.High, modelName: "Claude Sonnet 4" });

		const facts = factsAtLaunch();
		expect(facts.model?.supportsThinking).toBe(true);
		expect(facts.thinkingLevel).toBe(ThinkingLevel.High);
		expect(facts.autoThinking).toBeNull();
		expect(stripAnsi(cardContext().facts.model?.name ?? "")).toBe("Claude Sonnet 4");
	});

	/** Auto replays as the pending marker, which is what a session that has classified no turn prints. */
	it("replays auto as pending rather than as a rung", async () => {
		await record({ thinking: AUTO_THINKING });

		const facts = factsAtLaunch();
		expect(facts.autoThinking).toEqual({ resolved: null });
		expect(facts.thinkingLevel).toBe(ThinkingLevel.Off);
	});

	/** Nothing recorded is a model with no tail, not a model whose tail is unknown. */
	it("states no effort when none was recorded", () => {
		expect(factsAtLaunch().model?.supportsThinking).toBe(false);
		expect(factsAtLaunch().thinkingLevel).toBe(ThinkingLevel.Off);
	});
});
