import {
	bareModelId,
	getBundledModelReferenceIndex,
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGemmaModelId,
	isGrokReasoningEffortCapable,
	isKimiK26ModelId,
	isKimiModelId,
	isMimoModelIdOrName,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	isOpenAIGptOssModelId,
	isOpenAIModelId,
	isOpenAIOSeriesModelId,
	isQwenModelId,
	parseGlmModel,
	parseKnownModel,
	resolveModelReference,
} from "@veyyon/catalog/identity";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";

/**
 * Deciding, before a single container starts, whether the staged credential
 * store can actually serve a token.
 *
 * WHY THIS EXISTS. The bench copies the operator's `agent.db` into
 * `assets/auth-agent.db` and mounts it into every task container. Nothing
 * checked that the copy still works, so a dead credential was discovered one
 * container at a time: each trial paid full setup, failed to authenticate, and
 * reported a task failure. Worse, the message the agent produced blamed the
 * model id rather than the credential (BACKLOG AUTH-FAILURE-BLAMES-MODEL-ID), so
 * a burned 40-trial run was misdiagnosed as an unservable model and led to an
 * allowlist gate against a model that worked fine.
 *
 * `AuthStorage.checkCredentials` already does the real probe: OAuth
 * refresh-on-expiry followed by the provider's auth-verifying endpoint, per
 * credential, without swallowing errors. This module is the decision made from
 * its results, kept pure so the reasoning is testable without a network or a
 * SQLite file.
 *
 * The three outcomes are deliberately distinct, because collapsing them is how
 * the original failure stayed invisible. "No credential works" and "no credential
 * could be checked" are not the same claim, and neither may be reported as
 * success.
 */

/**
 * One usage pool a provider meters separately, as reported by its usage probe.
 *
 * The nesting is the provider's, not a choice made here, and it is spelled out
 * because getting it wrong is silent. A first version of this read `limit.resetsAt`
 * and `probe.limits`, which type-checked against hand-written fixtures and matched
 * NOTHING on real data, so the check quietly never fired. The shapes below are
 * copied from a live `checkCredentials()` result.
 */
export interface CredentialLimit {
	/** Provider-scoped pool id, e.g. `google-antigravity:google:default:daily`. */
	readonly id: string;
	/** `exhausted` means this pool is spent; anything else is usable. */
	readonly status?: string;
	/** The metering window, whose `resetsAt` is epoch milliseconds. */
	readonly window?: { readonly resetsAt?: number };
}

/** The subset of `CredentialHealthResult` this decision reads. */
export interface CredentialProbe {
	readonly provider: string;
	/** `true` served a token, `false` failed, `null` no probe is configured. */
	readonly ok: boolean | null;
	/** Why it failed; present when `ok === false`. */
	readonly reason?: string;
	/** OAuth identity, used only to make the operator's message specific. */
	readonly email?: string;
	/** The usage probe's result. Absent when the provider has no usage probe. */
	readonly report?: { readonly limits?: readonly CredentialLimit[] };
}

export type AuthPreflightVerdict =
	/** At least one credential served a token. Proceed. */
	| { readonly kind: "ok"; readonly usable: number }
	/** The staged store holds no credentials at all. Fatal. */
	| { readonly kind: "empty" }
	/** Every credential that could be probed failed. Fatal. */
	| { readonly kind: "dead"; readonly failures: readonly { provider: string; reason: string }[] }
	/** No credential could be probed either way. Report loudly, then proceed. */
	| { readonly kind: "unverifiable"; readonly providers: readonly string[] };

/**
 * Read a set of credential probes into one verdict.
 *
 * A single working credential is enough: the bench needs one usable token, and
 * an operator with several accounts routinely has stale rows alongside a live
 * one. Requiring all of them to pass would block runs that can succeed.
 *
 * `unverifiable` exists so an unprobeable provider is never silently treated as
 * healthy. It is the one outcome that proceeds despite proving nothing, and it
 * has to say so out loud: a quiet pass here would recreate exactly the failure
 * this module was written to catch.
 */
export function decideAuthPreflight(probes: readonly CredentialProbe[]): AuthPreflightVerdict {
	if (probes.length === 0) return { kind: "empty" };

	const usable = probes.filter(probe => probe.ok === true).length;
	if (usable > 0) return { kind: "ok", usable };

	const failures = probes
		.filter(probe => probe.ok === false)
		.map(probe => ({
			provider: probe.email ? `${probe.provider} (${probe.email})` : probe.provider,
			reason: probe.reason ?? "no reason reported",
		}));
	if (failures.length > 0) return { kind: "dead", failures };

	return { kind: "unverifiable", providers: [...new Set(probes.map(probe => probe.provider))] };
}

/**
 * The vendor a single id segment names, or null when the segment names none.
 *
 * A gateway provider meters each upstream vendor SEPARATELY. On
 * `google-antigravity` there are three daily pools, `:google:`, `:openai:` and
 * `:anthropic:`, and they empty independently: the Gemini pool can be spent to
 * the last token while the other two sit untouched at 100%. So "the credential
 * serves a token" is true and useless. The question that matters is whether the
 * pool THIS model draws from has anything left, which is a question about a
 * vendor rather than about a provider.
 *
 * Segments arrive from a router-namespaced id (`openrouter/mistralai/…`), from a
 * provider descriptor id, and from a bare model id, so the same normalization
 * serves all three.
 */
function normalizeVendorSegment(segment: string): string | null {
	const s = segment.toLowerCase().trim();
	if (
		s.includes("gemini") ||
		s === "google" ||
		s === "google-vertex" ||
		s === "google-gemini-cli" ||
		s === "google-antigravity"
	) {
		return "google";
	}
	if (
		s.includes("claude") ||
		s.includes("opus") ||
		s.includes("sonnet") ||
		s.includes("haiku") ||
		s.includes("fable") ||
		s.includes("mythos") ||
		s === "anthropic" ||
		s === "amazon-bedrock" ||
		s === "cursor" ||
		s.includes("gitlab-duo")
	) {
		return "anthropic";
	}
	if (s.includes("gpt") || s.includes("codex") || s === "openai" || s === "azure" || s === "github-copilot") {
		return "openai";
	}
	if (s.includes("mistral") || s.includes("codestral") || s.includes("pixtral") || s === "mistralai") return "mistral";
	if (s.includes("deepseek") || s === "deepseek-ai") return "deepseek";
	if (s.includes("llama") || s === "meta" || s === "meta-llama") return "meta";
	if (
		s.includes("qwen") ||
		s.includes("alibaba") ||
		s === "qwen-portal" ||
		s === "alibaba-coding-plan" ||
		s.includes("qianfan")
	) {
		return "qwen";
	}
	if (
		s.includes("kimi") ||
		s.includes("moonshot") ||
		s === "moonshotai" ||
		s === "kimi-code" ||
		s === "firepass" ||
		s === "fireworks" ||
		s === "command-code" ||
		s === "baseten"
	) {
		return "moonshot";
	}
	if (
		s.includes("glm") ||
		s.includes("zhipu") ||
		s === "zhipuai" ||
		s === "zai" ||
		s === "zai-org" ||
		s === "zhipu-coding-plan" ||
		s === "cerebras"
	) {
		return "zhipu";
	}
	if (s.includes("grok") || s === "xai" || s === "xai-oauth") return "xai";
	if (s.includes("minimax")) return "minimax";
	if (s.includes("mimo") || s === "xiaomi") return "xiaomi";
	if (s === "devin" || s.includes("swe-")) return "devin";
	if (s === "synthetic" || s.includes("synthetic-model")) return "synthetic";
	if (s === "vllm" || s === "local-model") return "vllm";
	if (s === "ollama") return "ollama";
	return null;
}

/**
 * The vendor whose pool a model draws from, or null when the id cannot be placed.
 *
 * Resolution walks four sources: the qualifier segments of a router-namespaced
 * id, the identity classifiers in `@veyyon/catalog/identity`, the bundled model
 * reference index, and the provider descriptor table. A hand written substring
 * table covered three families and read every other real id — Mistral, DeepSeek,
 * Llama, Qwen, an OpenRouter path — as unplaceable, which the pool check then
 * reported as "not checked".
 *
 * Segments are read RIGHT TO LEFT, because the rightmost names the model and the
 * leftmost names the gateway that serves it. Reading left to right placed
 * `google-antigravity/claude-sonnet-5` with the Google pool, which is the exact
 * confusion this check exists to remove: that credential's Gemini pool empties
 * while its Anthropic pool sits untouched, so a left-to-right reading refuses a
 * Claude run that would have succeeded.
 *
 * This is a query and it never throws: a caller that must have an answer asks
 * `requireModelVendor`.
 */
export function modelVendor(modelId: string): string | null {
	const id = modelId.toLowerCase().trim();
	if (!id) return null;

	// 1. Qualifier segments, most specific first (openrouter/mistralai/mistral-large,
	//    google-antigravity/claude-sonnet-5).
	if (id.includes("/")) {
		const parts = id.split("/");
		for (let index = parts.length - 1; index >= 0; index -= 1) {
			const normalized = normalizeVendorSegment(parts[index] as string);
			if (normalized) return normalized;
		}
	}

	// 2. Identity classifiers from @veyyon/catalog/identity
	const known = parseKnownModel(modelId);
	if (known.family === "gemini") return "google";
	if (known.family === "anthropic") return "anthropic";
	if (known.family === "openai") return "openai";

	if (parseGlmModel(modelId)) return "zhipu";
	if (isClaudeModelId(modelId) || isAnthropicNamespacedModelId(modelId)) return "anthropic";
	if (isOpenAIModelId(modelId) || isOpenAIOSeriesModelId(modelId) || isOpenAIGptOssModelId(modelId)) return "openai";
	if (isGemmaModelId(modelId)) return "google";
	if (isQwenModelId(modelId)) return "qwen";
	if (isDeepseekModelIdOrName(modelId)) return "deepseek";
	if (isKimiModelId(modelId) || isKimiK26ModelId(modelId)) return "moonshot";
	if (isMimoModelIdOrName(modelId)) return "xiaomi";
	if (isMinimaxM2FamilyModelId(modelId) || isMinimaxM3FamilyModelId(modelId)) return "minimax";
	if (isGrokReasoningEffortCapable(modelId) || id.includes("grok")) return "xai";

	// 3. Bundled reference lookup
	try {
		const ref = resolveModelReference(modelId, getBundledModelReferenceIndex());
		if (ref?.provider) {
			const normalized = normalizeVendorSegment(ref.provider);
			if (normalized) return normalized;
		}
	} catch {
		// Ignore reference resolution errors and proceed to descriptor check
	}

	// 4. Descriptor provider table lookup by ID or defaultModel
	const providerMatch = CATALOG_PROVIDERS.find(
		p => p.id === id || id.startsWith(`${p.id}/`) || p.defaultModel === modelId,
	);
	if (providerMatch) {
		return normalizeVendorSegment(providerMatch.id) ?? providerMatch.id;
	}

	// 5. Bare model id segment heuristics
	const bare = bareModelId(modelId).toLowerCase();
	return normalizeVendorSegment(bare);
}

/**
 * The vendor a model draws from, refusing when it cannot be placed.
 *
 * The preflight calls this: an id whose vendor no catalog source recognises is a
 * typo or a model the catalog has not learned yet, and either way the quota pool
 * behind it cannot be checked. Proceeding produces a run that dies on
 * RESOURCE_EXHAUSTED after paying for container setup, so the refusal names the
 * model and where to verify it.
 */
export function requireModelVendor(modelId: string): string {
	const vendor = modelVendor(modelId);
	if (!vendor) {
		throw new Error(
			`Cannot resolve model vendor for "${modelId}". Preflight refused: verify model id against @veyyon/catalog.`,
		);
	}
	return vendor;
}

/**
 * Whether the pool the requested model draws from is already spent, and when it
 * refills.
 *
 * WHY THIS IS A SEPARATE CHECK. The token probe above passes whenever ANY
 * credential authenticates, which stays true after a pool empties. Run
 * `2026-07-25T20-46-08-607Z` started on a healthy preflight, scored ten trials,
 * then hit `RESOURCE_EXHAUSTED` and produced twenty-six consecutive zero-token
 * trials. The mid-run abort in `run.ts` catches that case now, but catching it at
 * the START is strictly better: it costs nothing instead of an hour of container
 * setup, and it cannot produce a half-finished run whose missing samples read as
 * data.
 *
 * Matching is by vendor segment inside the pool id, so a provider that reports a
 * single unsegmented pool still matches when its id names the vendor. Returns
 * null when nothing matched, which means "not checked" and never "fine".
 */
export function exhaustedPoolFor(
	probes: readonly CredentialProbe[],
	modelId: string,
): { pool: string; resetsAt?: number } | null {
	const provider = modelId.includes("/") ? (modelId.split("/")[0] as string) : null;
	const vendor = modelVendor(modelId);
	if (vendor === null) return null;
	for (const probe of probes) {
		if (provider && probe.provider !== provider) continue;
		for (const limit of probe.report?.limits ?? []) {
			if (limit.status !== "exhausted") continue;
			if (!limit.id.toLowerCase().includes(vendor)) continue;
			const resetsAt = limit.window?.resetsAt;
			return { pool: limit.id, ...(resetsAt !== undefined && { resetsAt }) };
		}
	}
	return null;
}

/**
 * The operator-facing sentence for a spent pool, naming the pool and when it
 * refills.
 *
 * The reset time is the only actionable part. An operator told merely that quota
 * ran out reruns immediately and hits the same wall; one told the refill time
 * either waits or switches models, and the message names both ways out.
 */
export function describeExhaustedPool(pool: { pool: string; resetsAt?: number }, modelId: string): string {
	const when = pool.resetsAt ? ` It refills at ${new Date(pool.resetsAt).toISOString()}.` : "";
	return (
		`the quota pool "${pool.pool}" that "${modelId}" draws from is already spent.${when}\n` +
		"Every trial would fail with RESOURCE_EXHAUSTED and produce no tokens, leaving a run whose " +
		"missing samples look like data. Wait for the refill, or pass --model for a vendor with quota " +
		"left: a gateway provider meters each upstream vendor separately, so the others may be untouched. " +
		"This is a quota problem. The model id and the arm allowlists are not at fault."
	);
}

/**
 * The operator-facing sentence for a verdict that stops the run.
 *
 * Deliberately never names the model id. The whole point of the preflight is
 * that the previous failure path blamed `--model` for a credential problem and
 * sent a real investigation down the wrong road for a day.
 */
export function describeAuthPreflightFailure(verdict: AuthPreflightVerdict, stagedPath: string): string {
	switch (verdict.kind) {
		case "empty":
			return (
				`the staged auth DB holds no credentials: ${stagedPath}\n` +
				"re-seed it by logging in (vey, then /login), which writes ~/.veyyon/shared-auth/agent.db"
			);
		case "dead": {
			const lines = verdict.failures.map(failure => `  ${failure.provider}: ${failure.reason}`).join("\n");
			return (
				`the staged auth DB cannot serve a token: ${stagedPath}\n${lines}\n` +
				"re-seed it by logging in again (vey, then /login). This is a credential problem. " +
				"The model id and the arm allowlists are not at fault; do not change them."
			);
		}
		default:
			// `ok` and `unverifiable` both proceed, so neither has a failure message.
			// Returning "" rather than throwing keeps the caller's branch simple.
			return "";
	}
}

/**
 * Whether a spent quota pool should stop the run, or only be reported.
 *
 * A REAL RUN MUST STOP. Every trial would fail with `RESOURCE_EXHAUSTED` and
 * produce no tokens, and a run whose samples are missing reads as data rather than
 * as an outage, which is the confusion the check exists to prevent.
 *
 * A DRY RUN MUST NOT. `--dry-run` answers "is my arm wired correctly" without
 * paying for a container, and the moment that answer is most wanted is while
 * waiting for a spent pool to refill so the real run can start the instant it does.
 * Exiting made the flag unusable in exactly that window: the one time validation is
 * free, it refused to run. Quota is a property of the model rather than of the
 * configuration, so it belongs with what a dry run cannot check, not with the
 * guards it exists to apply. It is still printed either way.
 */
export function spentQuotaShouldAbort(spent: { pool: string } | null, dryRun: boolean): boolean {
	if (spent === null) return false;
	return !dryRun;
}
