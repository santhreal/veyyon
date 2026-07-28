import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import type { EffortSource } from "@veyyon/coding-agent/config/effort-resolver";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("per-model default effort", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-per-model-effort-");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		tempDir.removeSync();
	});

	function getOpus() {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("expected claude-opus-4-5");
		return model;
	}

	function getSonnet() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5");
		return model;
	}

	async function createSession(
		initialModel: Model,
		settings: Settings,
		initialLevel: Effort = Effort.Low,
		thinkingSource: EffortSource = "model-default",
	) {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: initialLevel,
			},
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: initialLevel,
			thinkingSource,
		});
	}

	/** A model-specific row must beat both the any-model row and metadata default. */
	it("restores the selected model's saved effort on switch", async () => {
		const sonnet = getSonnet();
		const opus = getOpus();
		const opusWithDefault: Model = {
			...opus,
			thinking: { ...opus.thinking!, defaultLevel: Effort.XHigh },
		};
		const settings = Settings.isolated({
			defaultEffort: {
				"*": Effort.High,
				[`${opus.provider}/${opus.id}`]: Effort.Medium,
			},
		});
		await createSession(sonnet, settings);

		await session.setModel(opusWithDefault);

		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(session.sessionThinkingOverride).toBeUndefined();
	});

	/** Models without their own row must consistently inherit the profile's any-model variant. */
	it("uses the any-model effort when no model row exists", async () => {
		const settings = Settings.isolated({ defaultEffort: { "*": Effort.High } });
		await createSession(getSonnet(), settings);

		await session.setModel(getOpus());

		expect(session.thinkingLevel).toBe(Effort.High);
	});

	/** A temporary `/thinking` choice has higher precedence than saved rows across model switches. */
	it("preserves a session override across model switches", async () => {
		const opus = getOpus();
		const settings = Settings.isolated({
			defaultEffort: { [`${opus.provider}/${opus.id}`]: Effort.High },
		});
		await createSession(getSonnet(), settings);
		session.setThinkingLevel(Effort.Low);

		await session.setModel(opus);

		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.sessionThinkingOverride).toBe(Effort.Low);
	});

	/** Choosing Default must clear only the temporary override and reveal the active model's saved row. */
	it("clears a session override back to the active model default", async () => {
		const opus = getOpus();
		const settings = Settings.isolated({
			defaultEffort: { [`${opus.provider}/${opus.id}`]: Effort.High },
		});
		await createSession(opus, settings);
		session.setThinkingLevel(Effort.Low);

		session.setThinkingLevel(undefined);

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.sessionThinkingOverride).toBeUndefined();
	});

	/** An explicit model-selector suffix must beat saved rows when no session override exists. */
	it("applies an explicit selector effort before saved defaults", async () => {
		const opus = getOpus();
		const settings = Settings.isolated({
			defaultEffort: { [`${opus.provider}/${opus.id}`]: Effort.Low },
		});
		await createSession(getSonnet(), settings);

		await session.setModel(opus, "default", { thinkingLevel: Effort.High });

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(session.sessionThinkingOverride).toBeUndefined();
	});
});
