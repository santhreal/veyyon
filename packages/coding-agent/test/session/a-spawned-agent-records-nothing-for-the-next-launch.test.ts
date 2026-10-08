/**
 * WHY: `createAgentSession` recorded the at-rest launch facts for every session it built, and a
 * spawned agent is one. A spawned agent that runs the default model files under the same model
 * key the launch card reads, with its own system prompt, tool set and effort. Its reading
 * overwrote the top-level session's, so the next launch's card stated a gauge and an effort rung
 * measured on a prompt that launch never builds. Each spawn also measured the gauge it then
 * misfiled, which builds the wire schema of every tool it holds before its first request.
 *
 * THE CLASS: no session the factory treats as spawned reaches the launch-facts record, by any of
 * the option shapes `isSubagentSession` accepts, when it is created or when it leaves rest
 * (`takeHeldAtRestReading`, which the session calls before its first turn appends a message). Each
 * shape is checked alone, where any record at all is the defect, and after a top-level session
 * recorded, where the defect is the record changing. The top-level arm is the positive control: it
 * proves the record is reachable from this harness, so an empty record in the spawned arms is the
 * guard and not a broken fixture.
 *
 * WHAT THIS DOES NOT CATCH: a spawned agent recording through the status row. A spawned agent has
 * no row, and the row's own recorder is covered by `the-launch-card-states-what-the-last-launch-knew`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { readLaunchFacts, resetLaunchFactsForTest } from "@veyyon/coding-agent/config/launch-facts";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type CreateAgentSessionOptions, isSubagentSession } from "@veyyon/coding-agent/session/factory-options";
import { takeHeldAtRestReading } from "@veyyon/coding-agent/session/non-message-tokens";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-5";

/** Every option shape the factory reads as a spawned agent. */
const SPAWNED: Record<string, Partial<CreateAgentSessionOptions>> = {
	"an agent spawned by task depth": { taskDepth: 1 },
	"an agent spawned under a parent prefix": { parentTaskPrefix: "0-Main" },
	"an agent spawned with both": { taskDepth: 2, parentTaskPrefix: "0-Main.1-Child" },
};

function bundledModel(): Model {
	const model = getBundledModel(PROVIDER, MODEL_ID);
	if (!model) throw new Error(`missing bundled model ${PROVIDER}/${MODEL_ID}`);
	return model as Model;
}

const sessions: AgentSession[] = [];
const tempDirs: string[] = [];
let sharedDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let isolated: IsolatedConfigRoot;

async function create(extra: Partial<CreateAgentSessionOptions>): Promise<AgentSession> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `spawn-launch-facts-${Snowflake.next()}-`));
	tempDirs.push(tempDir);
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(tempDir, "agent"),
		sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		modelRegistry,
		model: bundledModel(),
		...extra,
	});
	sessions.push(session);
	return session;
}

beforeAll(async () => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-launch-facts-"));
	authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	authStorage.setRuntimeApiKey(PROVIDER, "anthropic-test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
});

beforeEach(async () => {
	isolated = enterIsolatedConfigRoot("spawn-launch-facts", { defaultProfile: true });
	resetSettingsForTest();
	resetLaunchFactsForTest();
	await Settings.init({ cwd: isolated.root });
	settings.setModelRole("default", `${PROVIDER}/${MODEL_ID}`);
});

afterEach(async () => {
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	resetSettingsForTest();
	resetLaunchFactsForTest();
	isolated.restore();
});

afterAll(() => {
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	authStorage.close();
	removeSyncWithRetries(sharedDir);
});

describe("a spawned agent records nothing for the next launch", () => {
	it("covers every shape the factory reads as spawned, and no top-level one", () => {
		expect(Object.values(SPAWNED).map(isSubagentSession)).toEqual(Object.keys(SPAWNED).map(() => true));
		expect(isSubagentSession({})).toBe(false);
	});

	for (const [role, extra] of Object.entries(SPAWNED)) {
		it(`${role} alone leaves the record empty`, async () => {
			takeHeldAtRestReading(await create({ ...extra, thinkingLevel: ThinkingLevel.High }));

			const facts = readLaunchFacts();
			expect(facts.modelName).toBeNull();
			expect(facts.providerName).toBeNull();
			expect(facts.contextPercent).toBeNull();
			expect(facts.thinking).toBeNull();
		});

		it(`${role} leaves the top-level session's record as that session filed it`, async () => {
			const model = bundledModel();
			takeHeldAtRestReading(await create({ thinkingLevel: ThinkingLevel.Low }));
			const filed = readLaunchFacts();
			// The positive control: the top-level session reached the record.
			expect(filed.modelName).toBe(model.name);
			expect(filed.providerName).toBe(PROVIDER);
			expect(filed.thinking).toBe(ThinkingLevel.Low);
			expect(filed.contextPercent).not.toBeNull();

			takeHeldAtRestReading(await create({ ...extra, thinkingLevel: ThinkingLevel.High }));

			expect(readLaunchFacts()).toEqual(filed);
		});
	}
});
