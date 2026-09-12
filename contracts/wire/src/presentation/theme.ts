/**
 * Abstract theme contract: serializable canonical theme snapshot representing
 * production color roles, terminal defaults, symbols, spinner frames, ground,
 * appearance, and optional text styles.
 *
 * Pure data contract: zero runtime dependencies, device-independent.
 */

/** A colour in `#rrggbb` form, CSS name, or empty string for terminal default. */
export type HexColor = string;

/** A colour value: hex string, empty string for terminal default, or 0-255 ANSI index. */
export type ColorValue = string | number;

/** How a run of text is weighted, independent of colour. */
export interface TextStyle {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	dim?: boolean;
	inverse?: boolean;
}

/** A foreground colour with optional background and weight. */
export interface StyleRole {
	fg: HexColor | ColorValue;
	bg?: HexColor | ColorValue;
	style?: TextStyle;
}

/** Every ThemeColor member, as a value array. */
export const THEME_COLORS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"link",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
	"pythonMode",
	"statusLineSep",
	"statusLineModel",
	"statusLinePath",
	"statusLineGitClean",
	"statusLineGitDirty",
	"statusLineContext",
	"statusLineSpend",
	"statusLineStaged",
	"statusLineDirty",
	"statusLineUntracked",
	"statusLineOutput",
	"statusLineCost",
	"statusLineSubagents",
	"sessionAccent",
	"modeAccent",
	"shareAccent",
	"infoAccent",
	"matchHighlight",
] as const;

/** All 66 foreground colour tokens supported by the production theme system. */
export type ThemeColor = (typeof THEME_COLORS)[number];

/** Every ThemeBg member, as a value array. */
export const THEME_BG_COLORS = [
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"statusLineBg",
	"composerBg",
] as const;

/** All 8 background colour tokens supported by the production theme system. */
export type ThemeBg = (typeof THEME_BG_COLORS)[number];

/** Every SymbolPreset member, as a value array. */
export const SYMBOL_PRESETS = ["unicode", "nerd", "ascii"] as const;

/** Available symbol presets. */
export type SymbolPreset = (typeof SYMBOL_PRESETS)[number];

/** Every SpinnerType member, as a value array. */
export const SPINNER_TYPES = ["status", "activity", "thinking"] as const;

/** Available spinner types. */
export type SpinnerType = (typeof SPINNER_TYPES)[number];
/** Canonical symbol keys across UI categories. */
export type SymbolKey =
	// Status
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.connecting"
	| "status.active"
	| "status.shadowed"
	| "status.aborted"
	| "status.done"
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	| "nav.prev"
	| "nav.next"
	// Tree
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Box (rounded)
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box (sharp)
	| "boxSharp.topLeft"
	| "boxSharp.topRight"
	| "boxSharp.bottomLeft"
	| "boxSharp.bottomRight"
	| "boxSharp.horizontal"
	| "boxSharp.vertical"
	| "boxSharp.cross"
	| "boxSharp.teeDown"
	| "boxSharp.teeUp"
	| "boxSharp.teeRight"
	| "boxSharp.teeLeft"
	// Separators
	| "sep.powerline"
	| "sep.powerlineThin"
	| "sep.powerlineLeft"
	| "sep.powerlineRight"
	| "sep.powerlineThinLeft"
	| "sep.powerlineThinRight"
	| "sep.block"
	| "sep.space"
	| "sep.asciiLeft"
	| "sep.asciiRight"
	| "sep.dot"
	| "sep.slash"
	| "sep.pipe"
	// Icons
	| "icon.model"
	| "icon.plan"
	| "icon.prewalk"
	| "icon.goal"
	| "icon.pause"
	| "icon.loop"
	| "icon.folder"
	| "icon.worktree"
	| "icon.search"
	| "icon.scratchFolder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.pr"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.time"
	| "icon.pi"
	| "icon.ghost"
	| "icon.agents"
	| "icon.unread"
	| "icon.job"
	| "icon.cache"
	| "icon.cacheMiss"
	| "icon.input"
	| "icon.output"
	| "icon.throughput"
	| "icon.host"
	| "icon.profile"
	| "icon.session"
	| "icon.package"
	| "icon.warning"
	| "icon.rewind"
	| "icon.auto"
	| "icon.fast"
	| "icon.extensionSkill"
	| "icon.extensionTool"
	| "icon.extensionSlashCommand"
	| "icon.extensionMcp"
	| "icon.extensionRule"
	| "icon.extensionHook"
	| "icon.extensionPrompt"
	| "icon.extensionContextFile"
	| "icon.extensionInstruction"
	| "icon.mic"
	| "icon.camera"
	// Thinking levels
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	| "thinking.max"
	| "thinking.autoPending"
	// Checkboxes
	| "checkbox.checked"
	| "checkbox.unchecked"
	| "checkbox.progress"
	// Radio
	| "radio.selected"
	| "radio.unselected"
	// Formatting
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	| "md.colorSwatch"
	// Rails
	| "advisor.rail"
	| "block.rail"
	// Language/file icons
	| "lang.default"
	| "lang.typescript"
	| "lang.javascript"
	| "lang.python"
	| "lang.rust"
	| "lang.go"
	| "lang.java"
	| "lang.c"
	| "lang.cpp"
	| "lang.csharp"
	| "lang.ruby"
	| "lang.julia"
	| "lang.php"
	| "lang.swift"
	| "lang.kotlin"
	| "lang.shell"
	| "lang.html"
	| "lang.css"
	| "lang.json"
	| "lang.yaml"
	| "lang.markdown"
	| "lang.sql"
	| "lang.docker"
	| "lang.lua"
	| "lang.text"
	| "lang.env"
	| "lang.toml"
	| "lang.xml"
	| "lang.ini"
	| "lang.conf"
	| "lang.log"
	| "lang.csv"
	| "lang.tsv"
	| "lang.image"
	| "lang.pdf"
	| "lang.archive"
	| "lang.binary"
	// Settings tabs
	| "tab.appearance"
	| "tab.model"
	| "tab.interaction"
	| "tab.resources"
	| "tab.context"
	| "tab.rules"
	| "tab.files"
	| "tab.shell"
	| "tab.tools"
	| "tab.memory"
	| "tab.tasks"
	| "tab.agents"
	| "tab.providers"
	| "tab.global"
	| "tab.experimental"
	// Tool identity icons
	| "tool.write"
	| "tool.edit"
	| "tool.bash"
	| "tool.ssh"
	| "tool.lsp"
	| "tool.gh"
	| "tool.webSearch"
	| "tool.exa"
	| "tool.browser"
	| "tool.eval"
	| "tool.debug"
	| "tool.mcp"
	| "tool.job"
	| "tool.launch"
	| "tool.task"
	| "tool.todo"
	| "tool.memory"
	| "tool.ask"
	| "tool.resolve"
	| "tool.review"
	| "tool.inspectImage"
	| "tool.goal"
	| "tool.irc"
	| "tool.delete"
	| "tool.move";

/**
 * Canonical serializable theme snapshot representing a production Theme.
 *
 * Round-trips every foreground/background role, terminal-default colour,
 * symbol choice/override, spinner frame set, appearance ground, and optional
 * role text styles without loss.
 */
export interface PresentationTheme {
	/** Stable identifier, e.g. `"dark"`, `"gruvbox-dark"`, `"test-theme"`. */
	id: string;
	/** Display name, e.g. `"Dark"`, `"Gruvbox Dark"`, `"Test"`. */
	name: string;
	/** Which ground the palette was designed for. Drives a renderer's own defaults. */
	appearance: "light" | "dark";
	/** Foreground color definitions by token name. */
	colors: Record<ThemeColor, ColorValue>;
	/** Background color definitions by token name. */
	backgrounds: Record<ThemeBg, ColorValue>;
	/** Active symbol preset name. */
	symbolPreset: SymbolPreset;
	/** Explicit symbol overrides by symbol key, if any. */
	symbolOverrides?: Partial<Record<SymbolKey, string>>;
	/** Spinner frame overrides by spinner type, if any. */
	spinnerFrames?: Partial<Record<SpinnerType, string[]>>;
	/** Terminal ground color as `#RRGGBB` or undefined when unpainted. */
	groundHex?: HexColor;
	/** Optional text style overrides by theme color role. */
	styles?: Partial<Record<ThemeColor, TextStyle>>;
}
