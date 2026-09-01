/**
 * What a tool says its output looks like, without saying what draws it.
 *
 * A tool that builds a terminal `Component` can only ever run in a terminal. Every renderer in this
 * repository took a `Theme` and returned a `Component`, so the tool held a reference to the terminal
 * and no other host could show its output. That is what makes a tool part of the terminal rather than
 * a plugin.
 *
 * The types here are the other half: a tool returns one of these, a host draws it. The tool receives
 * nothing from the host, so it names no colour, no glyph, no width and no component. It states what
 * the row MEANS -- this is an error, this is the title, this part is secondary -- and the host decides
 * how that looks. A terminal maps a tone to an ANSI colour and a status to a glyph; a graphical host
 * maps the same tone to a CSS class and the same status to an icon, from the same value.
 *
 * The shapes are not invented. They are the shapes the tool renderers in this repository already
 * produce: a one-line status row (icon, title, description, trailing metadata) and a block of styled
 * text. Anything richer stays with the host-specific renderer until a second host needs it, because a
 * contract that guesses at a shape no caller produces is a shape nobody can draw.
 */

/**
 * What a tool reports about its own state.
 *
 * Semantic, never a glyph: a host chooses the symbol, the colour and whether `running` animates.
 */
export type ViewStatus = "success" | "done" | "error" | "warning" | "info" | "pending" | "running" | "aborted";

/**
 * The role a run of text plays, which a host maps to its own appearance.
 *
 * `title` is the name of the thing, `accent` its subject, `output` the text the tool itself
 * produced, `link` a target the reader can follow, `muted` and `dim` are secondary detail at two
 * strengths, `diffAdded` and `diffRemoved` are the two sides of a change, and the remaining four
 * carry outcome. A tone is a meaning, so a host is free to draw two of them the same way.
 */
export type ViewTone =
	| "title"
	| "accent"
	| "output"
	| "link"
	| "muted"
	| "dim"
	| "diffAdded"
	| "diffRemoved"
	| "success"
	| "warning"
	| "error"
	| "info";

/**
 * A run of text with one tone.
 *
 * Emphasis is separate from tone because the two compose: a bold title and a bold error are both
 * reachable, and a host that cannot render bold drops the emphasis and keeps the tone.
 */
export interface ViewSpan {
	text: string;
	/** Omitted means the host's ordinary body text. */
	tone?: ViewTone;
	bold?: boolean;
	italic?: boolean;
	/**
	 * A run struck through, which is a state the text is IN rather than a colour it carries.
	 *
	 * A closed task is the case: the tone says it succeeded and the strike says it is finished with.
	 * It is separate from tone for the reason `bold` is, and a host that cannot draw a strike drops
	 * it and keeps the words, which is what a terminal with attributes off already does.
	 */
	strike?: boolean;
	/**
	 * A glyph the host resolves from its own registry, drawn INSTEAD of `text` and in the span's tone.
	 *
	 * A row-level `emblem` marks what a card IS; this marks one run inside a line, which is what a
	 * finding's priority mark is: the same line carries the mark and the `[P1]` label beside it, and the
	 * mark is decoration the label already states in words. So `text` is the fallback a host without
	 * the glyph draws, and it may be empty, which is a tool saying the mark carries nothing the rest of
	 * the line does not.
	 */
	symbol?: string;
	/**
	 * A target this run names, which the host makes reachable however it can.
	 *
	 * A terminal wraps the run in an OSC 8 hyperlink, a browser draws an anchor and a transcript export
	 * writes a Markdown link, so the tool states the URL and never the escape bytes. It is separate
	 * from `tone` because the two are separate decisions: a run may be a link drawn in the host's link
	 * colour, a link drawn as ordinary text, or link-coloured text that goes nowhere.
	 */
	link?: string;
	/**
	 * A filesystem path this run names, which the host opens however it can.
	 *
	 * Separate from `link`, which carries a URL: a path is not one, and turning it into a `file://`
	 * URI means resolving it against a working directory and percent-encoding it, which is the host's
	 * answer rather than the tool's. A terminal wraps the run in an OSC 8 link to that URI, an editor
	 * host opens the file in a pane, and a browser that can reach no filesystem draws the text and
	 * nothing else. A run may carry both, and a host that offers one of the two uses that one.
	 */
	file?: string;
	/**
	 * The language of the source this run names, which a host may badge.
	 *
	 * The span-level twin of `StatusRowView.language`, for a line that names a file inside a card
	 * rather than at its head: a diagnostics group states the file it belongs to and the language it
	 * is in, and a terminal draws its own glyph for the language while a host with no icon set draws
	 * the path alone.
	 *
	 * Empty states a file whose language the tool could not tell, which is not the same as omitting
	 * the field: a run with no language names no file, and a run with an empty one names a file a
	 * host may still mark with whatever it draws for a language it does not know.
	 */
	language?: string;
}

/**
 * A one-line summary of a call or its result.
 *
 * This is the shape the great majority of tool output already has. The host owns the separators, so
 * the tool never writes a colon after the title or a dot between metadata entries: a terminal joins
 * metadata with its own separator glyph and a graphical host may lay the entries out as chips.
 */
export interface StatusRowView {
	kind: "statusRow";
	/** Omitted draws no icon, for a row that is a label rather than an outcome. */
	status?: ViewStatus;
	/**
	 * The tool's own emblem instead of an outcome icon, named as a registry key the host resolves.
	 *
	 * A settled card is titled by what the tool IS rather than by how its last call ended, which is
	 * the difference between `◎ Goal` and `✔ Goal`. The key is data, not a host reference: a terminal
	 * looks it up in its glyph table and a graphical host in its icon set, and a host that has no
	 * entry for it falls back to `status`, so an unknown emblem loses decoration and never the row.
	 */
	emblem?: string;
	title: string;
	/** Omitted lets the host pick the tone it gives a title. */
	titleTone?: ViewTone;
	/** Secondary text after the title, describing what happened. */
	description?: string;
	/**
	 * The role the description plays, which a host maps to its own appearance.
	 *
	 * The twin of `titleTone`, and needed for the same reason: the description of a card that wrote a
	 * file IS the file, so it is the subject of the row rather than secondary detail, while the
	 * description of a card that reports an operation is prose. Omitted lets the host pick the tone
	 * it gives secondary text.
	 */
	descriptionTone?: ViewTone;
	/**
	 * A target the description names, which the host makes reachable.
	 *
	 * The description of a row that reports on a URL or a file IS the thing it names, so the link
	 * belongs to the whole of it rather than to a run inside it, and a row states the target without
	 * stating how a reader follows it.
	 */
	descriptionLink?: string;
	/**
	 * A filesystem path the description names, which the host opens however it can.
	 *
	 * Separate from `descriptionLink` for the reason `ViewSpan.file` is separate from `ViewSpan.link`:
	 * a path is not a URL, and the path a row shows is often the one a reader recognises -- relative
	 * to the working directory, or shortened to `~` -- while the one a host must open is absolute. So
	 * the row states the readable path as its description and the absolute one here.
	 */
	descriptionFile?: string;
	/** A short parenthetical label, such as a mode or a count. */
	badge?: { label: string; tone: ViewTone };
	/**
	 * Trailing detail, one entry per fact, which the host joins with its own separator.
	 *
	 * An entry is a line rather than a run because one fact may take several: the task a todo write
	 * moved is a state mark and the task's words, and a row that stated them as two entries would put
	 * the host's separator between a glyph and the thing it marks.
	 */
	meta?: readonly ViewLine[];
	/**
	 * The language of the source a row names, stated as a name rather than as a decoration.
	 *
	 * A terminal draws its own badge for it, an editor host colours the tab it opens and a transcript
	 * export writes the name in a fence. The tool knows the language because it resolved the file it
	 * wrote; how a reader is told is nobody's business but the host's, and a host with no badge for a
	 * language it does not know drops the badge and keeps the row.
	 *
	 * Empty states a file whose language the tool could not tell, and omitting the field states a row
	 * that names no file at all. A card that wrote `Makefile` is the first of the two: there is a
	 * file, and a host that marks files marks this one however it marks a language it cannot name.
	 */
	language?: string;
}

/**
 * A run of styled text, wrapped and laid out by the host.
 *
 * A newline inside a span's text is a line break the tool intends. The host owns wrapping, so a tool
 * never breaks a line to fit a width it was not told.
 */
export interface TextBlockView {
	kind: "textBlock";
	spans: readonly ViewSpan[];
}

/**
 * One line of a block: the spans that make it up, in order.
 *
 * A line is never a string, because a string carries the host's escape bytes and a tool that builds
 * one has already decided what colour it is.
 */
export type ViewLine = readonly ViewSpan[];

/**
 * What a card held back, so the host is the one that names the gesture for seeing it.
 *
 * A tool that trims its own output to a preview knows how much it dropped and knows nothing about
 * how a reader asks for the rest: a terminal says `▸ ctrl+o expand`, a graphical host draws a
 * disclosure triangle, and a transcript export has no gesture at all. So the tool states the count
 * and whether more is reachable, and the host writes the sentence.
 *
 * `noun` is the unit the count is in, for a card whose preview trims something other than lines --
 * memories, files, findings. Omitted states the bare count, which is what a card says when the
 * lines above already make the unit obvious.
 */
export interface ViewHiddenCount {
	count: number;
	noun?: { one: string; many: string };
	/** False once the reader has everything, so the host offers no gesture it cannot honour. */
	revealable: boolean;
}

/**
 * A section the host shows the END of, cut to the rows it has room for.
 *
 * The other way a card holds lines back, and the one a tool cannot do itself: how many rows a
 * command or a stream of output occupies is known only after the host wraps it to a width the tool
 * never sees, and how many rows are available is the host's viewport. So the tool states the whole
 * section and says which end matters -- for a command still arriving and for output a process is
 * writing, that is the end -- and the host cuts the front off and states what it dropped.
 *
 * `ViewHiddenCount` is the other case and stays separate: there the tool trimmed its own payload and
 * knows exactly what it kept back. Here nothing is trimmed, and a wide enough terminal shows all of
 * it.
 */
export interface ViewTailWindow {
	/**
	 * The rows the section may spend, the host's note among them.
	 *
	 * Omitted leaves the bound to the host, which is what a card whose preview should follow the
	 * window the reader has states: a taller terminal shows more of it.
	 */
	max?: number;
}

/**
 * That a section's lines are source text, which the host colours and numbers.
 *
 * A tool that writes or reads a file knows the text and the language and nothing about how either is
 * shown: a terminal highlights the run and draws a line-number gutter, an editor host hands the
 * lines to its own tokenizer, and a transcript export writes a fenced block naming the language. So
 * the section states the source, and the spans of a code line carry the text alone -- a tool that
 * toned its own keywords would be writing a colour scheme.
 */
export interface ViewCodeLines {
	/**
	 * The language the source is in, by name.
	 *
	 * Omitted means the tool could not tell, which is what a file with no extension is: a host then
	 * draws the lines without colouring them rather than guessing.
	 */
	language?: string;
	/**
	 * The number the section's first line has in the file, so a window onto the middle of one is
	 * numbered by where it sits rather than from one.
	 *
	 * Omitted means the lines are not numbered at all, which is what a fragment with no place in a
	 * file is.
	 */
	firstLineNumber?: number;
	/**
	 * How many lines the whole source has, so every window of it is numbered in a gutter of one
	 * width and the rows do not shift as more of the file arrives.
	 *
	 * Omitted sizes the gutter to the lines the section carries.
	 */
	totalLines?: number;
}

/**
 * A labelled group of lines inside a block.
 *
 * The label is text, not chrome: the host decides whether it draws as a heading, a divider or a
 * legend, and a section with no label is a group the host separates its own way.
 */
export interface ViewSection {
	label?: string;
	lines: readonly ViewLine[];
	/**
	 * What this section trimmed away, when the hold-back belongs to one group rather than the card.
	 *
	 * A panel whose metadata is complete and whose content is a three-line preview holds nothing back
	 * at the card level and everything back in one section, so the note goes where the missing lines
	 * are and the host still writes it.
	 */
	hidden?: ViewHiddenCount;
	/**
	 * That this section is a window onto its end, cut by the host rather than by the tool.
	 *
	 * Omitted means the lines are the section, and a host draws every one of them.
	 */
	tail?: ViewTailWindow;
	/**
	 * That the lines are the items of a list, which the host marks and closes its own way.
	 *
	 * A terminal draws a tree, with a branch on every item and a different one on the last, and puts
	 * the held-back note on the closing branch; a graphical host draws list rows. The tool states one
	 * line per item and the count it kept back, and never a connector glyph, which is the part that
	 * was terminal chrome in every hand-written card that drew one.
	 *
	 * One line per item: a list whose items are several lines each has structure this does not carry,
	 * and a tool with one states it as its own sections instead.
	 */
	list?: boolean;
	/**
	 * That the lines are source text rather than prose, which the host colours and numbers.
	 *
	 * Omitted means the lines are the tool's own words, toned by the tool. A code section states the
	 * text and the language and leaves every appearance decision -- the colouring, the gutter, what a
	 * tab is worth -- to the host, which is the only party that knows what it can draw.
	 */
	code?: ViewCodeLines;
}

/**
 * A header row with its own lines under it, drawn without a frame.
 *
 * The shape a terse card already has: one status row, a few indented lines, and a note that more was
 * held back. A framed block is the wrong kind for it -- these cards are deliberately frameless, and a
 * rail around two bullets reads as a panel around nothing -- and a text block is the wrong kind too,
 * because a text block is one run of styled text and states no header and no held-back count.
 *
 * The lines are the tool's; the indent, the width they are cut to and the held-back note are the
 * host's.
 */
export interface HeadedBlockView {
	kind: "headedBlock";
	/** Omitted means the block is its lines alone, for a card whose row is drawn elsewhere. */
	header?: StatusRowView;
	lines: readonly ViewLine[];
	/** Omitted means the lines are everything the card has. */
	hidden?: ViewHiddenCount;
}

/**
 * A titled block of sections, framed by the host.
 *
 * This is the shape a tool reaches for when its output is a panel rather than a row: a header, then
 * grouped lines under it. The width is the host's, which is what made this kind necessary — every
 * framed renderer in this repository was a closure over a width the terminal passed in, so the tool
 * held the terminal's layout. Here the tool states the lines and the host wraps them.
 *
 * `state` is what the block REPORTS, never how the frame looks. A host maps it to its own chrome: a
 * terminal draws a coloured rail, a graphical host a border or a background.
 */
export interface FramedBlockView {
	kind: "framedBlock";
	header: StatusRowView;
	/** Omitted means the block reports nothing beyond its contents. */
	state?: ViewStatus;
	sections: readonly ViewSection[];
	/**
	 * What the block's body IS, which decides WHERE the host states the block's state.
	 *
	 * `report` (the default) is a card whose body states the outcome -- an error message, a summary,
	 * a settled row of counts -- so a host may carry the state across the whole card and leave its
	 * edge quiet. `data` is a card whose body is content the tool fetched or read, where the same
	 * treatment reads as highlighting text nobody highlighted: a host states the outcome on the
	 * card's edge instead and leaves the body on its ordinary ground. `listing` is a card whose body
	 * is a record the tool keeps -- a plan, a queue, a roster -- where the state belongs to the write
	 * that produced the card and not to the record it shows, so a host states it quietly and leaves
	 * both the body and the edge alone.
	 *
	 * Either way the state is stated once. This is not a request for chrome, and a host with one way
	 * of drawing a panel may ignore it.
	 */
	contents?: "report" | "data" | "listing";
}

/**
 * A short notice whose whole body carries one state.
 *
 * The shape a decision takes: an action was applied or rejected, and the card says so across its
 * full width rather than in a coloured mark at the start of a row. A framed block is the wrong kind
 * for it, because a notice has no sections to group and no header row to sit above them, and a text
 * block is the wrong kind too, because a run of styled text states no state at all.
 *
 * A span inside a notice states EMPHASIS and structure, never colour: the whole notice is one
 * state, so a host that let a span carry its own tone would be drawing two answers to the same
 * question. A tone on such a span is the tool overriding the notice, and a host is free to ignore
 * it.
 */
export interface NoticeView {
	kind: "notice";
	state: ViewStatus;
	/** A symbol the notice opens with, as a registry key the host resolves; unknown to a host, it is dropped. */
	mark?: string;
	headline: ViewLine;
	/** A short label set off at the end of the headline, naming what the notice is about. */
	tag?: string;
	/** Lines under the headline, inside the same notice. */
	body?: readonly ViewLine[];
}

/** Everything a host knows how to draw. */
export type ToolView = StatusRowView | TextBlockView | HeadedBlockView | FramedBlockView | NoticeView;

/**
 * The views that are one line of text, which a host can draw without a width.
 *
 * Neither block kind is one of them: a framed block has sections to lay out and a headed block has
 * lines to cut to a width, so a host draws both as containers.
 */
export type LineToolView = StatusRowView | TextBlockView;

/**
 * What the surface knows about the card when it asks for a view, which names no host.
 *
 * A collapsed card shows a summary and an expanded one shows everything, and only the surface knows
 * which the reader chose. A terminal expands on a keypress and a graphical host on a disclosure
 * control; both answer the same boolean, so a tool that shows a longer output when expanded is
 * host-agnostic and a tool that reads a `Theme` is not.
 *
 * `partial` is the other thing only the surface knows: whether the result in hand is the tool's last
 * word or an update it will replace. A tool that streams says a different thing about the same
 * payload -- running rather than succeeded -- and without this it would have to read the outcome off
 * a half-finished result and report success on every update.
 *
 * `frame` is how many animation frames the surface has advanced since the card appeared. A card
 * whose content changes over those frames -- a strike sweeping across a task as it closes -- states
 * the content for the frame it is given, which is host-agnostic in the way a spinner glyph is not:
 * the surface owns the clock and the tool owns what the animation shows. Omitted means the surface
 * animates nothing, so the card states its settled content.
 */
export interface ToolViewContext {
	expanded: boolean;
	/** Omitted means the result is settled, which is what a call site with nothing to stream states. */
	partial?: boolean;
	frame?: number;
}

/**
 * How a tool describes its call and its result, for any host.
 *
 * The absence of a host parameter is the whole point, and is what a gate can check: a renderer that
 * needs a `Theme` to answer cannot implement this. Both members are optional because a tool may
 * describe only one of the two and leave the other to the host's default presentation, and a
 * renderer that does not vary with disclosure declares one parameter and ignores the context.
 *
 * `renderResult` receives the call arguments as well, because a result card that says what happened
 * has to name what was asked, and a failed call carries no details to read it from: a goal that
 * failed to resume reports the operation from the arguments or reports nothing. They are optional
 * for the same reason the host's are: a rebuilt transcript may have the result and not the call.
 */
export interface ToolViewRenderer<Args = unknown, Result = unknown> {
	renderCall?: (args: Args, context: ToolViewContext) => ToolView;
	renderResult?: (result: Result, context: ToolViewContext, args?: Args) => ToolView;
}
