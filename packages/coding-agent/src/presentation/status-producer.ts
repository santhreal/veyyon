/**
 * `StatusPresentationProducer`: extracts and produces status display data and
 * capabilities from an `AgentSession` for host-neutral status presentation.
 *
 * All session, account, usage, message scanning, and active-time accounting
 * policy is encapsulated here so that status renderers (terminal, web, etc.)
 * receive clean value snapshots and explicit capabilities without coupling
 * to the agent runtime.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { UsageLimit, UsageReport } from "@veyyon/ai";
import type { OAuthAccountIdentity } from "@veyyon/ai/auth-storage";
import type {
	SessionFacts,
	StatusCapabilities,
	StatusContextBreakdown,
	StatusDataSource,
	StatusGoalFact,
	StatusLineState,
	StatusModelFact,
	StatusProviderUsage,
	StatusRunClock,
	StatusServingAccount,
	StatusUsageStats,
} from "@veyyon/wire/presentation";
import { resolveContextLimit } from "../config/compaction-strategy";
import { settings } from "../config/settings-instance";
import { recordRestLaunchFacts } from "../modes/launch-facts";
import { accountDisplayLabel, accountsForProvider, buildAccountInventory } from "../session/account-inventory";
import type { AgentSession } from "../session/agent-session";
import { computeNonMessageBreakdown } from "../session/non-message-tokens";
import { limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { calculateTokensPerSecond } from "./token-rate";
/**
 * Allocation-free structural size of a tool call's arguments.
 */
export function structuralTextSize(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean" || value === null || value === undefined) return 1;
	if (Array.isArray(value)) {
		let sum = 2;
		for (const item of value) sum += 1 + structuralTextSize(item);
		return sum;
	}
	if (typeof value === "object") {
		let sum = 2;
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			sum += key.length + 1 + structuralTextSize(obj[key]);
		}
		return sum;
	}
	return 1;
}

/**
 * Cheap structural fingerprint of a message's tokenizable content. O(blocks) —
 * only reads string `.length` and primitives, never copies or serializes.
 */
export function messageFingerprint(msg: AgentMessage): string {
	if (!msg || typeof msg !== "object") return "";
	const role = msg.role;
	if (!role) return "";
	const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (msg.role === "bashExecution") {
		const cmdLen = typeof msg.command === "string" ? msg.command.length : 0;
		const outLen = typeof msg.output === "string" ? msg.output.length : 0;
		return `bash:${cmdLen}:${outLen}`;
	} else if (msg.role === "user") {
		const content = msg.content;
		if (typeof content === "string") {
			textLen += content.length;
			return ts ? `${role}:${ts}:${textLen}` : `${role}:${textLen}`;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
					textLen += block.text.length;
				}
			}
			return ts ? `${role}:${ts}:${textLen}:${blocks}` : `${role}:${textLen}:${blocks}`;
		}
	} else if (msg.role === "assistant") {
		const assistantMsg = msg;
		const usage = assistantMsg.usage;
		const usageExt = usage && typeof usage === "object" && "promptTokensDetails" in usage ? 1 : 0;
		const usageTotal = typeof assistantMsg.usage?.totalTokens === "number" ? assistantMsg.usage.totalTokens : 0;
		const stopReason = typeof assistantMsg.stopReason === "string" ? assistantMsg.stopReason : "";

		let signatureLen = 0;
		let redactedLen = 0;
		const msgExt = assistantMsg as unknown as {
			thinkingSignature?: string;
			textSignature?: string;
			thoughtSignature?: string;
			redactedThinking?: { data?: string };
		};
		if (typeof msgExt.thinkingSignature === "string") signatureLen += msgExt.thinkingSignature.length;
		if (typeof msgExt.textSignature === "string") signatureLen += msgExt.textSignature.length;
		if (typeof msgExt.thoughtSignature === "string") signatureLen += msgExt.thoughtSignature.length;
		const redactedData = msgExt.redactedThinking?.data;
		if (typeof redactedData === "string") redactedLen += redactedData.length;

		const content = assistantMsg.content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string") {
					textLen += block.text.length;
				} else if (block.type === "thinking") {
					if (typeof block.thinking === "string") textLen += block.thinking.length;
					if (typeof block.thinkingSignature === "string") signatureLen += block.thinkingSignature.length;
					const bExt = block as unknown as {
						signature?: string;
						textSignature?: string;
						thoughtSignature?: string;
					};
					if (typeof bExt.signature === "string") signatureLen += bExt.signature.length;
					if (typeof bExt.textSignature === "string") signatureLen += bExt.textSignature.length;
					if (typeof bExt.thoughtSignature === "string") signatureLen += bExt.thoughtSignature.length;
				} else if (block.type === "redactedThinking" && typeof block.data === "string") {
					redactedLen += block.data.length;
				} else if (block.type === "toolCall") {
					if (typeof block.name === "string") textLen += block.name.length;
					if (block.arguments !== undefined) {
						textLen += structuralTextSize(block.arguments);
					}
				}
			}
		}
		return `${role}:${ts}:${textLen}:${blocks}:${images}:${signatureLen}:${redactedLen}:${usageTotal}:${usageExt}:${stopReason}`;
	} else if (msg.role === "toolResult" || msg.role === "hookMessage") {
		const content = msg.content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text" && typeof block.text === "string") textLen += block.text.length;
				else if (block.type === "image") images++;
			}
		}
	} else if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
		const summary = msg.summary;
		if (typeof summary === "string") textLen += summary.length;
		return `${role}:${textLen}`;
	}
	return ts ? `${role}:${ts}:${textLen}:${blocks}:${images}` : `${role}:${textLen}:${blocks}:${images}`;
}

interface ContextUsageMemo {
	messagesRef: readonly AgentMessage[];
	length: number;
	lastFingerprint: string | undefined;
	modelContextWindow: number;
	contextUsageRevision: number;
	usedTokens: number | null;
	contextWindow: number;
	systemPromptRef: readonly string[] | undefined;
	toolsRef: readonly unknown[] | undefined;
	skillsRef: readonly unknown[] | undefined;
}

interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
	lastRunMs: number;
	sessionFile: string | undefined;
}

export function normalizeUsageReports(
	reports: unknown,
	activeProvider?: string,
	activeIdentity?: OAuthAccountIdentity,
): StatusProviderUsage | null {
	if (!Array.isArray(reports)) return null;
	let fiveHour: { percent: number; resetMinutes?: number } | undefined;
	let sevenDay: { percent: number; resetHours?: number } | undefined;
	let fiveHourTier: string | undefined;
	let sevenDayTier: string | undefined;
	const now = Date.now();
	for (const report of reports) {
		if (!report || typeof report !== "object") continue;
		const reportObj = report as Record<string, unknown>;
		const provider = reportObj.provider;
		if (activeProvider && provider !== activeProvider) continue;
		const limits = reportObj.limits;
		if (!Array.isArray(limits)) continue;
		for (const limit of limits) {
			if (!limit || typeof limit !== "object") continue;
			const limitObj = limit as Record<string, unknown>;
			if (activeIdentity && !limitMatchesActiveAccount(report as UsageReport, limit as UsageLimit, activeIdentity)) {
				continue;
			}
			const scope =
				limitObj.scope && typeof limitObj.scope === "object"
					? (limitObj.scope as Record<string, unknown>)
					: undefined;
			const window =
				limitObj.window && typeof limitObj.window === "object"
					? (limitObj.window as Record<string, unknown>)
					: undefined;
			const amount =
				limitObj.amount && typeof limitObj.amount === "object"
					? (limitObj.amount as Record<string, unknown>)
					: undefined;

			const fraction = typeof amount?.usedFraction === "number" ? amount.usedFraction : undefined;
			if (fraction === undefined) continue;

			const windowId = typeof scope?.windowId === "string" ? scope.windowId : undefined;
			const tier = typeof scope?.tier === "string" ? scope.tier : undefined;
			const resetsAt = typeof window?.resetsAt === "number" ? window.resetsAt : undefined;

			if (windowId === "5h" && (!fiveHour || (fiveHourTier !== undefined && !tier))) {
				fiveHour = {
					percent: fraction * 100,
					resetMinutes:
						typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 60_000)) : undefined,
				};
				fiveHourTier = tier || undefined;
			}
			if (windowId === "7d" && (!sevenDay || (sevenDayTier !== undefined && !tier))) {
				sevenDay = {
					percent: fraction * 100,
					resetHours:
						typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 3_600_000)) : undefined,
				};
				sevenDayTier = tier || undefined;
			}
		}
	}
	if (!fiveHour && !sevenDay) return null;
	const effectiveTier = fiveHourTier ?? sevenDayTier;
	return { tier: effectiveTier, fiveHour, sevenDay };
}

export class StatusPresentationProducer implements StatusDataSource {
	#session: AgentSession;
	#focusedAgentId: string | undefined;
	#activeMeters: WeakMap<AgentSession, ActiveMeter> = new WeakMap();
	#revision = 0;
	#autoCompactEnabled = true;
	#contextUsageCache: ContextUsageMemo | undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondTimestamp: number | null = null;
	#cachedServingAccount: {
		key: string;
		value: StatusServingAccount | null;
	} | null = null;
	readonly capabilities: StatusCapabilities;

	constructor(session: AgentSession, focusedAgentId?: string) {
		this.#session = session;
		this.#focusedAgentId = focusedAgentId;

		this.capabilities = {
			getUsageContextKey: () => this.getUsageContextKey(),
			fetchUsage: signal => this.fetchUsage(signal),
			recordLaunchFacts: (contextPercent, contextLimit) => this.recordLaunchFacts(contextPercent, contextLimit),
			setFocusedAgentId: focusedAgentId => this.setFocusedAgentId(focusedAgentId),
		};
	}

	get session(): AgentSession {
		return this.#session;
	}

	setSession(session: AgentSession, focusedAgentId?: string): void {
		const sessionChanged = this.#session !== session;
		if (!sessionChanged && this.#focusedAgentId === focusedAgentId) return;
		this.#session = session;
		this.#focusedAgentId = focusedAgentId;
		this.#revision++;
		if (sessionChanged) {
			this.#contextUsageCache = undefined;
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			this.#cachedServingAccount = null;
			this.#closeStaleActiveWindow();
		}
	}
	setFocusedAgentId(focusedAgentId?: string | null): void {
		this.#focusedAgentId = focusedAgentId ?? undefined;
	}

	getRevision(): number {
		return this.#revision;
	}

	#closeStaleActiveWindow(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		if (this.#session.isStreaming) return;
		meter.activeStartedAt = null;
	}

	#meter(): ActiveMeter {
		const currentFile = this.#session.sessionFile;
		let meter = this.#activeMeters.get(this.#session);
		if (meter) {
			const switched =
				currentFile !== undefined && meter.sessionFile !== undefined && meter.sessionFile !== currentFile;
			if (switched) {
				meter = undefined;
			} else {
				meter.sessionFile = currentFile;
			}
		}
		if (!meter) {
			meter = { activeMs: 0, activeStartedAt: null, lastRunMs: 0, sessionFile: currentFile };
			this.#activeMeters.set(this.#session, meter);
		}
		return meter;
	}

	resetActiveTime(): void {
		const meter = this.#meter();
		meter.activeMs = 0;
		meter.activeStartedAt = null;
		meter.lastRunMs = 0;
	}

	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt !== null) return;
		meter.activeStartedAt = Date.now();
	}

	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		const windowMs = Math.max(0, Date.now() - meter.activeStartedAt);
		meter.activeMs += windowMs;
		meter.lastRunMs = windowMs;
		meter.activeStartedAt = null;
	}

	getRunClock(): StatusRunClock {
		const meter = this.#meter();
		return {
			runningMs: meter.activeStartedAt === null ? null : Math.max(0, Date.now() - meter.activeStartedAt),
			lastRunMs: meter.lastRunMs,
		};
	}

	getActiveMs(): number {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return meter.activeMs;
		return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}
	factsFromSession(session: AgentSession): SessionFacts {
		const state = session.state;
		const model = state?.model ?? session.model;
		const sessionManager = session.sessionManager;
		const modelFact: StatusModelFact | null = model
			? { id: model.id, name: model.name ?? "", supportsThinking: Boolean(model.thinking) }
			: null;

		return {
			model: modelFact,
			thinkingLevel: (state?.thinkingLevel as string) ?? ThinkingLevel.Off,
			autoThinking: session.isAutoThinking ? { resolved: session.autoResolvedThinkingLevel() ?? null } : null,
			advisorActive: typeof session.isAdvisorActive === "function" ? session.isAdvisorActive() : false,
			fastMode: typeof session.isFastModeActive === "function" ? session.isFastModeActive() : false,
			subscription: model && session.modelRegistry ? session.modelRegistry.isUsingOAuth(model) : false,
			streaming: session.isStreaming ?? false,
			approvalMode: session.effectiveApprovalMode?.(),
			approvalBypassed: typeof session.isApprovalBypassed === "function" ? session.isApprovalBypassed() : false,
			cwd: sessionManager?.getCwd?.() ?? null,
			sessionId: sessionManager?.getSessionId?.() ?? null,
			sessionName: sessionManager?.getSessionName?.() ?? null,
			goal: (() => {
				const rawGoal = typeof session.getGoalModeState === "function" ? session.getGoalModeState()?.goal : null;
				if (!rawGoal) return null;
				const goalFact: StatusGoalFact = {
					status: rawGoal.status,
					tokensUsed: rawGoal.tokensUsed,
					tokenBudget: rawGoal.tokenBudget,
					objective: rawGoal.objective,
					description: rawGoal.objective,
				};
				return goalFact;
			})(),
			goalModelBudgets: session.settings?.get?.("goal.modelBudgetsEnabled") === true,
			goalVerbose: session.settings?.get?.("goal.statusInFooter") === true,
		};
	}

	getContextBreakdown(session: AgentSession, autoCompactEnabled: boolean): StatusContextBreakdown {
		const messages = session.messages ?? [];
		const modelContextWindow = session.model?.contextWindow ?? session.state?.model?.contextWindow ?? 0;
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
		const contextUsageRevision = session.contextUsageRevision ?? 0;
		const systemPrompt = session.systemPrompt;
		const tools = session.agent?.state?.tools;
		const skills = session.skills;

		let usedTokens: number | null = null;
		let contextWindow = modelContextWindow;

		const cache = this.#contextUsageCache;
		if (
			cache &&
			cache.messagesRef === messages &&
			cache.length === length &&
			cache.lastFingerprint === lastFingerprint &&
			cache.modelContextWindow === modelContextWindow &&
			cache.contextUsageRevision === contextUsageRevision &&
			cache.systemPromptRef === systemPrompt &&
			cache.toolsRef === tools &&
			cache.skillsRef === skills
		) {
			usedTokens = cache.usedTokens;
			contextWindow = cache.contextWindow;
		} else {
			const usage = typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined;
			usedTokens = usage?.tokens ?? null;
			contextWindow = usage?.contextWindow ?? modelContextWindow;
			this.#contextUsageCache = {
				messagesRef: messages,
				length,
				lastFingerprint,
				modelContextWindow,
				contextUsageRevision,
				usedTokens,
				contextWindow,
				systemPromptRef: systemPrompt,
				toolsRef: tools,
				skillsRef: skills,
			};
		}

		let contextLimit = contextWindow;
		let contextLimitKind: "window" | "compaction" = "window";
		if (autoCompactEnabled && session.settings) {
			const compactionSettings = session.settings.getGroup?.("compaction");
			if (compactionSettings) {
				const limit = resolveContextLimit(contextWindow, compactionSettings);
				contextLimit = limit.tokens;
				contextLimitKind = limit.kind;
			}
		}

		const contextPercent = usedTokens === null ? null : contextLimit > 0 ? (usedTokens / contextLimit) * 100 : null;

		return { usedTokens, contextWindow, contextLimit, contextLimitKind, contextPercent };
	}

	getTokensPerSecond(session: AgentSession): number | null {
		const messages = session.state?.messages ?? session.messages ?? [];
		let lastAssistantTimestamp: number | null = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (
				message &&
				typeof message === "object" &&
				"role" in message &&
				message.role === "assistant" &&
				"timestamp" in message &&
				typeof message.timestamp === "number"
			) {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(messages, session.isStreaming ?? false);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	getUsageStats(session: AgentSession): StatusUsageStats {
		const aggregate = session.sessionManager?.getUsageStatistics?.() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
		};
		return {
			...aggregate,
			tokensPerSecond: this.getTokensPerSecond(session),
		};
	}

	getServingAccount(session: AgentSession): StatusServingAccount | null {
		if (!settings.get("statusLine.showAccount")) return null;
		const activeProvider = session.state?.model?.provider ?? session.model?.provider;
		const authStorage = session.modelRegistry?.authStorage;
		if (!activeProvider || !authStorage) return null;
		const stored = authStorage.listStoredCredentials(activeProvider);
		if (stored.length === 0) return null;
		const routing = authStorage.sessionCredentialRouting(activeProvider, session.sessionId);
		const servingId = routing?.activeCredentialId ?? routing?.selectedCredentialId ?? stored[0]?.id;
		if (servingId === undefined) return null;
		const key = [
			activeProvider,
			servingId,
			stored.length,
			authStorage.getAccountName(activeProvider, servingId) ?? "",
			routing?.activeIsPrediction === true ? "next" : "serving",
		].join("\0");
		if (this.#cachedServingAccount?.key === key) return this.#cachedServingAccount.value;
		const rows = accountsForProvider(
			buildAccountInventory(authStorage, { sessionId: session.sessionId }),
			activeProvider,
		);
		const serving = rows.find(row => row.credentialId === servingId) ?? rows[0];
		const value: StatusServingAccount | null = serving
			? {
					label: accountDisplayLabel(serving),
					storedCount: rows.length,
					isPrediction: Boolean(serving.activeForSession && serving.activeIsPrediction),
				}
			: null;
		this.#cachedServingAccount = { key, value };
		return value;
	}

	getBackgroundJobCount(session: AgentSession): number {
		const running = session.getAsyncJobSnapshot?.()?.running;
		if (!running || !Array.isArray(running)) return 0;
		return running.reduce(
			(count, job) => (job && typeof job === "object" && "type" in job && job.type === "task" ? count : count + 1),
			0,
		);
	}

	getUsageContextKey(): string {
		const session = this.#session as unknown as Record<string, unknown>;
		const stateModel = (session.state as { model?: { provider?: string } } | undefined)?.model;
		const model = session.model as { provider?: string } | undefined;
		const activeProvider =
			stateModel?.provider ??
			model?.provider ??
			(session.session as AgentSession | undefined)?.state?.model?.provider ??
			"";
		if (!activeProvider) return "";
		const modelRegistry =
			(session.modelRegistry as AgentSession["modelRegistry"] | undefined) ??
			(session.session as AgentSession | undefined)?.modelRegistry;
		const authStorage = modelRegistry?.authStorage;
		const identity = authStorage?.getOAuthAccountIdentity?.(activeProvider, session.sessionId as string | undefined);
		return [
			activeProvider,
			identity?.accountId ?? "",
			identity?.email ?? "",
			identity?.projectId ?? "",
			identity?.orgId ?? "",
		].join("\0");
	}

	async fetchUsage(signal: AbortSignal): Promise<StatusProviderUsage | null> {
		const session = this.#session as unknown as Record<string, unknown>;
		const fetcher =
			typeof session.fetchUsageReports === "function"
				? (session.fetchUsageReports as (signal?: AbortSignal) => Promise<unknown>)
				: typeof (session.session as Record<string, unknown> | undefined)?.fetchUsageReports === "function"
					? ((session.session as Record<string, unknown>).fetchUsageReports as (
							signal?: AbortSignal,
						) => Promise<unknown>)
					: undefined;
		if (!fetcher) return null;
		const stateModel = (session.state as { model?: { provider?: string } } | undefined)?.model;
		const model = session.model as { provider?: string } | undefined;
		const activeProvider =
			stateModel?.provider ??
			model?.provider ??
			(session.session as AgentSession | undefined)?.state?.model?.provider;
		const modelRegistry =
			(session.modelRegistry as AgentSession["modelRegistry"] | undefined) ??
			(session.session as AgentSession | undefined)?.modelRegistry;
		const authStorage = modelRegistry?.authStorage;
		const activeIdentity =
			activeProvider && authStorage
				? authStorage.getOAuthAccountIdentity?.(activeProvider, session.sessionId as string | undefined)
				: undefined;
		const reports = await fetcher.call(session, signal);
		return normalizeUsageReports(reports, activeProvider, activeIdentity);
	}

	recordLaunchFacts(contextPercent: number | null, contextLimit: number): void {
		void recordRestLaunchFacts(
			{
				model: this.#session.state?.model ?? this.#session.model,
				thinkingLevel: this.#session.state?.thinkingLevel ?? null,
				isAutoThinking: this.#session.isAutoThinking,
				messageCount: this.#session.messages?.length ?? 0,
				systemContextTokens: computeNonMessageBreakdown(this.#session).systemContextTokens,
			},
			contextPercent,
			contextLimit,
		);
	}

	getSnapshot(): StatusLineState {
		const self = this;
		let cachedContext: StatusContextBreakdown | undefined;
		return {
			facts: this.factsFromSession(this.#session),
			focusedAgentId: this.#focusedAgentId,
			sessionRevision: this.#revision,
			planMode: null,
			loopMode: null,
			prewalk:
				typeof this.#session.getPrewalkState === "function" && this.#session.getPrewalkState()
					? { enabled: true }
					: null,
			goalMode: null,
			vibeMode: null,
			collab: null,
			usageStats: this.getUsageStats(this.#session),
			get context(): StatusContextBreakdown {
				if (!cachedContext) {
					cachedContext = self.getContextBreakdown(self.#session, self.#autoCompactEnabled);
				}
				return cachedContext;
			},
			account: this.getServingAccount(this.#session),
			backgroundJobCount: this.getBackgroundJobCount(this.#session),
			activeMs: this.getActiveMs(),
			runClock: this.getRunClock(),
		};
	}
}
