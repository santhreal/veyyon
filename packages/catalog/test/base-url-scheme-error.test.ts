/**
 * A model baseUrl that is missing its scheme is caught, not left to fail later.
 *
 * A `baseUrl` becomes a request URL through `new URL(baseUrl)`, and it also
 * decides whether prefix KV-cache reuse can engage (`hasLocalLoopbackBaseUrl`).
 * Both need an absolute http(s) URL. A scheme-less value passes a non-empty
 * string check but is not usable: `new URL("192.168.1.5:8080")` throws, and
 * `new URL("localhost:11434")` is worse, parsing to an EMPTY hostname with
 * protocol `localhost:`, so the request goes nowhere and the loopback check
 * silently returns false and prefix caching never turns on. `localhost:11434`
 * and `192.168.1.5:8080` are exactly what a person hand-writing `models.yaml`
 * types, which is why this is worth catching once with a correction rather than
 * leaving it to surface as an opaque request failure or an unreproducible "it's
 * slow" much later (Law 10).
 *
 * `baseUrlSchemeError` is the ONE owner of "is this baseUrl a usable endpoint",
 * so the config-load validator and the loopback predicate cannot drift on what
 * counts as parseable. These tests pin the predicate itself; the config layer
 * that calls it is pinned separately.
 *
 * The predicate REJECTS rather than normalising on purpose: prepending
 * `http://` to a public host a user meant over https would silently downgrade
 * to plaintext, and guessing the scheme is exactly what a security-relevant
 * value must not do. The message hands back both schemes so the user picks.
 */
import { describe, expect, it } from "bun:test";
import { baseUrlSchemeError } from "@veyyon/catalog/hosts";

describe("baseUrlSchemeError", () => {
	describe("a usable endpoint returns no error", () => {
		it.each([
			["http://localhost:11434", "loopback over http"],
			["https://api.example.com", "public host over https"],
			["http://192.168.1.5:8080", "LAN IP with a port"],
			["https://api.example.com/v1", "a path after the host"],
			["http://[::1]:8080", "an IPv6 loopback literal"],
		])("accepts %s (%s)", baseUrl => {
			expect(baseUrlSchemeError(baseUrl)).toBeNull();
		});
	});

	describe("a scheme-less value is rejected with the scheme spelled out", () => {
		it("rejects a loopback host written without a scheme", () => {
			// `new URL("localhost:11434")` does not throw: it parses to protocol
			// `localhost:` with an EMPTY hostname, which is the quiet failure that
			// makes the request go nowhere and the loopback check return false.
			const error = baseUrlSchemeError("localhost:11434");

			expect(error).not.toBeNull();
			expect(String(error)).toContain("http://localhost:11434");
			expect(String(error)).toContain("https://localhost:11434");
		});

		it("rejects a LAN IP written without a scheme", () => {
			// `new URL("192.168.1.5:8080")` THROWS, which is the other failure mode,
			// and the caller must get the same clear correction either way.
			const error = baseUrlSchemeError("192.168.1.5:8080");

			expect(error).not.toBeNull();
			expect(String(error)).toContain("http://192.168.1.5:8080");
		});

		it("rejects a bare hostname", () => {
			const error = baseUrlSchemeError("ollama");

			expect(error).not.toBeNull();
			expect(String(error)).toContain("missing a scheme");
			expect(String(error)).toContain("http://ollama");
		});

		it("echoes the original value so the operator can find it in their config", () => {
			// The message is the only bridge between the config line and the fix, so
			// it must quote what the user actually wrote.
			expect(String(baseUrlSchemeError("localhost:11434"))).toContain('"localhost:11434"');
		});
	});

	describe("a value with a scheme that is not http(s) is rejected without a nonsense suggestion", () => {
		it("does not tell the user to prepend http:// to a value that already has ://", () => {
			// A `ws://` or `ftp://` value already has a scheme, so suggesting
			// `http://ws://…` would be gibberish. This branch gives the general rule
			// instead.
			const error = baseUrlSchemeError("ws://localhost:11434");

			expect(error).not.toBeNull();
			expect(String(error)).not.toContain("http://ws://");
			expect(String(error)).toContain('"http://"');
		});
	});

	describe("the rejection never silently downgrades to plaintext", () => {
		it("does not simply prepend http:// and accept a public host meant for https", () => {
			// The whole reason this rejects rather than normalising: a user who wrote
			// `api.example.com` almost certainly meant https, and a silent `http://`
			// would send their traffic in the clear. Rejecting forces the choice.
			const error = baseUrlSchemeError("api.example.com");

			expect(error).not.toBeNull();
			expect(String(error)).toContain("https://api.example.com");
		});
	});
});
