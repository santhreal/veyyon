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

export interface InFlight {
	directive: ToolChoiceDirective;
	yielded: ToolChoice;
	invoked: boolean;
}

export interface PendingInvoker {
	id: string;
	sourceToolName: string;
	onInvoked: (input: unknown) => Promise<unknown> | unknown;
}
