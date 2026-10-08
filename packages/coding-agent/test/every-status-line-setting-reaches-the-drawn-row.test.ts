// WHY THIS SUITE EXISTS.
//
// A status-line setting whose every value draws the same row is a knob that does nothing. Three
// shipped: the row's option merge wrote `roomy: true` over the configured model options, so
// `statusLine.segmentOptions.model.roomy: false` never reached the model segment; and the
// `separator` and `transparent` fields survived the bordered status line with no reader at all.
//
// The class this closes: a field of `StatusLineSettings`, or an option of a segment, that the row
// drops between the settings store and the drawn row. Each is set in the store, the row is built the
// way the composer builds it, and the drawn output (the footline plus the hook row) must differ
// between two values. The variant tables are keyed by the types, so a new field or option fails the
// type check until it is given a pair here. At run time, the fields the store reader returns must be
// exactly the swept ones, every option a preset sets must be swept, and every `statusLine.*` setting
// the reader does not return is pinned by exact equality.
//
// WHAT IT DOES NOT CATCH: a value that changes the row in the wrong way (each option's own suite
// owns what it draws), an option read only by a code path this row does not take (the launch card,
// an expanded path), and whether a pinned setting that the reader skips reaches its own consumer.

import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as os from "node:os";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { resetLaunchFactsForTest } from "@veyyon/coding-agent/config/launch-facts";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { isSettingPath, settingsSchemaPaths } from "@veyyon/coding-agent/config/settings-schema";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/terminal/components/status-line/presets";
import { statusLineSettingsFromConfig } from "@veyyon/coding-agent/modes/terminal/components/status-line/quiet-row";
import type {
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import * as git from "@veyyon/coding-agent/utils/git";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { makeStatusLineProducer } from "./helpers/status-line-session";

const WIDTH = 200;
/** A home outside every scratch root, so the path segment strips display roots rather than a temp dir. */
const HOME = "/sweep-home";
const CWD = `${HOME}/Projects/sweep/app`;
const MODEL = "claude-3-7-sonnet";

/** The row every variant starts from: each swept segment on it, each field at a value its variant moves. */
const BASE: Required<StatusLineSettings> = {
	preset: "custom",
	leftSegments: ["model", "path", "git"],
	rightSegments: ["session_name", "time"],
	segmentOptions: {},
	showHookStatus: true,
	compactThinkingLevel: false,
};

/** A value per field that must draw a different row from {@link BASE}. */
const FIELD_VARIANTS: { [K in keyof Required<StatusLineSettings>]: StatusLineSettings[K] } = {
	preset: "minimal",
	leftSegments: ["path", "git"],
	rightSegments: ["session_name"],
	segmentOptions: { model: { showThinkingLevel: false } },
	showHookStatus: false,
	compactThinkingLevel: true,
};

/** `statusLine.*` settings the reader does not return, each read by its consumer from the store. */
const READ_ELSEWHERE = ["statusLine.enabled", "statusLine.sessionAccent", "statusLine.showAccount"];

type OptionPairs<T> = { [K in keyof Required<T>]: readonly [T, T] };

/**
 * Two option sets per segment option that differ in that option alone and must draw different rows.
 * The path pairs hold the neighbouring options still where the option under test only shows beside
 * them: abbreviation only shows on a path that still starts at the home directory.
 */
const SEGMENT_OPTION_PAIRS: {
	[S in keyof Required<StatusLineSegmentOptions>]: OptionPairs<NonNullable<StatusLineSegmentOptions[S]>>;
} = {
	model: {
		showThinkingLevel: [{ showThinkingLevel: true }, { showThinkingLevel: false }],
		roomy: [{ roomy: true }, { roomy: false }],
	},
	path: {
		abbreviate: [
			{ stripWorkPrefix: false, abbreviate: true },
			{ stripWorkPrefix: false, abbreviate: false },
		],
		maxLength: [{ maxLength: 40 }, { maxLength: 5 }],
		stripWorkPrefix: [{ stripWorkPrefix: true }, { stripWorkPrefix: false }],
		displayRoots: [{ displayRoots: ["~/Projects"] }, { displayRoots: ["~/Projects/sweep"] }],
	},
	git: {
		showBranch: [{ showBranch: true }, { showBranch: false }],
	},
	time: {
		format: [{ format: "24h" }, { format: "12h" }],
		showSeconds: [{ showSeconds: false }, { showSeconds: true }],
	},
};

/** Write every field of {@link BASE} into the store as `statusLine.<field>`, then the overrides on top. */
function configure(overrides: Record<string, unknown> = {}): void {
	for (const [field, value] of Object.entries({ ...BASE, ...overrides })) {
		const path = `statusLine.${field}`;
		if (!isSettingPath(path)) throw new Error(`${path} is not a setting`);
		settings.set(path, value as never);
	}
}

/** The row the composer draws from the store: the footline, then the hook row beneath it. */
function drawnRow(): string {
	const row = new StatusLineComponent(
		makeStatusLineProducer({
			cwd: () => CWD,
			modelId: MODEL,
			modelThinking: true,
			thinkingLevel: ThinkingLevel.High,
			sessionName: "sweep session",
		}),
	);
	row.setHookStatus("sweep", "hook ran");
	const drawn = [row.renderQuietLine(WIDTH) ?? "", ...row.render(WIDTH)].join("\n");
	row.dispose();
	return drawn;
}

let isolated: IsolatedConfigRoot;

beforeEach(async () => {
	isolated = enterIsolatedConfigRoot("status-line-setting-sweep", { defaultProfile: true });
	resetLaunchFactsForTest();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	vi.spyOn(os, "homedir").mockReturnValue(HOME);
	// A branch to show and no git subprocess: HEAD answers from memory, the status read from nothing.
	vi.spyOn(git.head, "resolveSync").mockReturnValue({
		kind: "ref",
		branchName: "feature",
		ref: "refs/heads/feature",
		commit: null,
		commonDir: "/repo/.git",
		gitDir: "/repo/.git",
		gitEntryPath: "/repo/.git",
		headPath: "/repo/.git/HEAD",
		repoRoot: "/repo",
		headContent: "ref: refs/heads/feature\n",
	});
	vi.spyOn(git.status, "summary").mockResolvedValue(null);
	// 14:05:09 local, so the clock reads differently in 12h and 24h and with and without seconds.
	setSystemTime(new Date(2026, 0, 2, 14, 5, 9));
});

afterEach(() => {
	setSystemTime();
	vi.restoreAllMocks();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	isolated.restore();
});

describe("every status line setting reaches the drawn row", () => {
	it("reads exactly the swept fields from the store, and pins every other statusLine setting", () => {
		const read = Object.keys(statusLineSettingsFromConfig()).sort();
		expect(read).toEqual(Object.keys(FIELD_VARIANTS).sort());

		const unread: string[] = settingsSchemaPaths()
			.filter(path => path.startsWith("statusLine."))
			.filter(path => !read.includes(path.slice("statusLine.".length)))
			.sort();
		expect(unread).toEqual(READ_ELSEWHERE);
	});

	for (const [field, variant] of Object.entries(FIELD_VARIANTS)) {
		it(`draws a different row when ${field} changes`, () => {
			configure();
			const base = drawnRow();
			configure({ [field]: variant });

			expect(drawnRow()).not.toBe(base);
		});
	}

	it("sweeps every segment option a preset sets", () => {
		const swept = SEGMENT_OPTION_PAIRS as Record<string, Record<string, unknown>>;
		const setByAPreset = Object.values(STATUS_LINE_PRESETS).flatMap(preset =>
			Object.entries(preset.segmentOptions ?? {}).flatMap(([segment, options]) =>
				Object.keys(options ?? {}).map(option => `${segment}.${option}`),
			),
		);
		// Non-vacuity: the presets set options, so an empty list would mean the table moved.
		expect(setByAPreset.length).toBeGreaterThan(0);
		for (const key of setByAPreset) {
			const [segment, option] = key.split(".");
			expect(swept[segment!]?.[option!], key).toBeDefined();
		}
	});

	for (const [segment, pairs] of Object.entries(SEGMENT_OPTION_PAIRS)) {
		for (const [option, [first, second]] of Object.entries(
			pairs as Record<string, readonly [Record<string, unknown>, Record<string, unknown>]>,
		)) {
			it(`draws a different row when segmentOptions.${segment}.${option} changes`, () => {
				// The pair isolates its option: every other key agrees, and this one does not.
				const { [option]: firstValue, ...firstRest } = first;
				const { [option]: secondValue, ...secondRest } = second;
				expect(firstRest).toEqual(secondRest);
				expect(firstValue).not.toEqual(secondValue);

				configure({ segmentOptions: { [segment]: first } });
				const drawnFirst = drawnRow();
				configure({ segmentOptions: { [segment]: second } });

				expect(drawnRow()).not.toBe(drawnFirst);
			});
		}
	}

	it("joins the effort to the model with the dot separator under model.roomy false, and with @ by default", () => {
		const effort = theme.thinking.high;

		configure({ segmentOptions: { model: { roomy: false } } });
		const dotted = stripAnsi(drawnRow());
		expect(dotted).toContain(`${MODEL}${theme.sep.dot}${effort}`);
		expect(dotted).not.toContain(`${MODEL} @${effort}`);

		configure();
		const joined = stripAnsi(drawnRow());
		expect(joined).toContain(`${MODEL} @${effort}`);
		expect(joined).not.toContain(`${MODEL}${theme.sep.dot}${effort}`);
	});
});
