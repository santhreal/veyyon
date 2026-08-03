import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WORKFLOW_NOTICE } from "@veyyon/coding-agent/modes/workflow";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import {
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedSkillTurn = {
	texts: string[];
};

// 4644 gates the workflowz notice on an active `task` tool; keep one active so
// keyword steering exercises the notice path.
const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

describe("AgentSession skill prompt keyword steering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let startSession: (overrides?: Record<string, unknown>) => AgentSession;
	const observedTurns: ObservedSkillTurn[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-agent-session-skill-keywords-");
		observedTurns.length = 0;

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [mockTaskTool],
				messages: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				observedTurns.push({
					texts: context.messages.map(message => {
						const content = message.content;
						if (typeof content === "string") return content;
						if (!Array.isArray(content)) return "";
						return content
							.filter((block): block is TextContent => block.type === "text")
							.map(block => block.text)
							.join("\n");
					}),
				});
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response = createAssistantMessage("done");
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		startSession = overrides => {
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings: Settings.isolated({ "compaction.enabled": false, ...overrides }),
				modelRegistry,
			});
			return session;
		};
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	const SKILL_ARGS = "workflowz +500k! compare these approaches";

	const promptSkill = async (): Promise<ObservedSkillTurn> => {
		const skillPath = path.join(tempDir.path(), "deep-research.md");
		const details: SkillPromptDetails = {
			name: "deep-research",
			path: skillPath,
			args: SKILL_ARGS,
			lineCount: 1,
		};
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: `Skill body\n\n---\n\nSkill: ${skillPath}\nUser: ${details.args}`,
			display: true,
			details,
			attribution: "user",
		});

		expect(observedTurns).toHaveLength(1);
		const observedTurn = observedTurns[0];
		if (!observedTurn) throw new Error("Expected prompt context to be captured");
		// Outbound wire-path canonicalization (relativize-paths.ts, TW-10) rewrites
		// any absolute path under a session root to its session-relative form before
		// it reaches the model, so the skill path arrives relativized, not absolute.
		const wireSkillPath = path.relative(tempDir.path(), skillPath);
		expect(observedTurn.texts).toContain(`Skill body\n\n---\n\nSkill: ${wireSkillPath}\nUser: ${SKILL_ARGS}`);
		return observedTurn;
	};

	/**
	 * The armed half of the opt-in contract: with `magicKeywords.turnBudget` on, a
	 * `+500k!` written by the skill author is a real directive, so it arms a HARD
	 * ceiling on the session rather than riding to the model as prose. The workflowz
	 * notice is asserted alongside it because both are keyword steering off the same
	 * user-authored args, and a regression that stops parsing the args at all would
	 * otherwise still satisfy a budget-only assertion.
	 */
	it("arms a hard turn budget from user-authored skill args when the keyword is enabled", async () => {
		startSession({ "magicKeywords.turnBudget": true });

		const observedTurn = await promptSkill();

		expect(observedTurn.texts).toContain(WORKFLOW_NOTICE);
		expect(session.sessionManager.getTurnBudget()).toEqual({ total: 500_000, spent: 0, hard: true });
	});

	/**
	 * The negative twin, and the reason this file changed: `magicKeywords.turnBudget`
	 * now DEFAULTS OFF, so on a default install `+500k!` inside skill args is ordinary
	 * text. This locks out the silent-ceiling regression the opt-in exists to prevent,
	 * where a phrase an author never meant as a directive quietly caps the session's
	 * spend. The identical args flow through untouched, and the session stays unbudgeted.
	 */
	it("leaves the budget directive inert in skill args on a default install", async () => {
		startSession();

		await promptSkill();

		expect(session.sessionManager.getTurnBudget()).toEqual({ total: null, spent: 0, hard: false });
	});
});
