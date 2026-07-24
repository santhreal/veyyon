import type { StatusLineSegmentId } from "../settings-schema";

/** Appearance domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const APPEARANCE_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Appearance
	// ────────────────────────────────────────────────────────────────────────

	// Theme
	"theme.dark": {
		type: "string",
		default: "titanium",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Dark Theme",
			description: "Theme used when the terminal has a dark background",
			options: "runtime",
		},
	},

	"theme.light": {
		type: "string",
		default: "light",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Light Theme",
			description: "Theme used when the terminal has a light background",
			options: "runtime",
		},
	},

	symbolPreset: {
		type: "enum",
		values: ["unicode", "nerd", "ascii"] as const,
		default: "unicode",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Symbol Preset",
			description: "Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)",
			options: [
				{ value: "unicode", label: "Unicode", description: "Standard symbols (default)" },
				{ value: "nerd", label: "Nerd Font", description: "Requires Nerd Font" },
				{ value: "ascii", label: "ASCII", description: "Maximum compatibility" },
			],
		},
	},

	colorBlindMode: {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Color-Blind Mode",
			description: "Use blue instead of green for diff additions",
		},
	},

	// Status line
	"statusLine.preset": {
		type: "enum",
		values: ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const,
		default: "default",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Status Line Preset",
			description: "Pre-built status line configurations",
			options: [
				{ value: "default", label: "Default", description: "Model, mode, path, git, context" },
				{ value: "minimal", label: "Minimal", description: "Path and git only" },
				{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
				{ value: "full", label: "Full", description: "All segments including time" },
				{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
				{ value: "ascii", label: "ASCII", description: "No special characters" },
				{ value: "custom", label: "Custom", description: "User-defined segments" },
			],
		},
	},

	"statusLine.separator": {
		type: "enum",
		values: ["powerline", "powerline-thin", "slash", "pipe", "block", "none", "ascii"] as const,
		// `pipe` (a clean `│`), not powerline chevrons: the powerline styles need a
		// patched Nerd Font and otherwise degrade to stray `>`/`▶` glyphs on the
		// composer border. This is the authoritative default — it overrides the
		// preset's `separator` (component.ts prefers the setting), so the two must
		// agree (presets.ts `default` is also `pipe`).
		default: "pipe",
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Status Line Separator",
			description: "Style of separators between segments",
			options: [
				{ value: "powerline", label: "Powerline", description: "Solid arrows (Nerd Font)" },
				{ value: "powerline-thin", label: "Thin chevron", description: "Thin arrows (Nerd Font)" },
				{ value: "slash", label: "Slash", description: "Forward slashes" },
				{ value: "pipe", label: "Pipe", description: "Vertical pipes" },
				{ value: "block", label: "Block", description: "Solid blocks" },
				{ value: "none", label: "None", description: "Space only" },
				{ value: "ascii", label: "ASCII", description: "Greater-than signs" },
			],
		},
	},

	"statusLine.sessionAccent": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Session Accent",
			description: "Use the session name color for the editor border and status line gap",
			advanced: true,
		},
	},

	"statusLine.transparent": {
		type: "boolean",
		// Transparent by default: the inline TUI paints no backgrounds, so the
		// status line inherits the terminal ground like every other surface (the
		// 2026-07-23/24 slab class: any painted fill renders as a colored slab on
		// a terminal whose ground differs from the theme's). Set to false to opt
		// back into the theme's painted `statusLineBg` bar.
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Transparent Status Line",
			description:
				"Use the terminal's default background for the status line instead of the theme's `statusLineBg` (the default). When transparent, powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal. Turn off to paint the theme's bar.",
			advanced: true,
		},
	},
	"statusLine.compactThinkingLevel": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Compact Thinking Level",
			description:
				"Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.",
			advanced: true,
		},
	},
	"tools.artifactSpillThreshold": {
		type: "number",
		default: 50,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Spill Threshold (KB)",
			description: "Tool output above this size is saved as an artifact; tail is kept inline",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "~5K tokens" },
				{ value: "30", label: "30 KB", description: "~7.5K tokens" },
				{ value: "50", label: "50 KB", description: "Default; ~12.5K tokens" },
				{ value: "75", label: "75 KB", description: "~19K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
				{ value: "500", label: "500 KB", description: "~125K tokens" },
				{ value: "1000", label: "1 MB", description: "~250K tokens" },
			],
		},
	},
	"tools.artifactTailBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Tail Size (KB)",
			description: "Amount of tail content kept inline when output spills to artifact",
			options: [
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.artifactHeadBytes": {
		type: "number",
		default: 20,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Head Size (KB)",
			description:
				"Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.",
			options: [
				{ value: "0", label: "0 KB", description: "Disabled; tail-only truncation" },
				{ value: "1", label: "1 KB", description: "~250 tokens" },
				{ value: "2.5", label: "2.5 KB", description: "~625 tokens" },
				{ value: "5", label: "5 KB", description: "~1.25K tokens" },
				{ value: "10", label: "10 KB", description: "~2.5K tokens" },
				{ value: "20", label: "20 KB", description: "Default; ~5K tokens" },
				{ value: "50", label: "50 KB", description: "~12.5K tokens" },
				{ value: "100", label: "100 KB", description: "~25K tokens" },
				{ value: "200", label: "200 KB", description: "~50K tokens" },
			],
		},
	},
	"tools.outputMaxColumns": {
		type: "number",
		default: 768,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Output Column Cap",
			description:
				"Per-line byte cap for streaming tool outputs (bash, ssh, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.",
			options: [
				{ value: "0", label: "Off", description: "No per-line cap" },
				{ value: "256", label: "256", description: "Tight" },
				{ value: "512", label: "512" },
				{ value: "768", label: "768", description: "Default" },
				{ value: "1024", label: "1024" },
				{ value: "2048", label: "2048" },
				{ value: "4096", label: "4096", description: "Loose" },
			],
		},
	},
	"tools.artifactTailLines": {
		type: "number",
		default: 500,
		ui: {
			tab: "tools",
			group: "Output Limits",
			label: "Artifact Tail Lines",
			description: "Maximum lines of tail content kept inline when output spills to artifact",
			options: [
				{ value: "50", label: "50 lines", description: "~250 tokens" },
				{ value: "100", label: "100 lines", description: "~500 tokens" },
				{ value: "250", label: "250 lines", description: "~1.25K tokens" },
				{ value: "500", label: "500 lines", description: "Default; ~2.5K tokens" },
				{ value: "1000", label: "1000 lines", description: "~5K tokens" },
				{ value: "2000", label: "2000 lines", description: "~10K tokens" },
				{ value: "5000", label: "5000 lines", description: "~25K tokens" },
			],
		},
	},

	"statusLine.showHookStatus": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Status Line",
			label: "Show Hook Status",
			description: "Display hook status messages below the status line",
			advanced: true,
		},
	},

	"statusLine.leftSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.rightSegments": { type: "array", default: [] as StatusLineSegmentId[] },

	"statusLine.segmentOptions": { type: "record", default: {} as Record<string, unknown> },

	// Images and terminal
	"terminal.showImages": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Inline Images",
			description: "Render images inline in the terminal",
			condition: "hasImageProtocol",
		},
	},

	"images.autoResize": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Auto-Resize Images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			advanced: true,
		},
	},

	// Moved from appearance/Images: blocking images is a privacy control
	// (prevents images reaching providers), not a display preference.
	"images.blockImages": {
		type: "boolean",
		default: false,
		ui: {
			tab: "providers",
			group: "Privacy",
			label: "Block Images",
			description: "Prevent images from being sent to LLM providers",
		},
	},

	"images.describeForTextModels": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Vision",
			label: "Describe Images for Text Models",
			description:
				"When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it",
		},
	},

	"tui.maxInlineImageColumns": {
		type: "number",
		default: 100,
		description:
			"Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).",
	},

	"tui.maxInlineImageRows": {
		type: "number",
		default: 20,
		description:
			"Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).",
	},

	"tui.maxInlineImages": {
		type: "number",
		default: 8,
		description:
			"Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).",
	},

	"terminal.showProgress": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Native Terminal Progress",
			description: "Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running",
			advanced: true,
		},
	},

	"tui.textSizing": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Large Headings (Kitty)",
			description:
				"Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.",
			advanced: true,
		},
	},

	"tui.renderMermaid": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Render Mermaid Diagrams",
			description: "Render Mermaid fenced code blocks as ASCII diagrams",
			advanced: true,
		},
	},

	"tui.hyperlinks": {
		type: "enum",
		values: ["off", "auto", "always"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Terminal Hyperlinks",
			description:
				"Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)",
		},
	},
	"tui.paintGround": {
		type: "enum",
		values: ["auto", "always", "never"] as const,
		default: "auto",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Paint Theme Ground",
			description:
				"Set the terminal background (OSC 11) to the theme's ground color while Veyyon runs, restoring it on exit (auto: only when the terminal background already matches the theme so no seam appears; always: unconditional; never: inherit the terminal background)",
		},
	},
	"tui.tight": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Tight Layout",
			description: "Remove the 1-character horizontal padding from the left and right of the terminal output",
			advanced: true,
		},
	},
	"tui.scrollbackRebuild": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Rewrite Scrollback",
			description:
				"Erase and replay terminal scrollback when a block's final form replaces its live preview. When off (default), stale preview copies remain in history and the final content is appended below.",
			advanced: true,
		},
	},
	"tui.scrollIsolation": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Scroll Isolation",
			description:
				"Mouse wheel scrolls the transcript while the prompt stays pinned at the bottom of the window. When off, the wheel drives the terminal's native scrollback and the whole window scrolls with it. While on, plain drag-select becomes Shift+drag.",
			advanced: true,
		},
	},

	"display.shimmer": {
		type: "enum",
		values: ["classic", "kitt", "living", "disabled"] as const,
		default: "disabled",
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Shimmer",
			description: "Animation style for working/loading messages",
			options: [
				{ value: "classic", label: "Classic", description: "Soft cosine wave sweeping across the text" },
				{ value: "kitt", label: "KITT Scanner", description: "Knight Rider 1982 red light bouncing left-right" },
				{
					value: "living",
					label: "Living",
					description:
						"Motion and color change with what the agent is doing: thinking, streaming, running a tool, error",
				},
				{ value: "disabled", label: "Disabled", description: "No animation; static muted text" },
			],
		},
	},

	"display.subagentInbox": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Subagent Inbox (experimental)",
			description:
				"opencode-style split: a live per-agent sidebar plus the focused agent's detail pane, instead of the modal agent hub. Experimental; off by default while the layout is refined.",
			// Experimental and off by default: lives in the Advanced fold so the
			// simplified appearance view stays at its stable 12-row default.
			advanced: true,
		},
	},

	"display.smoothStreaming": {
		type: "boolean",
		default: true,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Smooth Streaming",
			description: "Reveal assistant text and streamed tool input smoothly while chunks arrive",
		},
	},

	"display.showTokenUsage": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Token Usage",
			description: "Show per-turn token usage on assistant messages",
		},
	},

	"display.cacheMissMarker": {
		type: "boolean",
		default: false,
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Cache Miss Marker",
			description: "Show a divider above an assistant turn whose request lost (missed) the prompt cache",
			advanced: true,
		},
	},

	// Moved from appearance/Display: governs post-compaction transcript
	// display, so it lives with the rest of the Compaction knobs on model.
	"display.collapseCompacted": {
		type: "boolean",
		default: true,
		ui: {
			tab: "model",
			group: "Compaction",
			label: "Collapse Compacted History",
			description:
				"Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point",
		},
	},

	showHardwareCursor: {
		type: "boolean",
		default: true, // will be computed based on platform if undefined
		ui: {
			tab: "appearance",
			group: "Display",
			label: "Show Hardware Cursor",
			description: "Show terminal cursor for IME support",
			advanced: true,
		},
	},
} as const;
