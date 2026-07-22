import { describe, expect, it } from "bun:test";
import { splitUpstreamRouting } from "@veyyon/coding-agent/config/model-resolver";

/**
 * splitUpstreamRouting peels a trailing `@<upstream>` provider-routing selector
 * off a model pattern. It is PURELY SYNTACTIC — it does not know which model ids
 * legitimately end in `@<slug>`. This suite exists because the function's docstring
 * previously claimed a Vertex id like `claude-opus-4-8@default` is "never split",
 * which is false: the function does split it, and the protection for such ids lives
 * at the CALL SITES (they only honor the split for aggregator providers that
 * support upstream routing). These tests pin the true syntactic behavior so nobody
 * "fixes" the function to skip a slug like `default` and thereby breaks aggregator
 * routing to an upstream literally named `default`. Pinned:
 *   - a valid trailing `@<slug>` is split into base + upstream;
 *   - a `:thinking` suffix after the slug stays on the base;
 *   - `@default` IS split (the caller, not this function, decides to ignore it for
 *     non-aggregator providers);
 *   - undefined when there is no `@`, the `@` is at index 0, the suffix is empty,
 *     or the suffix is not a bare slug (contains `/`, `_`, etc.);
 *   - the slug match is case-insensitive.
 */

describe("splitUpstreamRouting", () => {
	it("splits a valid trailing @<slug> into base and upstream", () => {
		expect(splitUpstreamRouting("openrouter/z-ai/glm-4.7@cerebras")).toEqual({
			base: "openrouter/z-ai/glm-4.7",
			upstream: "cerebras",
		});
	});

	it("keeps a :thinking suffix on the base while extracting the upstream", () => {
		expect(splitUpstreamRouting("openrouter/z-ai/glm-4.7@cerebras:high")).toEqual({
			base: "openrouter/z-ai/glm-4.7:high",
			upstream: "cerebras",
		});
	});

	it("DOES split `@default` syntactically (caller gates whether to honor it)", () => {
		// The old docstring wrongly claimed this was never split. It is; the call
		// sites protect Vertex-style ids by only routing for aggregator providers.
		expect(splitUpstreamRouting("anthropic/claude-opus-4-8@default")).toEqual({
			base: "anthropic/claude-opus-4-8",
			upstream: "default",
		});
	});

	it("does not split when the suffix after @ is not a bare slug", () => {
		// `cf/meta/llama` contains slashes, so `workers-ai/@cf/meta/llama` stays whole.
		expect(splitUpstreamRouting("workers-ai/@cf/meta/llama")).toBeUndefined();
		// Underscore is outside the slug character class.
		expect(splitUpstreamRouting("openrouter/model@bad_slug")).toBeUndefined();
	});

	it("returns undefined when there is no @, the @ is leading, or the suffix is empty", () => {
		expect(splitUpstreamRouting("openrouter/z-ai/glm-4.7")).toBeUndefined();
		expect(splitUpstreamRouting("@cerebras")).toBeUndefined();
		expect(splitUpstreamRouting("openrouter/model@")).toBeUndefined();
	});

	it("matches the upstream slug case-insensitively", () => {
		expect(splitUpstreamRouting("openrouter/model@UPPER")).toEqual({ base: "openrouter/model", upstream: "UPPER" });
	});
});
