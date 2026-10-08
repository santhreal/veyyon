/**
 * WHY: a session started with `planYolo` runs its first prompt in read-only plan mode and, when the
 * model resolves the plan, switches to the target model with the approved plan in hand. Nothing
 * drove that handoff through a real `AgentSession`, so arming it twice, leaving the plan phase's
 * tools active after approval, or approving without a plan file could each ship green. The handoff
 * is `session/runtime/model-handoff.ts`.
 *
 * The class this closes is a plan-yolo transition that leaves session state half-moved: plan mode,
 * the standing resolve handler, the active tool set and the model change together or not at all,
 * and the target reads the handoff on its first turn. Each case observes all four.
 *
 * What it does not catch: the resolve tool's own dispatch to the standing handler (the handler is
 * invoked directly here) and the wording of the plan-mode prompts, which their own suites pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { type Api, type Model, z } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@veyyon/coding-agent/internal-urls/local-protocol";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { ToolError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const emptySchema = z.object({});

function tool(name: string): AgentTool {
	const defined: AgentTool<typeof emptySchema, undefined> = {
		name,
		label: name,
		description: name,
		parameters: emptySchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	return defined as AgentTool;
}

function modelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model ${id}`);
	return model;
}

function contextText(messages: ReadonlyArray<unknown>): string {
	return JSON.stringify(messages);
}

describe("a plan-yolo run", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@plan-yolo-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	const primary = modelOrThrow("claude-sonnet-4-5");
	const target = modelOrThrow("claude-sonnet-4-6");

	function start(responses: string[]) {
		const mock = createMockModel({ responses: responses.map(text => ({ content: [text] })) });
		const calls: Array<{ model: string; context: string }> = [];
		const record = tool("record");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [record],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				calls.push({ model: model.id, context: contextText(context.messages) });
				return mock.stream(model, context, options);
			},
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map([
				[record.name, record],
				["resolve", tool("resolve")],
			]),
			planYolo: { target },
		});
		const planPath = (url: string) =>
			resolveLocalUrlToPath(url, {
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			});
		return { session, calls, planPath };
	}

	function approve(current: AgentSession, title: string): Promise<unknown> {
		const handler = current.peekStandingResolveHandler();
		if (!handler) throw new Error("Expected a standing resolve handler");
		return Promise.resolve(handler({ action: "apply", reason: "ready", extra: { title } }));
	}

	it("arms plan mode on the first prompt and nowhere before it", async () => {
		const { session: current } = start(["planning"]);

		expect(current.getPlanModeState()).toBeUndefined();
		expect(current.peekStandingResolveHandler()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["record"]);

		await current.prompt("plan the change");

		expect(current.getPlanModeState()).toMatchObject({ enabled: true, workflow: "parallel" });
		expect(current.peekStandingResolveHandler()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(["record", "resolve"]);
		expect(current.model?.id).toBe(primary.id);
	});

	it("restores the tools, leaves plan mode and hands the plan to the target on approval, once", async () => {
		const {
			session: current,
			calls,
			planPath,
		} = start(["planning", "refining", "implementing", "still implementing"]);
		// Two prompts in the plan phase: a second arm would record the plan phase's own tools as the
		// ones to restore.
		await current.prompt("plan the change");
		await current.prompt("refine the plan");
		const planFile = planPath("local://auth-plan.md");
		await fs.mkdir(path.dirname(planFile), { recursive: true });
		await fs.writeFile(planFile, "# Auth\n\n1. Add the check.\n");

		await approve(current, "auth");

		expect(current.model?.id).toBe(target.id);
		expect(current.getPlanModeState()).toBeUndefined();
		expect(current.peekStandingResolveHandler()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["record"]);

		await current.prompt("go");
		const handoffTurn = calls[2];
		expect(handoffTurn.model).toBe(target.id);
		expect(handoffTurn.context).toContain("Plan approved:");
		expect(handoffTurn.context).toContain("local://auth-plan.md");

		// A later prompt neither re-arms plan mode nor narrows the tools again.
		await current.prompt("continue");
		expect(current.getPlanModeState()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["record"]);
		expect(calls.map(call => call.model)).toEqual([primary.id, primary.id, target.id, target.id]);
	});

	it("rejects an approval with no plan file and leaves the plan phase as it was", async () => {
		const { session: current } = start(["planning"]);
		await current.prompt("plan the change");

		await expect(approve(current, "missing")).rejects.toBeInstanceOf(ToolError);

		expect(current.model?.id).toBe(primary.id);
		expect(current.getPlanModeState()).toMatchObject({ enabled: true });
		expect(current.peekStandingResolveHandler()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(["record", "resolve"]);
	});
});
