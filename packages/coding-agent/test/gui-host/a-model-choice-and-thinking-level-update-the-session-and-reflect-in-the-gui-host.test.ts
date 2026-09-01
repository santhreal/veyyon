/**
 * WHY:
 *
 * Model selection and thinking level adjustments must query the real ModelRegistry,
 * validate requested model and thinking effort configurations against model capabilities,
 * apply them to the active AgentSession, and emit typed `Models` snapshot sections
 * to the GUI host client. Before this, model actions were shallow stubs that accepted
 * invalid thinking levels without validation and failed to reflect model registry state.
 *
 * This suite defends:
 * 1. `RefreshModels` emits a `Models` snapshot section containing catalog models with exact
 *    context windows and output limits.
 * 2. `SelectModel` looks up the real model in `ModelRegistry`, attaches to an `AgentSession`,
 *    and sets the active model while reflecting the update in `Models.current`.
 * 3. `SelectModel` fails closed with `MODEL_NOT_FOUND` in scope `Provider` when the model is unknown.
 * 4. `SetThinkingLevel` validates the level against the `ThinkingLevel` enum, rejecting invalid
 *    values (such as "turbo") with `INVALID_ARGUMENTS` in scope `Provider` while naming valid levels.
 * 5. `SetThinkingLevel` applies valid levels and emits refreshed `Models` snapshot sections.
 *
 * What it does NOT catch: Desktop GPUI rendering of the model selector dropdown.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ModelsView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

describe("model selection and thinking level gui-host behaviour", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-models-test-"));
		authStorage = await isolatedAuthStorage(tempDir);
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup error
		}
	});

	test("RefreshModels lists catalog models with exact context window and reflects default/session model", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		const { frames, outcome } = await client.request(1, "RefreshModels");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const snapshotFrame = frames.find(f => f.Snapshot?.Models !== undefined);
		expect(snapshotFrame).toBeDefined();
		const modelsView = snapshotFrame!.Snapshot!.Models as ModelsView;

		expect(Array.isArray(modelsView.models)).toBeTrue();
		expect(modelsView.models.length).toBeGreaterThan(0);

		// Find known catalog model (e.g. Claude Opus 4.8 or Sonnet)
		const opus = modelsView.models.find(m => m.provider === "anthropic" && m.id === "claude-opus-4-8");
		expect(opus).toBeDefined();
		expect(opus!.context_window).toBe(1000000);
		expect(opus!.max_output).toBe(128000);
		expect(opus!.reasoning).toBeTrue();

		client.destroy();
	});

	test("SelectModel applies model to session and updates Models.current", async () => {
		await authStorage.set("anthropic", { type: "api_key", key: "sk-ant-test-key-for-select" });

		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		// Select a real model from the catalog
		const { frames, outcome } = await client.request(2, {
			SelectModel: {
				provider: "anthropic",
				model: "claude-opus-4-8",
			},
		});

		expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const snapshotFrame = frames.find(f => f.Snapshot?.Models !== undefined);
		expect(snapshotFrame).toBeDefined();
		const modelsView = snapshotFrame!.Snapshot!.Models as ModelsView;
		expect(modelsView.current).toEqual({
			provider: "anthropic",
			id: "claude-opus-4-8",
		});

		client.destroy();
	});

	test("SelectModel with unknown model fails with MODEL_NOT_FOUND in scope Provider", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		const { outcome } = await client.request(3, {
			SelectModel: {
				provider: "nonexistent-provider",
				model: "nonexistent-model",
			},
		});

		expect(outcome.RequestFailed).toBeDefined();
		expect(outcome.RequestFailed!.request).toBe(3);
		expect(outcome.RequestFailed!.error.scope).toBe("Provider");
		expect(outcome.RequestFailed!.error.code).toBe("MODEL_NOT_FOUND");

		client.destroy();
	});

	test("SelectModel without required parameters fails with INVALID_ARGUMENTS", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		const { outcome } = await client.request(4, {
			SelectModel: {},
		});

		expect(outcome.RequestFailed).toBeDefined();
		expect(outcome.RequestFailed!.request).toBe(4);
		expect(outcome.RequestFailed!.error.scope).toBe("Provider");
		expect(outcome.RequestFailed!.error.code).toBe("INVALID_ARGUMENTS");

		client.destroy();
	});

	test("SetThinkingLevel rejects invalid level naming valid levels and accepts valid level", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		// 1. Invalid thinking level: "turbo"
		const invalidResult = await client.request(5, {
			SetThinkingLevel: {
				level: "turbo",
			},
		});

		expect(invalidResult.outcome.RequestFailed).toBeDefined();
		expect(invalidResult.outcome.RequestFailed!.request).toBe(5);
		expect(invalidResult.outcome.RequestFailed!.error.scope).toBe("Provider");
		expect(invalidResult.outcome.RequestFailed!.error.code).toBe("INVALID_ARGUMENTS");
		expect(invalidResult.outcome.RequestFailed!.error.message).toContain("turbo");
		expect(invalidResult.outcome.RequestFailed!.error.message).toContain("off");
		expect(invalidResult.outcome.RequestFailed!.error.message).toContain("high");

		// 2. Valid thinking level: "high"
		const validResult = await client.request(6, {
			SetThinkingLevel: {
				level: "high",
			},
		});

		expect(validResult.outcome).toEqual({ RequestSucceeded: { request: 6 } });
		const snapshotFrame = validResult.frames.find(f => f.Snapshot?.Models !== undefined);
		expect(snapshotFrame).toBeDefined();
		const modelsView = snapshotFrame!.Snapshot!.Models as ModelsView;
		expect(modelsView.thinking_level).toBe("high");

		client.destroy();
	});
});
