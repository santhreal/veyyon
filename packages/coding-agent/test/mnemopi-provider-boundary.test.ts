import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, FetchImpl, Model, SimpleStreamOptions } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { mnemopiBackend } from "@veyyon/coding-agent/mnemopi/backend";
import { getMnemopiSessionState, setMnemopiSessionState } from "@veyyon/coding-agent/mnemopi/state";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { complete } from "@veyyon/mnemopi/core/local-llm";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";
import { TempDir } from "@veyyon/utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("coding-agent Mnemopi online smol boundary", () => {
	/** Why: the real smol adapter must keep raw context behind the post-credential physical-attempt hook. */
	it("reads the current session obfuscator after key lookup and at final payload dispatch", async () => {
		const afterKeySecret = "MNEMOPI_SMOL_AFTER_KEY_SECRET_771";
		const retrySecret = "MNEMOPI_SMOL_RETRY_SECRET_771";
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<Api> | undefined;
		if (!model) throw new Error("Expected bundled smol test model");
		const root = TempDir.createSync("mnemopi-smol-boundary-");
		const settings = Settings.isolated({
			"mnemopi.dbPath": root.join("mnemopi.db"),
			"mnemopi.llmMode": "smol",
			"mnemopi.noEmbeddings": true,
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
			"providers.memoryModel": "online",
		});
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		let obfuscator = new SecretObfuscator([]);
		const session = {
			sessionId: "mnemopi-smol-boundary-session",
			settings,
			get obfuscator() {
				return obfuscator;
			},
			set obfuscator(next: SecretObfuscator) {
				obfuscator = next;
			},
			// The live redaction authority the sanitizer actually calls. Reads the same mutable
			// binding as the getter above, so a swap mid-request still has to be observed.
			obfuscateProviderText: (text: string) => obfuscator.obfuscate(text),
			sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
			subscribe: () => () => {},
			emitNotice: () => {},
		} as never;
		const registry = {
			getAvailable: () => [model],
			getApiKeyForProvider: async () => undefined,
			getApiKey: async () => {
				obfuscator = new SecretObfuscator([{ type: "plain", content: afterKeySecret }]);
				return "test-key";
			},
			resolver: () => async () => "test-key",
		} as never;
		let providerContext = "";
		let finalPayload = "";
		const physicalFetch: FetchImpl = async (_input, init) => {
			finalPayload = String(init?.body);
			return new Response("", { status: 200 });
		};
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options?: SimpleStreamOptions) => {
			providerContext = JSON.stringify(context);
			obfuscator = new SecretObfuscator([
				{ type: "plain", content: afterKeySecret },
				{ type: "plain", content: retrySecret },
			]);
			if (options?.fetch === undefined) throw new Error("Expected final-attempt fetch wrapper");
			await options.fetch("http://provider.test/v1/messages", {
				method: "POST",
				body: JSON.stringify({ context }),
			});
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "smol result" }],
			} as never;
		});

		try {
			await mnemopiBackend.start({
				session,
				settings,
				modelRegistry: registry,
				agentDir: root.path(),
				taskDepth: 0,
			});
			const state = getMnemopiSessionState(session);
			if (!state) throw new Error("Mnemopi state did not start");
			const result = await withMnemopiRuntimeOptions(state.memory.runtimeOptions, () =>
				complete(`extract ${afterKeySecret} ${retrySecret} harmless`, 0, { fetch: physicalFetch }),
			);

			// Why: the backend awaits a registry preflight before completeSimple,
			// and provider auth retries happen after that context was first built.
			expect(result).toBe("smol result");
			expect(providerContext).not.toContain(afterKeySecret);
			expect(providerContext).not.toContain(retrySecret);
			expect(finalPayload).not.toContain(afterKeySecret);
			expect(finalPayload).not.toContain(retrySecret);
			expect(finalPayload).toContain("harmless");
			await state.dispose({ consolidate: false });
			setMnemopiSessionState(session, undefined);
		} finally {
			await root.remove();
		}
	});
});
