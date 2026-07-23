/**
 * AgentSession constructor thinking-level clamp.
 *
 * The bug this suite locks out (found live 2026-07-22): the constructor took
 * `config.thinkingLevel` UNCLAMPED against the session's model. A persisted
 * `high` (set while on another model) landing on a reasoning model with no
 * controllable effort surface (devin/swe-1-6: `thinking: undefined`) was
 * forwarded to the wire, and `requireSupportedEffort` threw at the FIRST
 * stream of every turn — combined with the pre-stream error being swallowed
 * by the TUI (see event-controller-error-banner.test.ts), every submitted
 * prompt silently vanished and the session was unusable.
 *
 * The restore path (session resume) already clamped via
 * `resolveThinkingLevelForModel`; the constructor now mirrors it. These tests
 * pin both directions: clamp-to-undefined for dial-less models, pass-through
 * for models whose ladder includes the requested effort, and `off` preserved.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@veyyon/agent-core";
import { Effort } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("AgentSession constructor thinking-level clamp", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-thinking-clamp-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		tempDir.removeSync();
	});

	async function createSession(provider: string, modelId: string, thinkingLevel: ThinkingLevel) {
		const model = getBundledModel(provider as Parameters<typeof getBundledModel>[0], modelId);
		if (!model) throw new Error(`Expected bundled model ${provider}/${modelId}`);
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${modelId}.db`));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			thinkingLevel,
		});
		return { session, model };
	}

	it("clamps an unsupported configured level to undefined on a dial-less reasoning model", async () => {
		// xai-oauth/grok-4.20-0309-reasoning thinks natively but exposes no wire
		// effort dial (`thinking: undefined`). Pre-fix `high` was stored as-is
		// and thrown at first stream; post-fix no effort is forwarded at all.
		const { session } = await createSession("xai-oauth", "grok-4.20-0309-reasoning", Effort.High);
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("keeps a configured level the model's ladder actually supports (positive twin)", async () => {
		const { session, model } = await createSession("anthropic", "claude-sonnet-4-5", Effort.High);
		expect(model.thinking?.efforts).toContain(Effort.High);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("preserves an explicit off on any model", async () => {
		// `off` is a user decision, not an effort on the ladder: the clamp must
		// never convert it into a concrete effort or drop it.
		const { session } = await createSession("xai-oauth", "grok-4.20-0309-reasoning", ThinkingLevel.Off);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
	});
});
