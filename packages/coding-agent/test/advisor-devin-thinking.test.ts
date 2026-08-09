import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { resolveThinkingLevelForModel } from "@veyyon/coding-agent/thinking";
import { TempDir } from "@veyyon/utils";

// Regression for https://github.com/can1357/oh-my-pi/issues/4579.
//
// When the advisor role resolves to a reasoning model without a controllable
// effort surface (Devin `devin-agent`: `reasoning: true`, `thinking: undefined`
// — Cascade routes by sibling model id, not a wire param), the advisor
// descriptor MUST NOT hand the Agent a concrete `Effort.Medium` default. That
// would trip `requireSupportedEffort` inside `stream.ts` on the first prompt
// and disable the advisor session-wide with an empty
// `Supported efforts:` warning list.
//
// This mirrors the `auto`-path fix already covered by
// `auto-thinking-classifier.test.ts:145` for `clampAutoThinkingEffort`, at the
// advisor descriptor boundary.
describe("AgentSession advisor descriptor thinking level", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let anthropicModel: Model;
	let devinModel: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-advisor-devin-thinking-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// Seeding a runtime API key exposes the bundled Devin catalog for
		// `resolveAdvisorRoleSelection` / `getAvailable()` without any live
		// network discovery.
		authStorage.setRuntimeApiKey("devin", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		// A Devin model that still has the regression shape: `reasoning: true` with
		// NO controllable `thinking` descriptor. `glm-5-2` gained an effort
		// descriptor upstream, so it no longer exercises the no-thinking clamp path.
		const devin = getBundledModel("devin", "swe-1-6-fast");
		if (!anthropic) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		if (!devin) throw new Error("Expected bundled devin/swe-1-6-fast to exist");
		anthropicModel = anthropic;
		devinModel = devin;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-devin-thinking-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model: anthropicModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("Devin advisor with no configured thinking suffix boots without an unsupported-effort throw", () => {
		// Confirm the catalog shape that triggered the bug: `reasoning: true` with
		// no controllable `thinking.efforts`. If this drifts upstream the
		// regression's assumptions no longer hold.
		expect(devinModel.reasoning).toBe(true);
		expect(devinModel.thinking).toBeUndefined();

		session.settings.setModelRole("advisor", `${devinModel.provider}/${devinModel.id}`);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.isAdvisorActive()).toBe(true);

		// Before the fix, the descriptor hardcoded `ThinkingLevel.Medium` which
		// flowed to `Agent#state.thinkingLevel` and then tripped
		// `requireSupportedEffort` inside `mapOptionsForApi`'s `devin-agent`
		// branch on the first stream. The clamp now forwards no explicit effort
		// (mirroring `clampAutoThinkingEffort`), so the Agent stores `undefined`
		// and the provider's default routing applies.
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.model.provider).toBe(devinModel.provider);
		expect(advisor.state.model.id).toBe(devinModel.id);
		expect(advisor.state.thinkingLevel).toBeUndefined();
		// `Off` is reserved for the explicit "disable reasoning" selector; the
		// Devin path forwards no effort while keeping reasoning enabled.
		expect(advisor.state.disableReasoning).toBe(false);
	});

	it("Anthropic advisor with no configured thinking suffix keeps the medium default", () => {
		// claude-sonnet-4-5 is budget mode, and a budget transport takes any legal
		// integer, so the catalog gives it minimal..xhigh: medium is selectable and
		// nothing clamps. The Devin test above guards the no-surface direction, and
		// the next one guards a ladder that genuinely lacks the default.
		session.settings.setModelRole("advisor", `${anthropicModel.provider}/${anthropicModel.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.model.provider).toBe(anthropicModel.provider);
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("clamps the medium default onto a ladder that omits it", () => {
		// The descriptor asks `resolveThinkingLevelForModel(model, Medium)` for the
		// level it hands the Agent (agent-session.ts, advisor branch), so the clamp
		// is only observable on a row whose ladder omits the default. Only google
		// ships one: gemini-3-pro-preview declares low/high, a google-level ladder
		// with a genuine gap. This session carries no google credential, so the
		// owner is driven directly rather than through a second fixture provider.
		const gemini = getBundledModel("google", "gemini-3-pro-preview");
		if (!gemini) throw new Error("Expected bundled google/gemini-3-pro-preview to exist");
		expect(gemini.thinking?.efforts).not.toContain(Effort.Medium);

		const resolved = resolveThinkingLevelForModel(gemini, ThinkingLevel.Medium);
		expect(gemini.thinking?.efforts).toContain(resolved);
	});

	it("Anthropic advisor on a model declaring medium keeps the medium default", () => {
		// claude-opus-4-5 declares [low, medium, high]: no clamp may fire.
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		if (!opus) throw new Error("Expected bundled anthropic/claude-opus-4-5 to exist");
		session.settings.setModelRole("advisor", `${opus.provider}/${opus.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("Devin advisor with an explicit :off suffix disables reasoning without clamping to inherit", () => {
		// `off` is an explicit user opt-out and MUST reach the Agent as
		// `disableReasoning: true` regardless of the model's effort surface. The
		// clamp helper preserves `off`; verifying that here so a future change
		// to the descriptor doesn't route `off` through the Devin
		// no-controllable-effort fallback and silently re-enable reasoning.
		session.settings.setModelRole("advisor", `${devinModel.provider}/${devinModel.id}:off`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBeUndefined();
		expect(advisor.state.disableReasoning).toBe(true);
	});
});
