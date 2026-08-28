import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { mnemopiBackend } from "@veyyon/coding-agent/memory/mnemopi/backend";
import { loadMnemopiConfig } from "@veyyon/coding-agent/memory/mnemopi/config";
import { getMnemopiSessionState, setMnemopiSessionState } from "@veyyon/coding-agent/memory/mnemopi/state";
import { MNEMOPI_MEMORY_EDIT_OPERATIONS } from "@veyyon/coding-agent/memory/mnemopi/verbs";
import { MemoryEditTool } from "@veyyon/coding-agent/tools/memory-edit";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: two layers answered "which LLM does memory use" and one of the answers was silently wrong.
 *
 * `loadMnemopiConfig` built a remote LLM client straight from the `mnemopi.llm*` settings into
 * `providerOptions.llm`, and every real session then threw it away: `loadMnemopiConfigWithProviders`
 * overwrites `providerOptions` with `resolveMnemopiProviderOptions`, which is the only layer that applies
 * the `providers.memoryModel` on-device override, a credential resolver, and `obfuscateProviderText`. The
 * four paths that load a config WITHOUT resolving it -- dispose, diagnostics, the stats memories -- kept
 * the loader's version and handed Mnemopi a remote client with no resolver and, worse, no provider-text
 * sanitizer, which is what keeps secrets out of a memory prompt.
 *
 * The class this closes: a config object that looks configured and is not. A config now carries the
 * REQUEST (`config.llm`) and nothing else; a client exists only where one was resolved.
 *
 * The second half is the memory verb vocabulary: the `memory_edit` schema restated the store's operation
 * union as an arktype string, so a verb could be offered to the model with no branch behind it. The schema
 * is derived from `MNEMOPI_MEMORY_EDIT_OPERATIONS` now, and the case below fails by default when a verb is
 * added to that list without a decision recorded here.
 *
 * The third defect in the same seam: `mnemopi.llmApiKey` and `mnemopi.embeddingApiKey` were handed to
 * Mnemopi as raw setting text, so `${VAR}` reached the endpoint as a credential -- the exact fail-open the
 * config-value grammar exists to close, and the spelling the memory backend's own documentation shows.
 *
 * What this does not catch: whether the smol and on-device branches pick the right model. That needs a live
 * model registry and is covered by the provider-boundary suite.
 */

function configFor(overrides: Record<string, unknown>): ReturnType<typeof loadMnemopiConfig> {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, "/nonexistent/mnemopi-llm-request-test");
}

describe("a loaded memory config carries the LLM request", () => {
	it("reports the mode and the three remote fields the operator set", () => {
		const config = configFor({
			"mnemopi.llmMode": "remote",
			"mnemopi.llmBaseUrl": "https://example.invalid/v1",
			"mnemopi.llmApiKey": "literal:test-key",
			"mnemopi.llmModel": "some-model",
		});

		// The REQUEST, verbatim: `literal:` is still there because resolving it belongs to the layer that
		// builds the client, and a config that was never resolved must not look like one that was.
		expect(config.llm).toEqual({
			mode: "remote",
			baseUrl: "https://example.invalid/v1",
			apiKey: "literal:test-key",
			model: "some-model",
		});
	});

	/**
	 * The defect itself. A remote request used to become a live `providerOptions.llm` here, and the object
	 * is spread straight into a `Mnemopi` constructor by both `createMemory` and `createStatsMemory`.
	 */
	it.each([["none"], ["smol"], ["remote"]])("hands out no client for mode %s", mode => {
		const config = configFor({
			"mnemopi.llmMode": mode,
			"mnemopi.llmBaseUrl": "https://example.invalid/v1",
			"mnemopi.llmModel": "some-model",
		});

		expect(config.providerOptions.llm).toBe(false);
	});

	/** Non-vacuity: the loader really did read this settings object, so the `false` above is a decision. */
	it("still resolves the embedding half of the same provider options", () => {
		const config = configFor({ "mnemopi.embeddingVariant": "multilingual", "mnemopi.llmMode": "remote" });

		expect(config.providerOptions.embeddingModel).toBe("intfloat/multilingual-e5-large");
	});
});

describe("a resolved memory LLM reads its credential through the config-value grammar", () => {
	/**
	 * Driven through `mnemopiBackend.start`, which is how a session reaches this: the backend is the only
	 * layer that resolves, and asserting on the loader would prove nothing about what Mnemopi receives.
	 */
	async function startedLlmOptions(llmApiKey: string): Promise<Record<string, unknown> | false | undefined> {
		const root = TempDir.createSync("mnemopi-credential-grammar-");
		const settings = Settings.isolated({
			"mnemopi.dbPath": root.join("mnemopi.db"),
			"mnemopi.llmMode": "remote",
			"mnemopi.llmBaseUrl": "https://memory.invalid/v1",
			"mnemopi.llmApiKey": llmApiKey,
			"mnemopi.llmModel": "memory-model",
			"mnemopi.noEmbeddings": true,
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
		});
		const session = {
			sessionId: "mnemopi-credential-grammar-session",
			settings,
			obfuscateProviderText: (text: string) => text,
			sessionManager: { getCwd: () => root.path(), getEntries: () => [] },
			subscribe: () => () => {},
			emitNotice: () => {},
		} as never;
		const registry = {
			getAvailable: () => [],
			getApiKeyForProvider: async () => undefined,
			getApiKey: async () => undefined,
			resolver: () => async () => undefined,
		} as never;
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
			const llm = state.config.providerOptions.llm as Record<string, unknown> | false | undefined;
			await state.dispose({ consolidate: false });
			setMnemopiSessionState(session, undefined);
			return llm;
		} finally {
			await root.remove();
		}
	}

	it("hands Mnemopi the value the grammar produced, not the setting text", async () => {
		expect(await startedLlmOptions("literal:memory-secret")).toMatchObject({ apiKey: "memory-secret" });
	});

	/**
	 * The fail-open this closes. An unset variable used to travel to the memory host AS the credential, and
	 * the failure came back as a 401 with nothing naming the setting. Nothing is sent now.
	 */
	it("sends nothing when the named variable is unset", async () => {
		const llm = await startedLlmOptions("MNEMOPI_LLM_KEY_THAT_IS_NEVER_SET");

		expect(llm).toMatchObject({ baseUrl: "https://memory.invalid/v1", model: "memory-model" });
		expect((llm as Record<string, unknown>).apiKey).toBeUndefined();
	});
});

describe("the memory edit verbs have one owner", () => {
	/**
	 * Pinned by exact equality against the store's list: adding a verb turns this red until the branch in
	 * `editScopedMemory` and this decision both exist.
	 */
	it("offers the model exactly the operations the store applies", () => {
		expect([...MNEMOPI_MEMORY_EDIT_OPERATIONS]).toEqual(["update", "forget", "invalidate"]);
	});

	it("accepts every verb on the list and rejects one that is not", () => {
		const schema = new MemoryEditTool({} as never).parameters;

		for (const op of MNEMOPI_MEMORY_EDIT_OPERATIONS) {
			expect(schema({ op, id: "m1" }), op).toEqual({ op, id: "m1" });
		}
		expect(schema({ op: "delete", id: "m1" })).toBeInstanceOf(Object);
		expect(String(schema({ op: "delete", id: "m1" }))).toContain("op");
	});
});
