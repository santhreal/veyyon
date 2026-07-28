import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Context, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { classifyUnexpectedStop } from "@veyyon/coding-agent/session/unexpected-stop-classifier";
import { tinyModelClient } from "@veyyon/coding-agent/tiny/title-client";
import { logger } from "@veyyon/utils";

const SECRET = "UNEXPECTED_STOP_SECRET_42d9";

function onlineModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled classifier model");
	return model;
}

function settingsFor(backend: string, model = onlineModel()) {
	return {
		get(path: string) {
			return path === "providers.unexpectedStopModel" ? backend : undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function assistant(text: string, errorStatus?: number, errorMessage = "credential rejected"): AssistantMessage {
	return {
		role: "assistant",
		provider: "test",
		model: "test/classifier",
		api: "anthropic-messages",
		content: [{ type: "text", text }],
		stopReason: errorStatus === undefined ? "stop" : "error",
		errorStatus,
		errorMessage: errorStatus === undefined ? undefined : errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function contextText(context: Context): string {
	const message = context.messages[0];
	if (!message) throw new Error("Expected classifier user message");
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
}

function registryFor(model: Model, resolver?: () => Promise<string | undefined> | string | undefined) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "initial-key",
		resolver: () => async () => (resolver ? resolver() : "fresh-key"),
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("unexpected-stop provider confidentiality boundary", () => {
	it("redacts boundary-positioned and repeated assistant secrets at the captured online request", async () => {
		// WHY: attacker/restored assistant text is provider-authored input, not trusted classifier metadata.
		const model = onlineModel();
		const raw = `${SECRET} safe middle ${SECRET}`;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET }]);
		const placeholder = obfuscator.obfuscate(SECRET);
		let captured = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			captured = contextText(context);
			return assistant("YES");
		});

		const result = await classifyUnexpectedStop(raw, {
			settings: settingsFor("online", model),
			registry: registryFor(model),
			model,
			sessionId: "boundary-session",
			obfuscateProviderText: text => obfuscator.obfuscate(text),
		});

		expect(result).toBe(true);
		expect(captured).not.toContain(SECRET);
		expect(captured).toContain("safe middle");
		expect(captured.split(placeholder).length - 1).toBe(2);
	});

	it("leaves safe online assistant text byte-for-byte unchanged", async () => {
		// WHY: the confidentiality boundary must not perturb ordinary classification semantics.
		const model = onlineModel();
		const raw = "I will continue by running the focused verification.";
		let captured = "";
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			captured = contextText(context);
			return assistant("NO");
		});

		const result = await classifyUnexpectedStop(raw, {
			settings: settingsFor("online", model),
			registry: registryFor(model),
			model,
			sessionId: "safe-session",
			obfuscateProviderText: text => text.replaceAll(SECRET, "#OBFUSCATED#"),
		});

		expect(result).toBe(false);
		expect(captured).toBe(raw);
	});

	it("re-resolves the live transform after credential refresh before retrying", async () => {
		// WHY: a 401 await can refresh both credentials and the authoritative secret runtime.
		const model = onlineModel();
		const captures: Array<{ text: string; apiKey: unknown }> = [];
		let secretBecameLive = false;
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
			captures.push({ text: contextText(context), apiKey: options?.apiKey });
			if (captures.length === 1) {
				secretBecameLive = true;
				return assistant("", 401);
			}
			return assistant("YES");
		});

		const result = await classifyUnexpectedStop(`retry ${SECRET}`, {
			settings: settingsFor("online", model),
			registry: registryFor(model, () => "refreshed-key"),
			model,
			sessionId: "refresh-session",
			obfuscateProviderText: text => (secretBecameLive ? text.replaceAll(SECRET, "#LATE_SECRET#") : text),
		});

		expect(result).toBe(true);
		expect(captures).toHaveLength(2);
		expect(captures[0]?.text).toContain(SECRET);
		expect(captures[1]?.text).not.toContain(SECRET);
		expect(captures[1]?.text).toContain("#LATE_SECRET#");
		expect(captures.map(capture => capture.apiKey)).toEqual(["initial-key", "refreshed-key"]);
	});

	it("does not invoke the provider transform for a local-only classifier", async () => {
		// WHY: local model behavior is an explicit non-network mode and must remain unchanged.
		let localPrompt = "";
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, promptText) => {
			localPrompt = promptText;
			return "YES";
		});
		const transform = vi.fn(() => {
			throw new Error("online transform must not run locally");
		});

		const result = await classifyUnexpectedStop(`local ${SECRET}`, {
			settings: settingsFor("qwen3-1.7b"),
			registry: { getAvailable: () => [] } as never,
			sessionId: "local-session",
			obfuscateProviderText: transform,
		});

		expect(result).toBe(true);
		expect(transform).not.toHaveBeenCalled();
		expect(localPrompt).toContain(SECRET);
	});

	it("sanitizes provider error detail before classifier failure logging", async () => {
		// WHY: an upstream may reflect submitted text in an HTTP error after the secret runtime changes.
		const model = onlineModel();
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant("", 400, `echo ${SECRET}`));

		const result = await classifyUnexpectedStop(`request ${SECRET}`, {
			settings: settingsFor("online", model),
			registry: registryFor(model),
			model,
			sessionId: "provider-error-session",
			obfuscateProviderText: text => text.replaceAll(SECRET, "#SECRET#"),
		});

		expect(result).toBeUndefined();
		expect(JSON.stringify(debug.mock.calls)).not.toContain(SECRET);
		expect(JSON.stringify(debug.mock.calls)).toContain("#SECRET#");
	});

	it("fails closed without reflecting adversarial transform errors containing the secret", async () => {
		// WHY: sanitizer failures must not turn the logger into a second disclosure channel.
		const model = onlineModel();
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const complete = vi.spyOn(ai, "completeSimple");

		const result = await classifyUnexpectedStop(`adversarial ${SECRET}`, {
			settings: settingsFor("online", model),
			registry: registryFor(model),
			model,
			sessionId: "failure-session",
			obfuscateProviderText: () => {
				throw new Error(`cannot transform ${SECRET}`);
			},
		});

		expect(result).toBeUndefined();
		expect(complete).not.toHaveBeenCalled();
		expect(JSON.stringify(debug.mock.calls)).not.toContain(SECRET);
	});
});
