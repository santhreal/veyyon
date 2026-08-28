const FIREWORKS_WIRE_PREFIX = "accounts/fireworks/models/";
export const FIREPASS_WIRE_PREFIX = "accounts/fireworks/routers/";
const VERSION_SEPARATOR_PATTERN = /(?<=\d)p(?=\d)/g;
const VERSION_DOT_PATTERN = /(?<=\d)\.(?=\d)/g;

export function toFireworksPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_WIRE_PREFIX) ? modelId.slice(FIREWORKS_WIRE_PREFIX.length) : modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFireworksWireModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_WIRE_PREFIX) ? modelId.slice(FIREWORKS_WIRE_PREFIX.length) : modelId;
	return `${FIREWORKS_WIRE_PREFIX}${stripped.replace(VERSION_DOT_PATTERN, "p")}`;
}

export function toFirepassPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREPASS_WIRE_PREFIX) ? modelId.slice(FIREPASS_WIRE_PREFIX.length) : modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFirepassWireModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREPASS_WIRE_PREFIX) ? modelId.slice(FIREPASS_WIRE_PREFIX.length) : modelId;
	return `${FIREPASS_WIRE_PREFIX}${stripped.replace(VERSION_DOT_PATTERN, "p")}`;
}

export const FIREWORKS_FAST_SUFFIX = "-fast";

export function isFireworksFastModelId(modelId: string): boolean {
	return modelId.endsWith(FIREWORKS_FAST_SUFFIX);
}

export function toFireworksBaseModelId(modelId: string): string {
	return modelId.endsWith(FIREWORKS_FAST_SUFFIX) ? modelId.slice(0, -FIREWORKS_FAST_SUFFIX.length) : modelId;
}
