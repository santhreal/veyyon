/**
 * WHY: an autoswarm arm switches the session onto its own model, and the
 * restore target is held only in `runtime.activeArm`, which a restart does not
 * keep. Recorded as the session's model, that switch survived a quit mid-arm:
 * the resumed session opened on the arm's model with nothing left to return
 * it, and the operator found a model they never chose in the model row.
 *
 * Closes the class: any extension model switch the caller will put back
 * itself. The switch is logged as a fallback, which resume ignores in favour
 * of the session's own model, and every arm switch is made that way.
 *
 * Does not catch: a caller that never asks for `ephemeral`; an arm whose
 * restore is refused while the session stays open, which
 * `an-arm-is-built-by-the-model-configured-for-it` covers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { enterArm, leaveArm } from "@veyyon/coding-agent/autoresearch/arm-model";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionAPI, SetModelOptions } from "@veyyon/coding-agent/extensibility/extensions";
import { runExtensionSetModel } from "@veyyon/coding-agent/extensibility/extensions/compact-handler";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createCtx } from "./helpers/autoresearch-session";

function bundled(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
	return model;
}

describe("a session quit mid-arm resumes on its own model", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	let open: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-arm-resume-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-arm-resume-");
	});

	afterEach(async () => {
		for (const session of open) await session.dispose();
		open = [];
		tempDir.removeSync();
	});

	/**
	 * A persisted session on `ownModel` with one completed turn, the state a
	 * loop is in when an arm starts. The file exists only once an assistant
	 * message is in the history.
	 */
	function liveSession(ownModel: Model<Api>): { session: AgentSession; file: string } {
		const settings = Settings.isolated();
		settings.setModelRole("default", `${ownModel.provider}/${ownModel.id}`);
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"));
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: ownModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager,
			settings,
			modelRegistry,
		});
		open.push(session);
		sessionManager.appendModelChange(`${ownModel.provider}/${ownModel.id}`, "default");
		sessionManager.appendMessage({ role: "user", content: "start the loop", timestamp: Date.now() });
		const reply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "started" }],
			api: ownModel.api,
			provider: ownModel.provider,
			model: ownModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage(reply);
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		return { session, file };
	}

	/** What a quit leaves on disk: everything the session logged so far. */
	async function quit(session: AgentSession): Promise<void> {
		await session.sessionManager.flush();
	}

	/** The model the next launch opens `file` on. */
	async function resumedModelId(file: string, ownModel: Model<Api>): Promise<string | undefined> {
		const settings = Settings.isolated();
		settings.setModelRole("default", `${ownModel.provider}/${ownModel.id}`);
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager: await SessionManager.open(file, path.join(tempDir.path(), "startup")),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		open.push(result.session);
		return result.session.model?.id;
	}

	it("returns to the session's own model after an ephemeral switch, and stays on a plain one", async () => {
		const own = bundled("claude-sonnet-4-5");
		const arm = bundled("claude-sonnet-4-6");

		const ephemeral = liveSession(own);
		expect(await runExtensionSetModel(ephemeral.session, arm, { ephemeral: true })).toBe(true);
		expect(ephemeral.session.model?.id).toBe(arm.id);
		await quit(ephemeral.session);
		expect(await resumedModelId(ephemeral.file, own)).toBe(own.id);

		// The control: the same switch recorded as the session's model DOES survive
		// a quit, which is what makes the ephemeral flag the only thing that fixes it.
		const plain = liveSession(own);
		expect(await runExtensionSetModel(plain.session, arm)).toBe(true);
		await quit(plain.session);
		expect(await resumedModelId(plain.file, own)).toBe(arm.id);
	});

	it("makes every arm switch ephemeral: onto the arm, back off it, and out of a stranded one", async () => {
		const own = bundled("claude-sonnet-4-5");
		const armModel = bundled("claude-sonnet-4-6");
		let current: Model<Api> | undefined = own;
		let accept = true;
		const switches: Array<{ id: string; options: SetModelOptions | undefined }> = [];
		const pi = {
			setModel: async (model: Model, options?: SetModelOptions) => {
				switches.push({ id: model.id, options });
				if (!accept) return false;
				current = model as Model<Api>;
				return true;
			},
		} as unknown as ExtensionAPI;
		const ctx = createCtx(tempDir.path(), "arm-resume", {
			current: () => current,
			resolve: (spec: string) => (spec === "arm" ? armModel : undefined),
		});
		const runtime = createSessionRuntime();

		expect((await enterArm(ctx, pi, runtime, "a1", "arm")).ok).toBe(true);
		// Refuse the restore, so the next enter has to move a stranded session.
		accept = false;
		expect((await leaveArm(pi, runtime)).strandedOn).toBe(armModel.name);
		accept = true;
		expect((await enterArm(ctx, pi, runtime, "a0", undefined)).ok).toBe(true);
		expect(current?.id).toBe(own.id);

		expect(switches.map(entry => entry.id)).toEqual([armModel.id, own.id, own.id]);
		expect(switches.every(entry => entry.options?.ephemeral === true)).toBe(true);
	});
});
