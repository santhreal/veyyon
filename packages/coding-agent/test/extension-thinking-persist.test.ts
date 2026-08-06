/**
 * WHY: an extension asking for a DURABLE thinking level has to get one.
 *
 * `AgentSession.setThinkingLevel` has taken a `persist` flag for a long time,
 * and `ExtensionAPI` forwards it, but the runtime wirings that connect an
 * extension to a session were written as `level => session.setThinkingLevel(level)`.
 * A one-parameter arrow is assignable to a two-parameter handler type, so
 * TypeScript accepted every one of them and the flag was dropped on the floor:
 * the extension's request became a session-only change that vanished on exit,
 * with nothing anywhere saying so. The published `ExtensionAPI` type did not
 * declare the parameter either, so a typed extension could not even ask.
 *
 * This drives the real wiring built by `initializeExtensions` -- the same
 * closure print and RPC modes install -- and asserts the write reaches the
 * setting the resolver reads. No source is inspected: the runtime handler is
 * called the way an extension calls it, and the assertion is on stored state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { ANY_MODEL_EFFORT_KEY } from "@veyyon/coding-agent/config/effort-resolver";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@veyyon/coding-agent/modes/runtime-init";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("an extension setting a durable thinking level", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let settings: Settings;
	let runtimeSetThinkingLevel: (level: Effort, persist?: boolean) => void;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-ext-thinking-persist-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const loaded = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		settings = Settings.isolated();
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.Low },
			}),
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
			extensionRunner,
		});

		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
		});
		runtimeSetThinkingLevel = loaded.runtime.setThinkingLevel;
	});

	afterEach(async () => {
		await session?.dispose();
		tempDir?.removeSync();
	});

	it("saves it as the profile default", () => {
		runtimeSetThinkingLevel(Effort.High, true);

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(settings.get("defaultEffort")).toEqual({ [ANY_MODEL_EFFORT_KEY]: Effort.High });
	});

	it("changes only the session when it does not ask to persist", () => {
		// The flag has to mean something in both directions: an extension nudging
		// the effort for one turn must not rewrite the operator's saved default.
		runtimeSetThinkingLevel(Effort.High);

		expect(session.thinkingLevel).toBe(Effort.High);
		expect(settings.get("defaultEffort")).toEqual({});
	});
});
