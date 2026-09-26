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
import type { AssistantMessage, UsageLimit, UsageReport } from "@veyyon/ai";
import type { OAuthAccountIdentity } from "@veyyon/ai/auth-storage";
import { asRecord } from "@veyyon/utils/type-guards";
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
import { measureContextGauge } from "../config/compaction-strategy";
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

/** Length of `value` when it is a string, 0 otherwise. */
function stringLength(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
}

/** `role:ts:rest`, or `role:rest` when the message carries no timestamp. */
function stampedFingerprint(role: string, ts: number, rest: string): string {
	return ts ? `${role}:${ts}:${rest}` : `${role}:${rest}`;
}

/** The block fields a user or tool-result fingerprint reads. */
interface FingerprintBlock {
	readonly type?: unknown;
	readonly text?: unknown;
}

type FingerprintContent = string | readonly FingerprintBlock[] | undefined;

/** Signature fields a provider may attach to an assistant message or a thinking block. */
interface SignatureCarrier {
	readonly thinkingSignature?: unknown;
	readonly textSignature?: unknown;
	readonly thoughtSignature?: unknown;
}

function signatureLength(carrier: SignatureCarrier): number {
	return (
		stringLength(carrier.thinkingSignature) +
		stringLength(carrier.textSignature) +
		stringLength(carrier.thoughtSignature)
	);
}

function userFingerprint(content: FingerprintContent, ts: number): string {
	if (typeof content === "string") return stampedFingerprint("user", ts, `${content.length}`);
	if (!Array.isArray(content)) return stampedFingerprint("user", ts, "0:0:0");
	let textLen = 0;
	for (const block of content) {
		if (block && typeof block === "object" && block.type === "text") textLen += stringLength(block.text);
	}
	return stampedFingerprint("user", ts, `${textLen}:${content.length}`);
}

function contentFingerprint(role: string, content: FingerprintContent, ts: number): string {
	if (typeof content === "string") return stampedFingerprint(role, ts, `${content.length}:0:0`);
	if (!Array.isArray(content)) return stampedFingerprint(role, ts, "0:0:0");
	let textLen = 0;
	let images = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") textLen += stringLength(block.text);
		else if (block.type === "image") images++;
	}
	return stampedFingerprint(role, ts, `${textLen}:${content.length}:${images}`);
}

function assistantFingerprint(msg: AssistantMessage, ts: number): string {
	const usage = msg.usage;
	const usageExt = usage && typeof usage === "object" && "promptTokensDetails" in usage ? 1 : 0;
	const usageTotal = typeof usage?.totalTokens === "number" ? usage.totalTokens : 0;
	const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
	const msgExt = msg as unknown as SignatureCarrier & { redactedThinking?: { data?: unknown } };
	let signatureLen = signatureLength(msgExt);
	let redactedLen = stringLength(msgExt.redactedThinking?.data);
	let textLen = 0;
	const content = msg.content;
	const blocks = Array.isArray(content) ? content.length : 0;
	for (let i = 0; i < blocks; i++) {
		const block = content[i];
		if (!block || typeof block !== "object") continue;
		switch (block.type) {
			case "text":
				textLen += stringLength(block.text);
				break;
			case "thinking":
				textLen += stringLength(block.thinking);
				signatureLen +=
					signatureLength(block) + stringLength((block as unknown as { signature?: unknown }).signature);
				break;
			case "redactedThinking":
				redactedLen += stringLength(block.data);
				break;
			case "toolCall":
				textLen += stringLength(block.name);
				if (block.arguments !== undefined) textLen += structuralTextSize(block.arguments);
				break;
		}
	}
	return `assistant:${ts}:${textLen}:${blocks}:0:${signatureLen}:${redactedLen}:${usageTotal}:${usageExt}:${stopReason}`;
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
	switch (msg.role) {
		case "bashExecution":
			return `bash:${stringLength(msg.command)}:${stringLength(msg.output)}`;
		case "user":
			return userFingerprint(msg.content, ts);
		case "assistant":
			return assistantFingerprint(msg, ts);
		case "toolResult":
		case "hookMessage":
			return contentFingerprint(role, msg.content, ts);
		case "branchSummary":
		case "compactionSummary":
			return `${role}:${stringLength(msg.summary)}`;
		default:
			return stampedFingerprint(role, ts, "0:0:0");
	}
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

/** One 5h or 7d usage window read out of a provider usage report. */
interface UsageWindowReading {
	readonly windowId: "5h" | "7d";
	readonly fraction: number;
	readonly resetsAt: number | undefined;
	readonly tier: string | undefined;
}

function readUsageWindow(
	report: UsageReport,
	limit: unknown,
	activeIdentity: OAuthAccountIdentity | undefined,
): UsageWindowReading | null {
	const limitObj = asRecord(limit);
	if (!limitObj) return null;
	if (activeIdentity && !limitMatchesActiveAccount(report, limit as UsageLimit, activeIdentity)) return null;
	const fraction = asRecord(limitObj.amount)?.usedFraction;
	if (typeof fraction !== "number") return null;
	const scope = asRecord(limitObj.scope);
	const windowId = scope?.windowId;
	if (windowId !== "5h" && windowId !== "7d") return null;
	const tier = typeof scope?.tier === "string" && scope.tier !== "" ? scope.tier : undefined;
	const resetsAt = asRecord(limitObj.window)?.resetsAt;
	return { windowId, fraction, resetsAt: typeof resetsAt === "number" ? resetsAt : undefined, tier };
}

/** The first reading of a window wins, except that a tierless (whole-account) reading replaces a tier-scoped one. */
function replacesReading(current: UsageWindowReading | undefined, next: UsageWindowReading): boolean {
	return !current || (current.tier !== undefined && next.tier === undefined);
}

function resetIn(resetsAt: number | undefined, now: number, unitMs: number): number | undefined {
	return resetsAt === undefined ? undefined : Math.max(0, Math.round((resetsAt - now) / unitMs));
}

type UsageWindowPicks = { [K in UsageWindowReading["windowId"]]?: UsageWindowReading };

/** The limits of `report`, or null when it is malformed or belongs to another provider. */
function reportLimits(report: unknown, activeProvider: string | undefined): readonly unknown[] | null {
	const reportObj = asRecord(report);
	if (!reportObj) return null;
	if (activeProvider && reportObj.provider !== activeProvider) return null;
	return Array.isArray(reportObj.limits) ? reportObj.limits : null;
}

function toProviderUsage(picks: UsageWindowPicks): StatusProviderUsage | null {
	const fiveHour = picks["5h"];
	const sevenDay = picks["7d"];
	if (!fiveHour && !sevenDay) return null;
	const now = Date.now();
	return {
		tier: fiveHour?.tier ?? sevenDay?.tier,
		fiveHour: fiveHour && { percent: fiveHour.fraction * 100, resetMinutes: resetIn(fiveHour.resetsAt, now, 60_000) },
		sevenDay: sevenDay && {
			percent: sevenDay.fraction * 100,
			resetHours: resetIn(sevenDay.resetsAt, now, 3_600_000),
		},
	};
}

export function normalizeUsageReports(
	reports: unknown,
	activeProvider?: string,
	activeIdentity?: OAuthAccountIdentity,
): StatusProviderUsage | null {
	if (!Array.isArray(reports)) return null;
	const picks: UsageWindowPicks = {};
	for (const report of reports) {
		const limits = reportLimits(report, activeProvider);
		if (!limits) continue;
		for (const limit of limits) {
			const reading = readUsageWindow(report as UsageReport, limit, activeIdentity);
			if (reading && replacesReading(picks[reading.windowId], reading)) picks[reading.windowId] = reading;
		}
	}
	return toProviderUsage(picks);
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

	/** The memoized context usage, recomputed only when an input the estimate reads has changed. */
	#contextUsage(session: AgentSession, modelContextWindow: number): ContextUsageMemo {
		const messages = session.messages ?? [];
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
		const contextUsageRevision = session.contextUsageRevision ?? 0;
		const systemPrompt = session.systemPrompt;
		const tools = session.agent?.state?.tools;
		const skills = session.skills;
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
			return cache;
		}
		const usage = typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined;
		const memo: ContextUsageMemo = {
			messagesRef: messages,
			length,
			lastFingerprint,
			modelContextWindow,
			contextUsageRevision,
			usedTokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? modelContextWindow,
			systemPromptRef: systemPrompt,
			toolsRef: tools,
			skillsRef: skills,
		};
		this.#contextUsageCache = memo;
		return memo;
	}

	getContextBreakdown(session: AgentSession, autoCompactEnabled: boolean): StatusContextBreakdown {
		const modelContextWindow = session.model?.contextWindow ?? session.state?.model?.contextWindow ?? 0;
		const { usedTokens, contextWindow } = this.#contextUsage(session, modelContextWindow);
		const compactionSettings = autoCompactEnabled ? session.settings?.getGroup?.("compaction") : undefined;
		return measureContextGauge(usedTokens, contextWindow, compactionSettings);
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
