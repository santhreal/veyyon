import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initializeExtensions } from "@veyyon/coding-agent/modes/runtime-init";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

// Regression for issue #5305: image-gen is registered as a custom tool, and
// custom tools are force-activated regardless of the `toolNames` filter. Before
// the fix, `generate_image` survived `--no-tools` (an empty `toolNames`), any
// explicit whitelist that omitted it, and had no `generate_image.enabled`
// settings toggle. The SDK must honor the whitelist and the new setting.
describe("generate_image tool gating", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-generate-image-gating-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function makeSession(
		settings: Settings,
		toolNames?: string[],
		sessionManager: SessionManager = SessionManager.inMemory(),
		model: Model = getBundledModel("openai", "gpt-4o-mini"),
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager,
			settings,
			model,
			disableExtensionDiscovery: true,
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	async function activeToolNames(settings: Settings, toolNames?: string[]): Promise<string[]> {
		return (await makeSession(settings, toolNames)).getActiveToolNames();
	}

	it("excludes generate_image from a restricted tool whitelist", async () => {
		const names = await activeToolNames(Settings.isolated({}), ["read"]);
		expect(names).toContain("read");
		expect(names).not.toContain("generate_image");
	});

	it("excludes generate_image under --no-tools (empty whitelist)", async () => {
		const names = await activeToolNames(Settings.isolated({}), []);
		expect(names).not.toContain("generate_image");
	});

	it("respects generate_image.enabled=false even when requested", async () => {
		const names = await activeToolNames(Settings.isolated({ "generate_image.enabled": false }), [
			"read",
			"generate_image",
		]);
		expect(names).not.toContain("generate_image");
	});

	/**
	 * The disabled setting is stronger than discovery-all: generate_image must
	 * be absent from both the provider schema and the searchable inventory.
	 */
	it("does not register disabled generate_image in discovery-all", async () => {
		const session = await makeSession(
			Settings.isolated({ "generate_image.enabled": false, "tools.discoveryMode": "all" }),
		);

		expect(session.getAllToolNames()).not.toContain("generate_image");
		expect(session.getDiscoverableTools().map(tool => tool.name)).not.toContain("generate_image");
	});

	it("includes generate_image when explicitly requested and enabled", async () => {
		const names = await activeToolNames(Settings.isolated({}), ["read", "generate_image"]);
		expect(names).toContain("generate_image");
	});

	/**
	 * Default/off discovery must retain the first-party tool's eager exposure;
	 * adding discovery metadata must not turn it into an always-lazy tool.
	 */
	it("keeps generate_image active under default discovery settings", async () => {
		const session = await makeSession(Settings.isolated({}));
		expect(session.getActiveToolNames()).toContain("generate_image");
	});

	/**
	 * Discovery-all previously exposed generate_image because its custom-tool
	 * registration bypassed built-in load modes. It must start hidden yet remain
	 * in the same searchable inventory used by every discoverable tool.
	 */
	it("hides generate_image initially in discovery-all and indexes it for search", async () => {
		const session = await makeSession(Settings.isolated({ "tools.discoveryMode": "all" }));

		expect(session.getActiveToolNames()).not.toContain("generate_image");
		expect(session.getDiscoverableTools()).toContainEqual(
			expect.objectContaining({
				name: "generate_image",
				source: "custom",
				summary: expect.stringContaining("image"),
			}),
		);
	});

	/**
	 * An explicit SDK whitelist is authoritative even in discovery-all mode.
	 * A requested generate_image tool must survive initial discovery filtering.
	 */
	it("keeps explicitly requested generate_image active in discovery-all", async () => {
		const session = await makeSession(Settings.isolated({ "tools.discoveryMode": "all" }), [
			"read",
			"generate_image",
		]);

		expect(session.getActiveToolNames()).toContain("generate_image");
		expect(session.getDiscoverableTools().map(tool => tool.name)).not.toContain("generate_image");
	});

	/**
	 * Search activation must remain selected and callable after the discovery
	 * request completes. Before this contract, custom-tool activation could be
	 * transient even though the search response reported it as activated.
	 */
	it("persists searched generate_image activation in the live session", async () => {
		const session = await makeSession(Settings.isolated({ "tools.discoveryMode": "all" }));
		const searchTool = session.getToolByName("search_tool_bm25");
		if (!searchTool) throw new Error("Expected search_tool_bm25 to be registered");

		const searchResult = await searchTool.execute("search-image", { query: "generate image", limit: 5 });

		expect(searchResult.details).toEqual(
			expect.objectContaining({
				activated_tools: ["generate_image"],
				active_selected_tools: ["generate_image"],
			}),
		);
		expect(session.getActiveToolNames()).toContain("generate_image");
		expect(session.getSelectedDiscoveredToolNames()).toContain("generate_image");
		expect(session.getDiscoverableTools().map(tool => tool.name)).not.toContain("generate_image");
	});

	/**
	 * Activation must expose the real first-party executor, not a discovery
	 * placeholder. A local provider endpoint pins the exact registered-tool
	 * result without replacing global fetch or module state.
	 */
	it("executes generate_image after search activation with the exact provider result", async () => {
		authStorage.setRuntimeApiKey("openai", "test-openai-key");
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				requests++;
				return Response.json({ output: [] });
			},
		});
		try {
			const model: Model = {
				...getBundledModel("openai", "gpt-4o-mini"),
				id: "gpt-image-discovery-test",
				baseUrl: `${server.url.origin}/v1`,
			};
			const session = await makeSession(
				Settings.isolated({ "tools.discoveryMode": "all" }),
				undefined,
				undefined,
				model,
			);
			await initializeExtensions(session, {
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: extensionError => {
					throw extensionError.error;
				},
			});
			const searchTool = session.getToolByName("search_tool_bm25");
			if (!searchTool) throw new Error("Expected search_tool_bm25 to be registered");
			await searchTool.execute("search-image-execution", { query: "generate image", limit: 5 });
			expect(session.getActiveToolNames()).toContain("generate_image");

			const generateImage = session.getToolByName("generate_image");
			if (!generateImage) throw new Error("Expected generate_image to remain registered");
			const result = await generateImage.execute("generate-image", { subject: "a brass telescope" });

			expect(requests).toBe(1);
			expect(result).toEqual({
				isError: true,
				content: [
					{
						type: "text",
						text: [
							"Image generation failed: openai (gpt-image-discovery-test) returned a response with no image in it.",
							"",
							"This can be transient. Retry once; if it happens again, change the prompt or pick a different provider or model.",
						].join("\n"),
					},
				],
				details: {
					provider: "openai",
					model: "gpt-image-discovery-test",
					imageCount: 0,
					imagePaths: [],
					images: [],
					revisedPrompt: undefined,
					usage: undefined,
				},
			});
		} finally {
			server.stop(true);
		}
	});

	// Regression for HUNT-SDKWIRING-CUSTOMTOOL-WHITELIST-BYPASS: tts is registered
	// exactly like image-gen — a force-activated custom tool — but did NOT honor an
	// explicit `toolNames` whitelist, so it survived `--no-tools` and any whitelist
	// that omitted it. The SDK now gates it on the whitelist the same way. (Exa's
	// tools share the identical `whitelist` filter; they are not asserted here only
	// because discovery makes a live round trip that would need a network stub.)
	it("excludes tts from a restricted tool whitelist even when speechgen is enabled", async () => {
		const names = await activeToolNames(Settings.isolated({ "speechgen.enabled": true }), ["read"]);
		expect(names).toContain("read");
		expect(names).not.toContain("tts");
	});

	it("excludes tts under --no-tools (empty whitelist) even when speechgen is enabled", async () => {
		const names = await activeToolNames(Settings.isolated({ "speechgen.enabled": true }), []);
		expect(names).not.toContain("tts");
	});

	it("includes tts when explicitly requested and speechgen is enabled", async () => {
		const names = await activeToolNames(Settings.isolated({ "speechgen.enabled": true }), ["read", "tts"]);
		expect(names).toContain("tts");
	});
});
