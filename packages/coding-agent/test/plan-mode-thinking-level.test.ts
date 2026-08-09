/**
 * A role's thinking suffix must reach the caller.
 *
 * `modelRoles.plan: "anthropic/claude-sonnet-4-5:xhigh"` used to resolve through
 * `resolveModelRoleValue` and then have only `.model` returned, so plan mode had no
 * level to apply and the operator's suffix did nothing.
 *
 * Every level here is DERIVED from what the model declares rather than written in.
 * A hardcoded `:xhigh` says nothing once the catalog declares `high` and `max` for
 * this model and nothing else: the clamp answers `high`, the case reads red, and the
 * contract it was defending is not the thing that changed. The sweep below asks the
 * round-trip question for every level the model does declare, and one case asks what
 * happens to a level it does not.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { type Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const MODEL_ID = "claude-sonnet-4-5";
const CATALOG_MODEL = getBundledModel("anthropic", MODEL_ID);
if (!CATALOG_MODEL) throw new Error(`Expected anthropic/${MODEL_ID} in the bundled catalog`);
const DECLARED_EFFORTS: readonly Effort[] = getSupportedEfforts(CATALOG_MODEL);
if (DECLARED_EFFORTS.length === 0) throw new Error(`Expected anthropic/${MODEL_ID} to declare thinking efforts`);
const UNDECLARED_EFFORT = THINKING_EFFORTS.find(effort => !DECLARED_EFFORTS.includes(effort));

describe("plan mode thinking level", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-plan-thinking-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSessionWithRoles(modelRoles: Record<string, string>): AgentSession {
		const model = modelRegistry.find("anthropic", MODEL_ID);
		if (!model) throw new Error(`Expected ${MODEL_ID} to exist in registry`);

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ modelRoles }),
			modelRegistry,
		});
		return session;
	}

	describe("resolveRoleModelWithThinking", () => {
		// One case per level the catalog declares for this model, generated from the
		// declaration. A level added to or removed from the model shows up here as a
		// case appearing or disappearing rather than as a stale literal.
		for (const effort of DECLARED_EFFORTS) {
			it(`carries the plan role's ${effort} suffix through to the caller`, () => {
				createSessionWithRoles({ plan: `anthropic/${MODEL_ID}:${effort}` });

				const result = session.resolveRoleModelWithThinking("plan");

				expect(result.model).toBeDefined();
				expect(result.model!.provider).toBe("anthropic");
				expect(result.model!.id).toBe(MODEL_ID);
				expect(result.thinkingLevel).toBe(effort);
				expect(result.explicitThinkingLevel).toBe(true);
			});
		}

		it("returns no explicit thinking level when plan role has no thinking suffix", () => {
			createSessionWithRoles({ plan: `anthropic/${MODEL_ID}` });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.id).toBe(MODEL_ID);
			expect(result.explicitThinkingLevel).toBe(false);
		});

		it("returns no model when no plan role is configured", () => {
			createSessionWithRoles({});

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeUndefined();
		});

		// A suffix the model cannot take is still the operator asking for a level, so it
		// stays explicit and resolves to one the model declares. Silently reporting no
		// level at all would put plan mode back on the model's own default.
		it("resolves a level the model does not declare to one it does, still as explicit", () => {
			if (!UNDECLARED_EFFORT) throw new Error("Expected a level outside the model's declared set");
			createSessionWithRoles({ plan: `anthropic/${MODEL_ID}:${UNDECLARED_EFFORT}` });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.thinkingLevel).not.toBe(UNDECLARED_EFFORT);
			expect(DECLARED_EFFORTS).toContain(result.thinkingLevel as Effort);
		});

		it("works with the default role", () => {
			const effort = DECLARED_EFFORTS[0];
			createSessionWithRoles({ default: `anthropic/${MODEL_ID}:${effort}` });

			const result = session.resolveRoleModelWithThinking("default");
			expect(result.model!.id).toBe(MODEL_ID);
			expect(result.thinkingLevel).toBe(effort);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("resolveRoleModel still returns just the model", () => {
			createSessionWithRoles({ plan: `anthropic/${MODEL_ID}:${DECLARED_EFFORTS[0]}` });

			const model = session.resolveRoleModel("plan");
			expect(model).toBeDefined();
			expect(model!.provider).toBe("anthropic");
			expect(model!.id).toBe(MODEL_ID);
		});
	});
});
