/**
 * Regression: "is this model server on my local network" has exactly one answer.
 *
 * `hasLocalLoopbackBaseUrl` was hand-copied into two packages,
 * `catalog/compat/openai.ts` and `coding-agent/config/append-only-context-mode.ts`,
 * with identical bodies. Identical is not safe, it is just drift that has not
 * happened yet, and the two copies decide real behaviour: whether append-only
 * context mode engages (which is what makes llama.cpp-style prefix KV-cache
 * reuse possible, so it is the difference between re-prefilling the whole
 * conversation every turn and not) and what goes into the OpenAI
 * chat-completions compat record. Two copies drifting means the same server gets
 * different behaviour depending on which code path reached it first, which is
 * the ONE PLACE failure that shows up as an unreproducible performance bug.
 *
 * These tests live with the owner in `catalog`, and pin the boundaries a copy
 * would most plausibly get wrong: which RFC1918 ranges count, that `172.32` is
 * NOT private, that the match is on hostname only so a port or a path cannot
 * change the answer, and that a public host is never called local.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasLocalLoopbackBaseUrl } from "@veyyon/catalog/hosts";

describe("hasLocalLoopbackBaseUrl", () => {
	describe("loopback addresses", () => {
		it.each([
			["http://localhost:11434", "the Ollama default"],
			["http://127.0.0.1:8080", "the llama.cpp default"],
			["http://0.0.0.0:8000", "a vLLM server bound to every interface"],
			["http://[::1]:1234", "IPv6 loopback, which URL parsing reports bracketed"],
		])("treats %s as local (%s)", url => {
			expect(hasLocalLoopbackBaseUrl(url)).toBe(true);
		});

		it("matches loopback regardless of the case the user wrote", () => {
			// `models.yaml` is hand-written, so `LocalHost` is a real thing to type.
			expect(hasLocalLoopbackBaseUrl("http://LOCALHOST:11434/v1")).toBe(true);
		});
	});

	describe("RFC1918 private ranges, which is how a LAN box is reached", () => {
		it.each([
			"http://10.0.0.5:8000/v1",
			"http://192.168.1.42:11434",
			"http://172.16.0.3:8080",
			"http://172.31.255.254:8080",
		])("treats %s as local", url => {
			expect(hasLocalLoopbackBaseUrl(url)).toBe(true);
		});

		it("does not treat 172.15 as private, since the block starts at 172.16", () => {
			// The 172 range is the one that is easy to get wrong, and getting it wrong
			// in the permissive direction silently enables append-only mode against a
			// public endpoint that does not benefit from it.
			expect(hasLocalLoopbackBaseUrl("http://172.15.0.1:8080")).toBe(false);
		});

		it("does not treat 172.32 as private, since the block ends at 172.31", () => {
			expect(hasLocalLoopbackBaseUrl("http://172.32.0.1:8080")).toBe(false);
		});

		it("does not treat a public address merely starting with the digits 10 as local", () => {
			// `100.64.0.1` begins with "10" as text but is not in 10.0.0.0/8. The
			// check is on the dotted octet, and this is what proves it.
			expect(hasLocalLoopbackBaseUrl("http://100.64.0.1:8080")).toBe(false);
		});
	});

	describe("mDNS names, which is how a home-LAN llama.cpp box is usually addressed", () => {
		it("treats a .local hostname as local", () => {
			expect(hasLocalLoopbackBaseUrl("http://gpu-box.local:8080/v1")).toBe(true);
		});

		it("does not treat a public host merely containing 'local' as local", () => {
			// Substring matching on the whole URL would call this local. Matching on
			// the parsed hostname's suffix is what makes it not.
			expect(hasLocalLoopbackBaseUrl("https://api.localhost-cdn.example.com/v1")).toBe(false);
		});
	});

	describe("public endpoints", () => {
		it.each(["https://api.openai.com/v1", "https://api.anthropic.com", "https://openrouter.ai/api/v1"])(
			"does not treat %s as local",
			url => {
				expect(hasLocalLoopbackBaseUrl(url)).toBe(false);
			},
		);
	});

	describe("inputs that are not usable URLs", () => {
		it("returns false for undefined rather than throwing", () => {
			// It is called with a possibly-absent baseUrl on every model lookup.
			expect(hasLocalLoopbackBaseUrl(undefined)).toBe(false);
		});

		it("returns false for an empty string", () => {
			expect(hasLocalLoopbackBaseUrl("")).toBe(false);
		});

		it("returns false for a baseUrl with no scheme, which URL parsing rejects", () => {
			// `localhost:11434` is a plausible thing to write in `models.yaml` and is
			// NOT a valid absolute URL. It reads as local to a human and is not
			// treated as local here, which is worth pinning because it is surprising.
			expect(hasLocalLoopbackBaseUrl("localhost:11434")).toBe(false);
		});
	});

	describe("the match ignores everything except the hostname", () => {
		it("ignores the port, so a non-default port is still local", () => {
			expect(hasLocalLoopbackBaseUrl("http://127.0.0.1:9999/v1/chat/completions")).toBe(true);
		});

		it("ignores a path that names a public host", () => {
			// A proxy path must not make a local server look remote.
			expect(hasLocalLoopbackBaseUrl("http://localhost:8080/proxy/api.openai.com/v1")).toBe(true);
		});

		it("ignores a path that names localhost on a public host", () => {
			// The mirror of the case above, and the one that would silently enable a
			// local-only optimisation against a real remote provider.
			expect(hasLocalLoopbackBaseUrl("https://api.example.com/localhost/v1")).toBe(false);
		});

		it("ignores credentials embedded in the URL", () => {
			expect(hasLocalLoopbackBaseUrl("http://user:pass@192.168.0.10:8080")).toBe(true);
		});
	});
});

/**
 * The unification only holds if a second copy cannot quietly reappear.
 *
 * Both former copies were byte-identical to the owner, which is exactly how
 * this kind of duplication survives review: nothing looks wrong until the two
 * drift. This scan fails the moment anyone re-declares the predicate instead of
 * importing it.
 */
describe("the local-host predicate has exactly one definition", () => {
	const CONSUMERS = [
		path.resolve(import.meta.dir, "../src/compat/openai.ts"),
		path.resolve(import.meta.dir, "../../coding-agent/src/config/append-only-context-mode.ts"),
	];

	it.each(CONSUMERS)("%s imports the predicate rather than declaring its own", file => {
		const source = fs.readFileSync(file, "utf8");

		expect(source).not.toContain("function hasLocalLoopbackBaseUrl");
		expect(source).toContain("hasLocalLoopbackBaseUrl");
	});

	it("keeps the RFC1918 range checks in one file only", () => {
		// The dotted-octet regexes are the substance of the predicate. A copy of
		// them anywhere else is a copy of the predicate under a different name.
		const owner = fs.readFileSync(path.resolve(import.meta.dir, "../src/hosts.ts"), "utf8");
		expect(owner).toContain("192\\.168\\.");

		for (const file of CONSUMERS) {
			expect(fs.readFileSync(file, "utf8")).not.toContain("192\\.168\\.");
		}
	});

	it("reads real sources, so a passing scan means something", () => {
		// Anti-vacuity: a renamed or moved consumer would otherwise pass every scan
		// above against an empty string.
		for (const file of CONSUMERS) {
			expect(fs.readFileSync(file, "utf8").length).toBeGreaterThan(1_000);
		}
	});
});
