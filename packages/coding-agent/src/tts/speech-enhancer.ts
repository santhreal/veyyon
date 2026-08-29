import { type ApiKeyResolver, type AssistantMessage, type Context, completeSimple } from "@veyyon/ai";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { logger } from "@veyyon/utils";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "../secrets/placeholder";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import type { SpeechEnhancerDeps } from "./speech-enhancer-helpers";
import { ANSWER_MAX_TOKENS, MAX_BLOCK_CHARS, REWRITE_TIMEOUT_MS, SYSTEM_PROMPT } from "./speech-enhancer-helpers";

export class SpeechEnhancer {
	#deps: SpeechEnhancerDeps;

	constructor(deps: SpeechEnhancerDeps) {
		this.#deps = deps;
	}

	async rewrite(block: string, signal?: AbortSignal): Promise<string | null> {
		try {
			const { settings, registry, sessionId } = this.#deps;
			const model = resolveModelRoleValue("@tiny", registry.getAvailable(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model;
			if (!model) return null;
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey) return null;
			const metadata = this.#deps.metadataResolver?.(model.provider);
			const requestContext: Context = { systemPrompt: [], messages: [] };
			const refreshProviderContext = (): void => {
				const sanitize = this.#deps.obfuscateProviderText ?? ((text: string) => text);
				const providerBlock = boundBlockWithAtomicPlaceholders(sanitize(block));
				requestContext.systemPrompt = [sanitize(SYSTEM_PROMPT)];
				requestContext.messages = [{ role: "user", content: providerBlock, timestamp: Date.now() }];
			};
			refreshProviderContext();
			const resolveApiKey = registry.resolver(model, sessionId);
			const resolveAttemptApiKey: ApiKeyResolver = async options => {
				const key = await resolveApiKey(options);
				refreshProviderContext();
				return key;
			};
			const timeout = scopedTimeoutSignal(REWRITE_TIMEOUT_MS, signal);
			let response: AssistantMessage;
			try {
				response = await completeSimple(model, requestContext, {
					apiKey: resolveAttemptApiKey,
					maxTokens: ANSWER_MAX_TOKENS,
					disableReasoning: true,
					metadata,
					signal: timeout.signal,
				});
			} finally {
				timeout.cancel();
			}
			if (response.stopReason === "error") {
				logger.debug("speech-enhancer: rewrite errored");
				return null;
			}
			return assistantText(response, " ").trim();
		} catch {
			if (!signal?.aborted) {
				logger.debug("speech-enhancer: rewrite failed");
			}
			return null;
		}
	}
}

const PLACEHOLDER_SHIELD_START = 0xe100;
const PLACEHOLDER_SHIELD_END = 0xf8ff;

function boundBlockWithAtomicPlaceholders(block: string): string {
	const unavailable = new Set(block);
	let nextCodePoint = PLACEHOLDER_SHIELD_START;
	const allocateShield = (): string => {
		while (nextCodePoint <= PLACEHOLDER_SHIELD_END) {
			const candidate = String.fromCharCode(nextCodePoint++);
			if (!unavailable.has(candidate)) {
				unavailable.add(candidate);
				return candidate;
			}
		}
		throw new Error("Too many distinct secret placeholders to bound safely.");
	};
	const padding = allocateShield();
	const shields = new Map<string, string>();
	const shielded = block.replace(PLACEHOLDER_RE, candidate => {
		if (!isSecretPlaceholder(candidate)) return candidate;
		let shield = shields.get(candidate);
		if (!shield) {
			shield = allocateShield();
			shields.set(candidate, shield);
		}
		return shield + padding.repeat(candidate.length - 1);
	});
	let bounded = boundBlock(shielded).split(padding).join("");
	for (const [placeholder, shield] of shields) {
		bounded = bounded.split(shield).join(placeholder);
	}
	return bounded;
}

function boundBlock(block: string): string {
	if (block.length <= MAX_BLOCK_CHARS) return block;
	const half = MAX_BLOCK_CHARS / 2;
	return `${block.slice(0, half)}\n… (elided) …\n${block.slice(-half)}`;
}

export class BlockAccumulator {
	#lines: string[] = [];
	#partial = "";
	#fence: string | null = null;
	#fenceStart = 0;

	push(delta: string): string[] {
		const out: string[] = [];
		let text = this.#partial + delta;
		for (;;) {
			const nl = text.indexOf("\n");
			if (nl === -1) break;
			const line = text.slice(0, nl);
			text = text.slice(nl + 1);
			this.#consumeLine(line, out);
		}
		this.#partial = text;
		return out;
	}

	flush(): string | null {
		if (this.#partial.length > 0) {
			this.#lines.push(this.#partial);
			this.#partial = "";
		}
		if (this.#fence !== null) {
			this.#lines.length = this.#fenceStart;
			this.#fence = null;
		}
		return this.#take();
	}

	flushPartial(): string | null {
		if (this.#fence !== null) return null;
		if (this.#partial.length > 0) {
			this.#lines.push(this.#partial);
			this.#partial = "";
		}
		return this.#take();
	}

	#consumeLine(line: string, out: string[]): void {
		const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (this.#fence === null && fence !== undefined) {
			this.#fence = fence.slice(0, 3);
			this.#fenceStart = this.#lines.length;
		} else if (this.#fence !== null && fence?.startsWith(this.#fence)) {
			this.#fence = null;
		}
		if (this.#fence === null && fence === undefined && line.trim().length === 0) {
			const block = this.#take();
			if (block !== null) out.push(block);
			return;
		}
		this.#lines.push(line);
	}

	#take(): string | null {
		if (this.#lines.length === 0) return null;
		const block = this.#lines.join("\n");
		this.#lines = [];
		return block;
	}
}
