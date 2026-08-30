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

/** Everything a host knows how to draw. */
export type ToolView = StatusRowView | TextBlockView;

/**
 * How a tool describes its call and its result, for any host.
 *
 * The absence of a host parameter is the whole point, and is what a gate can check: a renderer that
 * needs a `Theme` to answer cannot implement this. Both members are optional because a tool may
 * describe only one of the two and leave the other to the host's default presentation.
 */
export interface ToolViewRenderer<Args = unknown, Result = unknown> {
	renderCall?: (args: Args) => ToolView;
	renderResult?: (result: Result) => ToolView;
}
