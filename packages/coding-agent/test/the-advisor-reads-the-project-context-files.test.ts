/**
 * An advisor's system prompt carries the project context files of the session it watches, and a
 * re-scoped session's advisor carries the new project's files, not the old ones.
 *
 * WHY: the session holds the context files and renders the advisor's `<project-context>` block
 * only when an advisor starts, so a session that never runs one (every spawned agent by default)
 * holds no second copy of its AGENTS.md files. Rendering on demand opens two defects: an advisor
 * that starts without the block, and an advisor rebuilt after a cwd re-scope that keeps the block
 * rendered for the previous project.
 *
 * NOT CAUGHT: the block's layout, which `advisor/watchdog.test.ts` pins.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const FIRST = { path: "/repo/first/AGENTS.md", content: "First project rule: tabs for indentation." };
const SECOND = { path: "/repo/second/AGENTS.md", content: "Second project rule: no default exports." };

describe("the advisor reads the project context files", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@veyyon-advisor-context-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-advisor-context-");
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			// A re-scope rebuilds the advisor from the setting, as a session with the advisor on does.
			settings: Settings.isolated({ "compaction.enabled": false, "advisor.enabled": true }),
			modelRegistry,
			advisorContextFiles: [FIRST],
		});
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
	});

	afterEach(async () => {
		await session.dispose();
		await tempDir.remove();
	});

	const advisorPrompt = (): string => {
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("no advisor started");
		return advisor.state.systemPrompt.join("\n\n");
	};

	it("gives a started advisor the session's context files", () => {
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const prompt = advisorPrompt();
		expect(prompt).toContain("<project-context>");
		expect(prompt).toContain(FIRST.content);
	});

	it("gives an advisor rebuilt after a re-scope the new project's files only", () => {
		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(advisorPrompt()).toContain(FIRST.content);

		session.replaceProjectAdvisorScope({ advisorContextFiles: [SECOND] });
		const prompt = advisorPrompt();
		expect(prompt).toContain(SECOND.content);
		expect(prompt).not.toContain(FIRST.content);
	});

	it("gives an advisor no project-context block when the new project has no context files", () => {
		expect(session.setAdvisorEnabled(true)).toBe(true);
		session.replaceProjectAdvisorScope({ advisorContextFiles: [] });
		expect(advisorPrompt()).not.toContain("<project-context>");
	});
});
