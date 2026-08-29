import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { CacheRetention, Context, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { estimateTokensFromText } from "@veyyon/utils";

export const PRICE = Object.freeze({
	input: 1,
	read: 0.1,
	write5m: 1.25,
	write1h: 2.0,
});

export const TTL_MS = Object.freeze({ short: 5 * 60_000, long: 60 * 60_000 });

export const MIN_CACHEABLE_TOKENS = 2048;

export const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

export const CACHE_SIM_MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

export type CacheControl = { type: "ephemeral"; ttl?: "1h"; scope?: "global" };
export type WireBlock = { type?: string; cache_control?: CacheControl } & Record<string, unknown>;
export type WireMessage = { role?: string; content?: string | WireBlock[] };
export type WirePayload = { system?: WireBlock[]; messages?: WireMessage[]; tools?: WireBlock[] };

export function capturePayload(
	context: Context,
	options: { isOAuth: boolean; cacheRetention?: CacheRetention },
): Promise<WirePayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<WirePayload>();
	streamAnthropic(CACHE_SIM_MODEL, context, {
		apiKey: "sk-ant-simulation",
		isOAuth: options.isOAuth,
		cacheRetention: options.cacheRetention,
		signal: controller.signal,
		onPayload: payload => resolve(payload as WirePayload),
	});
	return promise;
}

export interface Prefix {
	readonly joined: string;
	readonly tokens: number;
	readonly retention: "short" | "long";
	readonly global: boolean;
}
export const BLOCK_SEPARATOR = "\u0000";

export function withoutMarker(block: WireBlock): Record<string, unknown> {
	const { cache_control: _directive, ...rest } = block;
	return rest;
}

export function blocksOf(payload: WirePayload): Array<{ text: string; marker?: CacheControl }> {
	const blocks: Array<{ text: string; marker?: CacheControl }> = [];
	for (const tool of payload.tools ?? []) {
		blocks.push({ text: JSON.stringify(withoutMarker(tool)), marker: tool.cache_control });
	}
	for (const block of payload.system ?? []) {
		blocks.push({ text: JSON.stringify(withoutMarker(block)), marker: block.cache_control });
	}
	for (const message of payload.messages ?? []) {
		if (!Array.isArray(message.content)) {
			blocks.push({ text: JSON.stringify(message) });
			continue;
		}
		message.content.forEach((block, index) => {
			const text = JSON.stringify(
				index === 0 ? { role: message.role, ...withoutMarker(block) } : withoutMarker(block),
			);
			blocks.push({ text, marker: block.cache_control });
		});
	}
	return blocks;
}

export function prefixesOf(payload: WirePayload): Prefix[] {
	const prefixes: Prefix[] = [];
	const seen: string[] = [];
	for (const block of blocksOf(payload)) {
		seen.push(block.text);
		if (!block.marker) continue;
		const joined = seen.join(BLOCK_SEPARATOR);
		prefixes.push({
			joined,
			tokens: estimateTokensFromText(joined),
			retention: block.marker.ttl === "1h" ? "long" : "short",
			global: block.marker.scope === "global",
		});
	}
	return prefixes;
}

export function joinedOf(payload: WirePayload): string {
	return blocksOf(payload)
		.map(block => block.text)
		.join(BLOCK_SEPARATOR);
}

export function promptTokensOf(payload: WirePayload): number {
	return estimateTokensFromText(joinedOf(payload));
}

export interface TurnLedger {
	readonly read: number;
	readonly write: number;
	readonly input: number;
	readonly promptTokens: number;
	readonly cost: number;
}

export interface SessionLedger {
	readonly turns: readonly TurnLedger[];
	readonly read: number;
	readonly write: number;
	readonly input: number;
	readonly cost: number;
	readonly misses: number;
}

export interface Entry {
	joined: string;
	owner: string | undefined;
	tokens: number;
	retention: "short" | "long";
	expiresAt: number;
}
