/**
 * A mid-session flip of `tools.intentTracing` reaches the tool schemas of a session `createAgentSession` built.
 *
 * The setting controls two things: the prompt bullet explaining the intent field, and whether each tool schema
 * that takes the field carries it to the provider. `Agent` accepts the second as a resolver it calls per request
 * (`packages/agent/test/intent-tracing-follows-the-setting.test.ts`), but nothing there sees what `sdk.ts`
 * hands it. Passing the resolved value at construction compiles, keeps every prompt test green, and freezes the
 * schemas at the launch value, so the prompt explains a field the schemas stopped carrying. This suite builds a
 * real session through the SDK, writes the setting both ways, and reads the provider context after each write.
 *
 * It does not catch a provider that drops the field after the context is built, which is the provider's
 * contract, nor `VEYYON_INTENT_TRACING` set in the environment, which outranks the setting and fails this suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { isRecord, TempDir } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";

describe("a mid-session intent tracing flip", () => {
	let dir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		dir = TempDir.createSync("@intent-tracing-flip-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-openai-key");
	});

	afterAll(async () => {
		await session?.dispose();
		authStorage.close();
		dir.removeSync();
	});

	it("adds and removes the intent field on every tool schema that takes one", async () => {
		const settings = Settings.isolated();
		const created = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
			sessionManager: SessionManager.inMemory(dir.path()),
			settings,
			model: getBundledModel("openai-codex", "gpt-5.6-sol"),
			disableExtensionDiscovery: true,
		});
		session = created.session;
		const agent = session.agent;

		/** The tools whose schemas carry the intent field in the provider context, by name. */
		const carriers = async (): Promise<string[]> => {
			const { tools = [] } = await agent.buildSideRequestContext([]);
			return tools
				.filter(tool => {
					const schema: unknown = tool.parameters;
					return isRecord(schema) && isRecord(schema.properties) && INTENT_FIELD in schema.properties;
				})
				.map(tool => tool.name)
				.sort();
		};
		// A tool declares `intent: "omit"`, or derives its intent from its arguments, when the field adds nothing.
		const injectable = (agent.state.tools ?? [])
			.filter(tool => tool.intent === undefined || tool.intent === "require" || tool.intent === "optional")
			.map(tool => tool.name)
			.sort();
		expect(injectable.length).toBeGreaterThan(0);

		const seen: string[][] = [];
		for (const enabled of [false, true, false, true]) {
			settings.set("tools.intentTracing", enabled);
			seen.push(await carriers());
		}
		expect(seen).toEqual([[], injectable, [], injectable]);
	});
});
