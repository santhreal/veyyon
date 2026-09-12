// WHY: every streaming gateway route hands the SSE encoder one cancel hook, and that hook together
// with the request-abort mirror is what turns a client hanging up into an abort of the provider call
// already in flight. The chat format endpoint is driven through a real server against a mock
// provider that stalls before its first event; the endpoint writes a role chunk before that event,
// so the server observes the hang-up at once, and a route that stops aborting leaves the provider
// call running until the poll below times out. Not caught: which of the two layers (request-abort
// mirror or SSE cancel hook) delivered the abort, since either suffices through a real server; a
// hook that aborts twice, since AbortController ignores a second abort; and the pi-native fast path,
// which writes nothing before the first upstream event, so a real server never observes the hang-up
// against a mock whose stream completes as soon as it starts.
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@veyyon/ai/providers/mock";

interface GatewayHarness {
	url: string;
	mock: MockModel;
	close(): Promise<void>;
}

async function bootGateway(): Promise<GatewayHarness> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-client-close-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "test-key");
	const mock = createMockModel({ provider: "openrouter", id: "mock/close-model" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: () => mock.model,
		version: "test",
	});
	return {
		url: handle.url,
		mock,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/** The provider call's signal once the gateway has placed it, or undefined if it never did in time. */
async function upstreamSignal(mock: MockModel, deadlineMs: number): Promise<AbortSignal | undefined> {
	const until = performance.now() + deadlineMs;
	while (performance.now() < until) {
		const signal = mock.calls[0]?.options?.signal;
		if (signal) return signal;
		await sleep(10);
	}
	return undefined;
}

async function untilAborted(signal: AbortSignal, deadlineMs: number): Promise<boolean> {
	const until = performance.now() + deadlineMs;
	while (!signal.aborted && performance.now() < until) await sleep(10);
	return signal.aborted;
}

afterEach(() => {
	clearCustomApis();
});

describe("a client that closes a streaming gateway response aborts the upstream call", () => {
	it("aborts the provider call behind the OpenAI chat format endpoint with a client-closed reason", async () => {
		const gw = await bootGateway();
		try {
			gw.mock.push({ content: ["never sent"], delayMs: 30_000 });
			const res = await fetch(`${gw.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "mock/close-model",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			});
			expect(res.status).toBe(200);
			const signal = await upstreamSignal(gw.mock, 5_000);
			if (!signal) throw new Error("the gateway never placed the provider call");
			expect(signal.aborted).toBe(false);

			await res.body?.cancel();

			expect(await untilAborted(signal, 5_000)).toBe(true);
			expect(signal.reason).toBeInstanceOf(Error);
		} finally {
			await gw.close();
		}
	});
});
