/**
 * Time-Traveling Stream Rules (TTSR): match rules against a streaming assistant
 * turn and deliver the matched rule bodies back to the model.
 *
 * This is a session collaborator. It owns every piece of TTSR state — the pending
 * interrupt queue, the per-tool buckets, the abort latch, the retry token and the
 * resume gate — and reaches the session only through {@link TtsrRuntimeHost}. The
 * eight state fields used to sit among two hundred others on `AgentSession`, where
 * nothing said which of them moved together, and the invariant that a claimed rule
 * is either delivered or released was spread across five call sites in a 19 000-line
 * file.
 *
 * Two delivery paths exist and they differ only in timing:
 *
 * - **Interrupting.** A match aborts the stream, the rendered bodies go in as a
 *   `display: false` `ttsr-injection` custom message, and the turn continues.
 * - **Tool-scoped.** A match on a tool's argument stream whose `interruptMode` is
 *   `never` buckets against that tool call, renders in `afterToolCall`, and rides
 *   the next step boundary as an aside. It must not abort, because the sibling tool
 *   calls still in flight have nothing to do with the rule that matched.
 *
 * A rule is CLAIMED in the manager when it is queued and released when the turn
 * dies before delivering it. Losing that release is not a visible failure: the rule
 * stays marked injected with nothing ever shown, and under the default
 * `repeatMode: "once"` one interrupted turn retires it for the session.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AfterToolCallContext, AfterToolCallResult, AgentMessage, AnyAgentTool } from "@veyyon/agent-core";
import { createToolScopedAbortReason } from "@veyyon/agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@veyyon/ai";
import { isRecord, logger, prompt, relativePathWithinRoot } from "@veyyon/utils";
import type { Rule } from "../../discovery/capability/rule";
import type { TtsrManager, TtsrMatchContext } from "../../export/ttsr";
import { rulesPrompts } from "../../prompts/rules/rows";
import type { AgentSessionEvent, ScheduledAgentContinueOptions } from "../agent-session-types";

/**
 * The slice of the agent loop TTSR drives. `Agent` satisfies this structurally.
 *
 * Named rather than `Agent` because TTSR reaches seven of that class's members and
 * three fields of its state, and a host that names the class instead of the slice
 * cannot be stood up in a test without the whole loop behind it.
 */
export interface TtsrAgent {
	readonly state: {
		readonly messages: readonly AgentMessage[];
		readonly tools: readonly AnyAgentTool[];
		readonly isStreaming: boolean;
	};
	abort(reason?: unknown): void;
	followUp(message: AgentMessage): void;
	appendMessage(message: AgentMessage): void;
	replaceMessages(messages: AgentMessage[]): void;
	hasQueuedMessages(): boolean;
	continue(): Promise<unknown>;
}

/** The slice of the session log TTSR appends to. `SessionManager` satisfies this. */
export interface TtsrSessionStore {
	getCwd(): string;
	appendTtsrInjection(ruleNames: string[]): string;
	appendCustomMessageEntry<T>(
		customType: string | undefined,
		content: string | undefined,
		display: boolean | undefined,
		details?: T,
		attribution?: "agent",
	): string;
}

/**
 * What {@link TtsrRuntime} needs from the session that owns it.
 *
 * Deliberately eight names, and none of them a class the session happens to hold.
 * A rule body renders against live session state (the two argot predicates and the
 * cwd), delivery goes through the agent, and the deferred retry re-checks the prompt
 * generation it was scheduled under. Anything wider would be the monolith with an
 * interface bolted on.
 */
export interface TtsrRuntimeHost {
	readonly agent: TtsrAgent;
	readonly sessionStore: TtsrSessionStore;
	/** Whether shorthand encoding is enabled, which decides the `argot` gate. */
	argotEnabled(): boolean;
	/** Whether a dictionary is already loaded, which closes the `argot_load` nudge. */
	argotLoaded(): boolean;
	/** Prompt generation a deferred continuation must still match to be valid. Read
	 *  at call time: a deferred retry compares it against the value it captured. */
	promptGeneration(): number;
	/** Emit a session event without blocking the caller on extension handlers. */
	emitSessionEventDetached(event: AgentSessionEvent, context: string): void;
	scheduleAgentContinue(options: ScheduledAgentContinueOptions): void;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>, options?: { delayMs?: number }): void;
}

export class TtsrRuntime {
	readonly #host: TtsrRuntimeHost;
	#manager: TtsrManager | undefined;
	#pendingInjections: Rule[] = [];
	/** Per-tool TTSR rules whose `interruptMode` opted out of aborting the stream.
	 *  Bucketed while the tool call's arguments stream, then rendered in
	 *  {@link afterToolCall} into {@link #pendingToolReminders}. */
	#perToolInjections = new Map<string, Rule[]>();
	/** Rendered tool-scoped TTSR reminders waiting for the next aside boundary.
	 *  Model-only: they never enter a tool result, so nothing the user reads
	 *  carries `<system-reminder>` markup. See {@link afterToolCall}. */
	#pendingToolReminders: { content: string; rules: string[] }[] = [];
	#abortPending = false;
	#retryToken = 0;
	#resumePromise: Promise<void> | undefined = undefined;
	#resumeResolve: (() => void) | undefined = undefined;

	constructor(host: TtsrRuntimeHost, manager: TtsrManager | undefined) {
		this.#host = host;
		this.#manager = manager;
	}

	/** TTSR manager for time-traveling stream rules. */
	get manager(): TtsrManager | undefined {
		return this.#manager;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules). */
	get isAbortPending(): boolean {
		return this.#abortPending;
	}

	/** The resume gate a prompt-settle drain must await before declaring the turn over. */
	get resumePromise(): Promise<void> | undefined {
		return this.#resumePromise;
	}

	/** Reset the match buffer at the start of a turn. */
	onTurnStart(): void {
		this.#manager?.resetBuffer();
	}

	/** Advance the repeat-after-gap counter at the end of a turn. */
	onTurnEnd(): void {
		this.#manager?.incrementMessageCount();
	}

	/** Re-prime the manager's transcript view after the context was rewritten. */
	onCompaction(): void {
		this.#manager?.resetForCompaction();
	}

	/**
	 * Match an assistant stream delta against TTSR rules.
	 *
	 * Returns true when the stream was aborted for an interrupting injection and
	 * the caller must stop processing this event.
	 */
	async observeStreamDelta(message: AgentMessage, assistantEvent: AssistantMessageEvent): Promise<boolean> {
		if (!this.#manager?.hasRules()) return false;
		let matchContext: TtsrMatchContext | undefined;
		let streamingToolCall: ToolCall | undefined;

		if (assistantEvent.type === "text_delta") {
			matchContext = { source: "text" };
		} else if (assistantEvent.type === "thinking_delta") {
			matchContext = { source: "thinking" };
		} else if (assistantEvent.type === "toolcall_delta") {
			streamingToolCall = this.#getStreamingToolCallBlock(message, assistantEvent.contentIndex);
			matchContext = this.#getToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
		}
		if (!matchContext || !("delta" in assistantEvent)) return false;

		const targetMessageTimestamp = message.role === "assistant" ? message.timestamp : undefined;
		const matches = this.#checkStream(assistantEvent.delta, matchContext, streamingToolCall);
		if (matches.length > 0 && this.#handleMatches(matches, matchContext, targetMessageTimestamp)) {
			return true;
		}
		// ast-grep `astCondition` rules match against the reconstructed edit/write
		// snapshot, which only exists for tool argument streams. The native worker
		// call is async, so this path is awaited and self-throttled by the manager.
		if (matchContext.source !== "tool" || this.#manager?.hasAstRules() !== true) return false;
		const astMatches = await this.#checkAstStream(matchContext, streamingToolCall);
		return astMatches.length > 0 && this.#handleMatches(astMatches, matchContext, targetMessageTimestamp);
	}

	/** Record delivery of a persisted `ttsr-injection` custom message. */
	onInjectionPersisted(details: unknown): void {
		this.#markInjected(this.#extractRuleNames(details));
	}

	/**
	 * Settle the turn: resolve the resume gate and queue any deferred injection.
	 *
	 * The gate is resolved on {@link isAbortPending} being false rather than on the
	 * stop reason, because a non-TTSR abort (a streaming edit, say) also reports
	 * `stopReason === "aborted"` and has no continuation coming behind it.
	 */
	onAssistantSettled(assistantMsg: AssistantMessage): void {
		if (!this.#abortPending) this.resolveResume();
		this.#queueDeferredInjectionIfNeeded(assistantMsg);
	}

	/** Resolve and clear the TTSR resume gate. */
	resolveResume(): void {
		if (!this.#resumeResolve) return;
		this.#resumeResolve();
		this.#resumeResolve = undefined;
		this.#resumePromise = undefined;
	}

	/**
	 * `afterToolCall` hook: queue any per-tool TTSR reminders for model-only delivery.
	 *
	 * This used to PREPEND the rendered reminder into `ctx.result.content`. Two things
	 * fell out of that, both reported from one screenshot. The reminder is model-directed
	 * `<system-reminder>` markup and a tool result is a surface the user reads, so the
	 * markup was shown to them, duplicating the `Injecting rule:` banner already on screen.
	 * And on a call that ALSO errored the reminder became the first text block, which is
	 * what the TUI prints as the error headline, so the real failure was pushed out of view
	 * for the user and displaced for the model.
	 *
	 * Appending would have fixed only the second half. The interrupting path has always
	 * delivered its reminder as a `display: false` `ttsr-injection` custom message, so this
	 * takes the same channel and the two paths now differ only in timing: an aside rides the
	 * next step boundary, which is before the model's next call and after the batch in flight
	 * finishes. A steer would reach the model just as promptly but aborts the remaining tool
	 * calls in the batch, and a reminder about a call that already returned must not do that.
	 *
	 * Persistence moves with the delivery. `message_end` marks and records any
	 * `ttsr-injection` custom message, so recording here as well would double-count, and
	 * recording here at all would claim a delivery that a dying turn never makes.
	 */
	afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolInjections.delete(ctx.toolCall.id);
		// The reminder states that the tool ran. On an errored or skipped call that is
		// false, and a false statement about what just happened is worse than no reminder.
		const details = ctx.result?.details;
		const skipped = isRecord(details) && details.__skipped === true;
		const ran = !ctx.isError && !skipped;
		const reminder = rules
			.map(r =>
				prompt.render(rulesPrompts["rules/ttsr-tool-reminder"].text, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: this.#renderRuleBody(r),
					tool: ctx.toolCall.name,
					ran,
				}),
			)
			.join("\n\n");
		const ruleNames = rules.map(r => r.name.trim()).filter(n => n.length > 0);
		this.#pendingToolReminders.push({ content: reminder, rules: ruleNames });
		return undefined;
	}

	/** Drain queued tool-scoped TTSR reminders as one model-only aside, if any wait. */
	takePendingToolReminders(): AgentMessage | null {
		if (this.#pendingToolReminders.length === 0) return null;
		const pending = this.#pendingToolReminders;
		this.#pendingToolReminders = [];
		return {
			role: "custom",
			customType: "ttsr-injection",
			content: pending.map(reminder => reminder.content).join("\n\n"),
			display: false,
			details: { rules: pending.flatMap(reminder => reminder.rules) },
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	#ensureResumePromise(): void {
		if (this.#resumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#resumePromise = promise;
		this.#resumeResolve = resolve;
	}

	#formatAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		const ruleNames = rules.map(rule => rule.name).join(", ");
		return `TTSR matched ${label}: ${ruleNames}`;
	}

	/**
	 * Resolve a rule body's template against the live session, for either delivery path.
	 *
	 * ONE owner, because there are TWO ways a rule reaches the model and only one of them used to
	 * render. A stream-interrupting rule went through here; a tool-scoped rule (`interruptMode:
	 * never` matching on a tool stream) had its RAW body folded into the tool result by
	 * {@link afterToolCall}. That is the path `cwd-reroot` always takes, so the model was shown
	 * `{{#if argot}}` markup verbatim — the exact leak `discovery/builtin-defaults.test.ts` exists to
	 * prevent, bypassed on the only path that rule uses.
	 *
	 * - `argot` gates advice to call `argot_load`, a tool that is not registered by default.
	 * - `cwd` lets a rule say where the session currently is.
	 * - `matchedPath` lets a rule name what triggered it; it is set only for a rule with a
	 *   `pathScope`, so a body that uses it must guard the reference.
	 */
	#renderRuleBody(rule: Rule): string {
		const argotEnabled = this.#host.argotEnabled();
		return prompt.render(rule.content, {
			argot: argotEnabled,
			// Whether the nudge to LOAD shorthand still applies, which is a different question from
			// whether the feature is on: telling a model to load a dictionary it already loaded is
			// advice it cannot act on. `unless` does not exist in the template language, so the
			// condition a rule wants to gate on has to be passed already inverted.
			argotUnloaded: argotEnabled && !this.#host.argotLoaded(),
			cwd: this.#host.sessionStore.getCwd(),
			matchedPath: this.#manager?.lastMatchedPath(rule.name),
		});
	}

	/**
	 * Keep only matches that will actually say something to the model.
	 *
	 * A rule body may be entirely wrapped in a `{{#if}}` gate — `argot-load-nudge` is, because its
	 * advice is to call a tool that only exists when argot is enabled. When the gate is closed the
	 * body renders to nothing, and delivering that is worse than not firing: an empty
	 * `<system-reminder>` spends tokens, interrupts a stream on the interrupting path, marks the rule
	 * as injected so it cannot fire when the gate later opens, and tells the model that a rule was
	 * violated without saying which behaviour to change.
	 *
	 * Dropped here rather than at either delivery site, so the decision is made once, before the
	 * claim is taken and before `ttsr_triggered` is emitted. The drop is LOGGED at warn: a bundled
	 * rule that can never say anything is a packaging bug, and it must not be silent.
	 */
	#deliverableMatches(matches: Rule[]): Rule[] {
		const deliverable: Rule[] = [];
		for (const rule of matches) {
			if (this.#renderRuleBody(rule).trim().length > 0) {
				deliverable.push(rule);
				continue;
			}
			// A body wrapped in a `{{#if}}` gate rendering empty is the gate WORKING, and it happens on
			// every match for as long as the gate is closed, so it is reported at debug. A body with no
			// gate that renders empty cannot ever say anything: that is a packaging bug in the rule and
			// it is reported at warn, where an operator will see it.
			const gated = rule.content.includes("{{#if");
			const message = "TTSR rule matched but its body renders empty, not delivering";
			const fields = { ruleName: rule.name, path: rule.path, gated };
			if (gated) logger.debug(message, fields);
			else logger.warn(message, fields);
		}
		return deliverable;
	}

	/** Get TTSR injection payload and clear pending injections. */
	#getInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingInjections.length === 0) return undefined;
		const rules = this.#pendingInjections;
		const content = rules
			.map(r =>
				prompt.render(rulesPrompts["rules/ttsr-interrupt"].text, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: this.#renderRuleBody(r),
				}),
			)
			.join("\n\n");
		this.#pendingInjections = [];
		return { content, rules };
	}

	/**
	 * Render a rule's file path for model-facing TTSR injections without leaking
	 * the absolute home directory: cwd-relative when the rule lives in the
	 * project, `~`-relative when it lives under home, else the raw path.
	 */
	#displayRulePath(rulePath: string): string {
		const cwd = this.#host.sessionStore.getCwd();
		const cwdRel = relativePathWithinRoot(cwd, rulePath) ?? this.#displayPathWithinRoot(cwd, rulePath);
		if (cwdRel) return cwdRel;
		const homeRel = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRel) return `~/${homeRel}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingInjections.push(rule);
			seen.add(rule.name);
		}
	}

	/** Tool-call id whose argument deltas triggered a TTSR match, when known. */
	#extractToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));
		// Dedupe against rules already bucketed for other tool calls in this
		// same assistant message so one rule attaches to exactly one tool call.
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolInjections.set(toolCallId, bucket);
		// Claim the rules in the TTSR manager so subsequent deltas in this same
		// turn (e.g. a sibling tool call's argument stream) don't re-match them.
		// Persistence still happens in afterToolCall when the tool actually
		// produces a result we can fold the reminder into. The claim is PROVISIONAL:
		// #dropUndeliveredPerToolInjections gives it back if that never happens.
		if (newlyAdded.length > 0) {
			this.#manager?.markInjectedByNames(newlyAdded);
		}
	}

	/**
	 * Drop tool-scoped reminders that will never be delivered, and give their claims back.
	 *
	 * A tool-scoped reminder is claimed when it is bucketed and delivered later, in `afterToolCall`.
	 * A turn that is aborted or errors never reaches that hook, so the bucket has to be discarded —
	 * and the claim discarded with it. Clearing the bucket alone left the rule marked as injected
	 * with nothing ever shown to the model, and under the default `repeatMode: "once"` that is
	 * permanent for the session: one interrupted turn silently retires the rule.
	 *
	 * This is why `cwd-reroot` "just did not fire". The state that suppressed it is indistinguishable
	 * from the state after a successful injection, so nothing anywhere reported a problem.
	 */
	#dropUndeliveredPerToolInjections(): void {
		if (this.#perToolInjections.size === 0 && this.#pendingToolReminders.length === 0) return;
		const undelivered = new Set<string>();
		for (const bucket of this.#perToolInjections.values()) {
			for (const rule of bucket) undelivered.add(rule.name);
		}
		// A reminder rendered but not yet drained as an aside is undelivered too.
		// The turn dying between `afterToolCall` and the next step boundary is the
		// same loss as the turn dying before the tool ran, so it releases the same way.
		for (const reminder of this.#pendingToolReminders) {
			for (const name of reminder.rules) undelivered.add(name);
		}
		this.#perToolInjections.clear();
		this.#pendingToolReminders = [];
		this.#manager?.releaseInjectedByNames([...undelivered]);
	}

	#extractRuleNames(details: unknown): string[] {
		if (!isRecord(details)) return [];
		const rules = details.rules;
		if (!Array.isArray(rules)) return [];
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	#markInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#manager?.markInjectedByNames(uniqueRuleNames);
		this.#host.sessionStore.appendTtsrInjection(uniqueRuleNames);
	}

	#findAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.#host.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "assistant") {
				continue;
			}
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	#shouldInterruptForMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#manager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking"))
				return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			// Tools that hadn't started by abort/error will never produce results to
			// fold injections into — drop their stale per-tool entries AND give back the
			// claims they took, or the rules stay retired for the rest of the session
			// having shown the model nothing.
			this.#dropUndeliveredPerToolInjections();
		}
		if (this.#abortPending || this.#pendingInjections.length === 0) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#pendingInjections = [];
			return;
		}

		const injection = this.#getInjectionContent();
		if (!injection) {
			return;
		}
		this.#host.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#host.scheduleAgentContinue({
			delayMs: 1,
			generation: this.#host.promptGeneration(),
			onSkip: () => {
				this.resolveResume();
			},
			shouldContinue: () => {
				if (this.#host.agent.state.isStreaming || !this.#host.agent.hasQueuedMessages()) {
					this.resolveResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.resolveResume();
			},
		});
	}

	/** Extract the tool-call block a `toolcall_delta` event refers to, if present. */
	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") {
			return undefined;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return undefined;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return undefined;
		}

		return block;
	}

	/** Build TTSR match context for tool call argument deltas. */
	#getToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) {
			return context;
		}

		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractToolFilePaths(toolCall);
		return context;
	}

	/**
	 * Resolve the file paths a tool call would touch for TTSR path-glob matching.
	 *
	 * Prefer the tool's own `matcherPaths` hook — it understands the wire format
	 * (hashline `[path#TAG]` section headers, apply_patch envelope markers) and
	 * surfaces paths the generic top-level argument scan never sees. Fall back
	 * to {@link #extractFilePathsFromArgs} for tools that pass paths as
	 * `path`/`paths` arguments and for tool calls whose payload has not yet
	 * streamed a header.
	 */
	#extractToolFilePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const toolPaths = this.#resolveTool(toolCall)?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const normalized = toolPaths.flatMap(p => this.#normalizePathCandidates(p));
			if (normalized.length > 0) return Array.from(new Set(normalized));
		}
		return this.#extractFilePathsFromArgs(args);
	}

	/**
	 * Match a stream delta against TTSR rules.
	 *
	 * Tool argument streams prefer the tool's `matcherDigest` normalization — the
	 * real content the call introduces — over the raw argument delta, so rule
	 * conditions written against source text keep working regardless of the
	 * tool's wire format (hashline patches, JSON-escaped strings, ...).
	 */
	#checkStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Rule[] {
		const manager = this.#manager;
		if (!manager) {
			return [];
		}
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(...manager.checkSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path)));
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		if (digest !== undefined) {
			return manager.checkSnapshot(digest, matchContext);
		}
		return manager.checkDelta(delta, matchContext);
	}

	/** Reconstruct the tool's normalized source snapshot via its `matcherDigest`, if any. */
	#resolveMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		return this.#resolveTool(toolCall)?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	/**
	 * Per-file split of a streamed call (one entry per touched file paired with
	 * the digest of only that file's added lines). Lets {@link #checkStream}
	 * and {@link #checkAstStream} evaluate each file in isolation so a
	 * path-scoped rule like `tool:edit(*.ts)` never fires on text that belongs
	 * to a sibling Markdown hunk in a multi-file payload.
	 */
	#resolveMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const entries = this.#resolveTool(toolCall)?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTool(toolCall: ToolCall | undefined): AnyAgentTool | undefined {
		if (!toolCall) return undefined;
		const tools = this.#host.agent.state.tools;
		return (
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name)
		);
	}

	/**
	 * Replace `matchContext`'s `filePaths` + `streamKey` so a per-file entry
	 * gets its own glob-eligible path and its own TTSR buffer/repeat tracking
	 * (each file's stream is independent inside the same tool call).
	 */
	#perFileContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizePathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	/**
	 * Match ast-grep `astCondition` rules against the reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams expose a `matcherDigest`, which is the real source
	 * the call introduces; AST matching needs that (and a language inferred from the
	 * path argument), so non-digest streams never produce AST matches.
	 */
	async #checkAstStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<Rule[]> {
		const manager = this.#manager;
		if (!manager) {
			return [];
		}
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(
					...(await manager.checkAstSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path))),
				);
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		if (digest === undefined) {
			return [];
		}
		return manager.checkAstSnapshot(digest, matchContext);
	}

	/**
	 * Route TTSR matches to either a per-tool injection or a stream-interrupting
	 * retry. Returns true when the stream was aborted and the caller should stop
	 * processing this event.
	 */
	#handleMatches(
		rawMatches: Rule[],
		matchContext: TtsrMatchContext,
		targetMessageTimestamp: number | undefined,
	): boolean {
		// A rule whose body renders to nothing is dropped before anything is claimed or emitted.
		const matches = this.#deliverableMatches(rawMatches);
		if (matches.length === 0) {
			return false;
		}
		// Decide first: a non-interrupting tool-source match attaches to the
		// specific tool call's result instead of driving a loop-wide follow-up.
		const shouldInterrupt = this.#shouldInterruptForMatch(matches, matchContext);
		const matchedToolId = this.#extractToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolInjections(perToolId, matches);
			this.#host.emitSessionEventDetached({ type: "ttsr_triggered", rules: matches }, "ttsr-per-tool");
			return false;
		}

		// Queue rules for injection; mark as injected only after successful enqueue.
		this.#addPendingInjections(matches);
		if (!shouldInterrupt) {
			return false;
		}

		// Abort the stream immediately — do not gate on extension callbacks
		this.#abortPending = true;
		this.#ensureResumePromise();
		const abortReason = this.#formatAbortReason(matches);
		this.#host.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);
		// Notify extensions (fire-and-forget, does not block abort)
		this.#host.emitSessionEventDetached({ type: "ttsr_triggered", rules: matches }, "ttsr-interrupt");
		// Schedule retry after a short delay
		const retryToken = ++this.#retryToken;
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(
			async () => {
				if (this.#retryToken !== retryToken) {
					this.resolveResume();
					return;
				}

				const targetAssistantIndex = this.#findAssistantIndex(targetMessageTimestamp);
				if (!this.#abortPending || this.#host.promptGeneration() !== generation || targetAssistantIndex === -1) {
					this.#abortPending = false;
					this.#pendingInjections = [];
					this.#dropUndeliveredPerToolInjections();
					this.resolveResume();
					return;
				}
				this.#abortPending = false;
				// The interrupting rules are about to be injected as a system reminder; any
				// TOOL-scoped buckets from the same turn are not, so their claims go back.
				this.#dropUndeliveredPerToolInjections();
				const ttsrSettings = this.#manager?.getSettings();
				if (ttsrSettings?.contextMode === "discard") {
					// Remove the partial/aborted assistant turn from agent state
					this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, targetAssistantIndex));
				}
				// Inject TTSR rules as system reminder before retry
				const injection = this.#getInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.#host.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.#host.sessionStore.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markInjected(details.rules);
				}
				try {
					await this.#host.agent.continue();
				} catch {
					this.resolveResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	/** Extract path-like arguments from tool call payload for TTSR glob matching. */
	#extractFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!isRecord(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizePathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	/** Convert a path argument into stable relative/absolute candidates for glob checks. */
	#normalizePathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.#host.sessionStore.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
}
