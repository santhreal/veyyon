/**
 * A custom theme declaring historical statusLineSubagents loads from disk and renders its color.
 *
 * WHY THIS SUITE EXISTS. PR #945 accidentally renamed the machine-readable color token
 * `statusLineSubagents` to `statusLineAgents` during vocabulary cleanup. This broke custom themes
 * authored before the rename: `validateThemeJson` rejected them with a missing required token,
 * `setTheme` fell back to the default theme, and any custom color configured for the status-line
 * agents badge was ignored.
 *
 * The class this closes is "persisted/custom theme token compatibility defects caused by token renames".
 * The suite proves that disk-based custom themes with `statusLineSubagents` load through the production
 * `setTheme` and `getThemeByName` APIs without error or fallback, render their configured color via
 * `theme.fg("statusLineSubagents", ...)`, `theme.getFgAnsi("statusLineSubagents")` and `agentBadgeText(...)`
 * with exact ANSI sequence matches, and that themes missing `statusLineSubagents` (such as those with the
 * renamed `statusLineAgents`) are rejected.
 *
 * What it does not catch: themes with circular variable references in other tokens (covered by
 * `color.test.ts`) or terminal appearance auto-switching (covered by `theme-auto-detection.test.ts`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentBadgeText } from "@veyyon/coding-agent/modes/terminal/components/status-line/quiet-row";
import {
	detectColorMode,
	fgAnsi,
	type ThemeJson,
	type ThemeJsonColors,
	validateThemeJson,
} from "@veyyon/coding-agent/theme/color";
import {
	FALLBACK_THEME_NAME,
	getThemeByName,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	type Theme,
} from "@veyyon/coding-agent/theme/theme";
import { theme } from "@veyyon/coding-agent/theme/theme-binding";
import * as termCaps from "@veyyon/tui/terminal-capabilities";
import {
	captureDirOverrides,
	type DirOverridesSnapshot,
	getCustomThemesDir,
	restoreDirOverrides,
	setAgentDir,
} from "@veyyon/utils/dirs";

const CUSTOM_SUBAGENTS_COLOR = "#FF5500";

/**
 * Pinned historical theme fixture. Deliberately does not inherit from or reference
 * current builtins so that a silent rename in builtins cannot mask a regression here.
 */
const PINNED_HISTORICAL_THEME: ThemeJson = {
	name: "historical-custom-dark",
	colors: {
		accent: "#3FB6A8",
		border: "#202020",
		borderAccent: "#3FB6A8",
		borderMuted: "#151515",
		success: "#7FB98A",
		error: "#E06C75",
		warning: "#E5C07B",
		muted: "#5C616A",
		dim: "#3A3E45",
		text: "#D0D4DC",
		thinkingText: "#8B9099",
		userMessageText: "#FFFFFF",
		customMessageText: "#D0D4DC",
		customMessageLabel: "#8B9099",
		toolTitle: "#B8BDC7",
		toolOutput: "#8B9099",
		mdHeading: "#FFFFFF",
		mdLink: "#3FB6A8",
		mdLinkUrl: "#5C616A",
		link: "#3FB6A8",
		mdCode: "#E5C07B",
		mdCodeBlock: "#D0D4DC",
		mdCodeBlockBorder: "#202020",
		mdQuote: "#8B9099",
		mdQuoteBorder: "#3A3E45",
		mdHr: "#202020",
		mdListBullet: "#5C616A",
		toolDiffAdded: "#7FB98A",
		toolDiffRemoved: "#E06C75",
		toolDiffContext: "#5C616A",
		syntaxComment: "#5C616A",
		syntaxKeyword: "#E06C75",
		syntaxFunction: "#61AFEF",
		syntaxVariable: "#E5C07B",
		syntaxString: "#98C379",
		syntaxNumber: "#D19A66",
		syntaxType: "#E5C07B",
		syntaxOperator: "#56B6C2",
		syntaxPunctuation: "#ABB2BF",
		thinkingOff: "#3A3E45",
		thinkingMinimal: "#5C616A",
		thinkingLow: "#7FB98A",
		thinkingMedium: "#E5C07B",
		thinkingHigh: "#E06C75",
		thinkingXhigh: "#D19A66",
		bashMode: "#E5C07B",
		pythonMode: "#61AFEF",
		statusLineSep: "#202020",
		statusLineModel: "#B8BDC7",
		statusLinePath: "#8B9099",
		statusLineGitClean: "#7FB98A",
		statusLineGitDirty: "#E5C07B",
		statusLineContext: "#5C616A",
		statusLineSpend: "#8B9099",
		statusLineStaged: "#7FB98A",
		statusLineDirty: "#E5C07B",
		statusLineUntracked: "#E06C75",
		statusLineOutput: "#8B9099",
		statusLineCost: "#8B9099",
		statusLineSubagents: CUSTOM_SUBAGENTS_COLOR,
		selectedBg: "#181818",
		userMessageBg: "#121212",
		customMessageBg: "#121212",
		toolPendingBg: "#181818",
		toolSuccessBg: "#181818",
		toolErrorBg: "#181818",
		statusLineBg: "#000000",
	} as unknown as ThemeJsonColors,
};

describe("custom theme loading and rendering with historical statusLineSubagents", () => {
	let dirOverrides: DirOverridesSnapshot;
	let tempAgentDir: string;
	let themesDir: string;
	let priorThemeInstance: Theme;

	beforeAll(async () => {
		const fallback = await getThemeByName(FALLBACK_THEME_NAME);
		if (!fallback) throw new Error(`Expected fallback theme ${FALLBACK_THEME_NAME} to exist`);
		priorThemeInstance = fallback;
	});

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-subagents-test-"));
		setAgentDir(tempAgentDir);
		themesDir = getCustomThemesDir();
		fs.mkdirSync(themesDir, { recursive: true });
	});

	afterEach(() => {
		stopThemeWatcher();
		restoreDirOverrides(dirOverrides);
		fs.rmSync(tempAgentDir, { recursive: true, force: true });
		setThemeInstance(priorThemeInstance);
	});

	it("validates and accepts a pinned historical custom theme carrying statusLineSubagents", () => {
		const validation = validateThemeJson(PINNED_HISTORICAL_THEME);
		expect(validation.missingColors).toEqual([]);
		expect(validation.problems).toEqual([]);
	});

	it("loads custom theme from disk via setTheme without fallback and renders its exact configured color", async () => {
		const themeFile = path.join(themesDir, `${PINNED_HISTORICAL_THEME.name}.json`);
		fs.writeFileSync(themeFile, JSON.stringify(PINNED_HISTORICAL_THEME, null, 2), "utf-8");

		const result = await setTheme(PINNED_HISTORICAL_THEME.name);
		expect(result.success).toBe(true);
		expect(result.fellBack).toBeUndefined();

		// Active theme binding now uses the custom theme's exact color
		expect(theme.getColorHex("statusLineSubagents").toUpperCase()).toBe(CUSTOM_SUBAGENTS_COLOR);

		const expectedAnsi = fgAnsi(CUSTOM_SUBAGENTS_COLOR, detectColorMode());
		expect(theme.getFgAnsi("statusLineSubagents")).toBe(expectedAnsi);

		// Under color-enabled terminals, theme.fg and status-line badge apply the exact ANSI color
		const colorSpy = spyOn(termCaps, "colorEnabled").mockReturnValue(true);
		try {
			const fgOutput = theme.fg("statusLineSubagents", "worker-badge");
			expect(fgOutput).toBe(`${expectedAnsi}worker-badge\x1b[39m`);

			const badge = agentBadgeText(5);
			expect(badge).toContain("5");
			expect(badge.startsWith(expectedAnsi)).toBe(true);
			expect(badge.endsWith("\x1b[39m")).toBe(true);
		} finally {
			colorSpy.mockRestore();
		}
	});

	it("loads custom theme from disk via getThemeByName and resolves statusLineSubagents", async () => {
		const themeFile = path.join(themesDir, `${PINNED_HISTORICAL_THEME.name}.json`);
		fs.writeFileSync(themeFile, JSON.stringify(PINNED_HISTORICAL_THEME, null, 2), "utf-8");

		const loadedTheme = await getThemeByName(PINNED_HISTORICAL_THEME.name);
		expect(loadedTheme).toBeDefined();
		expect(loadedTheme!.getColorHex("statusLineSubagents").toUpperCase()).toBe(CUSTOM_SUBAGENTS_COLOR);

		const expectedAnsi = fgAnsi(CUSTOM_SUBAGENTS_COLOR, detectColorMode());
		expect(loadedTheme!.getFgAnsi("statusLineSubagents")).toBe(expectedAnsi);
	});

	it("rejects a theme carrying statusLineAgents instead of statusLineSubagents as missing required token", async () => {
		const rawColors: Record<string, unknown> = { ...PINNED_HISTORICAL_THEME.colors };
		delete rawColors.statusLineSubagents;
		rawColors.statusLineAgents = CUSTOM_SUBAGENTS_COLOR;

		const renamedThemeName = "renamed-agents-theme";
		const invalidThemeJson = {
			...PINNED_HISTORICAL_THEME,
			name: renamedThemeName,
			colors: rawColors,
		};

		const validation = validateThemeJson(invalidThemeJson);
		expect(validation.missingColors).toContain("statusLineSubagents");

		const themeFile = path.join(themesDir, `${renamedThemeName}.json`);
		fs.writeFileSync(themeFile, JSON.stringify(invalidThemeJson, null, 2), "utf-8");

		const result = await setTheme(renamedThemeName);
		expect(result.success).toBe(false);
		expect(result.fellBack).toBe(true);
		expect(result.error).toContain("Missing required color tokens:\n  - statusLineSubagents");
	});
});
