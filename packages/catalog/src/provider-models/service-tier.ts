import { isOpenAIModelId } from "../identity/family";
import type { Api, Model } from "../types";
import {
	OPENAI_WIRE_TIERS,
	providerWireCapabilities,
	type ServiceTier,
	type ServiceTierByFamily,
	type ServiceTierFamily,
} from "./wire-capabilities";

type ServiceTierModel = Pick<Model, "provider" | "api" | "id">;

function isOpenAIServiceTierApi(api: Api | undefined): boolean {
	return api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses";
}

function isOpenAIRelayModel(model: ServiceTierModel): boolean {
	return isOpenAIServiceTierApi(model.api) && isOpenAIModelId(model.id);
}

function namespaceFamily(modelId: string): ServiceTierFamily | undefined {
	const id = modelId.toLowerCase();
	if (id.startsWith("anthropic/")) return "anthropic";
	if (id.startsWith("google/")) return "google";
	if (id.startsWith("openai/")) return "openai";
	return undefined;
}

export function serviceTierFamily(model: ServiceTierModel): ServiceTierFamily | undefined {
	const capability = providerWireCapabilities(model.provider)?.serviceTier;
	if (capability) {
		if (capability.family === "model-namespace") return namespaceFamily(model.id);
		if (capability.family && !capability.anthropicMessagesOverridesFamily) return capability.family;
		if (model.api === "anthropic-messages") return "anthropic";
		return capability.family;
	}
	if (model.api === "anthropic-messages") return "anthropic";
	return isOpenAIRelayModel(model) ? "openai" : undefined;
}

export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: ServiceTierModel,
): ServiceTier | undefined {
	if (!tiers) return undefined;
	const family = serviceTierFamily(model);
	return family ? tiers[family] : undefined;
}

export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	target: string | ServiceTierModel | undefined,
): boolean {
	if (!serviceTier) return false;
	const provider = typeof target === "string" ? target : target?.provider;
	const capability = providerWireCapabilities(provider)?.serviceTier;
	if (capability) return capability.wireTiers.includes(serviceTier);
	if (typeof target !== "string" && target && isOpenAIRelayModel(target)) {
		return (OPENAI_WIRE_TIERS as readonly ServiceTier[]).includes(serviceTier);
	}
	return false;
}

export function realizesPriorityServiceTier(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): boolean {
	if (serviceTier !== "priority") return false;
	const capability = providerWireCapabilities(model.provider)?.serviceTier;
	if (capability?.realizesPriorityOffWire) return true;
	if (capability?.realizesPriorityForFamilies) {
		const family = serviceTierFamily(model);
		return family !== undefined && capability.realizesPriorityForFamilies.includes(family);
	}
	if (model.api === "anthropic-messages") return false;
	return shouldSendServiceTier(serviceTier, model);
}

export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): number {
	if (!realizesPriorityServiceTier(serviceTier, model)) return 0;
	return providerWireCapabilities(model.provider)?.serviceTier?.premiumPriority ? 1 : 0;
}
