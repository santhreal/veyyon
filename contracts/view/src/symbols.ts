/**
 * The Unicode glyph table every host draws a symbol key from.
 *
 * A tool names a symbol by key (`tool.edit`, `status.running`, `checkbox.unchecked`) and never by
 * glyph, so the key must resolve on every host. This table is that resolution for the plain Unicode
 * preset; the terminal layers its Nerd Font and ASCII presets over it, the HTML export, the collab
 * web guest and the graphical host draw it as is. A key with no entry here is unknown to every host
 * and draws nothing, never the key text.
 *
 * `SymbolKey` is derived from the table, so a key added here is a key on every host at once.
 */

export const UNICODE_SYMBOLS = {
	// Status
	"status.success": "✓",
	"status.error": "✗",
	// A bare stroke matching ✓/✗ — this used to be the literal word "warn",
	// which leaked as text ("warn interrupted" in the resume dialog).
	"status.warning": "!",
	// FONT COVERAGE CONTRACT: this preset is what a user WITHOUT a Nerd Font
	// sees, so every glyph in it has to exist in the monospace fonts a plain
	// terminal actually falls back to. The bar is DejaVu Sans Mono and FreeMono,
	// the two broad-repertoire monospace faces shipped nearly everywhere. Noto
	// Sans Mono is deliberately NOT the bar: its repertoire stops at Latin,
	// Greek and Cyrillic, so it lacks even ✓ and ✗ and leans on fontconfig to
	// fall back to Noto Sans Symbols.
	//
	// Six picks failed that bar and were replaced on 2026-07-27. `⟳` (U+27F3)
	// was the RUNNING status, and DejaVu does not have it, so every busy agent
	// row in the agent dashboard rendered a tofu box; it is `◐` now, which
	// joins the `●`/`◦` circle family the other status marks already use.
	// `⤵`/`⤴` (U+2935/U+2934) were the token in/out icons in the status line and
	// exist in none of the three fonts checked; they are `↓`/`↑`. `⧉` (U+29C9)
	// is `◫`, `⎇` (U+2387) is `◈` and `⦸` (U+29B8) is `⊗`.
	//
	// `every-unicode-glyph-exists-in-a-plain-monospace-font.test.ts` is the
	// ratchet: a codepoint added here fails until it is measured and listed.
	// WIDTH CONTRACT: every status glyph must be unambiguously ONE cell wide.
	// East-Asian-ambiguous codepoints (ⓘ U+24D8) and emoji-presentation
	// codepoints (⏳ U+231B, ⏹ U+23F9) render TWO cells in many terminal
	// fonts while the TUI counts one, so the glyph swallows its following
	// space and overlaps the label ("ⓘwaiting on 1 job", live report
	// 2026-07-22). Replacements come from narrow-safe ranges only.
	"status.info": "i",
	"status.pending": "⋯",
	"status.disabled": "⊗",
	// House block style (see docs/internal/tui-design-language.md "Blockiness"):
	// a bare presence marker is a square, not a circle. `▪` = present/on/done,
	// `▫` = shadowed/auto. Kept distinct from the `■`/`□` checkbox squares.
	"status.enabled": "▪",
	"status.running": "◐",
	// ◦ pairs with the ● active mark as its unfilled state. The former ◌
	// (U+25CC DOTTED CIRCLE) is the combining-mark placeholder glyph and
	// reads as a rendering artifact in many fonts.
	"status.connecting": "◦",
	"status.active": "●",
	"status.shadowed": "▫",
	// ∎ (U+220E) keeps the house blockiness while staying narrow-safe; the
	// former ⏹ carries emoji presentation and rendered two cells wide.
	"status.aborted": "∎",
	"status.done": "▪",
	// Navigation
	"nav.cursor": "›",
	"nav.selected": "›",
	"nav.expand": "▸",
	"nav.collapse": "▾",
	"nav.back": "⟵",
	"nav.prev": "◂",
	"nav.next": "▸",
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
	// line reads as clean silver text, not a row of mismatched glyphs. veyyon shipped
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
	"icon.pause": "‖",
	"icon.loop": "↻",
	"icon.folder": "",
	"icon.worktree": "◫",
	"icon.search": "⌕",
	// Ephemeral mark: the house "shadowed" square (see status.shadowed). The old 🗑
	// read as "this session is garbage"; its ◌ replacement (U+25CC DOTTED CIRCLE)
	// is the combining-mark placeholder glyph and read as a rendering artifact
	// next to the blank regular folder icon.
	"icon.scratchFolder": "▫",
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
	// Unread agent-to-agent messages waiting on a roster row. `✉` is in every
	// broad monospace face, unlike the `⧉` this row used to hard-code inline.
	"icon.unread": "✉",
	"icon.job": "",
	"icon.cache": "",
	"icon.cacheMiss": "⊘",
	"icon.input": "↓",
	"icon.output": "↑",
	"icon.throughput": "",
	"icon.host": "",
	"icon.profile": "",
	"icon.session": "",
	"icon.package": "",
	"icon.warning": "!",
	"icon.rewind": "↶",
	"icon.auto": "∞",
	"icon.fast": "",
	"icon.extensionSkill": "*",
	"icon.extensionTool": "",
	"icon.extensionSlashCommand": "⌘",
	"icon.extensionMcp": "",
	"icon.extensionRule": "",
	"icon.extensionHook": "",
	"icon.extensionPrompt": "¶",
	"icon.extensionContextFile": "",
	"icon.extensionInstruction": "",
	// STT
	"icon.mic": "",
	// Compaction divider
	"icon.camera": "",
	// Thinking levels: an eighth-block level gauge (▁▂▃▅▆█), so reasoning effort
	// reads as rising magnitude rather than as filling quadrant circles. The
	// Plain text labels, no leading bar glyph: the block bars (▁▂▃▅▆█) rendered
	// as stray solid rectangles next to the word and read as artifacts, not a
	// scale. `glyphOf`/`thinkingGlyph` split on the first space, so with no glyph
	// they return the label itself — the compact chip shows the word instead.
	"thinking.minimal": "min",
	"thinking.low": "low",
	"thinking.medium": "med",
	"thinking.high": "high",
	"thinking.xhigh": "xhigh",
	"thinking.max": "max",
	"thinking.autoPending": "◐",
	// Checkboxes. `progress` sits in the same Geometric Shapes block and the same
	// East Asian width class as the other two, so a terminal that widens `■`
	// widens all three and the column stays aligned. Half-filled reads as
	// half-done without depending on colour.
	// An in-progress task must remain distinguishable from a pending one in a
	// monochrome capture and without relying on differences in hue.
	"checkbox.checked": "■",
	"checkbox.unchecked": "□",
	"checkbox.progress": "◧",
	// Radio (single-choice): squared to match the house block style, and kept
	// visually distinct from the `■`/`□` checkbox — `▣` is a square-in-square so
	// a selected radio never reads as a checked box.
	"radio.selected": "▣",
	"radio.unselected": "□",
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
	// The tool block's rail. One cell, lighter than `advisor.rail`: a note speaks once
	// and a tool block is the most repeated object in a session, so its rail has to
	// carry the block's colour without becoming the loudest column on the screen.
	"block.rail": "▏",
	// Language/file icons. EVERY ONE IS EMPTY, AND THAT IS THE VALUE.
	//
	// There is no Nerd Font here, and the honest set of one-cell glyphs that read as
	// "TypeScript" or "Dockerfile" in a plain monospace font is the empty set. What shipped
	// instead was `lang.default: "⌘"` with every language blank and a fallback in
	// {@link Theme.getLangIcon} that turned blank into the default: so every file in the
	// product wore the Command glyph, and `Edit: ⌘ hosts/terminal/engine/src/box.ts` badged a
	// TypeScript file with a mark that means "unknown kind". A badge identical on every row
	// distinguishes nothing, and it cost two columns of a header whose path is already
	// truncated to fit.
	//
	// The path carries the fact. `nerd` has devicons and `ascii` has per-language
	// abbreviations, so both still badge; this preset does not.
	"lang.default": "",
	"lang.typescript": "",
	"lang.javascript": "",
	"lang.python": "",
	"lang.rust": "",
	"lang.go": "",
	"lang.java": "",
	"lang.c": "",
	"lang.cpp": "",
	"lang.csharp": "",
	"lang.ruby": "",
	"lang.julia": "",
	"lang.php": "",
	"lang.swift": "",
	"lang.kotlin": "",
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
	"lang.xml": "",
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
	// Icon-light doctrine (see the icon block comment above): the category name
	// stands alone. The old arbitrary mnemonic letters ("K Interaction",
	// "R Memory", "N Providers") read as noise, not navigation.
	"tab.appearance": "",
	"tab.model": "",
	"tab.interaction": "",
	"tab.resources": "",
	"tab.context": "",
	"tab.rules": "",
	"tab.files": "",
	"tab.shell": "",
	"tab.tools": "",
	"tab.memory": "",
	"tab.tasks": "",
	"tab.agents": "",
	// icon-light doctrine applies to Global too — the lone 🌐 emoji among ten
	// bare labels read as a glitch, not an accent.
	"tab.providers": "",
	"tab.global": "",
	"tab.experimental": "",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "❐",
	"tool.edit": "✎",
	"tool.bash": ">",
	"tool.ssh": "⇄",
	"tool.lsp": "",
	"tool.gh": "◈",
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
	"tool.resolve": "✓",
	"tool.review": "◉",
	"tool.inspectImage": "",
	"tool.goal": "◎",
	"tool.irc": "",
	"tool.delete": "",
	"tool.move": "",
} satisfies Record<string, string>;

/** Every symbol key a view may name, derived from the table so the two cannot drift. */
export type SymbolKey = keyof typeof UNICODE_SYMBOLS;
