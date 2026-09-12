/**
 * WHY:
 *
 * The GUI host built its model list from `ModelRegistry.getAll()`, the whole
 * bundled catalog. On this machine that is 5234 models across 62 providers, of
 * which 4186 across 49 providers hold no credential: four fifths of the picker
 * were rows that cannot run a turn, and `SelectModel` accepted any of them and
 * persisted it as the default role, so the refusal arrived at the first prompt
 * instead of at the click. The terminal has always filtered the same list by
 * credential (`getAvailable()`), and it refreshes the registry the moment a
 * sign-in completes; the GUI host did neither, so a provider authenticated from
 * the desktop contributed nothing until something else happened to rebuild the
 * view.
 *
 * The class this closes: the host offers a choice it cannot honour, or holds
 * back one it can. Both halves are one contract — the list states what a turn
 * could run, at the moment it is sent.
 *
 * This suite defends:
 * 1. Every provider in the `Models` snapshot holds a credential or needs none,
 *    swept over whatever the shipped catalog contains rather than a fixed list.
 * 2. A provider with no credential contributes no models, and contributes them
 *    once it has one.
 * 3. Authenticating through `SubmitAuthSecret` publishes the new list within the
 *    same request, with no `RefreshModels` from the client.
 * 4. `SelectModel` refuses a model whose provider holds no credential, with
 *    `MODEL_NOT_AUTHENTICATED` in scope `Provider`, and leaves the selection
 *    alone.
 * 5. A provider that declares `auth: "none"` is offered though no credential is
 *    stored for it, so the filter is "could run" and not "has a stored key".
 *
 * What it does NOT catch: how the desktop draws an empty picker, and a
 * discovery-backed provider whose models arrive only from its own endpoint —
 * the registry refresh that fetches them is disabled under the test runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ModelsView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

/** The one provider this suite signs in, chosen because the bundled catalog lists it. */
const PROVIDER = "anthropic";
const MODEL = "claude-opus-4-8";
const SECRET = "sk-ant-not-a-real-key-000111";

function modelsFrom(frames: { Snapshot?: { Models?: unknown } }[]): ModelsView {
	const frame = frames.find(f => f.Snapshot?.Models !== undefined);
	expect(frame).toBeDefined();
	return frame!.Snapshot!.Models as ModelsView;
}

function providersIn(view: ModelsView): string[] {
	return [...new Set(view.models.map(model => model.provider))].sort();
}

describe("the model list the gui host sends", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-offered-models-"));
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

	async function start(): Promise<TestSocketClient> {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		return TestSocketClient.connect(server.endpoint);
	}

	test("every provider it offers holds a credential or needs none", async () => {
		await authStorage.set(PROVIDER, { type: "api_key", key: SECRET });
		const client = await start();
		try {
			// The truth is asked of the credential store and the registry's own
			// keyless set, never of the filter under test.
			const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
			const { frames } = await client.request(1, "RefreshModels");
			const offered = providersIn(modelsFrom(frames));

			expect(offered).toContain(PROVIDER);
			const unrunnable = offered.filter(
				provider => !authStorage.hasAuth(provider) && !registry.isKeylessProvider(provider),
			);
			expect(unrunnable).toEqual([]);
		} finally {
			client.destroy();
		}
	});

	test("a provider with no credential contributes no models", async () => {
		const client = await start();
		try {
			const { frames } = await client.request(1, "RefreshModels");
			const view = modelsFrom(frames);
			expect(view.models.filter(model => model.provider === PROVIDER)).toEqual([]);
			expect(providersIn(view)).not.toContain(PROVIDER);
		} finally {
			client.destroy();
		}
	});

	test("authenticating a provider publishes its models in the same request", async () => {
		const client = await start();
		try {
			const before = providersIn(modelsFrom((await client.request(1, "RefreshModels")).frames));
			expect(before).not.toContain(PROVIDER);

			const { frames, outcome } = await client.request(2, {
				SubmitAuthSecret: { provider: PROVIDER, secret: SECRET },
			});
			expect(outcome).toEqual({ RequestSucceeded: { request: 2 } });

			// The client asked for no models: the frame is the host's own.
			const after = modelsFrom(frames);
			expect(providersIn(after)).toContain(PROVIDER);
			expect(after.models.some(model => model.id === MODEL)).toBeTrue();
			// Signing one provider in adds that provider and nothing else.
			expect(providersIn(after).filter(provider => !before.includes(provider))).toEqual([PROVIDER]);
			// And the secret is not echoed back with the list it unlocked.
			expect(JSON.stringify(frames)).not.toContain(SECRET);
		} finally {
			client.destroy();
		}
	});

	test("SelectModel refuses a model whose provider holds no credential", async () => {
		const client = await start();
		try {
			const { outcome } = await client.request(1, { SelectModel: { provider: PROVIDER, model: MODEL } });
			expect(outcome.RequestFailed).toBeDefined();
			expect(outcome.RequestFailed!.error.scope).toBe("Provider");
			expect(outcome.RequestFailed!.error.code).toBe("MODEL_NOT_AUTHENTICATED");
			expect(outcome.RequestFailed!.error.message).toContain(PROVIDER);

			// Refused means unchanged: nothing was persisted as the model in effect.
			const view = modelsFrom((await client.request(2, "RefreshModels")).frames);
			expect(view.current).toBeNull();
		} finally {
			client.destroy();
		}
	});

	test("a provider that needs no credential is offered without one", async () => {
		await fs.writeFile(
			path.join(tempDir, "models.yml"),
			JSON.stringify({
				providers: {
					keyless: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						auth: "none",
						models: [{ id: "local-model", name: "Local Model", contextWindow: 4096, maxTokens: 256 }],
					},
				},
			}),
		);
		const client = await start();
		try {
			const view = modelsFrom((await client.request(1, "RefreshModels")).frames);
			expect(authStorage.hasAuth("keyless")).toBeFalse();
			expect(view.models.find(model => model.provider === "keyless")).toMatchObject({
				provider: "keyless",
				id: "local-model",
				context_window: 4096,
			});
		} finally {
			client.destroy();
		}
	});
});
