import { describe, expect, it } from "bun:test";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools";
import { resolveToolRenderer } from "@veyyon/tool-render";

/**
 * Every tool the agent can call has a real web renderer.
 *
 * WHY THIS SUITE EXISTS. `packages/tool-render` maps wire tool names to React
 * views, and an unknown name falls back to `genericRenderer`, which dumps the
 * raw arguments and result as JSON. That fallback is the right behaviour for a
 * tool this package has never heard of, an MCP tool or an extension's, and it is
 * the wrong outcome for a BUILT-IN, where the dump is strictly worse than the
 * line the terminal shows for the same call.
 *
 * Nothing noticed when it happened. Seven built-ins had no renderer at once:
 * `set_cwd`, `checkpoint`, `rewind`, `learn`, `launch`, `manage_skill` and
 * `memory_edit`. Every signal said covered. The registry test enumerated names
 * and passed, because it enumerated the names the registry already had; each
 * tool rendered without error, because falling back is not an error; and the
 * only list tying the two sides together was maintained by somebody remembering
 * to add to it. That is the same defect as CI-SCRIPT-TESTS-UNRUN and the
 * workspace-test-coverage gap one level down, and it is fixed the same way: stop
 * checking a list against itself and check it against the tree.
 *
 * ONE DIRECTION ONLY, deliberately. A tool with no renderer fails here. A
 * registry key naming no tool does NOT, because the registry keeps aliases for
 * retired wire names (`puppeteer`, `find`, `js`, `apply_patch`, …) so old
 * transcripts stay renderable, and there is no live list of retired names to
 * check them against. Asserting the reverse would mean maintaining a second
 * hand-kept list, which is the thing this test exists to eliminate.
 */

/**
 * A name no tool can have, used to obtain the fallback renderer.
 *
 * The check has to compare against the fallback INSTANCE rather than ask whether
 * a renderer came back, because `resolveToolRenderer` always returns one. "It
 * returned a renderer" is exactly the assertion that passed for seven years'
 * worth of missing views.
 */
const genericRenderer = resolveToolRenderer("definitely-not-a-real-tool-xyz");

const toolNames = [...Object.keys(BUILTIN_TOOLS), ...Object.keys(HIDDEN_TOOLS)].sort();

describe("every agent tool has a web renderer", () => {
	/** The premise: the fallback is reachable and is a distinct object. */
	it("resolves an unknown name to the generic fallback", () => {
		expect(genericRenderer.Summary).toBeDefined();
		expect(resolveToolRenderer("another-unknown-tool-name")).toBe(genericRenderer);
	});

	/** There are tools to check, so an empty registry cannot pass this file. */
	it("finds the agent's tool registries", () => {
		expect(toolNames.length).toBeGreaterThan(20);
		expect(toolNames).toContain("read");
		expect(toolNames).toContain("bash");
	});

	/**
	 * THE CHECK. Named individually rather than asserted in a loop so a failure
	 * says which tool is missing instead of only that something is.
	 */
	it.each(toolNames)("%s renders with its own view, not the JSON fallback", name => {
		const renderer = resolveToolRenderer(name);

		expect(
			renderer,
			`${name} has no renderer in packages/tool-render/src/registry.ts, so it renders as a raw JSON dump. Add one under src/tools/ and register it.`,
		).not.toBe(genericRenderer);
		expect(renderer.Summary).toBeDefined();
	});
});
