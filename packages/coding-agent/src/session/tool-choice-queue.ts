import type { ToolChoice } from "@veyyon/ai";

export interface ResolveInfo {
	choice: ToolChoice;
}

export interface RejectInfo {
	choice: ToolChoice;
	reason: "aborted" | "error" | "cleared" | "removed" | "unavailable" | "not_invoked";
}

export type RejectOutcome = "requeue" | "drop";

export interface DirectiveCallbacks {
	onResolved?: (info: ResolveInfo) => void;
	onRejected?: (info: RejectInfo) => RejectOutcome | undefined;
	onInvoked?: (input: unknown) => Promise<unknown> | unknown;
}

export interface ToolChoiceDirective {
	generator: Iterator<ToolChoice>;
	label: string;
	callbacks: DirectiveCallbacks;
}

export interface PushOptions {
	now?: boolean;
	label?: string;
	onResolved?: DirectiveCallbacks["onResolved"];
	onRejected?: DirectiveCallbacks["onRejected"];
	onInvoked?: DirectiveCallbacks["onInvoked"];
}

export function* onceGen(choice: ToolChoice): Generator<ToolChoice, void, unknown> {
	yield choice;
}

interface InFlight {
	directive: ToolChoiceDirective;
	yielded: ToolChoice;
	invoked: boolean;
}

interface PendingInvoker {
	id: string;
	sourceToolName: string;
	onInvoked: (input: unknown) => Promise<unknown> | unknown;
}

export class ToolChoiceQueue {
	#queue: ToolChoiceDirective[] = [];
	#inFlight: InFlight | undefined;
	#lastResolvedLabel: string | undefined;
	#pendingInvokers: PendingInvoker[] = [];

	pushOnce(choice: ToolChoice, options?: PushOptions): void {
		this.push(onceGen(choice), options);
	}

	pushSequence(choices: ToolChoice[], options?: PushOptions): void {
		this.push(choices, options);
	}

	push(generator: Iterable<ToolChoice>, options?: PushOptions): void {
		const directive: ToolChoiceDirective = {
			generator: generator[Symbol.iterator](),
			label: options?.label ?? "anonymous",
			callbacks: {
				onResolved: options?.onResolved,
				onRejected: options?.onRejected,
				onInvoked: options?.onInvoked,
			},
		};
		if (options?.now) {
			this.#queue.unshift(directive);
		} else {
			this.#queue.push(directive);
		}
	}

	nextToolChoice(): ToolChoice | undefined {
		while (this.#queue.length > 0) {
			const head = this.#queue[0]!;
			const result = head.generator.next();
			if (result.done) {
				this.#queue.shift();
				continue;
			}
			this.#inFlight = { directive: head, yielded: result.value, invoked: false };
			return result.value;
		}
		return undefined;
	}

	resolve(): void {
		const inFlight = this.#inFlight;
		if (!inFlight) return;
		if (inFlight.directive.callbacks.onInvoked && !inFlight.invoked) {
			this.reject("not_invoked");
			return;
		}
		this.#inFlight = undefined;

		this.#lastResolvedLabel = inFlight.directive.label;
		inFlight.directive.callbacks.onResolved?.({ choice: inFlight.yielded });
	}

	reject(reason: RejectInfo["reason"]): void {
		const inFlight = this.#inFlight;
		this.#inFlight = undefined;
		if (!inFlight) return;

		const outcome = inFlight.directive.callbacks.onRejected?.({
			choice: inFlight.yielded,
			reason,
		});

		if (outcome === "requeue") {
			this.#queue.unshift({
				generator: onceGen(inFlight.yielded),
				label: inFlight.directive.label,
				callbacks: {
					onResolved: inFlight.directive.callbacks.onResolved,
					onInvoked: inFlight.directive.callbacks.onInvoked,
					onRejected: inFlight.directive.callbacks.onRejected,
				},
			});
		}
	}

	get hasInFlight(): boolean {
		return this.#inFlight !== undefined;
	}

	peekInFlightInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		const inFlight = this.#inFlight;
		const onInvoked = inFlight?.directive.callbacks.onInvoked;
		if (!inFlight || !onInvoked) return undefined;
		return (input: unknown): Promise<unknown> | unknown => {
			inFlight.invoked = true;
			return onInvoked(input);
		};
	}

	registerPendingInvoker(
		id: string,
		sourceToolName: string,
		onInvoked: (input: unknown) => Promise<unknown> | unknown,
	): void {
		this.removePendingInvoker(id);
		this.#pendingInvokers.push({ id, sourceToolName, onInvoked });
	}

	removePendingInvoker(id: string): void {
		this.#pendingInvokers = this.#pendingInvokers.filter(p => p.id !== id);
	}

	clearPendingInvokers(): void {
		if (this.#pendingInvokers.length === 0) return;
		this.#pendingInvokers = [];
	}

	get hasPendingInvoker(): boolean {
		return this.#pendingInvokers.length > 0;
	}

	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#pendingInvokers.at(-1)?.onInvoked;
	}

	peekPendingHead(): { id: string; sourceToolName: string } | undefined {
		const head = this.#pendingInvokers.at(-1);
		return head ? { id: head.id, sourceToolName: head.sourceToolName } : undefined;
	}

	removeByLabel(label: string): void {
		if (this.#inFlight?.directive.label === label) {
			this.reject("removed");
		}
		this.#queue = this.#queue.filter(d => d.label !== label);
	}

	clear(): void {
		if (this.#inFlight) {
			this.reject("cleared");
		}
		this.#queue = [];
		this.#pendingInvokers = [];
		this.#lastResolvedLabel = undefined;
	}

	consumeLastServedLabel(): string | undefined {
		const label = this.#lastResolvedLabel;
		this.#lastResolvedLabel = undefined;
		return label;
	}

	inspect(): readonly string[] {
		return this.#queue.map(d => d.label);
	}
}
