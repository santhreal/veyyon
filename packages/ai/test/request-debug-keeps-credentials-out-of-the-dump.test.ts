/**
 * WHY: `VEYYON_REQ_DEBUG=1` writes the provider request to `rr-session-N.json` in the working
 * directory, which is normally a repository. Before this suite the dump carried `x-api-key` and
 * `Authorization: Bearer ...` verbatim, and the file was created with the default umask, so any
 * other local account could read the operator's provider key out of a 0644 file and a `git add`
 * could commit it.
 *
 * The contract these tests defend:
 *   - a credential-bearing header reaches the file as `<redacted N chars>`, never as its value,
 *     on the request side and on the response side alike;
 *   - both files are created owner-only;
 *   - ordinary protocol headers and the body still land verbatim, so the dump is still a dump.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai/types";
import { wrapFetchForRequestDebug } from "@veyyon/ai/utils/request-debug";
import { removeWithRetries } from "../../utils/src/temp";

const API_KEY = "sk-ant-live-0123456789abcdef";
const BEARER = "Bearer ghp_0123456789abcdefghij";

let previousDebugFlag: string | undefined;
let previousCwd: string;
let tempDir: string;

beforeEach(async () => {
	previousDebugFlag = Bun.env.VEYYON_REQ_DEBUG;
	previousCwd = process.cwd();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-req-debug-secrets-"));
	process.chdir(tempDir);
	Bun.env.VEYYON_REQ_DEBUG = "1";
});

afterEach(async () => {
	process.chdir(previousCwd);
	if (previousDebugFlag === undefined) delete Bun.env.VEYYON_REQ_DEBUG;
	else Bun.env.VEYYON_REQ_DEBUG = previousDebugFlag;
	await removeWithRetries(tempDir);
});

async function latestDump(): Promise<{ requestPath: string; responsePath: string }> {
	const entries = await fs.readdir(tempDir);
	const ids = entries
		.filter(name => /^rr-session-\d+\.json$/.test(name))
		.map(name => Number(name.match(/\d+/)![0]))
		.sort((a, b) => a - b);
	const id = ids[ids.length - 1];
	if (id === undefined) throw new Error(`no rr-session dump in ${tempDir}: ${entries.join(", ")}`);
	return {
		requestPath: path.join(tempDir, `rr-session-${id}.json`),
		responsePath: path.join(tempDir, `rr-session-${id}.res.log`),
	};
}

/** Drive the real wrapped fetch and return both dumped files as text. */
async function record(
	requestHeaders: Record<string, string>,
	responseHeaders: Record<string, string>,
): Promise<{ request: string; response: string; requestPath: string; responsePath: string }> {
	const fetchImpl: FetchImpl = async () => new Response("done", { headers: responseHeaders });
	const wrapped = wrapFetchForRequestDebug(fetchImpl);
	const response = await wrapped("https://provider.test/v1/messages", {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({ model: "debug-model" }),
	});
	await response.text();
	const { requestPath, responsePath } = await latestDump();
	return {
		request: await fs.readFile(requestPath, "utf8"),
		response: await fs.readFile(responsePath, "utf8"),
		requestPath,
		responsePath,
	};
}

describe("VEYYON_REQ_DEBUG credential handling", () => {
	it("replaces the provider key and bearer token with a length-only placeholder", async () => {
		const dump = await record(
			{
				"content-type": "application/json",
				"x-api-key": API_KEY,
				authorization: BEARER,
				cookie: "session=abc123",
			},
			{ "content-type": "text/plain" },
		);

		expect(dump.request).not.toContain(API_KEY);
		expect(dump.request).not.toContain(BEARER);
		expect(dump.request).not.toContain("session=abc123");

		const parsed = JSON.parse(dump.request) as { headers: Record<string, string> };
		expect(parsed.headers["x-api-key"]).toBe(`<redacted ${API_KEY.length} chars>`);
		expect(parsed.headers.authorization).toBe(`<redacted ${BEARER.length} chars>`);
		expect(parsed.headers.cookie).toBe("<redacted 14 chars>");
	});

	it("redacts a credential header on the response side too", async () => {
		const dump = await record(
			{ "content-type": "application/json" },
			{ "set-cookie": "sid=deadbeef; Path=/", "www-authenticate": 'Bearer realm="x"' },
		);

		expect(dump.response).not.toContain("sid=deadbeef");
		expect(dump.response).toContain("set-cookie: <redacted 20 chars>");
		expect(dump.response).toContain("www-authenticate: <redacted 16 chars>");
	});

	it("still records ordinary headers and the body verbatim", async () => {
		const dump = await record(
			{ "content-type": "application/json", "x-request-id": "req-42", "user-agent": "veyyon/test" },
			{ "content-type": "text/plain", "x-ratelimit-remaining": "99" },
		);

		const parsed = JSON.parse(dump.request) as {
			headers: Record<string, string>;
			body: { model: string };
			url: string;
		};
		expect(parsed.headers["x-request-id"]).toBe("req-42");
		expect(parsed.headers["user-agent"]).toBe("veyyon/test");
		expect(parsed.headers["content-type"]).toBe("application/json");
		expect(parsed.body).toEqual({ model: "debug-model" });
		expect(parsed.url).toBe("https://provider.test/v1/messages");
		expect(dump.response).toContain("x-ratelimit-remaining: 99");
		expect(dump.response).toContain("done");
	});

	it("creates both dump files owner-only", async () => {
		const dump = await record({ "content-type": "application/json" }, { "content-type": "text/plain" });

		const requestMode = (await fs.stat(dump.requestPath)).mode & 0o777;
		const responseMode = (await fs.stat(dump.responsePath)).mode & 0o777;
		expect(requestMode).toBe(0o600);
		expect(responseMode).toBe(0o600);
	});
});
