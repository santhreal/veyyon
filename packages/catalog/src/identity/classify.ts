export type SemVer = {
	major: number;
	minor: number;
	patch: number;
};

export type GeminiKind = "pro" | "flash";
export type AnthropicKind = "opus" | "sonnet" | "fable" | "mythos";
export type OpenAIVariant = "base" | "codex" | "codex-max" | "codex-mini" | "codex-spark" | "mini" | "max" | "nano";
export type GlmVariant = "base" | "air" | "turbo" | "flash" | "flashx" | "preview";

export interface GeminiModel {
	family: "gemini";
	kind: GeminiKind;
	version: SemVer;
}

export interface AnthropicModel {
	family: "anthropic";
	kind: AnthropicKind;
	version: SemVer;
}

export interface OpenAIModel {
	family: "openai";
	variant: OpenAIVariant;
	version: SemVer;
}

export interface GlmModel {
	family: "glm";
	variant: GlmVariant;
	vision: boolean;
	version: SemVer;
}

export interface UnknownModel {
	family: "unknown";
	id: string;
}

export type ParsedModel = GeminiModel | AnthropicModel | OpenAIModel | UnknownModel;

const bareModelIdCache = new Map<string, string>();
export function bareModelId(modelId: string): string {
	const cached = bareModelIdCache.get(modelId);
	if (cached !== undefined) return cached;
	const p = modelId.lastIndexOf("/");
	const result = p !== -1 ? modelId.slice(p + 1) : modelId;
	bareModelIdCache.set(modelId, result);
	return result;
}

export function parseKnownModel(modelId: string): ParsedModel {
	const canonicalId = bareModelId(modelId);
	return (
		parseGeminiModel(canonicalId) ??
		parseAnthropicModel(canonicalId) ??
		parseOpenAIModel(canonicalId) ?? { family: "unknown", id: canonicalId }
	);
}

function parser<T>(parse: (modelId: string) => T | null): (modelId: string) => T | null {
	const cache = new Map<string, T | null>();
	return modelId => {
		const key = modelId.toLowerCase();
		const hit = cache.get(key);
		if (hit !== undefined || cache.has(key)) {
			return hit ?? null;
		}
		const result = parse(key);
		cache.set(key, result);
		return result;
	};
}

const GEMINI_SUFFIX = "-preview";
export const parseGeminiModel = parser((modelId): GeminiModel | null => {
	if (modelId.endsWith(GEMINI_SUFFIX)) {
		modelId = modelId.slice(0, -GEMINI_SUFFIX.length);
	}
	const match = /gemini-(\d+(?:\.\d+){0,2})-(pro|flash)\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "gemini", kind: match[2] as GeminiKind, version };
});

export const parseAnthropicModel = parser((modelId): AnthropicModel | null => {
	const kindFirst = /claude-(opus|sonnet|fable|mythos)-(\d{1,2}(?:[.-]\d{1,2}){0,2})\b/.exec(modelId);
	const versionFirst = kindFirst
		? null
		: /claude-(\d{1,2}(?:[.-]\d{1,2}){0,2})-(opus|sonnet|fable|mythos)\b/.exec(modelId);
	const kind = kindFirst?.[1] ?? versionFirst?.[2];
	const versionInput = kindFirst?.[2] ?? versionFirst?.[1];
	if (!kind || !versionInput) {
		return null;
	}
	const version = parseSemVer(versionInput);
	if (!version) {
		return null;
	}
	return { family: "anthropic", kind: kind as AnthropicKind, version };
});

export const parseOpenAIModel = parser((modelId): OpenAIModel | null => {
	const match = /gpt-(\d+(?:\.\d+){0,2})(?:-(codex-spark|codex-mini|codex-max|codex|mini|max|nano))?\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "openai", variant: (match[2] as OpenAIVariant | undefined) ?? "base", version };
});

export const parseGlmModel = parser((modelId): GlmModel | null => {
	const match = /glm-(\d{1,2}(?:\.\d+)?)(v)?(?:-(air|turbo|flashx|flash|preview))?\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return {
		family: "glm",
		variant: (match[3] as GlmVariant | undefined) ?? "base",
		vision: match[2] === "v",
		version,
	};
});

export function isFableOrMythos(kind: AnthropicKind): boolean {
	return kind === "fable" || kind === "mythos";
}

export function isAnthropicAdaptiveGenAtLeast(parsed: AnthropicModel, opusMin: "4.6" | "4.7" | "4.8"): boolean {
	if (parsed.kind === "opus") {
		return semverGte(parsed.version, opusMin);
	}
	return semverGte(parsed.version, "5");
}

function createSemVer(major: number, minor: number, patch = 0): SemVer {
	return { major, minor, patch };
}

const precomputeTable: Record<string, SemVer> = {};
for (let major = 0; major <= 9; major++) {
	for (let minor = 0; minor <= 10; minor++) {
		const version = createSemVer(major, minor, 0);
		precomputeTable[`${major}.${minor}`] = version;
		precomputeTable[`${major}-${minor}`] = version;
	}
	precomputeTable[`${major}`] = createSemVer(major, 0, 0);
}

export function parseSemVer(version: string): SemVer | null {
	return precomputeTable[version] ?? null;
}

export function semverGte(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) >= 0;
}

export function semverEqual(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) === 0;
}

export function compareSemVer(left: SemVer | string | null, right: SemVer | string | null): number {
	left = typeof left === "string" ? parseSemVer(left) : left;
	right = typeof right === "string" ? parseSemVer(right) : right;
	if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);

	if (left.major !== right.major) {
		return left.major - right.major;
	}
	if (left.minor !== right.minor) {
		return left.minor - right.minor;
	}
	return left.patch - right.patch;
}
