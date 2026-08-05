import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { usesCodexTaskPrompt } from "@veyyon/coding-agent/task/prompt-policy";
import { removeSyncWithRetries } from "@veyyon/utils";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";
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

async function expectPromptDateFromStartupTimezone(options: {
	tempDir: string;
	timeZone: string;
	now: string;
	expectedDate: string;
	rejectedDate: string;
}): Promise<void> {
	const scenarioPath = path.join(options.tempDir, "prompt-date-timezone.test.ts");
	await Bun.write(
		scenarioPath,
		`import { expect, it, setSystemTime } from "bun:test";
import { buildSystemPrompt } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/system-prompt.ts"))};

it("renders the prompt date in the startup timezone", async () => {
	setSystemTime(new Date(process.env.VEYYON_TEST_NOW!));
	try {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: process.cwd(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: process.cwd(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			activeRepoContext: null,
		});
		const rendered = systemPrompt.join("\\n\\n");
		expect(rendered).toContain(\`Today is \${process.env.VEYYON_EXPECTED_DATE}\`);
		expect(rendered).not.toContain(\`Today is \${process.env.VEYYON_REJECTED_DATE}\`);
	} finally {
		setSystemTime();
	}
});
`,
	);
	// A CHILD process gets a fresh `os.homedir()` from whatever HOME it is handed, so the
	// parent's spy is invisible to it and the hermetic env is what isolates it: throwaway
	// HOME, config and XDG roots stripped, provider credentials denied. Bun's transpile
	// cache is handed back explicitly, so re-transpiling the prompt graph here stays warm.
	const hermetic = hermeticSpawnEnv({
		TZ: options.timeZone,
		VEYYON_TEST_NOW: options.now,
		VEYYON_EXPECTED_DATE: options.expectedDate,
		VEYYON_REJECTED_DATE: options.rejectedDate,
	});
	try {
		const child = Bun.spawn([process.execPath, "test", scenarioPath], {
			cwd: options.tempDir,
			env: hermetic.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(`${stdout}\n${stderr}`).toContain("1 pass");
		expect(exitCode).toBe(0);
	} finally {
		hermetic.cleanup();
	}
}

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
		});

		expect(systemPrompt.join("\n\n")).toContain("Model: anthropic/claude-opus-4");
	});

	it("renders the prompt date from the startup local timezone rather than UTC", async () => {
		await expectPromptDateFromStartupTimezone({
			tempDir,
			timeZone: "America/Los_Angeles",
			now: "2026-07-01T03:15:00Z",
			expectedDate: "2026-06-30",
			rejectedDate: "2026-07-01",
		});
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
		session = newSession(modelA, Settings.isolated({ "compaction.enabled": false }), async () => {
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
