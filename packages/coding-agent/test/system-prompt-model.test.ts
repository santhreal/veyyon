import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { usesCodexTaskPrompt } from "@veyyon/coding-agent/task/prompt-policy";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { removeSyncWithRetries } from "@veyyon/utils";
import { useTempHome } from "./helpers/temp-home";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const makePromptModelDir = useTrackedTempDirs("pi-prompt-model-");
const makePromptModelSessionDir = useTrackedTempDirs("pi-prompt-model-session-");

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt model identifier", () => {
	let tempDir = "";

	// The config root moves with HOME, not just the variable: the assembled prompt reads
	// the global `AGENTS.md` from a path built on `os.homedir()`.
	useTempHome();

	beforeEach(() => {
		tempDir = makePromptModelDir();
	});

	it("renders the model identifier into the workstation block when provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
			includeModelInPrompt: true,
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	// The gate, not the presence of `model`, decides. A caller that omits it gets the
	// shipped default (off), which is what keeps the model name out of the cached block.
	it("leaves the model out of the workstation block when the gate is omitted", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			model: "anthropic/claude-opus-4",
		});

		const text = systemPrompt.join("\n\n");
		expect(text).toContain("<workstation>");
		expect(text).not.toContain("anthropic/claude-opus-4");
	});

	it("omits the model line when no model is provided", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
		});

		expect(systemPrompt.join("\n\n")).not.toContain("Model:");
	});
});

describe("AgentSession model-change prompt refresh", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = makePromptModelSessionDir();
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function pickTwoModels(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(m => m.provider !== first.provider || m.id !== first.id);
		if (!first || !second) throw new Error("Expected at least two distinct models in the registry");
		return [first, second];
	}

	function pickTwoModelsWithSameTaskPolicy(): [Model, Model] {
		const all = modelRegistry.getAll();
		const first = all[0];
		const second = all.find(
			model =>
				(model.provider !== first.provider || model.id !== first.id) &&
				usesCodexTaskPrompt(model.id) === usesCodexTaskPrompt(first.id),
		);
		if (!first || !second) throw new Error("Expected two distinct models with the same task prompt policy");
		return [first, second];
	}

	function pickModelsAcrossTaskPolicies(): [Model, Model] {
		const all = modelRegistry.getAll();
		const defaultPolicy = all.find(model => !usesCodexTaskPrompt(model.id));
		const codexPolicy = all.find(model => usesCodexTaskPrompt(model.id));
		if (!defaultPolicy || !codexPolicy) throw new Error("Expected default-policy and GPT-5.6 models");
		return [defaultPolicy, codexPolicy];
	}

	function newSession(
		model: Model,
		settings: Settings,
		rebuild: () => Promise<{ systemPrompt: string[] }>,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] },
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			rebuildSystemPrompt: async () => rebuild(),
		});
		return created;
	}

	it("rebuilds the prompt with the new model when includeModelInPrompt is enabled", async () => {
		const [modelA, modelB] = pickTwoModels();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		// Explicit rather than inherited: the shipped default is off, and this test is
		// specifically about the enabled path its own name names.
		const enabled = Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: true });
		session = newSession(modelA, enabled, async () => {
			rebuildCount++;
			const active = session?.model;
			return { systemPrompt: [`model:${active ? `${active.provider}/${active.id}` : ""}`] };
		});

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual([`model:${modelB.provider}/${modelB.id}`]);

		// Re-selecting the same model leaves the rendered model unchanged → no rebuild.
		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
	});

	it("does not rebuild a hidden-model prompt when the task policy stays the same", async () => {
		const [modelA, modelB] = pickTwoModelsWithSameTaskPolicy();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["unchanged"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(0);
		expect(session.agent.state.systemPrompt).toEqual(["initial"]);
	});

	it("rebuilds a hidden-model prompt when the task policy changes", async () => {
		const [modelA, modelB] = pickModelsAcrossTaskPolicies();
		authStorage.setRuntimeApiKey(modelA.provider, "key-a");
		authStorage.setRuntimeApiKey(modelB.provider, "key-b");

		let rebuildCount = 0;
		session = newSession(
			modelA,
			Settings.isolated({ "compaction.enabled": false, includeModelInPrompt: false }),
			async () => {
				rebuildCount++;
				return { systemPrompt: ["policy changed"] };
			},
		);

		await session.setModel(modelB);
		expect(rebuildCount).toBe(1);
		expect(session.agent.state.systemPrompt).toEqual(["policy changed"]);
	});
});
