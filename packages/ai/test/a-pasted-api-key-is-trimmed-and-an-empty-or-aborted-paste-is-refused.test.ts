/**
 * The paste half of an API-key login, pinned through the real provider logins that share it:
 * the key is trimmed before it is validated or returned; an empty paste is rejected as
 * `ApiKeyRequiredError` before any network request; a login whose signal aborted during the
 * paste is rejected as `LoginCancelledError`; and a host without `onPrompt` is rejected as
 * `OnPromptRequiredError`, all with nothing fetched.
 *
 * WHY THIS SUITE EXISTS. NVIDIA, Xiaomi, and Alibaba each carried their own copy of the
 * paste and its three refusals; only the `createApiKeyLogin` copy had coverage. All four now
 * run through `promptApiKey`, and this suite drives it from the hand-written logins.
 *
 * WHAT IT DOES NOT CATCH: the validation each login runs after the paste. The NVIDIA arm
 * answers validation with a 200 and asserts only what reached the wire.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "../src/error";
import { loginNvidia } from "../src/registry/nvidia";
import type { OAuthController } from "../src/registry/oauth/types";
import { loginXiaomi } from "../src/registry/oauth/xiaomi";

function controller(
	pasted: string | undefined,
	overrides: Partial<OAuthController> = {},
): { options: OAuthController; requests: string[] } {
	const requests: string[] = [];
	const options: OAuthController = {
		onAuth: () => {},
		onProgress: () => {},
		onPrompt: pasted === undefined ? undefined : async () => pasted,
		fetch: async (input: string | URL | Request, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization") ?? "";
			requests.push(`${String(input)} ${authorization}`);
			return new Response(JSON.stringify({ choices: [] }), { status: 200 });
		},
		...overrides,
	};
	return { options, requests };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a pasted API key", () => {
	it("is trimmed before it is validated and returned", async () => {
		const { options, requests } = controller("  nvapi-abc123  \n");

		await expect(loginNvidia(options)).resolves.toBe("nvapi-abc123");

		expect(requests).toEqual(["https://integrate.api.nvidia.com/v1/chat/completions Bearer nvapi-abc123"]);
	});

	it("is refused when empty, before anything is fetched", async () => {
		const { options, requests } = controller("   ");

		await expect(loginNvidia(options)).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
		await expect(loginXiaomi(options)).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);

		expect(requests).toEqual([]);
	});

	it("is refused as cancelled when the signal aborted during the paste", async () => {
		const abort = new AbortController();
		const { options, requests } = controller("nvapi-abc123", {
			signal: abort.signal,
			onPrompt: async () => {
				abort.abort();
				return "nvapi-abc123";
			},
		});

		await expect(loginNvidia(options)).rejects.toBeInstanceOf(AIError.LoginCancelledError);

		expect(requests).toEqual([]);
	});

	it("cannot be taken at all from a host without a prompt", async () => {
		const { options, requests } = controller(undefined);

		await expect(loginNvidia(options)).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
		await expect(loginXiaomi(options)).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);

		expect(requests).toEqual([]);
	});
});
