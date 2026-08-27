import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
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
import { collapseWhitespace } from "@veyyon/utils";
import { authDbPath as defaultAuthDbPath } from "../paths";

export const AUTH_DB_SOURCES = [
	path.join(os.homedir(), ".veyyon", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "default", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "work", "shared-auth", "agent.db"),
];

/**
 * One usage pool a provider meters separately, as reported by its usage probe.
 */
export interface CredentialLimit {
	readonly id: string;
	readonly status?: string;
	readonly window?: { readonly resetsAt?: number };
}

/** The subset of `CredentialHealthResult` this decision reads. */
export interface CredentialProbe {
	readonly provider: string;
	readonly ok: boolean | null;
	readonly reason?: string;
	readonly email?: string;
	readonly report?: { readonly limits?: readonly CredentialLimit[] };
}

export type AuthPreflightVerdict =
	| { readonly kind: "ok"; readonly usable: number }
	| { readonly kind: "empty" }
	| { readonly kind: "dead"; readonly failures: readonly { provider: string; reason: string }[] }
	| { readonly kind: "unverifiable"; readonly providers: readonly string[] };

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

export function modelVendor(modelId: string): string | null {
	const id = modelId.toLowerCase().trim();
	if (!id) return null;

	if (id.includes("/")) {
		const parts = id.split("/");
		for (let index = parts.length - 1; index >= 0; index -= 1) {
			const normalized = normalizeVendorSegment(parts[index] as string);
			if (normalized) return normalized;
		}
	}

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

	try {
		const ref = resolveModelReference(modelId, getBundledModelReferenceIndex());
		if (ref?.provider) {
			const normalized = normalizeVendorSegment(ref.provider);
			if (normalized) return normalized;
		}
	} catch {
		// Ignore reference resolution errors and proceed to descriptor check
	}

	const providerMatch = CATALOG_PROVIDERS.find(
		p => p.id === id || id.startsWith(`${p.id}/`) || p.defaultModel === modelId,
	);
	if (providerMatch) {
		return normalizeVendorSegment(providerMatch.id) ?? providerMatch.id;
	}

	const bare = bareModelId(modelId).toLowerCase();
	return normalizeVendorSegment(bare);
}

export function requireModelVendor(modelId: string): string {
	const vendor = modelVendor(modelId);
	if (!vendor) {
		throw new Error(
			`Cannot resolve model vendor for "${modelId}". Preflight refused: verify model id against @veyyon/catalog.`,
		);
	}
	return vendor;
}

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
 * One provider failure as a verdict line.
 *
 * A credential probe reports the upstream error verbatim, so an OAuth refresh failure
 * arrives as one sentence followed by `; stack=` and a dozen indented frames. A preflight
 * verdict states which credential failed and what to do about it; the frames belong to the
 * provider client that produced them, and repeated once per credential they bury the line
 * that says a login is needed.
 */
export function summarizeCredentialReason(reason: string): string {
	const beforeStack = reason.split("; stack=")[0] ?? reason;
	const firstLine = beforeStack.split("\n")[0] ?? beforeStack;
	const collapsed = collapseWhitespace(firstLine);
	return collapsed.length > 0 ? collapsed : "no reason reported";
}

export function describeAuthPreflightFailure(verdict: AuthPreflightVerdict, stagedPath: string): string {
	switch (verdict.kind) {
		case "empty":
			return (
				`the staged auth DB holds no credentials: ${stagedPath}\n` +
				"re-seed it by logging in (vey, then /login), which writes ~/.veyyon/shared-auth/agent.db"
			);
		case "dead": {
			const lines = verdict.failures
				.map(failure => `  ${failure.provider}: ${summarizeCredentialReason(failure.reason)}`)
				.join("\n");
			return (
				`the staged auth DB cannot serve a token: ${stagedPath}\n${lines}\n` +
				"re-seed it by logging in again (vey, then /login). This is a credential problem. " +
				"The model id and the arm allowlists are not at fault; do not change them."
			);
		}
		default:
			return "";
	}
}

export function spentQuotaShouldAbort(spent: { pool: string } | null, dryRun: boolean): boolean {
	if (spent === null) return false;
	return !dryRun;
}

export async function requireStagedAuthCanServeToken(
	model: string,
	dryRun = false,
	dbPath = defaultAuthDbPath(),
): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	let probes: CredentialProbe[];
	try {
		const storage = new AuthStorage(store);
		await storage.reload();
		probes = await storage.checkCredentials();
	} finally {
		store.close();
	}

	if (modelVendor(model) === null) {
		const message =
			`cannot resolve the upstream vendor for model "${model}", so its quota pool cannot be ` +
			`checked. Verify the model id against @veyyon/catalog.`;
		if (!dryRun) throw new Error(message);
		console.error(message);
		console.error("continuing anyway because this is a --dry-run; no trial will be started.\n");
	}

	const spent = exhaustedPoolFor(probes, model);
	if (spent) {
		const message = describeExhaustedPool(spent, model);
		if (spentQuotaShouldAbort(spent, dryRun)) throw new Error(message);
		console.error(message);
		console.error("continuing anyway because this is a --dry-run; no trial will be started.\n");
	}

	const verdict = decideAuthPreflight(probes);
	if (verdict.kind === "ok") {
		return;
	}
	if (verdict.kind === "unverifiable") {
		console.warn(
			`WARNING the staged auth DB could NOT be verified. No probe is configured for: ` +
				`${verdict.providers.join(", ")}. Proceeding UNVERIFIED; an auth failure will now surface per trial.`,
		);
		return;
	}
	throw new Error(describeAuthPreflightFailure(verdict, dbPath));
}
