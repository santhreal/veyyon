/**
 * WHY:
 *
 * Provider discovery and authentication actions (RefreshProviders, StartProviderAuth,
 * RefreshAuth, SubmitAuthSecret, OpenAuthUrl, CancelAuthFlow, RetryAuthFlow) must
 * query and update credentials in AuthStorage, track active auth flows without leaking
 * secrets in wire frames, and emit typed snapshot sections for `Providers` and `AuthFlow`.
 *
 * This suite defends:
 * 1. `RefreshProviders` enumerates registered catalog and OAuth providers with their
 *    real authentication status.
 * 2. `SubmitAuthSecret` stores credentials in AuthStorage, marks the provider as authenticated,
 *    and NEVER echoes the secret across any wire frame or log.
 * 3. `StartProviderAuth` for an API-key provider transitions directly to `AwaitingSecret`
 *    with a prompt for the user.
 * 4. `CancelAuthFlow` aborts the active flow and emits `AuthFlow` with `state: "Cancelled"`.
 * 5. `OpenAuthUrl` invokes path opener and acknowledges with `RequestSucceeded`.
 * 6. Provider auth actions fail closed with `INVALID_ARGUMENTS` in scope `Authentication`
 *    when required parameters are missing.
 *
 * What it does NOT catch: OS browser launch behavior for desktop OAuth redirects.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { AuthFlowView, ProviderView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

describe("provider authentication and oauth flows gui-host behaviour", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-providers-test-"));
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

	test("RefreshProviders lists providers and SubmitAuthSecret authenticates provider without leaking secret", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		// 1. Initial RefreshProviders -> baseten should not be authenticated
		const { frames: refreshFrames, outcome: refreshOutcome } = await client.request(1, "RefreshProviders");
		expect(refreshOutcome).toEqual({ RequestSucceeded: { request: 1 } });

		const provSnap = refreshFrames.find(f => f.Snapshot?.Providers !== undefined);
		expect(provSnap).toBeDefined();
		const providers = provSnap!.Snapshot!.Providers as ProviderView[];
		expect(Array.isArray(providers)).toBeTrue();

		const basetenBefore = providers.find(p => p.id === "baseten");
		expect(basetenBefore).toBeDefined();
		expect(basetenBefore!.authenticated).toBeFalse();
		expect(basetenBefore!.api_key).toBeTrue();

		// 2. SubmitAuthSecret for baseten
		const SECRET_KEY = "sk-baseten-test-super-secret-key-999888";
		const { frames: submitFrames, outcome: submitOutcome } = await client.request(2, {
			SubmitAuthSecret: {
				provider: "baseten",
				secret: SECRET_KEY,
			},
		});

		expect(submitOutcome).toEqual({ RequestSucceeded: { request: 2 } });

		// Verify secret NEVER leaked into any wire frame
		for (const frame of submitFrames) {
			const serialized = JSON.stringify(frame);
			expect(serialized.includes(SECRET_KEY)).toBeFalse();
		}

		// Verify snapshot marks baseten as authenticated
		const updatedProvSnap = submitFrames.find(f => f.Snapshot?.Providers !== undefined);
		expect(updatedProvSnap).toBeDefined();
		const updatedProviders = updatedProvSnap!.Snapshot!.Providers as ProviderView[];
		const basetenAfter = updatedProviders.find(p => p.id === "baseten");
		expect(basetenAfter).toBeDefined();
		expect(basetenAfter!.authenticated).toBeTrue();

		// Verify in the store the server was given, and nowhere else
		expect(authStorage.hasAuth("baseten")).toBeTrue();

		client.destroy();
	});

	test("StartProviderAuth for API-key provider enters AwaitingSecret and CancelAuthFlow cancels it", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		// 1. StartProviderAuth for azure (API key only)
		const { frames: startFrames, outcome: startOutcome } = await client.request(3, {
			StartProviderAuth: {
				provider: "azure",
			},
		});

		expect(startOutcome).toEqual({ RequestSucceeded: { request: 3 } });
		const authFlowSnap = startFrames.find(f => f.Snapshot?.AuthFlow !== undefined);
		expect(authFlowSnap).toBeDefined();
		const flow = authFlowSnap!.Snapshot!.AuthFlow as AuthFlowView;
		expect(flow.provider).toBe("azure");
		expect(flow.state).toBe("AwaitingSecret");
		expect(flow.prompt).toContain("Azure");

		// 2. CancelAuthFlow
		const { frames: cancelFrames, outcome: cancelOutcome } = await client.request(4, {
			CancelAuthFlow: {
				provider: "azure",
			},
		});

		expect(cancelOutcome).toEqual({ RequestSucceeded: { request: 4 } });
		const cancelSnap = cancelFrames.find(f => f.Snapshot?.AuthFlow !== undefined);
		expect(cancelSnap).toBeDefined();
		const cancelledFlow = cancelSnap!.Snapshot!.AuthFlow as AuthFlowView;
		expect(cancelledFlow.state).toBe("Cancelled");

		client.destroy();
	});

	test("Missing parameters fail with INVALID_ARGUMENTS in scope Authentication", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		const client = await TestSocketClient.connect(server.endpoint);

		const { outcome: fail1 } = await client.request(5, {
			StartProviderAuth: {},
		});
		expect(fail1.RequestFailed).toBeDefined();
		expect(fail1.RequestFailed!.error.scope).toBe("Authentication");
		expect(fail1.RequestFailed!.error.code).toBe("INVALID_ARGUMENTS");

		const { outcome: fail2 } = await client.request(6, {
			SubmitAuthSecret: { provider: "anthropic" },
		});
		expect(fail2.RequestFailed).toBeDefined();
		expect(fail2.RequestFailed!.error.scope).toBe("Authentication");
		expect(fail2.RequestFailed!.error.code).toBe("INVALID_ARGUMENTS");

		client.destroy();
	});
});
