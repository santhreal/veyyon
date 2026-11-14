/**
 * Tool wrappers for extensions.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@veyyon/ai";
import { applyToolProxy } from "@veyyon/kernel/registry/tool-proxy";
import { errorMessage, isCancellation, toError } from "@veyyon/utils";
import type { ToolViewRenderer } from "@veyyon/view";
import { AgentRegistry } from "../../registry/agent-registry";
import type { Theme } from "../../theme/theme";
import { approvalDetailLines, formatApprovalCard } from "../../tools/core/approval";
import {
	type ApprovalChoice,
	type ApprovalConcern,
	type ApprovalGate,
	type ApprovalPrompt,
	approvalPrompt,
	openConcerns,
	recordAnswer,
	resolveApprovalGate,
	standingRefusal,
} from "../../tools/core/approval-gate";
import type { SessionToolApprovals } from "../../tools/core/approval-modes";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import type { ExtensionRunner } from "./runner";
import type {
	ApprovalCard,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	RegisteredTool,
	ToolCallEventResult,
	ToolRenderResultOptions,
} from "./types";

export const APPROVAL_DIALOG_OPTIONS: ExtensionUIDialogOptions = {
	selectionMarker: "radio",
	helpText: "↑/↓ navigate  enter confirm  esc cancel",
};

/**
 * The interactive approval prompt currently on screen, per session and tool.
 *
 * Keyed rather than held on the wrapper because there is one wrapper per tool
 * per session and the calls that collide are several calls to the SAME tool in
 * one batch. The entry lives only for the length of one prompt: it is deleted
 * in the `finally` that also releases the waiters, so an abort, a refusal or a
 * dialog error cannot strand it and no session accumulates entries.
 */
const IN_FLIGHT_APPROVALS = new Map<string, Promise<void>>();

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<TSchema, unknown, unknown> {
	declare name: string;
	declare description: string;
	declare parameters: TSchema;
	declare label: string;
	declare strict: boolean;

	// `theme` stays unknown to satisfy the default AgentTool TTheme; the
	// constructor narrows it once when bridging to the definition's Theme.
	renderCall?: (args: Static<TSchema>, options: ToolRenderResultOptions, theme: unknown) => unknown;
	renderResult?: (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: unknown,
		args?: Static<TSchema>,
	) => unknown;
	/**
	 * Forwarded in the constructor like the pair above, rather than left to `applyToolProxy`: the
	 * field declarations on this class put `renderCall`, `renderResult` and `view` on the instance
	 * already, and the proxy skips every key the wrapper owns. Without the assignment a definition's
	 * view would never reach a host, and the tool would fall back to the generic card.
	 */
	view?: ToolViewRenderer<Static<TSchema>, AgentToolResult<unknown>>;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args, options, theme) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result, options, theme, args) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
		if (registeredTool.definition.view) {
			this.view = registeredTool.definition.view;
		}
	}

	async execute(
		toolCallId: string,
		params: Static<TSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		_context?: AgentToolContext,
	) {
		return this.registeredTool.definition.execute(toolCallId, params, signal, onUpdate, this.runner.createContext());
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

/**
 * One call's interactive approval: the `tool_approval_requested` / `tool_approval_resolved` pair
 * for the extensions that listen, the card, and the session answer the choice records.
 */
class ApprovalRequest<TParameters extends TSchema, TDetails> {
	readonly #tool: AgentTool<TParameters, TDetails>;
	readonly #runner: ExtensionRunner;
	readonly #toolCallId: string;
	readonly #gate: ApprovalGate;
	readonly #approvals: SessionToolApprovals | undefined;
	readonly #sessionId: string;
	readonly #reported: boolean;
	readonly #cwd: string;
	/** The prompt as the call first raised it; a wait behind another card may narrow it. */
	#prompt: ApprovalPrompt;

	constructor(
		tool: AgentTool<TParameters, TDetails>,
		runner: ExtensionRunner,
		toolCallId: string,
		gate: ApprovalGate,
		open: readonly ApprovalConcern[],
		context: AgentToolContext | undefined,
	) {
		this.#tool = tool;
		this.#runner = runner;
		this.#toolCallId = toolCallId;
		this.#gate = gate;
		this.#prompt = approvalPrompt(gate, open);
		this.#approvals = context?.sessionApprovals;
		this.#reported = runner.hasHandlers("tool_approval_requested") || runner.hasHandlers("tool_approval_resolved");
		this.#sessionId = context?.sessionManager?.getSessionId() ?? "";
		this.#cwd = context?.sessionManager?.getCwd?.() ?? "";
	}

	/** Resolve once the call may run; throw when it is refused or no surface can show the card. */
	async obtain(params: Static<TParameters>): Promise<void> {
		if (this.#reported) {
			await this.#runner.emit({
				type: "tool_approval_requested",
				sessionId: this.#sessionId,
				toolName: this.#tool.name,
				toolCallId: this.#toolCallId,
				...(this.#prompt.reason ? { reason: this.#prompt.reason } : {}),
				approvalMode: this.#gate.mode,
			});
		}

		// The agent this call belongs to, when it is a spawned agent. Both
		// the byline on the card and the observable waiting state below are
		// keyed off it, and a root session has neither.
		const requester = this.#runner.agentId;

		if (!this.#runner.hasUI()) {
			await this.#resolve(false, "no interactive UI available");
			throw this.#headlessRefusal(requester);
		}

		const uiContext = this.#runner.getUIContext();
		// A tool the model called several times in one batch raises one approval
		// prompt per call, and only the first can reach the surface: the dialog
		// host presents one at a time and queues the rest. The standing grant was
		// read once, above, BEFORE this call queued, so an answer of "Approve for
		// session" given at the first card could never dismiss the cards already
		// waiting behind it. Those cards are also built without a signal, so
		// neither an abort nor the end of the turn drops them: they surface
		// whenever the surface frees up, which is how an operator who answered
		// once gets asked again for the same tool after the work is finished.
		//
		// Waiting on the in-flight prompt instead of queueing a second card is
		// what closes that window. The answers are re-read after the wait, so a
		// session grant dismisses this call with no card at all, and "Approve
		// once" still asks again, because that answer was only ever about one
		// call. Each concern is retired only by an answer in its own category,
		// so a destructive or boundary call is never dismissed by a tool-wide allow.
		const inFlightKey = this.#sessionId ? `${this.#sessionId}\u0000${this.#tool.name}` : undefined;
		const release = await this.#awaitTurn(inFlightKey);
		if (release === undefined) {
			await this.#resolve(true);
			return;
		}

		const answer = await this.#ask(uiContext, params, requester, release);
		const approved = this.#choice(answer)?.allow === true;
		await this.#resolve(approved, approved ? undefined : "denied by user");
		if (!approved) {
			throw new Error(`Tool call denied by user: ${this.#tool.name}`);
		}
	}

	/** The offered row a dialog answer names; undefined for a dismissed dialog or a label never offered. */
	#choice(answer: string | undefined): ApprovalChoice | undefined {
		return this.#prompt.choices.find(choice => choice.label === answer);
	}

	async #resolve(approved: boolean, reason?: string): Promise<void> {
		if (!this.#reported) return;
		await this.#runner.emit({
			type: "tool_approval_resolved",
			sessionId: this.#sessionId,
			toolName: this.#tool.name,
			toolCallId: this.#toolCallId,
			approved,
			...(reason ? { reason } : {}),
		});
	}

	/**
	 * Lead with the specific reason (e.g. the cwd-boundary path) so a
	 * headless run reports WHY it was blocked, not only that a prompt was
	 * needed.
	 *
	 * An agent reaches here only when the ROOT session has no UI either,
	 * because the spawner hands the root's surface down (see
	 * `resolveRootUIContext` in `task/executor.ts`). So the refusal has to
	 * read as a decision about the run's configuration rather than as a
	 * crash inside the child: this text is the entire explanation the
	 * child's tool result carries, and the operator sees it attributed to
	 * the child with no card ever having been drawn.
	 */
	#headlessRefusal(requester: string | undefined): Error {
		const toolName = this.#tool.name;
		const detail = this.#prompt.reason ? `${this.#prompt.reason}\n` : "";
		const forAgent = requester ? ` (requested by ${requester})` : "";
		return new Error(
			`${detail}Tool "${toolName}"${forAgent} requires approval but no interactive UI available.\n` +
				`Options:\n` +
				`  1. Raise tools.approvalMode (ask-command / auto / yolo) in /settings, or pass --approval-mode\n` +
				`  2. Add tools.approval.${toolName}: allow to config\n` +
				`  3. Use an interactive UI to approve the tool call`,
		);
	}

	/**
	 * Wait out every prompt already on screen for this session and tool, then hold the screen for
	 * this call; the returned function releases it and the calls queued behind it. Undefined when
	 * session answers given at earlier cards retire every concern; a session refusal throws.
	 *
	 * The lookup that finds the screen free and the claim run in one synchronous block, so two calls
	 * woken by the same answer cannot both find it free and both raise a card.
	 */
	async #awaitTurn(inFlightKey: string | undefined): Promise<(() => void) | undefined> {
		const { promise: promptSettled, resolve: releaseWaiters } = Promise.withResolvers<void>();
		if (inFlightKey === undefined) return releaseWaiters;
		for (
			let pending = IN_FLIGHT_APPROVALS.get(inFlightKey);
			pending;
			pending = IN_FLIGHT_APPROVALS.get(inFlightKey)
		) {
			await pending;
			const refusal = standingRefusal(this.#gate, this.#approvals);
			if (refusal) {
				await this.#resolve(false, "denied for this session");
				throw refusal;
			}
			const open = openConcerns(this.#gate, this.#approvals);
			if (open.length === 0) return undefined;
			this.#prompt = approvalPrompt(this.#gate, open);
		}
		IN_FLIGHT_APPROVALS.set(inFlightKey, promptSettled);
		return () => {
			IN_FLIGHT_APPROVALS.delete(inFlightKey);
			releaseWaiters();
		};
	}

	/** Show the card, record a session answer, and release the calls queued behind it. */
	async #ask(
		uiContext: ExtensionUIContext,
		params: Static<TParameters>,
		requester: string | undefined,
		release: () => void,
	): Promise<string | undefined> {
		// Observable waiting state, published for the whole process rather than
		// kept as a private boolean here. A blocked agent's status is `running`
		// (it is mid-turn), so nothing downstream can otherwise tell an agent
		// stopped at a prompt from an agent grinding through a build: the runtime
		// budget charges it the operator's reading time and the dashboard renders
		// it as busy. Opened immediately before the card and closed in the
		// `finally` that also covers the throw, so no abort, refusal or dialog
		// error can leave it open. A call queued behind another card of this tool
		// opens none while it waits: that card's wait already marks the agent.
		const closeWait = requester
			? AgentRegistry.global().openApprovalWait(requester, {
					toolName: this.#tool.name,
					...(this.#prompt.reason ? { reason: this.#prompt.reason } : {}),
					since: Date.now(),
				})
			: undefined;
		let answer: string | undefined;
		try {
			answer = await uiContext.select(
				formatApprovalCard(this.#tool, params, this.#prompt.reason, requester),
				this.#prompt.choices.map(({ label, description }) => ({ label, description })),
				{ ...APPROVAL_DIALOG_OPTIONS, approval: this.#card(params, requester) },
			);
		} catch (err) {
			await this.#resolve(false, err instanceof Error ? err.message : "approval aborted");
			throw err;
		} finally {
			closeWait?.();
			// Cleanup lives in the finally, not after the try: a dialog surface
			// that dies mid-prompt must still release the calls queued behind
			// it, or the batch waits on a promise nobody will ever settle and
			// the agent stops with no card on screen to answer.
			// The answer is recorded and the waiters released in the same
			// synchronous block, so no waiter can wake between the two and read
			// a grant that is about to exist.
			const choice = this.#choice(answer);
			if (choice) recordAnswer(choice, this.#approvals);
			release();
		}
		return answer;
	}

	#card(params: Static<TParameters>, requester: string | undefined): ApprovalCard {
		const prompt = this.#prompt;
		return {
			toolName: this.#tool.name,
			...(requester ? { requester } : {}),
			category: prompt.category,
			args: params,
			details: approvalDetailLines(this.#tool, params),
			reasons: prompt.concerns
				.filter(concern => concern.text.length > 0)
				.map(({ category, text }) => ({ category, text })),
			cwd: this.#cwd,
			mode: this.#gate.mode,
			...(this.#gate.pattern !== undefined ? { pattern: this.#gate.pattern } : {}),
			choices: prompt.choices.map(({ id, label, allow, scope }) => ({
				id,
				label,
				allow,
				...(scope !== undefined ? { scope } : {}),
			})),
		};
	}
}

/** Send `tool_call` to the extensions that vet calls; throw when one blocks this call or fails vetting it. */
async function vetToolCall<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	runner: ExtensionRunner,
	toolCallId: string,
	params: Static<TParameters>,
): Promise<void> {
	if (!runner.hasHandlers("tool_call")) return;
	try {
		const callResult = (await runner.emitToolCall({
			type: "tool_call",
			toolName: tool.name,
			toolCallId,
			input: normalizeToolEventInput(tool.name, resolveToolEventInput(tool, params as Record<string, unknown>)),
		})) as ToolCallEventResult | undefined;

		if (callResult?.block) {
			const reason =
				callResult.reason ||
				`An extension blocked this ${tool.name} call and gave no reason. Do not retry it; tell ` +
					"the operator which extension is blocking so they can fix or remove it.";
			throw new Error(reason);
		}
	} catch (err) {
		if (err instanceof Error) {
			throw err;
		}
		throw new Error(
			`An extension threw a non-error value while vetting this ${tool.name} call, so the call was ` +
				`blocked rather than run unchecked: ${errorMessage(err)}. Do not retry it; tell the operator that ` +
				"extension is failing.",
		);
	}
}

/** A tool's result, or the error it threw with a result holding that error's message. */
interface ExecutedCall<TParameters extends TSchema, TDetails> {
	result: { content: AgentToolResult<TDetails, TParameters>["content"]; details?: TDetails };
	error: Error | undefined;
}

/**
 * Send `tool_result` to the extensions that rewrite results. The rewritten result, or undefined when
 * no handler listens or none returned a change.
 */
async function rewrittenResult<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	runner: ExtensionRunner,
	toolCallId: string,
	params: Static<TParameters>,
	{ result, error }: ExecutedCall<TParameters, TDetails>,
): Promise<AgentToolResult<TDetails, TParameters> | undefined> {
	if (!runner.hasHandlers("tool_result")) return undefined;
	const resultResult = await runner.emitToolResult({
		type: "tool_result",
		toolName: tool.name,
		toolCallId,
		input: normalizeToolEventInput(tool.name, resolveToolEventInput(tool, params as Record<string, unknown>)),
		content: result.content,
		details: result.details,
		isError: !!error,
	});
	if (!resultResult) return undefined;

	const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
	const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

	// Effective error state: an explicit handler override wins; otherwise the
	// original execution outcome stands. This lets a handler rewrite a failed
	// call's model-visible content/details while keeping it an error, flip a
	// failure to success, or flag a success as an error.
	const effectiveError = resultResult.isError ?? !!error;

	// Return the (possibly modified) result carrying the error flag rather than
	// rethrowing the original exception. The agent loop honors
	// `AgentToolResult.isError` and surfaces it as a tool error on the wire (see
	// `coerceToolResult` in agent-loop), so replacement failure content reaches
	// the model while the call remains an error — the original exception text is
	// no longer forced through, which previously discarded the replacement.
	return {
		content: modifiedContent,
		details: modifiedDetails,
		...(effectiveError ? { isError: true } : {}),
	};
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// 1. Check approval policy (before extension handlers).
		const gate = resolveApprovalGate(this.tool, params, context);
		const sessionApprovals = context?.sessionApprovals;
		const refusal = standingRefusal(gate, sessionApprovals);
		if (refusal) throw refusal;
		const open = openConcerns(gate, sessionApprovals);
		if (open.length > 0) {
			await new ApprovalRequest(this.tool, this.runner, toolCallId, gate, open, context).obtain(params);
		}

		// 2. Emit tool_call event - extensions can block execution
		await vetToolCall(this.tool, this.runner, toolCallId, params);

		// Execute the actual tool
		let executed: ExecutedCall<TParameters, TDetails>;
		try {
			executed = {
				result: await this.tool.execute(toolCallId, params, signal, onUpdate, context),
				error: undefined,
			};
		} catch (err) {
			// A CANCELLATION IS NOT A FAILED CALL, so it never becomes one here. The
			// `tool_result` path below deliberately turns a thrown error into a
			// resolved `isError: true` result when a handler returns replacement
			// content, which is right for a tool that failed and wrong for a tool the
			// operator stopped: it swallows the abort, so the agent loop reads a
			// retryable failure and re-issues the very work the user cancelled. There
			// is also nothing for a handler to usefully rewrite, since the "content"
			// of a cancelled call is the fact that it did not happen.
			// `isCancellation`, so a deadline is not swallowed either. Both mean the
			// call did not happen, and turning either into a result the handlers can
			// rewrite invites the agent loop to re-issue the work.
			if (isCancellation(err)) throw err;
			const error = toError(err);
			executed = {
				result: { content: [{ type: "text", text: error.message }], details: undefined as TDetails },
				error,
			};
		}

		// Emit tool_result event - extensions can modify the result and error status
		const rewritten = await rewrittenResult(this.tool, this.runner, toolCallId, params, executed);
		if (rewritten) return rewritten;

		// No extension modification
		if (executed.error) {
			throw executed.error;
		}
		return executed.result;
	}
}
