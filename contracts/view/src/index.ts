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
 * `title` is the name of the thing, `accent` its subject, `muted` and `dim` are secondary detail at
 * two strengths, and the remaining four carry outcome. A tone is a meaning, so a host is free to draw
 * two of them the same way.
 */
export type ViewTone = "title" | "accent" | "muted" | "dim" | "success" | "warning" | "error" | "info";

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
	/** A short parenthetical label, such as a mode or a count. */
	badge?: { label: string; tone: ViewTone };
	/** Trailing detail. A host joins these with its own separator. */
	meta?: readonly ViewSpan[];
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
 * A labelled group of lines inside a block.
 *
 * The label is text, not chrome: the host decides whether it draws as a heading, a divider or a
 * legend, and a section with no label is a group the host separates its own way.
 */
export interface ViewSection {
	label?: string;
	lines: readonly ViewLine[];
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
}

/** Everything a host knows how to draw. */
export type ToolView = StatusRowView | TextBlockView | FramedBlockView;

/**
 * The views that are one line of text, which a host can draw without a width.
 *
 * A framed block is not one of them: it has sections to lay out, so a host draws it as a container.
 */
export type LineToolView = StatusRowView | TextBlockView;

/**
 * What the reader has already asked of the card, which names no host.
 *
 * A collapsed card shows a summary and an expanded one shows everything, and only the surface knows
 * which the reader chose. A terminal expands on a keypress and a graphical host on a disclosure
 * control; both answer the same boolean, so a tool that shows a longer output when expanded is
 * host-agnostic and a tool that reads a `Theme` is not.
 */
export interface ToolViewContext {
	expanded: boolean;
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
