/**
 * The `pi` namespace handed to extension authors is loaded once, on demand, and only when somebody is
 * actually going to see it.
 *
 * WHY THIS SUITE EXISTS. `api.pi` is the whole package, so the loaders used to import the package barrel
 * statically. That barrel re-exports every mode and every component, so three loaders that run during
 * startup put the entire interactive TUI in the boot graph of every launch, including the launches that
 * never render one. `extensibility/coding-agent-api.ts` replaced those four static imports with one lazy
 * owner, and `loadCustomTools` stopped building an API object when there are no custom tools to hand it
 * to.
 *
 * Both halves need pinning, and for different reasons. The lazy load has to still RETURN the real
 * namespace -- a lazy import that resolved to something incomplete would break every extension while the
 * startup measurement looked wonderful -- and it has to be memoised, since re-importing the barrel per
 * extension is the same cost paid repeatedly. The zero-path shortcut has to keep the contract its callers
 * rely on: `loadCustomTools` always returns tools, errors and a `setUIContext`, and a caller that invokes
 * `setUIContext` on a session with no custom tools must not crash.
 *
 * `test/startup-module-graph.test.ts` guards the graph these changes were made for; this suite guards the
 * behaviour they must not have broken to get there.
 */

import { describe, expect, it } from "bun:test";
import { loadCodingAgentApi } from "@veyyon/coding-agent/extensibility/coding-agent-api";
import { loadCustomTools } from "@veyyon/coding-agent/extensibility/custom-tools/loader";

describe("the lazily loaded coding-agent namespace", () => {
	/**
	 * The namespace is the package's real public surface, not a subset. `createAgentSession` and
	 * `getBundledModel`-style entry points are what extension authors reach for first, so a barrel that
	 * resolved to a partial module would show up here rather than in someone's extension.
	 */
	it("resolves to the package's public surface", async () => {
		const api = await loadCodingAgentApi();

		expect(typeof api.createAgentSession).toBe("function");
		expect(typeof api.AgentSession).toBe("function");
		expect(typeof api.Settings).toBe("function");
	});

	/**
	 * Once, not once per extension. `once()` is what makes the lazy import cheap after the first
	 * extension; without it every loaded extension would re-enter the barrel.
	 */
	it("returns the same namespace object on every call", async () => {
		const first = await loadCodingAgentApi();
		const second = await loadCodingAgentApi();

		expect(second).toBe(first);
	});
});

describe("loading custom tools with nothing to load", () => {
	/**
	 * The shortcut that keeps the barrel out of an ordinary launch: no paths, no API object. Asserted on
	 * the RESULT rather than on the module graph, because the result is the contract every caller sees.
	 */
	it("returns an empty result rather than building an API object", async () => {
		const result = await loadCustomTools([], process.cwd(), ["read", "bash"]);

		expect(result.tools).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(typeof result.setUIContext).toBe("function");
	});

	/**
	 * The shortcut must be about there being nothing to load, not about the loader being switched off. A
	 * path that does not exist still goes down the real path and still reports itself as an error, so a
	 * misconfigured tool is visible instead of silently absent (Law 10).
	 */
	it("still reports a configured path that cannot be loaded", async () => {
		const missing = "/nonexistent/veyyon-custom-tool-that-is-not-there.ts";
		const result = await loadCustomTools([{ path: missing }], process.cwd(), []);

		expect(result.tools).toEqual([]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]?.path).toBe(missing);
	});
});
