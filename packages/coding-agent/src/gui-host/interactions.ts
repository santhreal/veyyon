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
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	getExtensionUISelectOptionLabel,
} from "../extensibility/extensions/types";
import { APPROVAL_SELECT_OPTIONS } from "../extensibility/extensions/wrapper";
import { theme } from "../modes/theme/theme";
import { writeFrame } from "./frames";
import type {
	ApprovalInteraction,
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

type Settle = (response: InteractionResponse) => AnswerRejection | undefined;

/**
 * What one raised decision needs to settle: the record the client sees, and
 * the function that turns the client's answer into the caller's value.
 */
interface Waiting {
	settle: Settle;
	cancel: () => void;
}

/** The tool name on a wrapper approval card, or `undefined` when absent. */
export function approvalToolName(card: string): string | undefined {
	const line = card.split("\n").find(l => l.startsWith("**Tool:**"));
	return line?.match(/`([^`]+)`/)?.[1];
}

export class InteractionLedger {
	readonly #waiting = new Map<string, Waiting>();
	#approvals: ApprovalInteraction[] = [];
	#questions: QuestionInteraction[] = [];
	#plans: PlanInteraction[] = [];
	#seq = 0;

	constructor(
		readonly socket: net.Socket,
		readonly sessionId: () => string,
	) {}

	/** The decisions outstanding, as the client last received them. */
	pending(): PendingDecisions {
		return { approvals: this.#approvals, questions: this.#questions, plans: this.#plans };
	}

	/** True while any decision waits on the operator. */
	get isEmpty(): boolean {
		return this.#waiting.size === 0;
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
	 * Raise a decision and wait for its answer. `decode` turns a well-shaped
	 * answer into the value the caller gets, or a rejection that leaves the
	 * decision open. An abort or timeout resolves `fallback`.
	 */
	#raise<T>(
		kind: "approval" | "question" | "plan",
		record: (id: string, now: number) => void,
		decode: (response: InteractionResponse) => T | AnswerRejection,
		fallback: T,
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): Promise<T> {
		if (dialogOptions?.signal?.aborted) return Promise.resolve(fallback);
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
			this.#publish();
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
				resolve(fallback);
			}, dialogOptions.timeout);
		}

		this.#waiting.set(id, {
			cancel: onAbort,
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
		const detail = card
			.split("\n")
			.filter(line => !line.startsWith("## ") && !line.startsWith("**Tool:**"))
			.join("\n")
			.trim();
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

	/** A plan review, answered with `{ accepted }`. */
	plan(markdown: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		return this.#raise(
			"plan",
			(id, now) => {
				this.#plans = [...this.#plans, { id, markdown_plan: markdown, requested_at_ms: now }];
			},
			response =>
				"accepted" in response && typeof response.accepted === "boolean"
					? response.accepted
					: invalid("a plan is answered with { accepted: boolean }"),
			false,
			dialogOptions,
		);
	}
}

function invalid(message: string): AnswerRejection {
	return { code: "INVALID_ARGUMENTS", message };
}

function isRejection(value: unknown): value is AnswerRejection {
	return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

/**
 * The session's UI surface when a desktop client is attached.
 *
 * The four prompting methods raise decisions on the ledger. The rest of the
 * contract is the terminal's chrome — status line, widgets, editor text,
 * themes — which the desktop draws from its own state; those accept the call
 * and change nothing, the same as the RPC surface.
 */
export class GuiHostUIContext implements ExtensionUIContext {
	readonly timeoutStartsOnPresentation = false;

	constructor(readonly ledger: InteractionLedger) {}

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

	notify(): void {}
	onTerminalInput(): () => void {
		return () => {};
	}
	setStatus(): void {}
	setWorkingMessage(): void {}
	setWidget(): void {}
	setFooter(): void {}
	setHeader(): void {}
	setTitle(): void {}
	custom<T>(): Promise<T> {
		return Promise.reject(new Error("Custom TUI components are not available on a desktop client"));
	}
	setEditorText(): void {}
	pasteToEditor(): void {}
	getEditorText(): string {
		return "";
	}
	addAutocompleteProvider(): void {}
	setEditorComponent(): void {}
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
