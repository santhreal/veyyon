/**
 * WHY: `AgentSession.prompt` awaits the `before_agent_start` extension hook,
 * and a host extension holds that await open for as long as it likes. The
 * generation check that follows it was once deleted in favour of a startup
 * marker, which let a turn the user had already aborted go on to issue an
 * auto-thinking classifier request and to run pre-prompt compaction before the
 * next check stopped it. That request is billed and that compaction pass
 * rewrites session context, both for a turn that no longer exists.
 *
 * The class this closes: an awaited setup stage between prompt entry and the
 * model request re-checks the prompt generation before spending anything else
 * on the turn. Driven here at the `before_agent_start` seam, the one a host
 * controls directly, with a positive control proving the classifier does run
 * for a turn that is not superseded — without it, a suite that only asserts
 * "not called" passes when the classifier is unreachable for any reason.
 *
 * What it does not catch: a new awaited stage inserted between two existing
 * checks. The stages are statements in one method rather than a registry, so
 * they cannot be enumerated at run time and a new one is not detected here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { Effort } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import * as classifier from "@veyyon/coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";
import { TempDir } from "@veyyon/utils";

describe("a prompt superseded inside before_agent_start", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-superseded-before-agent-start-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	/**
	 * `onHook` runs while the session is suspended inside the extension hook,
	 * which is the window an abort has to land in for this contract to matter.
	 */
	function createSession(onHook?: () => void) {
		const emitBeforeAgentStart = vi.fn(async () => {
			onHook?.();
			return undefined;
		});
		const extensionRunner = {
			emitBeforeAgentStart,
			emit: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
			thinkingLevel: AUTO_THINKING,
		});

		return { emitBeforeAgentStart };
	}

	it("classifies the thinking level when the turn is not superseded", async () => {
		const classify = vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("write the parser");

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(classify).toHaveBeenCalledTimes(1);
	});

	it("issues no classifier request when an abort lands inside the hook", async () => {
		const classify = vi.spyOn(classifier, "classifyDifficulty").mockResolvedValue(Effort.Medium);
		let aborted: Promise<void> | undefined;
		const { emitBeforeAgentStart } = createSession(() => {
			aborted = session.abort({ reason: "user-interrupt" });
		});

		await session.prompt("write the parser");
		await aborted;

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(classify).not.toHaveBeenCalled();
	});
});
