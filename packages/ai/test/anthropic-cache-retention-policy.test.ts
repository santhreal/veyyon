/**
 * Which cache TTL an Anthropic request asks for, and why it depends on the
 * credential.
 *
 * WHY THIS SUITE EXISTS. `getCacheControl` reads
 * `cacheRetention ?? (isOAuthToken ? "long" : resolveCacheRetention(undefined))`,
 * so an OAuth session asks for `ttl: "1h"` and an API-key session asks for the
 * default 5-minute ephemeral marker. That is a BILLING decision with no test on
 * it: Anthropic charges a 1h cache write at 2x the base input rate against
 * 1.25x for the 5m one, so the two credentials pay different multipliers for the
 * same workload on the same endpoint. `supportsLongCacheRetention` is keyed on
 * the endpoint rather than the credential, so an API-key session on
 * api.anthropic.com could ask for 1h and does not.
 *
 * Neither default is asserted here as correct. The point is that both are now
 * pinned, so changing either is a deliberate act with a diff that says so
 * instead of a silent multiplier change nobody notices until the bill.
 *
 * The tradeoff, for whoever revisits it: a 5m marker is cheaper per write and
 * expires during ordinary agent work. A measured 469-turn session had
 * inter-turn gaps of 787s, 248s, 196s, 168s and 111s, because a turn spans tool
 * calls, subagent batches and human replies. Every gap past the TTL costs a
 * re-read of the prefix as fresh input plus another write, so 2x once can beat
 * 1.25x repeatedly. The honest fix is to choose the TTL from the observed gap
 * distribution rather than from the credential type, which is a policy change
 * and not a repair.
 */

import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { CacheRetention, Context, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
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

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

type CacheControl = { type: "ephemeral"; ttl?: "1h" };
type WireBlock = { cache_control?: CacheControl };
type WireMessage = { content?: string | WireBlock[] };
type AnthropicPayload = { system?: WireBlock[]; messages?: WireMessage[] };

const CONTEXT: Context = {
	systemPrompt: ["stable harness", "changing project context"],
	messages: [{ role: "user", content: "Run the task", timestamp: 1 }],
};

function capturePayload(isOAuth: boolean, cacheRetention?: CacheRetention): Promise<AnthropicPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<AnthropicPayload>();
	streamAnthropic(MODEL, CONTEXT, {
		apiKey: "sk-ant-test",
		isOAuth,
		cacheRetention,
		signal: controller.signal,
		onPayload: payload => resolve(payload as AnthropicPayload),
	});
	return promise;
}

/** Every cache_control marker on the wire, system blocks then message blocks. */
function markers(payload: AnthropicPayload): CacheControl[] {
	const found: CacheControl[] = [];
	for (const block of payload.system ?? []) {
		if (block.cache_control) found.push(block.cache_control);
	}
	for (const message of payload.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.cache_control) found.push(block.cache_control);
		}
	}
	return found;
}

describe("Anthropic cache retention policy", () => {
	/**
	 * The OAuth default. Every marker carries `ttl: "1h"`, including the ones
	 * placed on messages, because a request may not mix retentions: a 5m marker
	 * earlier in the prefix would cap what the 1h markers after it can protect.
	 */
	it("asks for a one-hour TTL on every marker for an OAuth session", async () => {
		const found = markers(await capturePayload(true));

		expect(found.length).toBeGreaterThan(0);
		for (const marker of found) {
			expect(marker).toEqual({ type: "ephemeral", ttl: "1h" });
		}
	});

	/**
	 * The API-key default: the bare ephemeral marker, which is Anthropic's 5
	 * minutes. This is the asymmetry, pinned. The same model, the same endpoint
	 * and the same prompt get a different TTL purely because the credential is a
	 * key rather than a subscription token.
	 */
	it("asks for the default five-minute TTL on every marker for an API-key session", async () => {
		const found = markers(await capturePayload(false));

		expect(found.length).toBeGreaterThan(0);
		for (const marker of found) {
			expect(marker).toEqual({ type: "ephemeral" });
			expect(marker.ttl).toBeUndefined();
		}
	});

	/**
	 * An explicit request wins over the credential-derived default in both
	 * directions. This is the escape hatch an API-key caller has today, and the
	 * only way a subscription session can ask for the cheaper write.
	 */
	it("lets an explicit retention override the credential default", async () => {
		const keyedLong = markers(await capturePayload(false, "long"));
		const oauthShort = markers(await capturePayload(true, "short"));

		expect(keyedLong.length).toBeGreaterThan(0);
		for (const marker of keyedLong) {
			expect(marker).toEqual({ type: "ephemeral", ttl: "1h" });
		}
		expect(oauthShort.length).toBeGreaterThan(0);
		for (const marker of oauthShort) {
			expect(marker).toEqual({ type: "ephemeral" });
		}
	});

	/**
	 * `cacheRetention: "none"` must place no marker at all, on either credential.
	 * A caller asking for no caching that still received markers would pay cache
	 * writes it explicitly declined.
	 */
	it("places no marker at all when caching is declined", async () => {
		expect(markers(await capturePayload(true, "none"))).toEqual([]);
		expect(markers(await capturePayload(false, "none"))).toEqual([]);
	});
});
