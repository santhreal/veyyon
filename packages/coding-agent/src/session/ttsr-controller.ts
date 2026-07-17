/**
 * TTSR (time-traveling stream rules) controller: matches streamed assistant
 * text/thinking/tool-argument deltas against active rules, folds non-interrupting
 * matches into the triggering tool call's result, and drives the interrupt →
 * inject → resume cycle for interrupting matches. Owns all TTSR runtime state
 * (pending/per-tool injections, the abort latch, the resume gate promise).
 */
import os from "node:os";
import path from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentEvent,
	type AgentMessage,
	createToolScopedAbortReason,
} from "@veyyon/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@veyyon/pi-ai";
import { prompt, relativePathWithinRoot } from "@veyyon/pi-utils";
import type { Rule } from "../capability/rule";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import type { AgentSessionEvent, ScheduledAgentContinueOptions } from "./agent-session";
import type { SessionManager } from "./session-manager";

/** Session facilities the controller drives; closures over AgentSession privates. */
export interface TtsrControllerDeps {
	agent: Agent;
	sessionManager: SessionManager;
	getPromptGeneration(): number;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>, options?: { delayMs?: number }): void;
	scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void;
}

export class TtsrController {
	readonly #deps: TtsrControllerDeps;
	readonly #manager: TtsrManager | undefined;
	#pendingInjections: Rule[] = [];
	#perToolInjections = new Map<string, Rule[]>();
	#abortPending = false;
	#retryToken = 0;
	#resumePromise: Promise<void> | undefined = undefined;
	#resumeResolve: (() => void) | undefined = undefined;

	constructor(manager: TtsrManager | undefined, deps: TtsrControllerDeps) {
		this.#manager = manager;
		this.#deps = deps;
	}

	get manager(): TtsrManager | undefined {
		return this.#manager;
	}

	get isAbortPending(): boolean {
		return this.#abortPending;
	}

	/** The resume gate: pending while an interrupt → inject → continue cycle is in flight. */
	get resumePromise(): Promise<void> | undefined {
		return this.#resumePromise;
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	ensureResumePromise(): void {
		if (this.#resumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#resumePromise = promise;
		this.#resumeResolve = resolve;
	}

	/** Resolve and clear the TTSR resume gate. */
	resolveResume(): void {
		if (!this.#resumeResolve) return;
		this.#resumeResolve();
		this.#resumeResolve = undefined;
		this.#resumePromise = undefined;
	}

	#formatAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		const ruleNames = rules.map(rule => rule.name).join(", ");
		return `TTSR matched ${label}: ${ruleNames}`;
	}

	/** Get TTSR injection payload and clear pending injections. */
	#getInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingInjections.length === 0) return undefined;
		const rules = this.#pendingInjections;
		const content = rules
			.map(r =>
				prompt.render(ttsrInterruptTemplate, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: r.content,
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
		const cwdRel =
			relativePathWithinRoot(this.#deps.sessionManager.getCwd(), rulePath) ??
			this.#displayPathWithinRoot(this.#deps.sessionManager.getCwd(), rulePath);
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
		// produces a result we can fold the reminder into.
		if (newlyAdded.length > 0) {
			this.#manager?.markInjectedByNames(newlyAdded);
		}
	}

	/** `afterToolCall` hook: fold any per-tool TTSR reminders into the result. */
	afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolInjections.delete(ctx.toolCall.id);
		const reminder = rules
			.map(r =>
				prompt.render(ttsrToolReminderTemplate, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: r.content,
				}),
			)
			.join("\n\n");
		// The TTSR manager was already claimed at bucket time; only persistence remains.
		const ruleNames = rules.map(r => r.name.trim()).filter(n => n.length > 0);
		if (ruleNames.length > 0) {
			this.#deps.sessionManager.appendTtsrInjection(ruleNames);
		}
		return {
			content: [{ type: "text", text: reminder }, ...ctx.result.content],
		};
	}

	#extractRuleNames(details: unknown): string[] {
		if (!details || typeof details !== "object" || Array.isArray(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	/** Mark the rules named in a persisted `ttsr-injection` custom message as injected. */
	markInjectedFromDetails(details: unknown): void {
		this.#markInjected(this.#extractRuleNames(details));
	}

	#markInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#manager?.markInjectedByNames(uniqueRuleNames);
		this.#deps.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.#deps.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") {
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

	queueDeferredInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			// Tools that hadn't started by abort/error will never produce results to
			// fold injections into — drop their stale per-tool entries.
			this.#perToolInjections.clear();
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
		this.#deps.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.ensureResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#deps.scheduleAgentContinue({
			delayMs: 1,
			generation: this.#deps.getPromptGeneration(),
			onSkip: () => {
				this.resolveResume();
			},
			shouldContinue: () => {
				if (this.#deps.agent.state.isStreaming || !this.#deps.agent.hasQueuedMessages()) {
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

	/**
	 * Check a `message_update` event's delta against TTSR rules. Returns true
	 * when the stream was aborted and the caller should stop processing the event.
	 */
	async handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): Promise<boolean> {
		if (!this.#manager?.hasRules()) return false;
		const assistantEvent = event.assistantMessageEvent;
		let matchContext: TtsrMatchContext | undefined;
		let streamingToolCall: ToolCall | undefined;

		if (assistantEvent.type === "text_delta") {
			matchContext = { source: "text" };
		} else if (assistantEvent.type === "thinking_delta") {
			matchContext = { source: "thinking" };
		} else if (assistantEvent.type === "toolcall_delta") {
			streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
			matchContext = this.#getToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
		}

		if (matchContext && "delta" in assistantEvent) {
			const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
			const matches = this.#checkStream(assistantEvent.delta, matchContext, streamingToolCall);
			if (matches.length > 0 && this.#handleMatches(matches, matchContext, targetMessageTimestamp)) {
				return true;
			}
			// ast-grep `astCondition` rules match against the reconstructed edit/write
			// snapshot, which only exists for tool argument streams. The native worker
			// call is async, so this path is awaited and self-throttled by the manager.
			if (matchContext.source === "tool" && this.#manager?.hasAstRules()) {
				const astMatches = await this.#checkAstStream(matchContext, streamingToolCall);
				if (astMatches.length > 0 && this.#handleMatches(astMatches, matchContext, targetMessageTimestamp)) {
					return true;
				}
			}
		}
		return false;
	}

	/** Extract the tool-call block a toolcall_delta event refers to, if present. */
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

		return block as ToolCall;
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
		const tools = this.#deps.agent.state.tools;
		const tool =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		const toolPaths = tool?.matcherPaths?.(args);
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
		const tool = this.#resolveTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	/**
	 * Per-file split of a streamed call (one entry per touched file paired with
	 * the digest of only that file's added lines). Lets {@link #checkStream}
	 * and {@link #checkAstStream} evaluate each file in isolation so a
	 * path-scoped rule like `tool:edit(*.ts)` never fires on text that belongs
	 * to a sibling Markdown hunk in a multi-file payload.
	 */
	#resolveMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const tool = this.#resolveTool(toolCall);
		const entries = tool?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTool(toolCall: ToolCall | undefined) {
		if (!toolCall) return undefined;
		const tools = this.#deps.agent.state.tools;
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
		matches: Rule[],
		matchContext: TtsrMatchContext,
		targetMessageTimestamp: number | undefined,
	): boolean {
		// Decide first: a non-interrupting tool-source match attaches to the
		// specific tool call's result instead of driving a loop-wide follow-up.
		const shouldInterrupt = this.#shouldInterruptForMatch(matches, matchContext);
		const matchedToolId = this.#extractToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolInjections(perToolId, matches);
			this.#deps.emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
			return false;
		}

		// Queue rules for injection; mark as injected only after successful enqueue.
		this.#addPendingInjections(matches);
		if (!shouldInterrupt) {
			return false;
		}

		// Abort the stream immediately — do not gate on extension callbacks
		this.#abortPending = true;
		this.ensureResumePromise();
		const abortReason = this.#formatAbortReason(matches);
		this.#deps.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);
		// Notify extensions (fire-and-forget, does not block abort)
		this.#deps.emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
		// Schedule retry after a short delay
		const retryToken = ++this.#retryToken;
		const generation = this.#deps.getPromptGeneration();
		this.#deps.schedulePostPromptTask(
			async () => {
				if (this.#retryToken !== retryToken) {
					this.resolveResume();
					return;
				}

				const targetAssistantIndex = this.#findAssistantIndex(targetMessageTimestamp);
				if (!this.#abortPending || this.#deps.getPromptGeneration() !== generation || targetAssistantIndex === -1) {
					this.#abortPending = false;
					this.#pendingInjections = [];
					this.#perToolInjections.clear();
					this.resolveResume();
					return;
				}
				this.#abortPending = false;
				this.#perToolInjections.clear();
				const ttsrSettings = this.#manager?.getSettings();
				if (ttsrSettings?.contextMode === "discard") {
					// Remove the partial/aborted assistant turn from agent state
					this.#deps.agent.replaceMessages(this.#deps.agent.state.messages.slice(0, targetAssistantIndex));
				}
				// Inject TTSR rules as system reminder before retry
				const injection = this.#getInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.#deps.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.#deps.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markInjected(details.rules);
				}
				try {
					await this.#deps.agent.continue();
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
		if (!args || typeof args !== "object" || Array.isArray(args)) {
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

		const cwd = this.#deps.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
}
