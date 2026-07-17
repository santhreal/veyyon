// Symbol presets and spinner frames: the single owner of every glyph the TUI
// renders (status icons, tree connectors, box drawing, tool glyphs) and of the
// per-preset spinner frame sets. Pure data + pure helpers — no runtime state.
// Consumers go through `theme.ts` (the theme boundary), which re-exports the
// public pieces.
// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * All available symbol keys organized by category.
 */
export type SymbolKey =
	// Status Indicators
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.shadowed"
	| "status.aborted"
	| "status.done"
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	// Tree Connectors
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Box Drawing - Rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box Drawing - Sharp
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
	| "icon.job"
	| "icon.cache"
	| "icon.cacheMiss"
	| "icon.input"
	| "icon.output"
	| "icon.throughput"
	| "icon.host"
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
	// STT
	| "icon.mic"
	// Compaction divider
	| "icon.camera"
	// Thinking Levels
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
	// Radio (single-choice)
	| "radio.selected"
	| "radio.unselected"
	// Text Formatting
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown-specific
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	| "md.colorSwatch"
	// Advisor note rail
	| "advisor.rail"
	// Language/file type icons
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
	// Settings tab icons
	| "tab.appearance"
	| "tab.model"
	| "tab.interaction"
	| "tab.context"
	| "tab.files"
	| "tab.shell"
	| "tab.tools"
	| "tab.memory"
	| "tab.tasks"
	| "tab.providers"
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

export type SymbolMap = Record<SymbolKey, string>;

export const UNICODE_SYMBOLS: SymbolMap = {
	// Status
	"status.success": "✓",
	"status.error": "✗",
	"status.warning": "warn",
	"status.info": "ⓘ",
	"status.pending": "⏳",
	"status.disabled": "⦸",
	"status.enabled": "●",
	"status.running": "⟳",
	"status.shadowed": "○",
	"status.aborted": "⏹",
	"status.done": "•",
	// Navigation
	"nav.cursor": "›",
	"nav.selected": "›",
	"nav.expand": "▸",
	"nav.collapse": "▾",
	"nav.back": "⟵",
	// Tree
	"tree.branch": "├─",
	"tree.last": "└─",
	"tree.vertical": "│",
	"tree.horizontal": "─",
	"tree.hook": "└",
	// Box (rounded)
	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",
	// Box (sharp)
	"boxSharp.topLeft": "┌",
	"boxSharp.topRight": "┐",
	"boxSharp.bottomLeft": "└",
	"boxSharp.bottomRight": "┘",
	"boxSharp.horizontal": "─",
	"boxSharp.vertical": "│",
	"boxSharp.cross": "┼",
	"boxSharp.teeDown": "┬",
	"boxSharp.teeUp": "┴",
	"boxSharp.teeRight": "├",
	"boxSharp.teeLeft": "┤",
	// Separators (powerline-ish, but pure Unicode)
	"sep.powerline": "▕",
	"sep.powerlineThin": "┆",
	"sep.powerlineLeft": "▶",
	"sep.powerlineRight": "◀",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "▌",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " · ",
	"sep.slash": " / ",
	"sep.pipe": " │ ",
	// Icons.
	//
	// The DEFAULT (non-Nerd-Font) map is deliberately icon-light: veyyon's status
	// line reads as clean silver text, not a row of mismatched glyphs. omp shipped
	// a grab-bag here — a hexagon for the model, the bare letters F/T/P as folder/
	// scratch/package "icons", an emoji for the session — which looked unfinished
	// and clashed with the wordmark. Segment content is self-describing (the model
	// name, the path, the branch, "32K/?" context), so the prefix glyph is noise.
	// Users who want iconography opt into the `nerd` preset, which carries a proper
	// Nerd Font set (see the second icon map below). State indicators that encode
	// something the text does not — pause, loop, warning, the status symbols — stay.
	"icon.model": "",
	"icon.plan": "",
	"icon.prewalk": "",
	"icon.goal": "",
	"icon.pause": "⏸",
	"icon.loop": "↻",
	"icon.folder": "",
	"icon.worktree": "⧉",
	"icon.search": "⌕",
	"icon.scratchFolder": "🗑",
	"icon.file": "▤",
	"icon.git": "",
	"icon.branch": "",
	"icon.pr": "",
	"icon.tokens": "",
	"icon.context": "",
	"icon.cost": "",
	"icon.time": "",
	"icon.pi": "",
	"icon.ghost": "",
	"icon.agents": "",
	"icon.job": "",
	"icon.cache": "",
	"icon.cacheMiss": "⊘",
	"icon.input": "⤵",
	"icon.output": "⤴",
	"icon.throughput": "",
	"icon.host": "",
	"icon.session": "",
	"icon.package": "",
	"icon.warning": "warn",
	"icon.rewind": "↶",
	"icon.auto": "⟲",
	"icon.fast": "",
	"icon.extensionSkill": "*",
	"icon.extensionTool": "",
	"icon.extensionSlashCommand": "⌘",
	"icon.extensionMcp": "",
	"icon.extensionRule": "",
	"icon.extensionHook": "",
	"icon.extensionPrompt": "note",
	"icon.extensionContextFile": "",
	"icon.extensionInstruction": "",
	// STT
	"icon.mic": "",
	// Compaction divider
	"icon.camera": "",
	// Thinking levels
	"thinking.minimal": "o min",
	"thinking.low": "◔ low",
	"thinking.medium": "◑ med",
	"thinking.high": "◒ high",
	"thinking.xhigh": "◕ xhigh",
	"thinking.max": "◉ max",
	"thinking.autoPending": "⟳",
	// Checkboxes
	"checkbox.checked": "■",
	"checkbox.unchecked": "□",
	// Radio (single-choice)
	"radio.selected": "◉",
	"radio.unselected": "○",
	// Formatting
	"format.bullet": "•",
	"format.dash": "—",
	"format.bracketLeft": "⟦",
	"format.bracketRight": "⟧",
	// Markdown
	"md.quoteBorder": "▏",
	"md.hrChar": "─",
	"md.bullet": "•",
	"md.colorSwatch": "■",
	// Advisor note rail (heavier than md.quoteBorder so notes read as a distinct voice)
	"advisor.rail": "▎",
	// Language/file icons (emoji-centric, no Nerd Font required)
	"lang.default": "⌘",
	"lang.typescript": "",
	"lang.javascript": "",
	"lang.python": "",
	"lang.rust": "",
	"lang.go": "",
	"lang.java": "",
	"lang.c": "Ⓒ",
	"lang.cpp": "",
	"lang.csharp": "",
	"lang.ruby": "",
	"lang.julia": "Ⓙ",
	"lang.php": "",
	"lang.swift": "",
	"lang.kotlin": "Ⓚ",
	"lang.shell": "",
	"lang.html": "",
	"lang.css": "",
	"lang.json": "",
	"lang.yaml": "",
	"lang.markdown": "",
	"lang.sql": "",
	"lang.docker": "",
	"lang.lua": "",
	"lang.text": "",
	"lang.env": "",
	"lang.toml": "",
	"lang.xml": "⟨⟩",
	"lang.ini": "",
	"lang.conf": "",
	"lang.log": "",
	"lang.csv": "",
	"lang.tsv": "",
	"lang.image": "",
	"lang.pdf": "",
	"lang.archive": "",
	"lang.binary": "",
	// Settings tabs
	"tab.appearance": "A",
	"tab.model": "M",
	"tab.interaction": "K",
	"tab.context": "C",
	"tab.files": "F",
	"tab.shell": "S",
	"tab.tools": "T",
	"tab.memory": "R",
	"tab.tasks": "P",
	"tab.providers": "N",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "note",
	"tool.edit": "note",
	"tool.bash": ">",
	"tool.ssh": "⇄",
	"tool.lsp": "",
	"tool.gh": "⎇",
	"tool.webSearch": "⌕",
	"tool.exa": "",
	"tool.browser": "N",
	"tool.eval": "▶",
	"tool.debug": "",
	"tool.mcp": "",
	"tool.job": "",
	"tool.launch": "",
	"tool.task": "⇶",
	"tool.todo": "",
	"tool.memory": "R",
	"tool.ask": "?",
	"tool.resolve": "ok",
	"tool.review": "◉",
	"tool.inspectImage": "",
	"tool.goal": "◎",
	"tool.irc": "",
	"tool.delete": "",
	"tool.move": "",
};

export const NERD_SYMBOLS: SymbolMap = {
	// Status Indicators
	// pick:  | alt:   
	"status.success": "\uf00c",
	// pick:  | alt:   
	"status.error": "\uf00d",
	// pick:  | alt:  
	"status.warning": "\uf12a",
	// pick:  | alt: 
	"status.info": "\uf129",
	// pick:  | alt:   
	"status.pending": "\uf254",
	// pick:  | alt:  
	"status.disabled": "\uf05e",
	// pick:  | alt:  
	"status.enabled": "\uf111",
	// pick:  | alt:   
	"status.running": "\uf110",
	// pick:  (nf-fa-circle_o, pairs with status.enabled's nf-fa-circle) | alt: ◐ ◑
	"status.shadowed": "\uf10c",
	// pick:  | alt:  
	"status.aborted": "\uf04d",
	// pick: • | alt: ● ·
	"status.done": "•",
	// Navigation
	// pick:  | alt:  
	"nav.cursor": "\uf054",
	// pick:  | alt:  
	"nav.selected": "\uf178",
	// pick:  | alt:  
	"nav.expand": "\uf0da",
	// pick:  | alt:  
	"nav.collapse": "\uf0d7",
	// pick:  | alt:  
	"nav.back": "\uf060",
	// Tree Connectors (same as unicode)
	// pick: ├─ | alt: ├╴ ├╌ ╠═ ┣━
	"tree.branch": "├─",
	// pick: └─ | alt: └╴ └╌ ╚═ ┗━
	"tree.last": "└─",
	// pick: │ | alt: ┃ ║ ▏ ▕
	"tree.vertical": "│",
	// pick: ─ | alt: ━ ═ ╌ ┄
	"tree.horizontal": "─",
	// pick: └ | alt: ╰ ⎿ ↳
	"tree.hook": "└",
	// Box Drawing - Rounded (same as unicode)
	// pick: ╭ | alt: ┌ ┏ ╔
	"boxRound.topLeft": "╭",
	// pick: ╮ | alt: ┐ ┓ ╗
	"boxRound.topRight": "╮",
	// pick: ╰ | alt: └ ┗ ╚
	"boxRound.bottomLeft": "╰",
	// pick: ╯ | alt: ┘ ┛ ╝
	"boxRound.bottomRight": "╯",
	// pick: ─ | alt: ━ ═ ╌
	"boxRound.horizontal": "─",
	// pick: │ | alt: ┃ ║ ▏
	"boxRound.vertical": "│",
	// Box Drawing - Sharp (same as unicode)
	// pick: ┌ | alt: ┏ ╭ ╔
	"boxSharp.topLeft": "┌",
	// pick: ┐ | alt: ┓ ╮ ╗
	"boxSharp.topRight": "┐",
	// pick: └ | alt: ┗ ╰ ╚
	"boxSharp.bottomLeft": "└",
	// pick: ┘ | alt: ┛ ╯ ╝
	"boxSharp.bottomRight": "┘",
	// pick: ─ | alt: ━ ═ ╌
	"boxSharp.horizontal": "─",
	// pick: │ | alt: ┃ ║ ▏
	"boxSharp.vertical": "│",
	// pick: ┼ | alt: ╋ ╬ ┿
	"boxSharp.cross": "┼",
	// pick: ┬ | alt: ╦ ┯ ┳
	"boxSharp.teeDown": "┬",
	// pick: ┴ | alt: ╩ ┷ ┻
	"boxSharp.teeUp": "┴",
	// pick: ├ | alt: ╠ ┝ ┣
	"boxSharp.teeRight": "├",
	// pick: ┤ | alt: ╣ ┥ ┫
	"boxSharp.teeLeft": "┤",
	// Separators - Nerd Font specific
	// pick:  | alt:   
	"sep.powerline": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineThin": "\ue0b1",
	// pick:  | alt:  
	"sep.powerlineLeft": "\ue0b0",
	// pick:  | alt:  
	"sep.powerlineRight": "\ue0b2",
	// pick:  | alt: 
	"sep.powerlineThinLeft": "\ue0b1",
	// pick:  | alt: 
	"sep.powerlineThinRight": "\ue0b3",
	// pick: █ | alt: ▓ ▒ ░ ▉ ▌
	"sep.block": "█",
	// pick: space | alt: ␠ ·
	"sep.space": " ",
	// pick: > | alt: › » ▸
	"sep.asciiLeft": ">",
	// pick: < | alt: ‹ « ◂
	"sep.asciiRight": "<",
	// pick: · | alt: • ⋅
	"sep.dot": " · ",
	// pick:  | alt: / ∕ ⁄
	"sep.slash": "\ue0bb",
	// pick:  | alt: │ ┃ |
	"sep.pipe": "\ue0b3",
	// Icons - Nerd Font specific
	// pick:  | alt:   ◆
	"icon.model": "\uec19",
	// pick:  | alt:  
	"icon.plan": "\uf2d2",
	"icon.prewalk": "\uf29d",
	// pick:  (nf-fa-bullseye) | alt:  (nf-md-target) ◎ ⌖
	"icon.goal": "\uf140",
	// pick:  (nf-fa-pause) | alt: ⏸ ||
	"icon.pause": "\uf04c",
	// pick: ↻ | alt: ⟳
	"icon.loop": "\uf021",
	// pick:  | alt:  
	"icon.folder": "\uf115",
	"icon.search": "\uf002",
	// pick:  | alt:
	"icon.scratchFolder": "\uf014",
	// pick: nf-fa-sitemap | alt: nf-cod-list_tree
	"icon.worktree": "\uf0e8",
	// pick:  | alt:  
	"icon.file": "\uf15b",
	// pick:  | alt:  ⎇
	"icon.git": "\uf1d3",
	// pick:  | alt:  ⎇
	"icon.branch": "\uf126",
	// pick:  (nf-cod-git_pull_request) | alt:  (nf-oct-git_pull_request)
	"icon.pr": "\uea64",
	// pick:  | alt: ⊛ ◍ 
	"icon.tokens": "\ue26b",
	// pick:  | alt: ◫ ▦
	"icon.context": "\ue70f",
	// pick:  | alt: $ ¢
	"icon.cost": "\uf155",
	// pick:  | alt: ◷ ◴
	"icon.time": "\uf017",
	// pick:  | alt: π ∏ ∑
	"icon.pi": "\ue22c",
	// pick: 󰊠 (nf-md-ghost) | alt:
	"icon.ghost": "\u{f02a0}",
	// pick:  | alt: 
	"icon.agents": "\uf0c0",
	// pick:  (nf-fa-gear) | alt:
	"icon.job": "\uf013",
	// pick:  | alt:  
	"icon.cache": "\uf1c0",
	// pick:  (fa-ban) | alt: ⊘
	"icon.cacheMiss": "\uf05e",
	// pick:  | alt:  →
	"icon.input": "\uf090",
	// pick:  | alt:  →
	"icon.output": "\uf08b",
	// pick:  (nf-fa-tachometer) | alt:   ↬
	"icon.throughput": "\uf0e4",
	// pick:  | alt:  
	"icon.host": "\uf109",
	// pick:  | alt:  
	"icon.session": "\uf550",
	// pick:  | alt: 
	"icon.package": "\uf487",
	// pick:  | alt:  
	"icon.warning": "\uf071",
	// pick:  | alt:  ↺
	"icon.rewind": "\uf0e2",
	// pick: 󰁨 | alt:   
	"icon.auto": "\u{f0068}",
	"icon.fast": "\uf0e7",
	"icon.extensionSkill": "\uf0eb",
	// pick:  | alt:  
	"icon.extensionTool": "\uf0ad",
	// pick:  | alt: 
	"icon.extensionSlashCommand": "\uf120",
	// pick:  | alt:  
	"icon.extensionMcp": "\uf1e6",
	// pick:  | alt:  
	"icon.extensionRule": "\uf0e3",
	// pick:  | alt: 
	"icon.extensionHook": "\uf0c1",
	// pick:  | alt:  
	"icon.extensionPrompt": "\uf075",
	// pick:  | alt:  
	"icon.extensionContextFile": "\uf0f6",
	// pick:  | alt:  
	"icon.extensionInstruction": "\uf02d",
	// STT - fa-microphone
	"icon.mic": "\uf130",
	// Compaction divider - fa-camera-retro
	"icon.camera": "\uf083",
	// Thinking levels — increasing circle slices, with fire reserved for max.
	"thinking.minimal": "\u{F0A9E} min",
	"thinking.low": "\u{F0A9F} low",
	"thinking.medium": "\u{F0AA1} med",
	"thinking.high": "\u{F0AA3} high",
	"thinking.xhigh": "\u{F0AA5} xhi",
	"thinking.max": "\u{F06D} max",
	// Auto mode uses shuffle until the model resolves its thinking level.
	"thinking.autoPending": "\u{F074}",
	// Checkboxes
	// pick:  | alt:  
	"checkbox.checked": "\uf14a",
	// pick:  | alt: 
	"checkbox.unchecked": "\uf096",
	// Radio (single-choice)
	// pick:  (fa-dot-circle-o) | alt:  ◉
	"radio.selected": "\uf192",
	// pick:  (fa-circle-o) | alt:  o
	"radio.unselected": "\uf10c",
	// pick:  | alt:   •
	"format.bullet": "\uf111",
	// pick: – | alt: — ― -
	"format.dash": "–",
	// pick: ⟨ | alt: [ ⟦
	"format.bracketLeft": "⟨",
	// pick: ⟩ | alt: ] ⟧
	"format.bracketRight": "⟩",
	// Markdown-specific
	// pick: │ | alt: ┃ ║
	"md.quoteBorder": "│",
	// pick: ─ | alt: ━ ═
	"md.hrChar": "─",
	// pick:  | alt:  •
	"md.bullet": "\uf111",
	// pick: ■ | alt:  (U+F096)
	"md.colorSwatch": "■",
	// pick: ▎ | alt: ┃ │
	"advisor.rail": "▎",
	// Language icons (nerd font devicons)
	"lang.default": "",
	"lang.typescript": "\u{E628}",
	"lang.javascript": "\u{E60C}",
	"lang.python": "\u{E606}",
	"lang.rust": "\u{E7A8}",
	"lang.go": "\u{E627}",
	"lang.java": "\u{E738}",
	"lang.c": "\u{E61E}",
	"lang.cpp": "\u{E61D}",
	"lang.csharp": "\u{E7BC}",
	"lang.ruby": "\u{E791}",
	"lang.julia": "\u{E624}",
	"lang.php": "\u{E608}",
	"lang.swift": "\u{E755}",
	"lang.kotlin": "\u{E634}",
	"lang.shell": "\u{E795}",
	"lang.html": "\u{E736}",
	"lang.css": "\u{E749}",
	"lang.json": "\u{E60B}",
	"lang.yaml": "\u{E615}",
	"lang.markdown": "\u{E609}",
	"lang.sql": "\u{E706}",
	"lang.docker": "\u{E7B0}",
	"lang.lua": "\u{E620}",
	"lang.text": "\u{E612}",
	"lang.env": "\u{E615}",
	"lang.toml": "\u{E615}",
	"lang.xml": "\u{F05C0}",
	"lang.ini": "\u{E615}",
	"lang.conf": "\u{E615}",
	"lang.log": "\u{F0331}",
	"lang.csv": "\u{F021B}",
	"lang.tsv": "\u{F021B}",
	"lang.image": "\u{F021F}",
	"lang.pdf": "\u{F0226}",
	"lang.archive": "\u{F187}",
	"lang.binary": "\u{F019A}",
	// Settings tab icons
	"tab.appearance": "󰃣",
	"tab.model": "󰚩",
	"tab.interaction": "󰌌",
	"tab.context": "󰘸",
	"tab.files": "󰈔",
	"tab.shell": "󰆍",
	"tab.tools": "󰠭",
	"tab.memory": "󰧑",
	"tab.tasks": "󰐱",
	"tab.providers": "󰖟",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "\uEA7F",
	"tool.edit": "\uEA73",
	"tool.bash": "\uEBCA",
	"tool.ssh": "\uEB3A",
	"tool.lsp": "\uEA61",
	"tool.gh": "\uEA84",
	"tool.webSearch": "\uEB01",
	"tool.exa": "\uEB68",
	"tool.browser": "\uEAAE",
	"tool.eval": "\uEBAF",
	"tool.debug": "\uEAD8",
	"tool.mcp": "\uEB2D",
	"tool.job": "\uEBA2",
	"tool.launch": "\uF135",
	"tool.task": "\uf4a0",
	"tool.todo": "\uEAB3",
	"tool.memory": "\uEACE",
	"tool.ask": "\uEAC7",
	"tool.resolve": "\uEBB1",
	"tool.review": "\uEA70",
	"tool.inspectImage": "\uEAEA",
	"tool.goal": "\uEBF8",
	"tool.irc": "\uF086",
	"tool.delete": "\uf12d",
	"tool.move": "\uf061",
};

export const ASCII_SYMBOLS: SymbolMap = {
	// Status Indicators
	"status.success": "[ok]",
	"status.error": "[!!]",
	"status.warning": "[!]",
	"status.info": "[i]",
	"status.pending": "[*]",
	"status.disabled": "[ ]",
	"status.enabled": "[x]",
	"status.running": "[~]",
	"status.shadowed": "[/]",
	"status.aborted": "[-]",
	"status.done": "*",
	// Navigation
	"nav.cursor": ">",
	"nav.selected": "->",
	"nav.expand": "+",
	"nav.collapse": "-",
	"nav.back": "<-",
	// Tree Connectors
	"tree.branch": "|--",
	"tree.last": "'--",
	"tree.vertical": "|",
	"tree.horizontal": "-",
	"tree.hook": "`-",
	// Box Drawing - Rounded (ASCII fallback)
	"boxRound.topLeft": "+",
	"boxRound.topRight": "+",
	"boxRound.bottomLeft": "+",
	"boxRound.bottomRight": "+",
	"boxRound.horizontal": "-",
	"boxRound.vertical": "|",
	// Box Drawing - Sharp (ASCII fallback)
	"boxSharp.topLeft": "+",
	"boxSharp.topRight": "+",
	"boxSharp.bottomLeft": "+",
	"boxSharp.bottomRight": "+",
	"boxSharp.horizontal": "-",
	"boxSharp.vertical": "|",
	"boxSharp.cross": "+",
	"boxSharp.teeDown": "+",
	"boxSharp.teeUp": "+",
	"boxSharp.teeRight": "+",
	"boxSharp.teeLeft": "+",
	// Separators
	"sep.powerline": ">",
	"sep.powerlineThin": ">",
	"sep.powerlineLeft": ">",
	"sep.powerlineRight": "<",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "#",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " - ",
	"sep.slash": " / ",
	"sep.pipe": " | ",
	// Icons
	"icon.model": "[M]",
	"icon.plan": "plan",
	"icon.prewalk": "prewalk",
	"icon.goal": "goal",
	"icon.pause": "||",
	"icon.loop": "loop",
	"icon.folder": "[D]",
	"icon.worktree": "[wt]",
	"icon.search": "[/]",
	"icon.scratchFolder": "[T]",
	"icon.file": "[F]",
	"icon.git": "git:",
	"icon.branch": "@",
	"icon.pr": "PR",
	"icon.tokens": "tok:",
	"icon.context": "ctx:",
	"icon.cost": "$",
	"icon.time": "t:",
	"icon.pi": "pi",
	"icon.ghost": "@",
	"icon.agents": "AG",
	"icon.job": "bg",
	"icon.output": "out:",
	"icon.throughput": "tok/s:",
	"icon.cache": "cache",
	"icon.cacheMiss": "!",
	"icon.input": "in:",
	"icon.host": "host",
	"icon.session": "id",
	"icon.package": "[P]",
	"icon.warning": "[!]",
	"icon.rewind": "<-",
	"icon.auto": "[A]",
	"icon.fast": ">>",
	"icon.extensionSkill": "SK",
	"icon.extensionTool": "TL",
	"icon.extensionSlashCommand": "/",
	"icon.extensionMcp": "MCP",
	"icon.extensionRule": "RL",
	"icon.extensionHook": "HK",
	"icon.extensionPrompt": "PR",
	"icon.extensionContextFile": "CF",
	"icon.extensionInstruction": "IN",
	// STT
	"icon.mic": "MIC",
	// Compaction divider
	"icon.camera": "[o]",
	// Thinking Levels
	"thinking.minimal": "[min]",
	"thinking.low": "[low]",
	"thinking.medium": "[med]",
	"thinking.high": "[high]",
	"thinking.xhigh": "[xhi]",
	"thinking.max": "[max]",
	"thinking.autoPending": "[~]",
	// Checkboxes
	"checkbox.checked": "[x]",
	"checkbox.unchecked": "[ ]",
	"radio.selected": "(o)",
	"radio.unselected": "( )",
	"format.bullet": "*",
	"format.dash": "-",
	"format.bracketLeft": "[",
	"format.bracketRight": "]",
	// Markdown-specific
	"md.quoteBorder": "|",
	"md.hrChar": "-",
	"md.bullet": "*",
	"md.colorSwatch": "[]",
	"advisor.rail": "|",
	// Language icons (ASCII uses abbreviations)
	"lang.default": "code",
	"lang.typescript": "ts",
	"lang.javascript": "js",
	"lang.python": "py",
	"lang.rust": "rs",
	"lang.go": "go",
	"lang.java": "java",
	"lang.c": "c",
	"lang.cpp": "cpp",
	"lang.csharp": "cs",
	"lang.ruby": "rb",
	"lang.julia": "jl",
	"lang.php": "php",
	"lang.swift": "swift",
	"lang.kotlin": "kt",
	"lang.shell": "sh",
	"lang.html": "html",
	"lang.css": "css",
	"lang.json": "json",
	"lang.yaml": "yaml",
	"lang.markdown": "md",
	"lang.sql": "sql",
	"lang.docker": "docker",
	"lang.lua": "lua",
	"lang.text": "txt",
	"lang.env": "env",
	"lang.toml": "toml",
	"lang.xml": "xml",
	"lang.ini": "ini",
	"lang.conf": "conf",
	"lang.log": "log",
	"lang.csv": "csv",
	"lang.tsv": "tsv",
	"lang.image": "img",
	"lang.pdf": "pdf",
	"lang.archive": "zip",
	"lang.binary": "bin",
	// Settings tab icons
	"tab.appearance": "[A]",
	"tab.model": "[M]",
	"tab.interaction": "[I]",
	"tab.context": "[X]",
	"tab.files": "[F]",
	"tab.shell": "[S]",
	"tab.tools": "[T]",
	"tab.memory": "[Y]",
	"tab.tasks": "[K]",
	"tab.providers": "[P]",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "+f",
	"tool.edit": "~",
	"tool.bash": "$",
	"tool.ssh": "ssh",
	"tool.lsp": "lsp",
	"tool.gh": "gh",
	"tool.webSearch": "web",
	"tool.exa": "exa",
	"tool.browser": "[w]",
	"tool.eval": ">_",
	"tool.debug": "dbg",
	"tool.mcp": "<>",
	"tool.job": "job",
	"tool.launch": "run",
	"tool.task": ">>>",
	"tool.todo": "[x]",
	"tool.memory": "mem",
	"tool.ask": "[?]",
	"tool.resolve": "[v]",
	"tool.review": "rev",
	"tool.inspectImage": "[i]",
	"tool.goal": "(o)",
	"tool.irc": "irc",
	"tool.delete": "rm",
	"tool.move": "mv",
};

export const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	nerd: NERD_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

export type SpinnerType = "status" | "activity" | "thinking";

export const SPINNER_FRAMES: Record<SymbolPreset, Record<SpinnerType, string[]>> = {
	unicode: {
		// The breathing pixel: the sun's intensity ramp inhaling and exhaling —
		// the brand compressed into one quiet cell.
		status: ["·", ":", "░", "▒", "▓", "█", "▓", "▒", "░", ":"],
		activity: ["·", ":", "░", "▒", "▓", "█", "▓", "▒", "░", ":"],
		thinking: ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"],
	},
	nerd: {
		status: ["·", ":", "░", "▒", "▓", "█", "▓", "▒", "░", ":"],
		activity: ["·", ":", "░", "▒", "▓", "█", "▓", "▒", "░", ":"],
		thinking: ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"],
	},
	ascii: {
		status: ["|", "/", "-", "\\"],
		activity: ["-", "\\", "|", "/"],
		// Single frame: consumers skip the animation timer entirely for a
		// one-frame set, so ASCII terminals get a static marker, not churn.
		thinking: ["*"],
	},
};

/**
 * Shape accepted by `themeJson.symbols.spinnerFrames`. A flat array applies to
 * the `status` and `activity` spinners; an object lets a theme override
 * `status`, `activity`, and/or `thinking` independently. Anything not
 * specified falls back to the symbol preset's default frames.
 */
export type SpinnerFramesOverride = string[] | { status?: string[]; activity?: string[]; thinking?: string[] };

export function normalizeSpinnerFramesOverride(
	value: SpinnerFramesOverride | undefined,
): Partial<Record<SpinnerType, string[]>> {
	if (value === undefined) return {};
	if (Array.isArray(value)) return { status: value, activity: value };
	const result: Partial<Record<SpinnerType, string[]>> = {};
	if (value.status) result.status = value.status;
	if (value.activity) result.activity = value.activity;
	if (value.thinking) result.thinking = value.thinking;
	return result;
}
