/**
 * Provider usage: what a session reports to the account ledger and reads back from it.
 *
 * This is a session collaborator. It reaches the credential store and the session only through
 * {@link ProviderUsageHost}, and holds no state of its own: the auto-redeem attempt ledger is the
 * process-wide coordinator, so concurrent sessions on one account share it.
 *
 * - Rate-limit headers of every provider response and the reported cost of an OpenCode Go turn are
 *   recorded against the credential the session routes under.
 * - Usage reports, the saved-reset list and a manual reset redeem resolve each provider's base URL
 *   the way requests do.
 * - A weekly Codex block that `codexResets.autoRedeem` permits spends one saved reset and retries,
 *   asking first when the policy is unset.
 */
import type {
	AssistantMessage,
	Model,
	OAuthAccountIdentity,
	ProviderResponseMetadata,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	UsageReport,
} from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { errorMessage, formatDuration, logger, withScopedTimeoutSignal } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import type { GroupTypeMap } from "../../config/settings-schema";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import {
	type CodexAutoRedeemCoordinator,
	type CodexAutoRedeemRedeemDecision,
	defaultCodexAutoRedeemCoordinator,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "../codex-auto-reset";

/** How long a saved-reset redeem runs before it is abandoned. */
export const CODEX_AUTO_REDEEM_TIMEOUT_MS = 15_000;

/** The notice source every auto-redeem notice is filed under. */
export const CODEX_AUTO_REDEEM_SOURCE = "codex-auto-reset";

/** The credential store slice usage reads and writes. `AuthStorage` satisfies this. */
export type ProviderUsageAuth = Pick<
	AuthStorage,
	| "ingestUsageHeaders"
	| "recordUsageCost"
	| "fetchUsageReports"
	| "redeemResetCredit"
	| "listResetCredits"
	| "getOAuthAccountIdentity"
>;

/** What {@link ProviderUsage} needs from the session that holds it. */
export interface ProviderUsageHost {
	/** Read at every call: the session can swap its model registry. */
	authStorage(): ProviderUsageAuth;
	providerBaseUrl(provider: string): string | undefined;
	readonly settings: Pick<Settings, "get" | "getGroup" | "set">;
	/** The provider session id requests route under. */
	sessionId(): string;
	/** The session id the agent last synced, which response headers are recorded under. */
	agentSessionId(): string | undefined;
	model(): Model | undefined;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	/** The prompt surface, when the session has one. */
	ui(): Pick<ExtensionUIContext, "select"> | undefined;
}

export class ProviderUsage {
	readonly #host: ProviderUsageHost;

	constructor(host: ProviderUsageHost) {
		this.#host = host;
	}

	/** Record a response's rate-limit headers. A provider with no header parser records nothing. */
	ingestHeaders(response: ProviderResponseMetadata, model: Model | undefined): void {
		const provider = model?.provider;
		if (!provider) return;
		const host = this.#host;
		host.authStorage().ingestUsageHeaders(provider, response.headers, {
			sessionId: host.agentSessionId(),
			baseUrl: host.providerBaseUrl(provider),
		});
	}

	/** Record the cost a provider reports per turn. Only OpenCode Go bills against a local ledger. */
	recordTurnCost(message: AssistantMessage): void {
		if (message.provider !== "opencode-go") return;
		const host = this.#host;
		host.authStorage().recordUsageCost(message.provider, message.usage.cost.total, {
			sessionId: host.sessionId(),
			recordedAt: message.timestamp,
			baseUrl: host.providerBaseUrl(message.provider),
		});
	}

	/** Usage reports for every stored credential. A synchronous failure rejects rather than throws. */
	async fetchReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const host = this.#host;
		const authStorage = host.authStorage();
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => {
				if (provider === "google-antigravity") {
					const mode = host.settings.get("providers.antigravityEndpoint");
					if (mode === "sandbox") return ANTIGRAVITY_SANDBOX_ENDPOINT;
					if (mode === "production") return ANTIGRAVITY_PRIMARY_ENDPOINT;
				}
				return host.providerBaseUrl(provider);
			},
			signal,
		});
	}

	async redeem(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		const host = this.#host;
		return host.authStorage().redeemResetCredit({
			target,
			baseUrlResolver: provider => host.providerBaseUrl(provider),
			signal,
		});
	}

	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		const host = this.#host;
		return host.authStorage().listResetCredits({
			sessionId: host.sessionId(),
			baseUrlResolver: provider => host.providerBaseUrl(provider),
			signal,
		});
	}

	/**
	 * The retry ladder's usage-limit hook. Returns `true` only when a saved Codex reset was spent, so
	 * the caller retries at once. `autoRedeem: "no"` skips the eligibility IO, `"unset"` asks before
	 * spending, and `"yes"` spends without asking. The coordinator's per-account in-flight map lets
	 * concurrent sessions adopt one redeem instead of spending two, and its attempt ledger keeps one
	 * block from being redeemed twice.
	 */
	async maybeAutoRedeemCodexReset(
		coordinator: CodexAutoRedeemCoordinator = defaultCodexAutoRedeemCoordinator,
	): Promise<boolean> {
		const host = this.#host;
		const cfg = host.settings.getGroup("codexResets");
		const model = host.model();
		// Cheap exits before any IO.
		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = host.authStorage();
		// Read before any await: a usage-limit block leaves the session credential sticky, so this is
		// the blocked account.
		const identity = authStorage.getOAuthAccountIdentity("openai-codex", host.sessionId());
		const accountKey = (identity?.accountId ?? identity?.email)?.trim().toLowerCase();
		if (!accountKey) return false;
		const existing = coordinator.inFlightByAccount.get(accountKey);
		if (existing) return existing;

		const run = this.#redeemBlockedAccount(coordinator, model, identity, accountKey, cfg).finally(() =>
			coordinator.inFlightByAccount.delete(accountKey),
		);
		coordinator.inFlightByAccount.set(accountKey, run);
		return run;
	}

	async #redeemBlockedAccount(
		coordinator: CodexAutoRedeemCoordinator,
		model: Model,
		identity: OAuthAccountIdentity | undefined,
		accountKey: string,
		cfg: GroupTypeMap["codexResets"],
	): Promise<boolean> {
		const host = this.#host;
		const reports = await this.fetchReports();
		const decision = evaluateCodexAutoRedeem({
			nowMs: Date.now(),
			provider: model.provider,
			modelId: model.id,
			settings: {
				autoRedeem: true,
				minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
				keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
			},
			identity,
			reports,
			attemptedBlockKeys: coordinator.attemptedBlockKeys,
			lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
		});
		if (!decision.redeem) {
			logger.debug("codex-auto-reset: skipped", { reason: decision.reason, account: accountKey });
			return false;
		}
		if (shouldPromptCodexAutoRedeem(cfg.autoRedeem) && !(await this.#confirm(decision))) return false;
		// The attempt is recorded before the redeem, so this block can never re-enter.
		coordinator.attemptedBlockKeys.add(decision.blockKey);
		coordinator.lastAttemptAtByAccount.set(decision.accountKey, Date.now());
		const who = decision.target.email ?? decision.target.accountId ?? "the active account";
		// The scoped deadline is cleared the moment the redeem settles. It is not tied to the retry's
		// abort controller: aborting a consume mid-flight leaves the credit state unknown.
		const outcome = await withScopedTimeoutSignal(CODEX_AUTO_REDEEM_TIMEOUT_MS, signal =>
			host.authStorage().redeemResetCredit({
				target: decision.target,
				baseUrlResolver: provider => host.providerBaseUrl(provider),
				signal,
			}),
		);
		switch (outcome.code) {
			case "reset": {
				const left = Math.max(0, decision.availableCount - 1);
				host.emitNotice(
					"info",
					`Auto-redeemed a saved Codex rate-limit reset for ${who} (${left} left); retrying now.`,
					CODEX_AUTO_REDEEM_SOURCE,
				);
				// Refreshed so the status line stops showing the spent window, and not awaited: this is a
				// network call on a rate-limit recovery path, and a failed refresh reaching postmortem
				// would end the session the redeem recovered.
				this.fetchReports().catch(error => {
					logger.debug("codex-auto-reset: usage refresh after redeem failed", { error: errorMessage(error) });
				});
				return true;
			}
			case "already_redeemed":
				host.emitNotice(
					"warning",
					"A saved Codex reset was already redeemed elsewhere; waiting for the window.",
					CODEX_AUTO_REDEEM_SOURCE,
				);
				return false;
			case "no_credit":
				logger.debug("codex-auto-reset: no_credit (snapshot/live mismatch)", { account: accountKey });
				return false;
			case "nothing_to_reset":
				host.emitNotice(
					"warning",
					"Codex reset reported nothing to reset; auto-redeem suppressed for this window.",
					CODEX_AUTO_REDEEM_SOURCE,
				);
				return false;
			default:
				host.emitNotice("warning", `Codex auto-redeem failed (${outcome.code}).`, CODEX_AUTO_REDEEM_SOURCE);
				return false;
		}
	}

	/** Ask whether to spend a saved reset, recording a Yes or No as the policy for later blocks. */
	async #confirm(decision: CodexAutoRedeemRedeemDecision): Promise<boolean> {
		const host = this.#host;
		const ui = host.ui();
		if (!ui) {
			host.emitNotice(
				"warning",
				"Codex saved reset is eligible, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.",
				CODEX_AUTO_REDEEM_SOURCE,
			);
			return false;
		}
		const who = decision.target.email ?? decision.target.accountId ?? "the active account";
		const resetLabel = decision.availableCount === 1 ? "reset" : "resets";
		try {
			const choice = await ui.select(
				`Do you wanna redeem your reset?\n${who} is blocked by the weekly Codex limit for about ${formatDuration(decision.remainingMs)}. Spend 1 of ${decision.availableCount} saved ${resetLabel}?`,
				[
					{ label: "Yes", description: "Redeem now and remember yes for future eligible Codex weekly blocks." },
					{ label: "No", description: "Do not auto-redeem saved Codex resets." },
				],
			);
			if (choice === "Yes") {
				host.settings.set("codexResets.autoRedeem", "yes");
				return true;
			}
			if (choice === "No") host.settings.set("codexResets.autoRedeem", "no");
		} catch (error) {
			logger.warn("codex-auto-reset prompt failed", { error: errorMessage(error) });
		}
		return false;
	}
}
