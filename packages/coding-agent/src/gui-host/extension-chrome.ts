/**
 * What a session's extensions put around the desktop composer.
 *
 * The terminal draws an extension's status entries in its status line, its
 * working message in the loader, its text widgets above and below the editor
 * and its notices in the status area; it edits the editor for
 * `setEditorText` and `pasteToEditor`, reads it for `getEditorText`, and
 * stacks `addAutocompleteProvider` factories over the editor's completion.
 *
 * `ExtensionChrome` is that surface for a desktop window. It holds the chrome
 * of the window's session and states it whole in the `ExtensionUi` section on
 * every change, sends each edit as a `ComposerEdit`, keeps the draft the
 * composer reports through `ReportComposerDraft` so `getEditorText` answers
 * without a round trip, answers `CompleteComposer` with a `ComposerCompletions`
 * section, and raises each notice as an `ExtensionNotice`.
 *
 * One is made per connection rather than per agent session: the session's
 * extensions load on the first request that needs them, and a draft the
 * composer reported before then is the one they read.
 *
 * Offsets on the wire are UTF-8 byte offsets, which is what the window's
 * text model counts in; they are converted here and nowhere else.
 */
import type * as net from "node:net";
import { setTimeout as scheduleTimeout } from "node:timers";
import { MAX_WIDGET_LINES } from "@veyyon/kernel/registry/widget";
import { errorMessage, logger } from "@veyyon/utils";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	applyAutocompleteCompletion,
} from "@veyyon/utils/autocomplete";
import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { replaceTabs } from "@veyyon/utils/tab-width";
import type {
	AutocompleteProviderFactory,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions/types";
import { writeFrame } from "./frames";
import type {
	ComposerCompletionView,
	ComposerEditKind,
	ExtensionNoticeLevel,
	ExtensionUiView,
	ExtensionWidgetView,
	SnapshotSection,
} from "./wire";

/**
 * How long a completion source has to answer one `CompleteComposer`. A source
 * that takes longer is answered for with an empty list, so a hung extension
 * leaves the composer's menu closed rather than waiting.
 */
export const COMPLETION_TIMEOUT_MS = 2_000;

/**
 * The most completions one answer carries. The composer's menu scrolls a
 * handful at a time, and each item costs an `applyCompletion` call here.
 */
export const MAX_COMPLETIONS = 100;

/**
 * The source the extension factories wrap. The window completes `/` commands
 * and `@` paths on its own, so the base offers nothing and applies an item the
 * way the terminal editor does; what reaches the composer is only what an
 * extension adds.
 */
const BASE_PROVIDER: AutocompleteProvider = {
	getSuggestions: () => Promise.resolve(null),
	applyCompletion: applyAutocompleteCompletion,
};

/** Why a request from the composer was not taken. */
export interface ComposerRefusal {
	code: string;
	message: string;
}

/** The UTF-8 length of `text`. */
function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * The UTF-16 index of the UTF-8 byte offset `offset` into `text`, or
 * `undefined` when the offset is past the end or inside a character.
 */
function utf16Index(text: string, offset: number): number | undefined {
	let bytes = 0;
	let index = 0;
	for (const char of text) {
		if (bytes >= offset) break;
		const point = char.codePointAt(0) ?? 0;
		bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
		index += char.length;
	}
	return bytes === offset ? index : undefined;
}

/**
 * The replacement that turns `before` into `after`, as the completion view
 * states it: the changed byte range of `before`, what replaces it, and where
 * the caret lands in `after`.
 */
function completionEdit(
	label: string,
	description: string | undefined,
	before: string,
	after: string,
	caret: number,
): ComposerCompletionView {
	let start = 0;
	const shorter = Math.min(before.length, after.length);
	while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
	// A shared high surrogate whose low half differs belongs to the change.
	const high = before.charCodeAt(start - 1);
	if (start > 0 && high >= 0xd800 && high <= 0xdbff) start -= 1;
	let tail = 0;
	while (
		tail < shorter - start &&
		before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
	) {
		tail += 1;
	}
	// Likewise a shared low surrogate whose high half differs.
	const low = before.charCodeAt(before.length - tail);
	if (tail > 0 && low >= 0xdc00 && low <= 0xdfff) tail -= 1;
	return {
		label,
		description: description ?? null,
		replace_start: utf8Length(before.slice(0, start)),
		replace_end: utf8Length(before.slice(0, before.length - tail)),
		insert: after.slice(start, after.length - tail),
		caret: utf8Length(after.slice(0, caret)),
	};
}

/** The editor position of the UTF-16 index `index` into `text`. */
function position(text: string, index: number): { lines: string[]; line: number; column: number } {
	const lines = text.split("\n");
	const beforeCaret = text.slice(0, index).split("\n");
	return { lines, line: beforeCaret.length - 1, column: beforeCaret[beforeCaret.length - 1]?.length ?? 0 };
}

/** The UTF-16 index into `lines.join("\n")` of an editor position. */
function indexOf(lines: readonly string[], line: number, column: number): number {
	let index = 0;
	for (let row = 0; row < line && row < lines.length; row += 1) index += (lines[row]?.length ?? 0) + 1;
	return index + column;
}

/** Resolves `promise`, or `undefined` once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	const expiry = Promise.withResolvers<undefined>();
	const timer = scheduleTimeout(() => expiry.resolve(undefined), ms);
	try {
		return await Promise.race([promise, expiry.promise]);
	} finally {
		clearTimeout(timer);
	}
}

export class ExtensionChrome {
	readonly #statuses = new Map<string, string>();
	readonly #widgets = new Map<string, ExtensionWidgetView>();
	#workingMessage: string | undefined;
	readonly #factories: AutocompleteProviderFactory[] = [];
	#provider: AutocompleteProvider = BASE_PROVIDER;
	/** The session the chrome was last stated for, cleared there when the id moves on. */
	#statedFor: string | undefined;
	/**
	 * The draft as the host last knew it, the session it belongs to and the
	 * caret in it as a UTF-16 index. The draft of any other session reads empty.
	 */
	#draftFor: string | undefined;
	#draft = "";
	#caret = 0;
	/** The `seq` of the last edit the held draft includes; `0` before any. */
	#draftEdit = 0;
	/** The `seq` of the last edit sent, to any session; `0` before any. */
	#lastEdit = 0;
	/** The newest `CompleteComposer` query received. */
	#newestQuery = 0;

	constructor(
		readonly socket: net.Socket,
		readonly sessionId: () => string,
	) {}

	/** Set or clear the status entry `key`. Text that is empty once sanitized clears it. */
	setStatus(key: string, text: string | undefined): void {
		const shown = text === undefined ? "" : sanitizeStatusText(text);
		if (shown) this.#statuses.set(key, shown);
		else if (!this.#statuses.delete(key)) return;
		this.#publish();
	}

	/** Set the message a streaming turn states, or restore the window's own with none. */
	setWorkingMessage(message?: string): void {
		const shown = message === undefined ? undefined : sanitizeStatusText(message) || undefined;
		if (shown === this.#workingMessage) return;
		this.#workingMessage = shown;
		this.#publish();
	}

	/**
	 * Set or clear the widget `key`. Setting a key moves it to the end of its
	 * placement, the order the terminal draws in.
	 */
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const existed = this.#widgets.delete(key);
		if (content === undefined) {
			if (existed) this.#publish();
			return;
		}
		this.#widgets.set(key, {
			key,
			placement: options?.placement === "belowEditor" ? "BelowEditor" : "AboveEditor",
			// No escapes, tabs expanded, no control bytes: the window draws the text as it is.
			lines: content
				.slice(0, MAX_WIDGET_LINES)
				.map(line => replaceTabs(stripAnsi(line)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")),
			truncated: content.length > MAX_WIDGET_LINES,
		});
		this.#publish();
	}

	/** Raise a notice on the window's announcement stack. */
	notify(message: string, type?: "info" | "warning" | "error"): void {
		const shown = sanitizeStatusText(message);
		if (!shown) return;
		const level: ExtensionNoticeLevel = type === "error" ? "Error" : type === "warning" ? "Warning" : "Info";
		this.#write({
			ExtensionNotice: {
				session: this.sessionId(),
				notice: { level, message: shown, raised_at_ms: Date.now() },
			},
		});
	}

	/** Replace the draft, leaving the caret at its end. */
	setEditorText(text: string): void {
		this.#own();
		this.#draft = text;
		this.#caret = text.length;
		this.#edit("Set", text);
	}

	/** Insert `text` at the caret, the way a paste lands. */
	pasteToEditor(text: string): void {
		this.#own();
		this.#draft = this.#draft.slice(0, this.#caret) + text + this.#draft.slice(this.#caret);
		this.#caret += text.length;
		this.#edit("Paste", text);
	}

	/** The draft as the composer last reported it, with every edit made since applied. */
	getEditorText(): string {
		return this.#draftFor === this.sessionId() ? this.#draft : "";
	}

	/**
	 * Stack `factory` over the completion sources added before it, in the order
	 * the terminal stacks them. A factory that throws or returns something that
	 * is not a provider is skipped, so one broken extension leaves the others.
	 */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#factories.push(factory);
		let provider = BASE_PROVIDER;
		for (const each of this.#factories) {
			try {
				const wrapped = each(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (error) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", { error: errorMessage(error) });
			}
		}
		const completed = this.#provider !== BASE_PROVIDER;
		this.#provider = provider;
		if (completed !== (provider !== BASE_PROVIDER)) this.#publish();
	}

	/**
	 * Take the draft the composer reports for the session. A report that
	 * predates an edit the host sent is dropped: the composer has not applied
	 * that edit yet, and the draft the host already holds includes it.
	 */
	reportDraft(text: string, cursor: number, appliedEdit: number): ComposerRefusal | undefined {
		const caret = utf16Index(text, cursor);
		if (caret === undefined) {
			return {
				code: "INVALID_ARGUMENTS",
				message: `ReportComposerDraft cursor ${cursor} is not a character boundary of the ${utf8Length(text)}-byte draft`,
			};
		}
		const session = this.sessionId();
		if (session === this.#draftFor && appliedEdit < this.#draftEdit) return undefined;
		this.#draftFor = session;
		this.#draft = text;
		this.#caret = caret;
		this.#draftEdit = appliedEdit;
		return undefined;
	}

	/**
	 * Answer query `query` for `text` with the caret at byte `cursor`: every
	 * item the stacked sources offer, each stated as the edit accepting it
	 * makes. A source that throws or runs past `COMPLETION_TIMEOUT_MS` is
	 * answered for with no items. The answer is not sent when a newer query
	 * arrived while this one ran; the composer shows only its newest.
	 */
	async complete(query: number, text: string, cursor: number): Promise<ComposerRefusal | undefined> {
		const caret = utf16Index(text, cursor);
		if (caret === undefined) {
			return {
				code: "INVALID_ARGUMENTS",
				message: `CompleteComposer cursor ${cursor} is not a character boundary of the ${utf8Length(text)}-byte draft`,
			};
		}
		if (query > this.#newestQuery) this.#newestQuery = query;
		const session = this.sessionId();
		const provider = this.#provider;
		const at = position(text, caret);
		let suggestions: { items: AutocompleteItem[]; prefix: string } | null | undefined;
		try {
			suggestions = await within(provider.getSuggestions(at.lines, at.line, at.column), COMPLETION_TIMEOUT_MS);
			if (suggestions === undefined) {
				logger.warn("Extension autocomplete provider did not answer in time", { timeoutMs: COMPLETION_TIMEOUT_MS });
			}
		} catch (error) {
			logger.warn("Extension autocomplete provider failed", { error: errorMessage(error) });
		}
		const items: ComposerCompletionView[] = [];
		for (const item of suggestions?.items.slice(0, MAX_COMPLETIONS) ?? []) {
			try {
				const applied = provider.applyCompletion(at.lines, at.line, at.column, item, suggestions?.prefix ?? "");
				const after = applied.lines.join("\n");
				const landed = Math.min(indexOf(applied.lines, applied.cursorLine, applied.cursorCol), after.length);
				items.push(completionEdit(item.label, item.description, text, after, landed));
			} catch (error) {
				logger.warn("Extension autocomplete provider could not apply an item; skipping it", {
					error: errorMessage(error),
				});
			}
		}
		if (query < this.#newestQuery) return undefined;
		this.#write({ ComposerCompletions: { session, completions: { query, items } } });
		return undefined;
	}

	/**
	 * Clear what the window draws for the session, as when its extensions are
	 * unloaded. The draft stays: it is the composer's, not the extensions'.
	 */
	clear(): void {
		this.#statuses.clear();
		this.#widgets.clear();
		this.#workingMessage = undefined;
		this.#factories.length = 0;
		this.#provider = BASE_PROVIDER;
		if (this.#statedFor !== undefined) this.#publish();
		this.#statedFor = undefined;
	}

	/**
	 * Give what the extensions set to `to`, which states it from here on, and
	 * hold nothing: as a session moves to the background with its own chrome,
	 * and back. Nothing is published, since the window files what it was sent
	 * under the session it was stated for and keeps it for that session, and
	 * this chrome no longer clears it there when it states for another. `to`
	 * holds nothing of its own; the draft is the composer's and stays.
	 */
	handOver(to: ExtensionChrome): void {
		for (const [key, text] of this.#statuses) to.#statuses.set(key, text);
		for (const [key, widget] of this.#widgets) to.#widgets.set(key, widget);
		to.#workingMessage = this.#workingMessage;
		to.#factories.push(...this.#factories);
		to.#provider = this.#provider;
		to.#statedFor = this.#statedFor;
		this.#statuses.clear();
		this.#widgets.clear();
		this.#workingMessage = undefined;
		this.#factories.length = 0;
		this.#provider = BASE_PROVIDER;
		this.#statedFor = undefined;
	}

	/**
	 * State the chrome under the session id when the id moved. A session that
	 * reloads in place (a new session, a switch, a branch) keeps its
	 * extensions, and what they set stays drawn, as the terminal keeps it.
	 */
	follow(): void {
		if (this.#statedFor !== undefined && this.#statedFor !== this.sessionId()) this.#publish();
	}

	#view(): ExtensionUiView {
		return {
			statuses: [...this.#statuses]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, text]) => ({ key, text })),
			working_message: this.#workingMessage ?? null,
			widgets: [...this.#widgets.values()],
			completes: this.#provider !== BASE_PROVIDER,
		};
	}

	#publish(): void {
		const session = this.sessionId();
		if (this.#statedFor !== undefined && this.#statedFor !== session) {
			this.#write({
				ExtensionUi: {
					session: this.#statedFor,
					ui: { statuses: [], working_message: null, widgets: [], completes: false },
				},
			});
		}
		this.#statedFor = session;
		this.#write({ ExtensionUi: { session, ui: this.#view() } });
	}

	/** Make the held draft the session's, empty when it was another session's. */
	#own(): void {
		const session = this.sessionId();
		if (this.#draftFor === session) return;
		this.#draftFor = session;
		this.#draft = "";
		this.#caret = 0;
	}

	#edit(kind: ComposerEditKind, text: string): void {
		this.#lastEdit += 1;
		this.#draftEdit = this.#lastEdit;
		this.#write({ ComposerEdit: { session: this.sessionId(), edit: { seq: this.#lastEdit, kind, text } } });
	}

	#write(section: SnapshotSection): void {
		if (this.socket.destroyed) return;
		writeFrame(this.socket, { Snapshot: section });
	}
}

/**
 * Where a session's extensions draw: the connection's chrome, which states
 * under the open session's id, or the session's own while it works in the
 * background. A session drawing into the connection's chrome from the
 * background would draw its notices, statuses and widgets over another
 * thread; its own chrome states them under its own id, where the window files
 * them for when the thread is opened again. The composer is the open
 * thread's, so the draft reads empty and an edit to it goes nowhere
 * meanwhile.
 */
export class ChromeRoute {
	#current: ExtensionChrome;

	constructor(readonly home: ExtensionChrome) {
		this.#current = home;
	}

	/** The chrome the session's extensions draw into now. */
	get current(): ExtensionChrome {
		return this.#current;
	}

	/** The chrome that holds the window's draft: the connection's, while the session is open. */
	get composer(): ExtensionChrome | undefined {
		return this.#current === this.home ? this.home : undefined;
	}

	/** Draw into `chrome` until `returnHome`, as the session leaves the screen with work left to do. */
	drawInto(chrome: ExtensionChrome): void {
		this.#current = chrome;
	}

	/** Draw into the connection's chrome again, as the session is opened again. */
	returnHome(): void {
		this.#current = this.home;
	}
}
