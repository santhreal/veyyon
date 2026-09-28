/**
 * WHY: a paste-code login (Anthropic, OpenAI Codex, the Gemini and GitLab
 * flows) has no redirect back to this machine. It shows a URL, waits for the
 * code the browser prints to be pasted back through `onManualCodeInput`, and
 * after the token lands serves a success page through `onSuccessPage`, which
 * the terminal opens. A window that could not answer the first never finished
 * the sign-in, and one that dropped the second left the browser on the
 * provider's page with no "Signed in" screen.
 *
 * This suite drives the real host over its socket, with the provider's own
 * network exchange replaced by a login that makes the same calls in the same
 * order, and defends:
 * 1. The pasted-code request reaches the window as an `AuthFlow` waiting for a
 *    secret, next to the URL the login showed.
 * 2. The code the window sends with `SubmitAuthSecret` is the code the login
 *    receives, and the credential it returns is stored and listed.
 * 3. The success page the login serves is opened on the host's machine.
 *
 * Not caught: the provider's real token exchange, which the provider suites
 * own; and a loopback login, which gets no pasted-code prompt from the
 * terminal either and finishes on its own redirect.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@veyyon/ai/registry";
import { anthropicProvider } from "@veyyon/ai/registry/anthropic";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { AuthFlowView, StoredAccountView } from "../../src/gui-host/wire";
import * as open from "../../src/utils/open";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";

const AUTHORIZE_URL = "https://login.example.invalid/authorize?state=paste-code-test";
const SUCCESS_PAGE = "http://127.0.0.1:1/signed-in";
const PASTED = "pasted-authorization-code";

/** Reads frames, starting with `seen`, until one satisfies `done`; returns every frame read. */
async function readUntil(
	client: TestSocketClient,
	seen: RequestFrame[],
	done: (frame: RequestFrame) => boolean,
): Promise<RequestFrame[]> {
	const frames = [...seen];
	while (!frames.some(done)) frames.push((await client.nextFrame()) as RequestFrame);
	return frames;
}

function authFlow(frame: RequestFrame): AuthFlowView | undefined {
	return frame.Snapshot?.AuthFlow as AuthFlowView | undefined;
}

describe("a login that asks for a pasted code is answered from the window", () => {
	let dir = "";
	let authStorage: AuthStorage;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-paste-code-"));
		authStorage = await isolatedAuthStorage(dir);
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: dir, agentDir: dir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client?.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("the pasted code finishes the sign-in and the success page opens", async () => {
		expect(PASTE_CODE_LOGIN_PROVIDERS.has(anthropicProvider.id)).toBe(true);
		const opened = vi.spyOn(open, "openPath").mockImplementation(() => {});
		const received = Promise.withResolvers<string>();
		vi.spyOn(anthropicProvider, "login").mockImplementation(async callbacks => {
			callbacks.onAuth({ url: AUTHORIZE_URL });
			if (!callbacks.onManualCodeInput) throw new Error("the login was given no way to receive a pasted code");
			const code = await callbacks.onManualCodeInput();
			received.resolve(code);
			callbacks.onSuccessPage?.(SUCCESS_PAGE);
			return {
				access: `access-for-${code}`,
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				email: "pasted@example.com",
			};
		});

		const started = await client.request(1, { StartProviderAuth: { provider: anthropicProvider.id } });
		expect(started.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const waiting = await readUntil(client, started.frames, frame => authFlow(frame)?.state === "AwaitingSecret");
		expect(authFlow(waiting.findLast(frame => authFlow(frame)?.state === "AwaitingSecret")!)).toMatchObject({
			provider: anthropicProvider.id,
			url: AUTHORIZE_URL,
		});

		const submitted = await client.request(2, {
			SubmitAuthSecret: { provider: anthropicProvider.id, secret: PASTED },
		});
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(await received.promise).toBe(PASTED);

		const finished = await readUntil(client, submitted.frames, frame => frame.Snapshot?.Accounts !== undefined);
		expect(finished.some(frame => authFlow(frame)?.state === "Completed")).toBe(true);
		const accounts = finished.findLast(frame => frame.Snapshot?.Accounts !== undefined)?.Snapshot
			?.Accounts as StoredAccountView[];
		expect(accounts.map(({ provider, label, kind }) => ({ provider, label, kind }))).toEqual([
			{ provider: anthropicProvider.id, label: "pasted@example.com", kind: "oauth" },
		]);
		await authStorage.reload();
		const stored = authStorage.get(anthropicProvider.id);
		expect(stored?.type === "oauth" ? stored.access : undefined).toBe(`access-for-${PASTED}`);
		expect(opened.mock.calls).toEqual([[SUCCESS_PAGE]]);
	});
});
