/**
 * The decisions a session is waiting on, and the surface that raises them.
 *
 * A tool approval, an `ask` question, an extension prompt and a plan review
 * all reach the operator the same way in the terminal: through the session's
 * `ExtensionUIContext`. `GuiHostUIContext` is that context for a desktop
 * client. Each request becomes one record in the `InteractionLedger`, the
 * ledger is sent whole to the client as a `Snapshot.Interactions` section
 * every time it changes, and `RespondToInteraction` settles one record by id.
 *
 * The record kinds and their answers are the desktop's, so they are defined
 * beside the other wire types in `wire.ts`. The ledger never interprets an
 * answer beyond checking its shape: what "Approve for session" does is the
 * tool wrapper's decision, and what an option label means is the `ask`
 * tool's.
 */

import type * as net from "node:net";
import { setTimeout as scheduleTimeout } from "node:timers";
import {
	type AutocompleteProviderFactory,
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogResultItem,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetContent,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../extensibility/extensions/types";
import { APPROVAL_SELECT_OPTIONS } from "../extensibility/extensions/wrapper";
import { theme } from "../theme/theme";
import { ChromeRoute, ExtensionChrome } from "./extension-chrome";
import { writeFrame } from "./frames";
import type {
	ApprovalInteraction,
	DialogInteraction,
	DialogQuestionAnswer,
	InteractionResponse,
	PendingDecisions,
	PlanInteraction,
	QuestionInteraction,
} from "./wire";

/** The labels the tool wrapper offers, in the order it offers them. */
const APPROVAL_LABEL = {
	approveOnce: getExtensionUISelectOptionLabel(APPROVAL_SELECT_OPTIONS[0]),
	approveSession: getExtensionUISelectOptionLabel(APPROVAL_SELECT_OPTIONS[1]),
	denyOnce: getExtensionUISelectOptionLabel(APPROVAL_SELECT_OPTIONS[2]),
	denySession: getExtensionUISelectOptionLabel(APPROVAL_SELECT_OPTIONS[3]),
} as const;

const CONFIRM_OPTIONS = ["Yes", "No"] as const;

/** Why an answer was not applied. The action handler reports it verbatim. */
export interface AnswerRejection {
	code: "INTERACTION_NOT_FOUND" | "INVALID_ARGUMENTS";
	message: string;
}

/**
 * What a plan review came back as: accepted as written, or sent back with the
 * refinement to make. `feedback` is empty when the answer carried none, which
 * is the plan card's own revise row.
 */
export interface PlanDecision {
	accepted: boolean;
	feedback: string;
}

type Settle = (response: InteractionResponse) => AnswerRejection | undefined;

/**
 * What one raised decision needs to settle: the record the client sees, and
 * the function that turns the client's answer into the caller's value.
 *
 * `signalled` says whose job it is to take the decision down when the turn
 * stops. A caller that passed an `AbortSignal` is reached by the abort itself
 * and unwinds with its own classification of the outcome; a caller that passed
 * none is reached by nothing, and stopping the turn would wait on it forever.
 */
interface Waiting {
	settle: Settle;
	cancel: () => void;
	signalled: boolean;
}

/** The tool name on a wrapper approval card, or `undefined` when absent. */
export function approvalToolName(card: string): string | undefined {
	const line = card.split("\n").find(l => l.startsWith("**Tool:**"));
	return line?.match(/`([^`]+)`/)?.[1];
}

/** A label line the wrapper writes on its own card: `**Scope:** This call only`. */
const WRAPPER_LABEL = /^\*\*([^*:]+):\*\*\s*(.*)$/;

/** A wrapper line that is bold and nothing else: `**Requested action**`. */
const WRAPPER_HEADING = /^\*\*([^*]+)\*\*$/;

/**
 * The card's detail as the plain text lines the `detail` field carries.
 *
 * WHY: `formatApprovalCard` writes markdown for the terminal's renderer, while
 * the desktop draws each detail line into a mono pane verbatim, so the card
 * read `**Scope:** This call only` with the emphasis markers as text. Only the
 * wrapper's own label lines are rewritten. A tool's detail line crosses
 * byte-identical, because it states the command about to run, and an approval
 * that shows anything other than what runs is worse than an ugly one.
 */
export function approvalDetail(card: string): string {
	return card
		.split("\n")
		.filter(line => !line.startsWith("## ") && !line.startsWith("**Tool:**"))
		.map(line => {
			const labelled = line.match(WRAPPER_LABEL);
			if (labelled) {
				const value = labelled[2]!.replaceAll("`", "").trim();
				return value.length > 0 ? `${labelled[1]!}: ${value}` : `${labelled[1]!}:`;
			}
			return line.match(WRAPPER_HEADING)?.[1] ?? line;
		})
		.join("\n")
		.trim();
}

export class InteractionLedger {
	readonly #waiting = new Map<string, Waiting>();
	#approvals: ApprovalInteraction[] = [];
	#questions: QuestionInteraction[] = [];
	#plans: PlanInteraction[] = [];
	#dialogs: DialogInteraction[] = [];
	#seq = 0;
	#drained: (() => void) | undefined;

	constructor(
		readonly socket: net.Socket,
		readonly sessionId: () => string,
	) {}

	/** The decisions outstanding, as the client last received them. */
	pending(): PendingDecisions {
		return { approvals: this.#approvals, questions: this.#questions, plans: this.#plans, dialogs: this.#dialogs };
	}

	/** True while any decision waits on the operator. */
	get isEmpty(): boolean {
		return this.#waiting.size === 0;
	}

	/**
	 * Call `listener` each time the last open decision closes, however it
	 * closed: answered, aborted, timed out or cancelled. `undefined` stops it.
	 */
	onDrained(listener: (() => void) | undefined): void {
		this.#drained = listener;
	}

	/**
	 * Settle the decision `id` with the client's answer. Returns the rejection
	 * when there is no such decision or the answer has the wrong shape for it;
	 * in both cases the decision stays open.
	 */
	answer(id: string, response: unknown): AnswerRejection | undefined {
		const waiting = this.#waiting.get(id);
		if (!waiting) {
			return { code: "INTERACTION_NOT_FOUND", message: `No pending interaction with id '${id}'` };
		}
		if (typeof response !== "object" || response === null) {
			return { code: "INVALID_ARGUMENTS", message: `RespondToInteraction for '${id}' needs an object response` };
		}
		return waiting.settle(response as InteractionResponse);
	}

	/** Cancel every open decision, as when the client goes away. Each caller sees its default. */
	cancelAll(): void {
		for (const waiting of [...this.#waiting.values()]) waiting.cancel();
	}

	/**
	 * Cancel the open decisions no `AbortSignal` reaches.
	 *
	 * Stopping a turn waits for the agent to go idle, and the agent is not idle
	 * while a tool blocks on a decision. A decision raised with a signal comes
	 * down with the abort, so the wait ends on its own. A decision raised
	 * without one -- a plan review, whose standing resolve handler is given no
	 * signal to pass on -- is reached by nothing, so the stop would wait on an
	 * answer that the operator can no longer give, and every action that ends a
	 * running turn before leaving the session would wait with it.
	 *
	 * Called before the abort is awaited rather than after, since after is
	 * where the wait already is. The signalled ones are deliberately left to
	 * the abort: taking them down here first would resolve them before the
	 * signal fires, and their callers read the signal to tell a stop from a
	 * refusal.
	 */
	cancelUnsignalled(): void {
		for (const waiting of [...this.#waiting.values()]) {
			if (!waiting.signalled) waiting.cancel();
		}
	}

	/**
	 * Raise a decision and wait for its answer. `decode` turns a well-shaped
	 * answer into the value the caller gets, or a rejection that leaves the
	 * decision open. An abort resolves `fallback`; a timeout resolves
	 * `timedOut` when given, `fallback` otherwise.
	 */
	#raise<T>(
		kind: "approval" | "question" | "plan" | "dialog",
		record: (id: string, now: number) => void,
		decode: (response: InteractionResponse) => T | AnswerRejection,
		fallback: T,
		dialogOptions: ExtensionUIDialogOptions | undefined,
		timedOut: T = fallback,
	): Promise<T> {
		if (this.socket.destroyed || dialogOptions?.signal?.aborted) return Promise.resolve(fallback);
		this.#seq += 1;
		const id = `${kind}-${this.#seq}`;
		const { promise, resolve } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		const close = () => {
			clearTimeout(timer);
			dialogOptions?.signal?.removeEventListener("abort", onAbort);
			this.#waiting.delete(id);
			this.#approvals = this.#approvals.filter(a => a.id !== id);
			this.#questions = this.#questions.filter(q => q.id !== id);
			this.#plans = this.#plans.filter(p => p.id !== id);
			this.#dialogs = this.#dialogs.filter(d => d.id !== id);
			this.#publish();
			if (this.#waiting.size === 0) this.#drained?.();
		};
		const onAbort = () => {
			close();
			resolve(fallback);
		};
		dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
		if (dialogOptions?.timeout !== undefined) {
			timer = scheduleTimeout(() => {
				dialogOptions.onTimeout?.();
				close();
				resolve(timedOut);
			}, dialogOptions.timeout);
		}

		this.#waiting.set(id, {
			cancel: onAbort,
			signalled: dialogOptions?.signal !== undefined,
			settle: response => {
				const value = decode(response);
				if (isRejection(value)) return value;
				close();
				resolve(value);
				return undefined;
			},
		});
		record(id, Date.now());
		this.#publish();
		return promise;
	}

	#publish(): void {
		writeFrame(this.socket, { Snapshot: { Interactions: { session: this.sessionId(), pending: this.pending() } } });
	}

	/** A tool approval: the wrapper's four-way card, answered with `{ approved, scope }`. */
	approval(card: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		const tool = approvalToolName(card) ?? "tool";
		const detail = approvalDetail(card);
		return this.#raise(
			"approval",
			(id, now) => {
				this.#approvals = [...this.#approvals, { id, tool_name: tool, detail, requested_at_ms: now }];
			},
			response => {
				if (!("approved" in response) || typeof response.approved !== "boolean") {
					return invalid('an approval is answered with { approved: boolean, scope?: "once" | "session" }');
				}
				const session = response.scope === "session";
				if (response.approved) return session ? APPROVAL_LABEL.approveSession : APPROVAL_LABEL.approveOnce;
				return session ? APPROVAL_LABEL.denySession : APPROVAL_LABEL.denyOnce;
			},
			undefined,
			dialogOptions,
		);
	}

	/** A choice among labels, answered with `{ option }`; resolves the chosen label. */
	choice(
		prompt: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const labels = options.map(getExtensionUISelectOptionLabel);
		return this.#raise(
			"question",
			(id, now) => {
				this.#questions = [...this.#questions, { id, prompt, options: labels, requested_at_ms: now }];
			},
			response => {
				if (!("option" in response) || !Number.isInteger(response.option)) {
					return invalid("a choice is answered with { option: index }");
				}
				const label = labels[response.option];
				return label === undefined
					? invalid(`option ${response.option} is out of range (${labels.length} options)`)
					: label;
			},
			undefined,
			dialogOptions,
		);
	}

	/** Free text, answered with `{ text }`. */
	text(prompt: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return this.#raise(
			"question",
			(id, now) => {
				this.#questions = [...this.#questions, { id, prompt, options: [], requested_at_ms: now }];
			},
			response =>
				"text" in response && typeof response.text === "string"
					? response.text
					: invalid("a free-text question is answered with { text: string }"),
			undefined,
			dialogOptions,
		);
	}

	/** A plan review, answered with `{ accepted }` and, when sent back, the refinement asked for. */
	plan(markdown: string, dialogOptions?: ExtensionUIDialogOptions): Promise<PlanDecision> {
		return this.#raise(
			"plan",
			(id, now) => {
				this.#plans = [...this.#plans, { id, markdown_plan: markdown, requested_at_ms: now }];
			},
			response => {
				if (!("accepted" in response) || typeof response.accepted !== "boolean") {
					return invalid("a plan is answered with { accepted: boolean, feedback?: string }");
				}
				const feedback = "feedback" in response ? response.feedback : undefined;
				if (feedback !== undefined && typeof feedback !== "string") {
					return invalid("a plan's feedback is a string");
				}
				return { accepted: response.accepted, feedback: feedback ?? "" };
			},
			{ accepted: false, feedback: "" },
			dialogOptions,
		);
	}

	/**
	 * A dialog of questions answered together, answered with
	 * `{ kind: "submit", answers }` (one answer per question) or
	 * `{ kind: "chat" }`. A timeout settles every question on its recommended
	 * option, the terminal dialog's own timeout answer.
	 */
	dialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		const labelsOf = (question: ExtensionAskDialogQuestion) => question.options.map(option => option.label);
		const recommended: ExtensionAskDialogResult = {
			kind: "submit",
			results: questions.map(question => {
				const labels = labelsOf(question);
				const chosen = question.recommended === undefined ? undefined : labels[question.recommended];
				return {
					id: question.id,
					question: question.question,
					options: labels,
					multi: question.multi === true,
					selectedOptions: chosen === undefined ? [] : [chosen],
					timedOut: true,
				};
			}),
		};
		return this.#raise<ExtensionAskDialogResult | undefined>(
			"dialog",
			(id, now) => {
				const dialog: DialogInteraction = {
					id,
					questions: questions.map(question => {
						const labels = labelsOf(question);
						return {
							id: question.id,
							question: question.question,
							header: question.header,
							options: question.options.map(option => ({
								label: option.label,
								description: option.description,
								preview: option.preview,
							})),
							multi: question.multi === true,
							recommended: question.recommended,
							preselected: (question.preselected ?? [])
								.map(label => labels.indexOf(label))
								.filter(index => index >= 0),
						};
					}),
					requested_at_ms: now,
					expires_at_ms: dialogOptions?.timeout === undefined ? undefined : now + dialogOptions.timeout,
				};
				this.#dialogs = [...this.#dialogs, dialog];
			},
			response => decodeDialogAnswer(questions, labelsOf, response),
			undefined,
			dialogOptions,
			recommended,
		);
	}
}

function invalid(message: string): AnswerRejection {
	return { code: "INVALID_ARGUMENTS", message };
}

const DIALOG_SHAPE = 'a dialog is answered with { kind: "submit", answers } or { kind: "chat" }';

function decodeDialogAnswer(
	questions: ExtensionAskDialogQuestion[],
	labelsOf: (question: ExtensionAskDialogQuestion) => string[],
	response: InteractionResponse,
): ExtensionAskDialogResult | AnswerRejection {
	if (!("kind" in response)) return invalid(DIALOG_SHAPE);
	if (response.kind === "chat") return { kind: "chat" };
	if (response.kind !== "submit" || !Array.isArray(response.answers)) return invalid(DIALOG_SHAPE);
	const answers = new Map<string, DialogQuestionAnswer>();
	for (const answer of response.answers) answers.set(answer.id, answer);
	const results: ExtensionAskDialogResultItem[] = [];
	for (const question of questions) {
		const answer = answers.get(question.id);
		if (!answer) return invalid(`question '${question.id}' has no answer`);
		const labels = labelsOf(question);
		const multi = question.multi === true;
		if (!Array.isArray(answer.selected)) return invalid(`question '${question.id}' needs selected: number[]`);
		if (!multi && answer.selected.length > 1) {
			return invalid(`question '${question.id}' takes one option, ${answer.selected.length} were selected`);
		}
		const selectedOptions: string[] = [];
		for (const index of answer.selected) {
			const label = Number.isInteger(index) ? labels[index] : undefined;
			if (label === undefined) {
				return invalid(`option ${index} of question '${question.id}' is out of range (${labels.length} options)`);
			}
			selectedOptions.push(label);
		}
		const customInput = answer.custom_input?.trim() ? answer.custom_input : undefined;
		if (selectedOptions.length === 0 && customInput === undefined) {
			return invalid(`question '${question.id}' needs a selected option or custom_input`);
		}
		results.push({
			id: question.id,
			question: question.question,
			options: labels,
			multi,
			selectedOptions,
			...(customInput === undefined ? {} : { customInput }),
			...(answer.note?.trim() ? { note: answer.note } : {}),
		});
	}
	return { kind: "submit", results };
}

function isRejection(value: unknown): value is AnswerRejection {
	return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

/**
 * The session's UI surface when a desktop client is attached.
 *
 * The prompting methods and the multi-question dialog raise decisions on the
 * ledger. Notices, status entries, the working message, text widgets, edits
 * to the draft, reading it and completion sources go to the session's
 * `ExtensionChrome`, which states them to the window. The rest of the
 * terminal's chrome — the window title, raw terminal input, themes and tool
 * expansion — the window keeps as its own, so those accept the call and
 * change nothing.
 */
export class GuiHostUIContext implements ExtensionUIContext {
	readonly timeoutStartsOnPresentation = false;
	/** Where the session's extensions draw, which the host moves as the session goes to the background and back. */
	readonly chromeRoute: ChromeRoute;

	constructor(
		readonly ledger: InteractionLedger,
		chrome = new ExtensionChrome(ledger.socket, ledger.sessionId),
	) {
		this.chromeRoute = new ChromeRoute(chrome);
	}

	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return options === APPROVAL_SELECT_OPTIONS
			? this.ledger.approval(title, dialogOptions)
			: this.ledger.choice(title, options, dialogOptions);
	}

	async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		const prompt = message ? `${title}\n\n${message}` : title;
		const chosen = await this.ledger.choice(prompt, [...CONFIRM_OPTIONS], dialogOptions);
		return chosen === CONFIRM_OPTIONS[0];
	}

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		const prompt = placeholder ? `${title}\n\n${placeholder}` : title;
		return this.ledger.text(prompt, dialogOptions);
	}

	editor(title: string, prefill?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		const prompt = prefill ? `${title}\n\n${prefill}` : title;
		return this.ledger.text(prompt, dialogOptions);
	}

	askDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		return this.ledger.dialog(questions, dialogOptions);
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.chromeRoute.current.notify(message, type);
	}
	onTerminalInput(): () => void {
		return () => {};
	}
	setStatus(key: string, text: string | undefined): void {
		this.chromeRoute.current.setStatus(key, text);
	}
	setWorkingMessage(message?: string): void {
		this.chromeRoute.current.setWorkingMessage(message);
	}
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.chromeRoute.current.setWidget(key, content, options);
	}
	setTitle(): void {}
	setEditorText(text: string): void {
		this.chromeRoute.composer?.setEditorText(text);
	}
	pasteToEditor(text: string): void {
		this.chromeRoute.composer?.pasteToEditor(text);
	}
	getEditorText(): string {
		return this.chromeRoute.composer?.getEditorText() ?? "";
	}
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.chromeRoute.current.addAutocompleteProvider(factory);
	}
	get theme() {
		return theme;
	}
	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}
	getTheme(): Promise<undefined> {
		return Promise.resolve(undefined);
	}
	setTheme(): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Themes are chosen on the desktop client" });
	}
	getToolsExpanded(): boolean {
		return false;
	}
	setToolsExpanded(): void {}
}
