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
	| "info"
	/**
	 * Money a run spent, which is a fact of its own rather than an outcome.
	 *
	 * A card that reports work done by a model states what the work cost, and the figure is neither
	 * good news nor bad: `success` would read as an outcome and `dim` as detail nobody scans, which
	 * is the opposite of how a reader uses it. A terminal has carried a colour of its own for this
	 * since before a view existed -- the status line, the agent roster and the subagent wall all
	 * draw the same one -- and a host with no such colour draws the figure in its body text.
	 */
	| "cost"
	/**
	 * The host's own body text, stated rather than inherited.
	 *
	 * A run with no tone takes whatever colour the surrounding row was left in, which is right for a
	 * fragment inside a coloured phrase and wrong for a row that has SETTLED: a delegated agent's row
	 * is accent while it runs and plain once it finishes, and "plain" there is a decision the card
	 * made, not the absence of one. Naming it is also what lets a host draw a card on a ground of its
	 * own without a settled row inheriting the ground's colour.
	 */
	| "text";

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
	 * That the text is a run of ANOTHER program's output, captured as that program wrote it.
	 *
	 * The one case where a span's bytes are not the tool's words: a tool that reports a pty-backed
	 * process states the screen that process drew, and the styles in it are the program's own
	 * decisions rather than a colour scheme the tool picked. A tone cannot carry them, because a
	 * captured cell is a truecolor value and a tone is a meaning; decoding the screen into tones would
	 * be the tool inventing a palette for output it only observed.
	 *
	 * So the run stays verbatim, control sequences and all, and every host is told which runs those
	 * are. A terminal replays the subset it trusts -- emphasis and colour -- over its own body colour
	 * and strips the rest. A host that cannot replay them strips every control sequence and keeps the
	 * text, which is what a transcript export and a browser guest do. A host that draws a span's text
	 * without reading this member is the one case a view can leak escape bytes, which is why it is
	 * stated on the span rather than left for a host to infer from the tool it came from.
	 */
	captured?: boolean;
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
	 * That this run is the state mark of its line, drawn INSTEAD of `text` from the host's own glyph
	 * set and animated by the host while the state is one that moves.
	 *
	 * `StatusRowView.status` marks a whole card and this marks one row inside one, which is what a
	 * card whose body is a set of things each doing something needs: a wall of workers and a list of
	 * background jobs are rows that succeeded, failed and are still going, side by side under one
	 * header that reports the set. A row that stated its state in words alone would put a reader to
	 * reading a column of adjectives, and a row that named a glyph would be choosing one.
	 *
	 * A terminal draws the same mark it gives a status row and spins the one that reports `running`,
	 * a graphical host draws its own icon, and a host with no glyph for a state draws `text`, which is
	 * the fallback and may be empty. The mark carries the state's own appearance, so `tone` says
	 * nothing here: two rows reporting the same state look the same however the tool toned the words
	 * beside them.
	 */
	status?: ViewStatus;
	/**
	 * That this run is a short label the host sets off from the words around it, in whatever grammar it
	 * brackets one with.
	 *
	 * The line-level twin of `StatusRowView.badge`, for a row inside a card: a wall of workers marks
	 * each row with the flavour of CLI behind it and a list of jobs with the kind of job it is, and both
	 * are labels rather than prose. A tool that wrote the brackets itself would be choosing the
	 * bracket glyphs, which is the one part of a badge that is the host's -- a terminal theme owns its
	 * pair, and a graphical host draws a chip with no brackets at all.
	 *
	 * `text` is the label alone, so a host that sets nothing off draws exactly the words.
	 */
	badge?: boolean;
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
	 * The line inside `file` this run names, which the host opens the file AT.
	 *
	 * A search result is the case: the run is one matched line of one file, so the target is a
	 * position rather than a document, and a run that named the file alone would send a reader to its
	 * first line. Separate from `file` because most runs that name a path mean the whole of it, and a
	 * host that can only open documents ignores this and still opens the right one.
	 *
	 * Meaningless without `file`, and one-based: the first line of a file is 1, which is what every
	 * editor and every terminal that follows a link expects.
	 */
	fileLine?: number;
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
	/**
	 * That the run is Markdown written for one line, which the host renders however it can.
	 *
	 * The inline twin of `ViewSection.markdown`, for a run whose emphasis is the author's rather than
	 * the tool's: the label of an offered choice is a person's words, and `**pick this**` in it is a
	 * decision the person made about their own text. A tool that toned the run itself would be
	 * deciding what bold looks like, and a tool that stripped the syntax would be editing what was
	 * asked.
	 *
	 * The run is one line, which is what separates this from a section: a document has paragraphs, a
	 * list and fenced code, and none of them fit inside a row beside a marker glyph. A terminal
	 * renders the inline subset over the span's tone, a browser host mounts the same subset as HTML,
	 * and a host with no renderer draws the source, which is the text a reader would have seen either
	 * way.
	 *
	 * `tone` is the ground the rendered run sits on rather than a colour applied over it: the tone
	 * carries the run's own words and whatever the Markdown asks for -- a code span, a link -- takes
	 * the host's own appearance for that. Meaningless with `symbol` or `captured`, each of which
	 * states that the run is not the tool's prose at all.
	 */
	markdown?: boolean;
	/**
	 * That this run, and every run after it on the same line, is trailing detail rather than the
	 * subject of the row.
	 *
	 * The line-level twin of `StatusRowView.meta`, for a row inside a block: a watched CI job is its
	 * name and how long it ran, and the two are one row whose second half is an aside. A host that
	 * lays a row out in columns sets the tail at the end of the row and cuts the words before it,
	 * which is how a column of durations stays a column; a host with one column draws the runs where
	 * they fall, which is the same text in the same order.
	 *
	 * The tail is the END of a line, so the first marked run opens it and nothing after it can leave
	 * it. Meaningless on a list item, a code line and a status row, each of which states its own
	 * structure already.
	 */
	trailing?: boolean;
	/**
	 * That the thing this run names is still in flight, so a host may animate the run while it is.
	 *
	 * The span-level twin of a `running` status: a status marks the whole row and this marks one run
	 * inside it, which is what the wall of live workers needs -- a worker's id and the tool it is part
	 * way through are the moving parts of a row whose other columns are settled facts. A tool that
	 * knows a run is arriving cannot animate it itself, because motion needs a clock and a frame the
	 * tool is not given until the host supplies one in `ToolViewContext`.
	 *
	 * So the run says it is live and the host decides what live looks like: a terminal sweeps a
	 * highlight across it on every frame the surface advances, a graphical host may pulse it, and a
	 * host with no clock -- a transcript export, a still capture -- draws the run in its `tone` and
	 * nothing moves. It is separate from `tone` because the two answer different questions: the tone
	 * is what the run means when it settles, and a settled card carries it with nothing animating.
	 */
	live?: boolean;
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
	/**
	 * The role the emblem plays, for a card whose mark is part of its title rather than a decoration
	 * beside it.
	 *
	 * Omitted lets the host pick, which is an accent: an emblem is usually the one coloured thing on a
	 * settled row. A tool states this when the mark and the title are one subject -- a search card's
	 * glyph reads as a second accent otherwise, competing with the paths the card exists to show.
	 */
	emblemTone?: ViewTone;
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
	 * Whether the description must FIT the columns the row is given, cut inside itself.
	 *
	 * A row overruns its columns when the title, the description and the trailing facts together
	 * outrun them, and a host has two answers: drop what does not fit off the end of the row, or
	 * shorten the description until the rest fits. Which one is right belongs to the card, not to the
	 * host: a row whose description is prose reads fine cut short at the end, while a row whose
	 * description IS the file it acted on loses the fact the row exists to state, and the counts after
	 * it are the ones a reader checks. So a card that names a subject sets this and keeps every part
	 * of its row, and a card that does not leaves the row to the host's own clipping.
	 *
	 * What "fit" looks like is still the host's: a terminal cuts a path through the middle, because
	 * the end of a path is the file name; another host may scroll it, or hover it, or wrap it.
	 */
	descriptionFits?: boolean;
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
	/**
	 * The line inside `descriptionFile` the row names, which the host opens the file AT.
	 *
	 * The row-level twin of `ViewSpan.fileLine`, and needed for the same reason: a card that read one
	 * window of a file names a position rather than a document, and a row that named the file alone
	 * would send a reader to its first line. One-based, and meaningless without `descriptionFile`.
	 */
	descriptionFileLine?: number;
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
	/**
	 * That the host's own bound applies as well, so the window is the SMALLER of the two.
	 *
	 * A card that states a bound of its own and sets this asks for at most that many rows and never
	 * more than fit: a stream of output windowed to the tool's ten rows still has to sit inside a
	 * twenty-four-row terminal, where the frame, the other sections and the composer take rows the
	 * tool cannot see. Without it a bound is the tool's alone, which is what a card whose section is
	 * short by construction wants.
	 */
	viewport?: boolean;
	/**
	 * Rows of the host's own bound the window gives up, for what the card is about to become.
	 *
	 * A preview of something still arriving is replaced by the settled card, and a window that spent
	 * the whole viewport leaves that card nowhere to land: it commits the preview's mutating rows to
	 * scrollback and draws the finished one under them. Only meaningful beside `viewport`, since a
	 * bound the tool set itself already leaves whatever it left.
	 */
	reserve?: number;
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
	/**
	 * The number each line has in the file, one entry per line the section carries, for a section
	 * that is SEVERAL windows onto one file rather than one run of it.
	 *
	 * A read of `:5-16,960-973` and a structural summary that elides the body of every function are
	 * both this shape: the rows are in file order and the numbers jump, so `firstLineNumber` plus a
	 * count would number the second window as a continuation of the first. A `null` entry is a row
	 * that has no number of its own, which is what a marker standing in for an elided span is.
	 *
	 * Omitted numbers the lines from `firstLineNumber`, which is what one contiguous window is. A
	 * host that draws no gutter ignores both.
	 */
	lineNumbers?: readonly (number | null)[];
	/**
	 * A run the host draws before the FIRST line of the source, as an aside rather than as source.
	 *
	 * The prompt a shell command is read under is this: `$ cd services &&` states where the command
	 * ran and is not part of what ran, so a host that highlights the source leaves the lead alone and
	 * one that hands the source to a tokenizer never sends it. A section with no lead is source and
	 * nothing else, which is what a file is, and a section with no source draws no lead.
	 */
	lead?: string;
}

/** Which side of a change one line of a diff section is on. */
export type ViewDiffSide = "added" | "removed" | "context" | "gap";

/**
 * That a section's lines are one change to a file, which the host marks, numbers and colours.
 *
 * The twin of `code` for text that is a CHANGE rather than a file: a tool that edits a file knows
 * which lines it added, which it removed, which stood still and where each one sits, and knows
 * nothing about whether a reader sees a red row, a left-hand gutter, a struck-through word or two
 * panes side by side. So the section states the sides and the numbers, and the host draws them: a
 * terminal marks each row `+`, `-` or a space, colours it, highlights the words that changed inside
 * a one-for-one replacement and colours the unchanged rows in the file's own language; a graphical
 * host may draw the same rows as two columns.
 *
 * The spans of a diff line carry text alone, for the reason a code line's do: a tool that toned its
 * own added rows would be writing a colour scheme. `sides` is one entry per line the section
 * carries, so a line and its side are read together however many the window kept.
 *
 * Mutually exclusive with `code` and `markdown`, each of which states something else about the same
 * lines. A host handed more than one draws the diff, which is the reading that keeps the meaning of
 * a `-` row.
 */
export interface ViewDiffLines {
	/** Which side of the change each line is on, one entry per line the section carries. */
	sides: readonly ViewDiffSide[];
	/**
	 * The number each line has in the file, one entry per line, `null` for a row that has none.
	 *
	 * Omitted draws no gutter at all, which is what a change to a file nobody has yet -- a preview
	 * computed before the edit landed -- is: the rows are the change and no line of them has a place
	 * in a file on disk.
	 */
	lineNumbers?: readonly (number | null)[];
	/**
	 * The file the change is to, so a host colours its unchanged rows in that file's language.
	 *
	 * Omitted states a change whose file the tool could not name, and the rows are drawn uncoloured
	 * rather than guessed at.
	 */
	path?: string;
}

/**
 * That a section's lines are the nodes of a tree, which the host draws connectors for.
 *
 * A card that reports work delegated to other agents is the case: an agent that spawned agents of
 * its own is a structure rather than a list, and the rows under one node -- what it is running, what
 * it found, how much it spent -- belong to that node however deep it sits. `list` states one flat
 * level and one line per item, and a nested run fits neither half of that.
 *
 * So the section states where each line sits and the host draws whatever it draws for depth: a
 * terminal draws the branch, the elbow and the vertical run that carries a parent's line past its
 * children, a graphical host indents or mounts a disclosure widget, and a transcript export writes
 * nested list items. The tool names no glyph, which is the part that was terminal chrome in every
 * hand-written card that drew one.
 *
 * Every member is one entry per line the section carries, read together with the line at the same
 * index, and the lines are in document order: a host that draws connectors resolves a line's
 * ancestors from the lines above it.
 */
export interface ViewTreeLines {
	/** How deep each line sits, `0` for a line at the section's own level. */
	depth: readonly number[];
	/**
	 * Whether each line OPENS the node it belongs to, rather than continuing one already open.
	 *
	 * A node is one line that names it and any number under it that describe it, and only the first
	 * carries a mark: a terminal draws the elbow on the line that opens a node and the vertical run
	 * on the rest, so a node's own detail is not read as four more children.
	 */
	opens: readonly boolean[];
	/**
	 * Whether the node each line belongs to is the last of its parent's children.
	 *
	 * A continuation line carries the same answer its opening line does, since it belongs to the same
	 * node. A host that draws connectors closes the last node with an elbow and stops running the
	 * vertical past it; one that indents ignores this.
	 */
	last: readonly boolean[];
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
	 * That the host divides this section from the one above it.
	 *
	 * A card whose body is a brief and then the agents working from it states two groups a reader
	 * reads separately, and neither of them wants a label: the brief IS the words above the rule.
	 * Meaningless on the first section, which has nothing above it to be divided from, and a host
	 * that separates groups its own way -- whitespace, a card of its own -- ignores it.
	 */
	separator?: boolean;
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
	/**
	 * That the lines are a change to a file rather than prose, which the host marks and colours.
	 *
	 * Omitted means the lines are the tool's own words. A diff section states which side of the
	 * change each line is on and leaves the marker column, the gutter, the colours and whatever a
	 * host does with the words that changed inside a replaced line to the host.
	 */
	diff?: ViewDiffLines;
	/**
	 * That the lines are the nodes of a tree, which the host draws depth for.
	 *
	 * Omitted means the lines are flat, which is what prose and a listing are. A tree section states
	 * where each line sits and leaves every connector, indent and disclosure to the host. It composes
	 * with the tone the tool gave its spans, since depth is structure and not appearance.
	 */
	tree?: ViewTreeLines;
	/**
	 * That the lines are Markdown, which the host renders however it can.
	 *
	 * The twin of `code` for a document rather than a program: a tool that reads a `.md` file knows
	 * the text is Markdown and knows nothing about whether a reader sees a heading in bold, a heading
	 * in a larger font, or a `#` in the first column. A terminal renders the source and lays it out at
	 * its own width, a browser host mounts it as HTML, and a host with no renderer draws the source
	 * lines, which is what the text already is.
	 *
	 * Mutually exclusive with `code`, which states the opposite of the same lines: source a host
	 * colours and numbers, never a document it formats. A section that states both is a tool
	 * contradicting itself, and a host resolves the pair by drawing the code, which is the reading
	 * that never invents layout.
	 *
	 * The document's ordinary text takes the TONE of the span carrying it, which is the one thing a
	 * tool states about the appearance of a document it did not write: a question put to a reader is
	 * the card's subject and is toned as such, while a file's contents are body text. Nothing else on
	 * the span reaches the rows -- the source is joined from the spans' text -- so a section that
	 * tones its first span states the ground the whole document sits on, and one that tones none
	 * takes the host's own body text.
	 */
	markdown?: boolean;
	/**
	 * That each line is one row and never flows onto a second, so a host CUTS it to the width instead
	 * of wrapping it.
	 *
	 * A listing states this and prose does not: one found path per row is a promise about the shape of
	 * the section, and wrapping the one path that is too long makes it two rows in a body whose every
	 * other entry is one, which is how a reader loses count. The width is the host's, so the cut is
	 * too; the tool says only that a line is atomic.
	 */
	clip?: boolean;
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
	/**
	 * That the lines are a window onto their END, cut by the host rather than by the tool.
	 *
	 * The same bargain a section strikes, for a card with no sections to strike it in: a stream of
	 * output whose newest rows are the ones a reader wants is stated whole, and the host — the only
	 * party that knows how many rows the lines wrap to and how many it has — drops the front and says
	 * what it dropped. `hidden` is the other case and still stands beside this one: what the TOOL
	 * trimmed is counted there, whatever the host does with the rest.
	 *
	 * Omitted means the lines are the block, and a host draws every one of them.
	 */
	tail?: ViewTailWindow;
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
	/**
	 * Omitted means the block opens on its own first section, for a card whose body already states
	 * what it is.
	 *
	 * A shell card is the case: its first row is the command that was run, and a title row above it
	 * reads as the word "Bash" over `$ ls`. The outcome still reaches the reader, through `state` on
	 * the frame and through whatever the body says, so a headerless card is one that would have
	 * repeated itself rather than one that reports less.
	 */
	header?: StatusRowView;
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
	/**
	 * That the body carries its own leading column, so the host adds no indent of its own.
	 *
	 * A change and a code frame draw a gutter — a marker, a line number and a separator — and an
	 * indent in front of one is a second margin: the gutter IS the indent, and the rows were measured
	 * without the other. Omitted means the body is prose and a host indents it as it indents any
	 * other card.
	 */
	gutter?: boolean;
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
 *
 * `hasResult` is whether the surface already has a result for the call it is asking about. A host
 * that merges the two cards into one draws the call half and the result half together, so a call
 * preview that lists what a result card lists again would say it twice; the call half reads this
 * and stops describing what the result half describes. A host that draws them as two separate
 * cards omits it, and the preview stands on its own.
 *
 * `frozen` is whether the card has left the surface's live region: a detached spawn the reader has
 * scrolled past, or a block the surface has sealed. Its content no longer updates, so a row that
 * would otherwise read as in-progress states itself as inert instead of claiming work is happening.
 */
export interface ToolViewContext {
	expanded: boolean;
	/** Omitted means the result is settled, which is what a call site with nothing to stream states. */
	partial?: boolean;
	frame?: number;
	hasResult?: boolean;
	frozen?: boolean;
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
