import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { estimateToolSchemaTokens } from "@veyyon/coding-agent/session/context-usage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { estimateTokensFromText, TempDir } from "@veyyon/utils";

function bundledModel(provider: string, id: string): Model<Api> {
	const model = getBundledModel(provider as Parameters<typeof getBundledModel>[0], id);
	if (!model) throw new Error(`Missing bundled test model ${provider}/${id}`);
	return model;
}

describe("session descriptor placement across model switches", () => {
	let dir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		dir = TempDir.createSync("@descriptor-model-switch-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("google-antigravity", "test-google-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-openai-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	});

	afterAll(async () => {
		await session?.dispose();
		authStorage.close();
		dir.removeSync();
	});

	/** Locks out a Gemini-start session retaining inline descriptors after switching to a native OpenAI model. */
	it("moves descriptors from the prompt into native schemas as one synchronized transition", async () => {
		const gemini = bundledModel("google-antigravity", "gemini-3.1-pro");
		const openai = bundledModel("openai-codex", "gpt-5.6-sol");
		const created = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(dir.path()),
			settings: Settings.isolated({ inlineToolDescriptors: "auto" } as never),
			model: gemini,
			disableExtensionDiscovery: true,
		});
		session = created.session;

		const sourceDescription = session.agent.state.tools?.find(tool => tool.name === "read")?.description;
		if (!sourceDescription) throw new Error("Expected the active read tool to carry its provider description");
		const initialPrompt = session.agent.state.systemPrompt.join("\n\n");
		const initialWire = await session.agent.buildSideRequestContext([]);
		const initialProviderTokens =
			estimateTokensFromText(initialPrompt) + estimateToolSchemaTokens(initialWire.tools ?? []);
		expect(initialPrompt).toContain("# Tool: read");
		expect(initialWire.tools?.find(tool => tool.name === "read")?.description).toBe("");

		await session.setModel(openai);

		const switchedPrompt = session.agent.state.systemPrompt.join("\n\n");
		const switchedWire = await session.agent.buildSideRequestContext([]);
		const switchedProviderTokens =
			estimateTokensFromText(switchedPrompt) + estimateToolSchemaTokens(switchedWire.tools ?? []);
		expect(switchedPrompt).not.toContain("# Tool: read");
		expect(switchedWire.tools?.find(tool => tool.name === "read")?.description).toBe(sourceDescription);
		expect(switchedProviderTokens).toBeLessThanOrEqual(initialProviderTokens - 500);
	});
});
