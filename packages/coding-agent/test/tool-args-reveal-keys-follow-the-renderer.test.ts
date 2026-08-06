/**
 * Contract: tool names that share a renderer share the fields that renderer reads mid-stream.
 *
 * WHAT WENT WRONG. `STREAMING_STRING_KEYS_BY_TOOL` is keyed by TOOL NAME. The behaviour it feeds is keyed by
 * RENDERER, and `tools/renderers.ts` binds one renderer object to more than one name: `apply_patch` is
 * `editToolRenderer`, the same object `edit` is. The list was written while looking at `edit`, so `apply_patch`
 * got none of it.
 *
 * The visible result was in the title. An edit preview's heading is the file path, and `edit/renderer.ts`
 * recovers that path from the raw partial-JSON buffer when the parsed args do not carry it yet. That buffer is
 * the WIRE form: argot's `§handle` fragments are expanded on decoded values, never on the buffer, because a
 * handle can expand to text holding a quote or a newline and splicing that into the buffer would corrupt the
 * JSON the next frame parses. So for `edit` the streamed keys decoded and expanded the path every frame and the
 * heading read `src/db.ts`, while for `apply_patch` nothing decoded it and the heading read `§db` until a
 * throttled full parse caught up, which for a long patch is most of the call.
 *
 * WHY A STRUCTURAL TEST RATHER THAN A RENDER TEST. Nothing about this fails. Both tools render, both eventually
 * show the right path, and the difference is a table entry nobody looks at next to a renderer binding nobody
 * cross-checks. A test that only asserted `apply_patch`'s current list would restate the fix; this one states
 * the RULE the fix followed, so the next renderer bound to a second name fails here instead of shipping.
 */

import { describe, expect, it } from "bun:test";
import { streamingStringKeysForTool } from "@veyyon/coding-agent/modes/controllers/tool-args-reveal";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";

/**
 * Tool names grouped by the renderer object they are bound to.
 *
 * Read through the table's own getters rather than from source text, because one entry (`task`) is a lazy
 * getter that breaks an import cycle, and identity is the thing the rule is about: two names are siblings when
 * they are the SAME object, not when they look alike.
 */
function namesByRenderer(): Map<unknown, string[]> {
	const groups = new Map<unknown, string[]>();
	for (const name of Object.keys(toolRenderers)) {
		const renderer = toolRenderers[name];
		const existing = groups.get(renderer);
		if (existing) existing.push(name);
		else groups.set(renderer, [name]);
	}
	return groups;
}

const SHARED: Array<readonly [string[], unknown]> = [...namesByRenderer()]
	.filter(([, names]) => names.length > 1)
	.map(([renderer, names]) => [names, renderer] as const);

describe("the renderer table really has shared bindings", () => {
	/**
	 * NON-VACUITY, and it is the whole risk here: the rule below is "for every shared renderer …",
	 * which an empty grouping satisfies for free. Naming the specific pair the suite was written for
	 * proves the grouping found a real one, so a refactor that gave every tool its own renderer
	 * object fails loudly here instead of quietly emptying `SHARED`.
	 */
	it("groups edit and apply_patch together", () => {
		const pair = SHARED.find(([names]) => names.includes("edit"));

		expect(pair?.[0].sort()).toEqual(["apply_patch", "edit"]);
	});

	/** The grouping walks the whole table, including the lazy `task` getter, which a source scan would miss. */
	it("reads every registered tool name", () => {
		const names = SHARED.flatMap(([group]) => group);

		expect(Object.keys(toolRenderers).length).toBeGreaterThan(25);
		expect(Object.keys(toolRenderers)).toContain("task");
		expect(names.every(name => name in toolRenderers)).toBe(true);
	});
});

describe("streaming string keys follow the renderer, not the name", () => {
	/**
	 * THE RULE. A renderer reads the same fields whichever name invoked it, so the names bound to it must
	 * declare the same fields. Anything else means one of them falls back to the throttled parse and to the
	 * raw buffer slice, which is the wire form.
	 */
	it.each(SHARED)("%s share one set of streamed keys", names => {
		const keySets = names.map(name => streamingStringKeysForTool(name, false));
		const first = keySets[0];

		for (const keys of keySets) {
			expect(keys, `these names share a renderer: ${names.join(", ")}`).toEqual(first);
		}
	});

	/**
	 * The values, pinned. The rule above is satisfied by every sibling having NO keys, which is what the bug
	 * looked like from `apply_patch`'s side, so the pair that motivated it asserts its actual contents.
	 *
	 * `path` and `file_path` are the title. `input` and `_input` are the hashline payload under both spellings,
	 * since streaming sees the raw model output before validation coerces the legacy alias.
	 */
	it.each(["edit", "apply_patch"])("%s decodes the title path and the hashline payload", name => {
		expect(streamingStringKeysForTool(name, false)).toEqual(["path", "file_path", "input", "_input"]);
	});

	/**
	 * And they are the SAME array, not two lists that agree today. Two equal literals would pass the case above
	 * and drift on the next edit, which is the failure this whole suite is about, one level down.
	 */
	it("edit and apply_patch reference one list", () => {
		expect(streamingStringKeysForTool("edit", false)).toBe(streamingStringKeysForTool("apply_patch", false));
	});

	/**
	 * A raw-text tool has no JSON to decode incrementally, so it gets no keys whatever its name says. Asserted
	 * because the lookup takes `rawInput` and ignoring it would hand a custom tool a set of JSON field names to
	 * hunt for in a plain text stream.
	 */
	it("gives a raw-text stream no keys at all", () => {
		expect(streamingStringKeysForTool("edit", true)).toBeUndefined();
		expect(streamingStringKeysForTool("apply_patch", true)).toBeUndefined();
	});

	/** A tool with no entry is undefined rather than an empty list, which is what the reveal path branches on. */
	it("leaves an unlisted tool undefined", () => {
		expect(streamingStringKeysForTool("glob", false)).toBeUndefined();
		expect(streamingStringKeysForTool("not_a_tool", false)).toBeUndefined();
	});
});

describe("every tool with streamed keys is a tool that exists", () => {
	/**
	 * A key list for a name nothing is bound to is dead: it fails nothing, matches nothing, and reads like
	 * coverage. This is the inverse of the rule above and catches a tool being renamed out from under its
	 * entry, which is how the `apply_patch` gap would have reappeared from the other direction.
	 */
	it.each(["write", "edit", "apply_patch", "eval"])("%s is bound to a renderer", name => {
		expect(toolRenderers[name]).toBeDefined();
	});
});
