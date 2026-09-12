/**
 * A `PresentationTheme` with a distinct role per surface, for tests that render
 * view-models through a driver.
 *
 * `accentStyle` is what makes a theme change observable through a VT: a colour
 * arrives as a palette index whose RGB the harness cannot read back, while
 * underline is a cell flag it can.
 */

import type {
	ColorValue,
	HexColor,
	PresentationTheme,
	SpinnerType,
	SymbolKey,
	SymbolPreset,
	TextStyle,
	ThemeBg,
	ThemeColor,
} from "@veyyon/wire/presentation";

export interface TestThemeOverrides {
	accent?: string;
	accentStyle?: TextStyle;
	appearance?: "light" | "dark";
	colors?: Partial<Record<ThemeColor, ColorValue>>;
	backgrounds?: Partial<Record<ThemeBg, ColorValue>>;
	symbolPreset?: SymbolPreset;
	symbolOverrides?: Partial<Record<SymbolKey, string>>;
	spinnerFrames?: Partial<Record<SpinnerType, string[]>>;
	groundHex?: HexColor;
	styles?: Partial<Record<ThemeColor, TextStyle>>;
}

export function testTheme(overrides: TestThemeOverrides = {}): PresentationTheme {
	const accentFg = overrides.accent ?? "#00aaff";

	const defaultColors: Record<ThemeColor, ColorValue> = {
		accent: accentFg,
		border: "#333333",
		borderAccent: "#00aaff",
		borderMuted: "#222222",
		success: "#00ff00",
		error: "#ff0000",
		warning: "#ffaa00",
		muted: "#777777",
		dim: "#555555",
		text: "#ffffff",
		thinkingText: "#8888ff",
		userMessageText: "#ffffff",
		customMessageText: "#dddddd",
		customMessageLabel: "#8888ff",
		toolTitle: "#00ffff",
		toolOutput: "#bbbbbb",
		mdHeading: "#00aaff",
		mdLink: "#00ffff",
		mdLinkUrl: "#777777",
		link: "#00ffff",
		mdCode: "#ff88ff",
		mdCodeBlock: "#dddddd",
		mdCodeBlockBorder: "#333333",
		mdQuote: "#888888",
		mdQuoteBorder: "#555555",
		mdHr: "#444444",
		mdListBullet: "#00aaff",
		toolDiffAdded: "#00ff00",
		toolDiffRemoved: "#ff0000",
		toolDiffContext: "#888888",
		syntaxComment: "#666666",
		syntaxKeyword: "#ff88ff",
		syntaxFunction: "#88ffff",
		syntaxVariable: "#ffffff",
		syntaxString: "#88ff88",
		syntaxNumber: "#ffff88",
		syntaxType: "#ffaa88",
		syntaxOperator: "#cccccc",
		syntaxPunctuation: "#999999",
		thinkingOff: "#555555",
		thinkingMinimal: "#666688",
		thinkingLow: "#7777aa",
		thinkingMedium: "#8888cc",
		thinkingHigh: "#9999ee",
		thinkingXhigh: "#aaaaff",
		thinkingMax: "#ccccff",
		bashMode: "#00ff00",
		pythonMode: "#ffff00",
		statusLineSep: "#444444",
		statusLineModel: "#00aaff",
		statusLinePath: "#aaaaaa",
		statusLineGitClean: "#00ff00",
		statusLineGitDirty: "#ffaa00",
		statusLineContext: "#8888ff",
		statusLineSpend: "#888888",
		statusLineStaged: "#00ff00",
		statusLineDirty: "#ffaa00",
		statusLineUntracked: "#777777",
		statusLineOutput: "#bbbbbb",
		statusLineCost: "#aaaaaa",
		statusLineSubagents: "#aa88ff",
		sessionAccent: "#00aaff",
		modeAccent: "#00aaff",
		shareAccent: "#00ffff",
		infoAccent: "#777777",
		matchHighlight: "#ffaa00",
		...overrides.colors,
	};

	const defaultBackgrounds: Record<ThemeBg, ColorValue> = {
		selectedBg: "#223344",
		userMessageBg: "#112233",
		customMessageBg: "#111122",
		toolPendingBg: "#222211",
		toolSuccessBg: "#112211",
		toolErrorBg: "#221111",
		statusLineBg: "#181818",
		composerBg: "",
		...overrides.backgrounds,
	};

	const mergedStyles: Partial<Record<ThemeColor, TextStyle>> = {
		...(overrides.accentStyle ? { accent: overrides.accentStyle, bashMode: overrides.accentStyle } : {}),
		...overrides.styles,
	};

	return {
		id: "test-theme",
		name: "Test",
		appearance: overrides.appearance ?? "dark",
		colors: defaultColors,
		backgrounds: defaultBackgrounds,
		symbolPreset: overrides.symbolPreset ?? "unicode",
		...(overrides.symbolOverrides ? { symbolOverrides: overrides.symbolOverrides } : {}),
		...(overrides.spinnerFrames ? { spinnerFrames: overrides.spinnerFrames } : {}),
		...(overrides.groundHex !== undefined ? { groundHex: overrides.groundHex } : {}),
		...(Object.keys(mergedStyles).length > 0 ? { styles: mergedStyles } : {}),
	};
}
