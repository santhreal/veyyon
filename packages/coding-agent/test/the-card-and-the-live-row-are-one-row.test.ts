/**
 * A segment the resolved preset declares reaches the launch card, or somebody decided it does not.
 *
 * WHY THIS SUITE EXISTS. The card paints the composer footline about a second before the status
 * line mounts (measured on a pty: card and composer at 84-102ms, status row still blank at 1067ms),
 * and it used to paint a hand-written `path · git` there. That copy had no way to go stale loudly:
 * every segment added to a preset after it was written was simply missing from the card, the live
 * row landed on top with more on it, and no test could see the difference, because the copy was
 * correct about the two things it knew. The card now renders through the same gather-and-fit the
 * live row uses (`gatherQuietSegments`, `composeQuietRow`) over `launchSegmentContext`.
 *
 * THE CLASS, NOT THE INCIDENT. The defect was not "the card lacked a cost segment". It was "a
 * segment reached one row and not the other, silently". So the variant space is derived at run
 * time and swept twice over: every preset in `STATUS_LINE_PRESETS`, and inside each, every id
 * `resolvePresetSegments` resolves for it — the same resolver the card calls, so a preset whose
 * configured lists override the table is swept as the card actually renders it. Every resolved id
 * is either proven present in the card's own row bytes or recorded below as silent. A preset that
 * gains an id, or a whole new preset, turns this red until someone puts it in one bucket.
 *
 * WHAT WAS TRIED AGAINST IT. Three ways to reintroduce the class, each injected into the source
 * and reverted: reverting the card to the hand-written `path · git` (red on every preset), making
 * `launchSegmentContext` start from `NO_SESSION_FACTS` instead of config (red on the model and rung
 * case — and green before this suite seeded a model and an approval mode, which is why it does),
 * and freezing the card's preset to `default` (red on the presets that differ from it, and on the
 * repaint case).
 *
 * WHAT IT DOES NOT CATCH. It proves the id's launch content reaches the card, not that the live
 * row later renders the same bytes for it: the live row has facts the card cannot have (a session
 * name, a measured gauge), which is the whole reason the two rows differ at all. Byte agreement
 * for the one fact both rows have before any lookup — the branch — is held in
 * `modes/components/status-line/the-branch-reads-the-same-on-the-card-and-the-live-row.test.ts`,
 * and that the rows land on the same SCREEN ROW is held in
 * `the-first-frame-paints-the-composer-instantly.test.ts`. Every case here runs wide enough that
 * the fitter sheds nothing, because what a narrow row drops is the fitter's contract and is
 * asserted against the fitter.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import {
	COMPOSER_INSET_COLS,
	LaunchComposerFoot,
} from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import {
	resolvePresetSegments,
	STATUS_LINE_PRESETS,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/presets";
import {
	effectiveStatusLineSettings,
	gatherQuietSegments,
	statusLineSettingsFromConfig,
	subagentBadgeText,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/quiet-row";
import { launchSegmentContext } from "@veyyon/coding-agent/modes/terminal/components/status-line/session-facts";
import type { StatusLinePreset } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { branchLabelFromFiles } from "@veyyon/coding-agent/utils/git-head";
import * as utils from "@veyyon/utils";
import { getProjectDir, stripAnsi } from "@veyyon/utils";

/**
 * The profile chip hides on the built-in `default` profile and shows on any named one, so the
 * recorded tables below would otherwise depend on whose machine ran them. Pinned to a named
 * profile, which is the case that puts the chip on the row: the hidden case adds nothing here,
 * since a chip that renders nothing cannot go missing from the card.
 */
const ACTIVE_PROFILE = "work";

/** Wide enough that the fitter sheds nothing: this suite is about presence, not degradation. */
const WIDE = 400;

/** What the card hands the segments, which is the terminal minus the composer's own inset. */
const SEGMENT_WIDTH = WIDE - COMPOSER_INSET_COLS;

/**
 * Ids that render nothing at launch, per preset, each because the fact behind it does not exist
 * before a session does — no spend to report, no measured cache, no named session, no credential
 * store read, no PR looked up.
 *
 * Pinned by exact equality rather than by count, and per preset rather than as a union, so the
 * table states what each row looks like at rest. A newly silent id fails here, which is the case
 * that matters: it means a segment stopped reaching the card. An id that stops being silent fails
 * here too, which is the other case that matters: it means a segment started stating a value
 * before anything measured one.
 */
const SILENT_AT_LAUNCH: Record<string, string[]> = {
	default: ["account", "background", "secrets", "session_name"],
	minimal: ["account", "background", "secrets", "session_name"],
	compact: ["account", "background", "cost", "pr", "secrets", "session_name"],
	full: [
		"account",
		"background",
		"cache_hit",
		"cache_read",
		"cost",
		"pi",
		"pr",
		"secrets",
		"session_name",
		"time_spent",
		"token_in",
		"token_out",
		"token_rate",
	],
	nerd: [
		"account",
		"background",
		"cache_read",
		"cache_write",
		"context_total",
		"cost",
		"pi",
		"pr",
		"secrets",
		"session_name",
		"time_spent",
		"token_in",
		"token_out",
		"token_rate",
	],
	ascii: ["account", "background", "cost", "pr", "secrets", "session_name", "token_total"],
	// `custom` resolves the CONFIGURED lists, and the shipped config configures none, so the row is
	// empty and there is nothing to be silent about. That is the card rendering the preset
	// faithfully, not the card failing to render.
	custom: [],
};

/** The card's footline row, as the component paints it, with the inset removed. */
function cardRow(): string {
	const rows = new LaunchComposerFoot().render(WIDE);
	const footline = rows.find(row => stripAnsi(row).trim().length > 0);
	return stripAnsi(footline ?? "").slice(COMPOSER_INSET_COLS);
}

/**
 * What the card's gatherer produces for the current settings, keyed by segment id.
 *
 * This calls the production gatherer at the width the card gives it, so a part's bytes here are
 * the bytes the card composed — no second clipping rule, and no re-derived budget that would make
 * the location segment disagree with itself.
 */
function launchParts(): Map<string, string> {
	const effective = effectiveStatusLineSettings(statusLineSettingsFromConfig());
	const branch = branchLabelFromFiles(getProjectDir());
	const groups = gatherQuietSegments({
		width: SEGMENT_WIDTH,
		effectiveSettings: effective,
		gitEnabled: true,
		expansion: 0,
		buildContext: request =>
			launchSegmentContext({
				width: request.width,
				options: request.options,
				compactThinkingLevel: effective.compactThinkingLevel ?? false,
				branch,
				autoCompactEnabled: false,
			}),
		subagentBadge: subagentBadgeText(0),
		badgeSlot: null,
	});
	const parts = new Map<string, string>();
	for (const part of [...groups.location, ...groups.capLeft, ...groups.capRight]) {
		parts.set(part.id, stripAnsi(part.content));
	}
	return parts;
}

/** The ids the card resolves for `preset`, which is not the table's list when config overrides it. */
function resolvedIds(preset: StatusLinePreset): string[] {
	const configured = statusLineSettingsFromConfig();
	const resolved = resolvePresetSegments(preset, {
		left: configured.leftSegments,
		right: configured.rightSegments,
	});
	return [...new Set([...resolved.left, ...resolved.right])];
}

/**
 * The config the launch row reads, seeded to non-default values.
 *
 * A store with nothing in it makes `factsAtLaunch()` and `NO_SESSION_FACTS` the same block, and a
 * `launchSegmentContext` that dropped config entirely would then satisfy every case below — the
 * mutation was run and it survived. These two values are what make the model and mode segments
 * carry something only config can supply, so dropping config turns the sweep red.
 */
const CONFIGURED_MODEL = "claude-sonnet-4-5";
const CONFIGURED_APPROVAL = "yolo";

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false);
	settings.setModelRole("default", CONFIGURED_MODEL);
	settings.set("tools.approvalMode", CONFIGURED_APPROVAL);
});

afterAll(() => {
	// The seeded model role and approval rung are process-wide; a later file in the bucket must not
	// inherit them, and must not inherit an in-memory store it did not initialize.
	resetSettingsForTest();
});

/** The one thing this suite mocks, restored per test. */
let profileSpy: Mock<() => string> | null = null;

beforeEach(() => {
	// Per test, restored below: a file-wide override of the profile resolver would follow this
	// suite into every later file in the bucket.
	profileSpy = spyOn(utils, "getActiveProfileOrDefault").mockReturnValue(ACTIVE_PROFILE);
});

afterEach(() => {
	settings.set("statusLine.preset", "default");
	profileSpy?.mockRestore();
	profileSpy = null;
});

describe("the card and the live row are one row", () => {
	/**
	 * The sweep below is "every resolved id is present or silent", which an empty preset table and
	 * an empty id list both satisfy vacuously. This is what makes those cases mean something.
	 */
	it("sweeps the real preset table, resolved the way the card resolves it", () => {
		const names = Object.keys(STATUS_LINE_PRESETS);

		expect(names).toContain("default");
		expect(names.length).toBeGreaterThan(3);
		expect(resolvedIds("default")).toContain("path");
		expect(resolvedIds("default")).toContain("model");
	});

	/** Every preset gets its own case, so a failure names the row that lost a segment. */
	for (const preset of Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[]) {
		it(`puts every segment the ${preset} preset resolves on the card`, () => {
			settings.set("statusLine.preset", preset);
			const row = cardRow();
			const parts = launchParts();

			const missing = resolvedIds(preset).filter(id => {
				const content = parts.get(id);
				return content !== undefined && content.length > 0 && !row.includes(content);
			});

			expect(missing).toEqual([]);
		});

		/**
		 * And the case above is not passing because the row is blank. This pins which ids render
		 * nothing, so "present" cannot quietly become "absent from both sides".
		 */
		it(`renders nothing at launch for exactly the recorded ${preset} segments`, () => {
			settings.set("statusLine.preset", preset);
			const parts = launchParts();

			const silent = resolvedIds(preset)
				.filter(id => (parts.get(id) ?? "").length === 0)
				.sort();

			expect(silent).toEqual(SILENT_AT_LAUNCH[preset] ?? []);
		});
	}

	/**
	 * The card reads config on every render rather than a snapshot taken when the module loaded.
	 * Without this, the per-preset cases above would all be measuring the default row.
	 */
	it("repaints against the configured preset rather than one frozen at import", () => {
		const before = cardRow();
		settings.set("statusLine.preset", "nerd");

		expect(cardRow()).not.toBe(before);
	});

	/**
	 * The card states the facts only config can supply, which is the whole reason
	 * `launchSegmentContext` reads config rather than starting from an empty block. Both values are
	 * non-default and neither can come from anywhere else before a session exists: the model is the
	 * persisted default role, and `yolo` is a configured rung that the row must never understate.
	 */
	it("states the model and the approval rung config names, before any session resolves them", () => {
		const row = cardRow();

		expect(row).toContain(CONFIGURED_MODEL);
		expect(row.toLowerCase()).toContain(CONFIGURED_APPROVAL);
	});
});
