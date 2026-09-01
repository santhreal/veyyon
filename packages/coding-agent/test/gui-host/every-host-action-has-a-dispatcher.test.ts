/**
 * WHY:
 *
 * Every action tag declared in `wire.ts` at `PROTOCOL_VERSION = 1` must have a
 * registered dispatcher and must never fail with `UNIMPLEMENTED_ACTION`.
 * Furthermore, the set of Unavailable capabilities must be pinned by exact equality
 * so any new capability turns the suite red until an implementation decision is made.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ALL_CAPABILITIES,
	ALL_HOST_ACTIONS,
	type Capability,
	type GuiHostServer,
	PROTOCOL_VERSION,
	startGuiHostServer,
} from "../../src/gui-host";
import { TestSocketClient } from "./test-client";

describe("every host action has a dispatcher", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-dispatch-test-"));
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	test("capability snapshot matches the pinned unavailable set exactly", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// Frame 1: Greeting
		const greeting = (await client.nextFrame()) as Record<string, unknown>;
		expect(greeting).toEqual({
			ConnectionChanged: {
				Connected: {
					endpoint: server.endpoint,
					protocol: PROTOCOL_VERSION,
				},
			},
		});

		// Frame 2: Capability snapshot
		const capFrame = (await client.nextFrame()) as {
			Snapshot: { Capabilities: [Capability, string | { Unavailable: { reason: string } }][] };
		};
		expect(capFrame.Snapshot).toBeDefined();
		expect(capFrame.Snapshot.Capabilities).toBeDefined();

		const capabilitiesList = capFrame.Snapshot.Capabilities;
		expect(capabilitiesList.length).toBe(ALL_CAPABILITIES.length);

		const actualUnavailable: Capability[] = [];
		for (const [cap, status] of capabilitiesList) {
			if (typeof status === "object" && status !== null && "Unavailable" in status) {
				actualUnavailable.push(cap);
			}
		}

		// Pinned by exact equality: a new capability turns this red
		expect(actualUnavailable).toEqual(["PendingEdits", "Extensions", "AgentCommands"]);

		client.destroy();
	});

	test("enumerates all action tags from wire.ts and asserts none answers UNIMPLEMENTED_ACTION", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// Drain initial greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		// Put Shutdown at the end so it does not terminate the connection mid-sweep
		const actionsToTest = [...ALL_HOST_ACTIONS.filter(tag => tag !== "Shutdown"), "Shutdown" as const];

		let requestId = 100;
		for (const actionTag of actionsToTest) {
			requestId += 1;
			client.send({
				id: requestId,
				action: actionTag,
			});

			let response: Record<string, unknown> | undefined;
			// Drain any snapshot frames emitted before the settlement frame
			while (true) {
				const frame = (await client.nextFrame()) as Record<string, unknown>;
				if ("RequestSucceeded" in frame || "RequestFailed" in frame) {
					response = frame;
					break;
				}
			}

			expect(response).toBeDefined();
			if ("RequestFailed" in response!) {
				const failed = response.RequestFailed as {
					request: number;
					error: { scope: string; code: string; message: string };
				};
				expect(failed.request).toBe(requestId);
				// MUST NOT be UNIMPLEMENTED_ACTION
				expect(failed.error.code).not.toBe("UNIMPLEMENTED_ACTION");
			} else {
				const succeeded = response!.RequestSucceeded as { request: number };
				expect(succeeded.request).toBe(requestId);
			}
		}

		client.destroy();
	}, 15000);
});
