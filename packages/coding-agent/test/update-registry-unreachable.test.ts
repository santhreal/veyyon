import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readAutoUpdateState } from "@veyyon/coding-agent/cli/auto-update-state";
import * as updateCli from "@veyyon/coding-agent/cli/update-cli";
import { removeWithRetries } from "@veyyon/utils";

/**
 * UPD-11: when the release source is unreachable, veyyon must say so.
 *
 * `update-cli.test.ts` already pins the two answers GitHub gives on purpose: a
 * 404 (nothing published) and a 403 (rate limited). This suite covers the
 * answers nobody chose: a 5xx, a dropped connection, a timeout, and a 200 whose
 * body is not what the API documents. Those are the states a real user hits on a
 * hotel network, behind a corporate proxy that returns an HTML error page with
 * status 200, or during a GitHub incident.
 *
 * The property under test is Law 10, applied to version discovery. Every one of
 * these paths must THROW, naming what failed. The forbidden outcomes are the
 * quiet ones, and each is worse than an error:
 *
 *  - returning the current version, which reports "you are up to date" to
 *    someone who is several releases behind,
 *  - returning an empty or partial answer that a caller reads as "no releases
 *    exist",
 *  - returning a previously-seen version from any cache, which makes the update
 *    check report a stale answer indefinitely.
 *
 * The last block also proves a network failure does not poison the auto-update
 * backoff. A failure to ASK is not a failure to INSTALL, and recording it as one
 * would suppress updates for six hours because a laptop was offline once.
 */
describe("an unreachable release source fails loudly and never answers from stale data", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	/** Replace `fetch` with one that returns `response`, recording each call. */
	function respondWith(response: () => Response | Promise<Response>): { calls: string[] } {
		const calls: string[] = [];
		const impl = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return await response();
		}) as unknown as typeof fetch;
		spyOn(globalThis, "fetch").mockImplementation(impl);
		return { calls };
	}

	/** Replace `fetch` with one that rejects, as an offline machine does. */
	function failWith(error: Error): void {
		spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw error;
		}) as unknown as typeof fetch);
	}

	describe("server-side failures", () => {
		it("throws naming the URL and the status on a 500", async () => {
			respondWith(() => new Response("", { status: 500, statusText: "Internal Server Error" }));

			// The message has to carry the URL: the first question anyone asks is whether
			// it is the network, the proxy, or the wrong endpoint being queried.
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(
				/api\.github\.com\/repos\/santhreal\/veyyon\/releases\/latest: HTTP 500 Internal Server Error/,
			);
		});

		it("throws on a 503, the shape a GitHub incident takes", async () => {
			respondWith(() => new Response("", { status: 503, statusText: "Service Unavailable" }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/HTTP 503/);
		});

		it("throws on a 502 rather than treating an empty body as an empty release list", async () => {
			respondWith(() => new Response("", { status: 502, statusText: "Bad Gateway" }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/HTTP 502/);
		});
	});

	describe("network-side failures", () => {
		it("propagates a connection failure instead of reporting up to date", async () => {
			// What an offline machine actually produces. Silently reporting "up to date"
			// here is the exact bug this whole lane exists to prevent: it looks identical
			// to a healthy check.
			failWith(new TypeError("Unable to connect. Is the computer able to access the url?"));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/Unable to connect/);
		});

		it("reports a timeout as a timeout, with the budget it waited", async () => {
			const timeout = new Error("The operation timed out.");
			timeout.name = "TimeoutError";
			failWith(timeout);

			// Naming the seconds matters because the startup check and the explicit
			// command use deliberately different budgets, and a user seeing a fast
			// give-up needs to know it was a short budget, not a dead network.
			await expect(updateCli.getLatestRelease(2000)).rejects.toThrow(/Timed out fetching release info after 2s/);
		});

		it("surfaces a DNS failure rather than swallowing it", async () => {
			const dns = new Error("getaddrinfo ENOTFOUND api.github.com");
			failWith(dns);
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/ENOTFOUND/);
		});
	});

	describe("a 200 that is not a release", () => {
		it("throws when the body is HTML, as a captive portal or proxy returns", async () => {
			// Status 200 with an interception page is the nastiest case: every status
			// check passes and only the body is wrong.
			respondWith(() => new Response("<html><body>Sign in to the network</body></html>", { status: 200 }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow();
		});

		it("throws when tag_name is absent instead of resolving to an empty version", async () => {
			// An empty version string would compare as "not newer" against anything and
			// silently report up to date forever.
			respondWith(() => new Response(JSON.stringify({ name: "1.2.3" }), { status: 200 }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/unusable tag/);
		});

		it("throws when tag_name is the wrong type", async () => {
			respondWith(() => new Response(JSON.stringify({ tag_name: 123 }), { status: 200 }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/unusable tag/);
		});

		it("throws when tag_name is an empty string", async () => {
			respondWith(() => new Response(JSON.stringify({ tag_name: "" }), { status: 200 }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/unusable tag/);
		});

		it("throws when the tag is a moving pointer rather than a version", async () => {
			// `latest`/`nightly` style tags are not installable versions; accepting one
			// would send the installer after an artifact whose contents change underneath.
			respondWith(() => new Response(JSON.stringify({ tag_name: "v1.2" }), { status: 200 }));
			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/unusable tag/);
		});
	});

	describe("no answer is ever served from a cache", () => {
		it("asks again after a failure and returns the FRESH version, not the failed one", async () => {
			let attempt = 0;
			const { calls } = respondWith(() => {
				attempt += 1;
				if (attempt === 1) return new Response("", { status: 500, statusText: "Internal Server Error" });
				return new Response(JSON.stringify({ tag_name: "v3.1.4" }), { status: 200 });
			});

			await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/HTTP 500/);
			expect(await updateCli.getLatestRelease(1000)).toEqual({ tag: "v3.1.4", version: "3.1.4" });
			// Two real round trips: a memoized failure would have skipped the second, and
			// a memoized success would make every later check report a version that may
			// already be superseded.
			expect(calls).toHaveLength(2);
		});

		it("returns each successive version on repeated calls, so a newer release is seen immediately", async () => {
			const versions = ["v1.0.0", "v1.1.0", "v2.0.0"];
			let index = 0;
			respondWith(() => new Response(JSON.stringify({ tag_name: versions[index++] }), { status: 200 }));

			expect((await updateCli.getLatestRelease(1000)).version).toBe("1.0.0");
			expect((await updateCli.getLatestRelease(1000)).version).toBe("1.1.0");
			expect((await updateCli.getLatestRelease(1000)).version).toBe("2.0.0");
		});
	});

	describe("runAutoUpdate under an unreachable source", () => {
		async function statePath(): Promise<string> {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-registry-unreachable-"));
			tempDirs.push(dir);
			return path.join(dir, "auto-update-state.json");
		}

		it("reports the failure with its cause rather than claiming up to date", async () => {
			failWith(new TypeError("Unable to connect. Is the computer able to access the url?"));

			const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath());

			expect(outcome.status).toBe("failed");
			// The cause is carried, not flattened to a generic message: a proxy failure
			// and a rate limit need different actions from the user.
			expect(outcome.status === "failed" ? outcome.error : "").toMatch(/Unable to connect/);
		});

		it("does NOT record a network failure as an install failure, so it cannot suppress updates for hours", async () => {
			// Failing to ASK is not failing to INSTALL. Recording it would start the
			// six-hour install backoff because a laptop was briefly offline, and the user
			// would then miss a release with nothing on screen to explain why.
			const path = await statePath();
			failWith(new TypeError("Unable to connect. Is the computer able to access the url?"));

			await updateCli.runAutoUpdate("1.0.0", undefined, path);

			expect(await readAutoUpdateState(path)).toEqual({});
		});

		it("still reports up to date when the source IS reachable and the version matches", async () => {
			// The control. Without it, every assertion above would also pass if
			// runAutoUpdate had simply stopped working.
			respondWith(() => new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }));

			expect((await updateCli.runAutoUpdate("1.0.0", undefined, await statePath())).status).toBe("up-to-date");
		});
	});
});
