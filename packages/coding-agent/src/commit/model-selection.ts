import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, ApiKey, Model } from "@veyyon/ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import {
	fallbackForUnavailableDefault,
	getModelMatchPreferences,
	type ModelLookupRegistry,
	parseModelPattern,
	resolveModelRoleValue,
	resolveRoleSelection,
	resolveRoleSelectionWithInherit,
} from "../config/model-resolver";
import { MODEL_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import { concreteThinkingLevel } from "../thinking";

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	/**
	 * Commit-time inference is stateless: session-level auto classification
	 * isn't available, so an explicit `:auto` selector collapses to "no
	 * override" and the model's own default level fills in.
	 */
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry &
	ApiKeyResolverRegistry & {
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	};

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	warn: (message: string) => void = message => process.stderr.write(`Warning: ${message}\n`),
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences })
		: resolveRoleSelectionWithInherit(["commit", "smol", ...MODEL_ROLE_IDS], settings, available);
	let model = resolved?.model;
	let thinkingLevel = resolved?.thinkingLevel;
	if (!model && !override) {
		// Parity with the interactive/print surface (main.ts): a configured
		// default whose provider lost auth substitutes LOUDLY instead of
		// failing here while `-p` succeeds. An explicit --model override stays
		// authoritative and still fails hard. With no configured default at all
		// there is nothing to warn about — picking an available model IS the
		// default resolution (mirrors main.ts's un-warned scopedModels[0] path).
		const configuredDefault = settings.getModelRole("default");
		const fallback = fallbackForUnavailableDefault(configuredDefault, available);
		if (fallback) {
			if (configuredDefault) warn(fallback.warning);
			model = fallback.model;
			thinkingLevel = undefined;
		}
	}
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return {
		model,
		apiKey: modelRegistry.resolver(model),
		thinkingLevel: concreteThinkingLevel(thinkingLevel),
	};
}

export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: ApiKey,
	warn: (message: string) => void = message => process.stderr.write(`Warning: ${message}\n`),
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolvedSmol = resolveRoleSelection(["smol"], settings, available);
	if (resolvedSmol?.model) {
		const apiKey = await modelRegistry.getApiKey(resolvedSmol.model);
		if (apiKey) {
			return {
				model: resolvedSmol.model,
				apiKey: modelRegistry.resolver(resolvedSmol.model),
				thinkingLevel: concreteThinkingLevel(resolvedSmol.thinkingLevel),
			};
		}
		// Law 10: a CONFIGURED smol role being skipped for missing credentials
		// must be loud, not a quiet substitution down the priority list.
		warn(
			`Configured smol model ${resolvedSmol.model.provider}/${resolvedSmol.model.id} has no stored credentials; picking a substitute — run \`veyyon auth\` to sign in.`,
		);
	}

	const matchPreferences = getModelMatchPreferences(settings);
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences).model;
		if (!candidate) continue;
		const apiKey = await modelRegistry.getApiKey(candidate);
		if (apiKey) {
			return {
				model: candidate,
				apiKey: modelRegistry.resolver(candidate),
			};
		}
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
