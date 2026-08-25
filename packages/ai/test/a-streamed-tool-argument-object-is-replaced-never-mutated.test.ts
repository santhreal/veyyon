/**
 * A streamed tool call's `arguments` object is replaced, never written into.
 *
 * WHY: `agentLoop` pushes a `message_update` snapshot on every streaming delta, and subscribers
 * hold those snapshots: the transcript rebuild, the tool-call preview, the collab wire. A delta
 * snapshot copies the block but shares the `arguments` object by reference, because cloning it
 * per delta made per-delta cost scale with the accumulated argument size, so a `write` streaming
 * a large file paid for the whole body again on every token.
 *
 * That sharing is correct only while every producer REPLACES the value. `ToolCall.arguments` is
 * a `Readonly<Record<string, unknown>>`, so a write into a live object is a type error in every
 * package that compiles against it, present and future, and the whole-value assignment every
 * provider uses is untouched. The contract is enforced where it is declared rather than by a
 * suite that reads provider source and looks for a spelling.
 *
 * THE CLASS this closes: "a producer mutates a tool-call argument object a subscriber is already
 * holding". The type-level block below is checked by tsgo over the test tree; reverting the
 * declaration to a mutable `Record` leaves every `@ts-expect-error` with nothing to report and
 * turns `check:ts` red on the unused directives. The runtime case proves the reference really is
 * shared, which is what makes the mutability of the object load-bearing at all.
 *
 * WHAT IT DOES NOT CATCH: a write through a value already widened to a mutable type
 * (`const args = block.arguments as Record<string, unknown>; args.path = …`), and
 * `Object.assign(block.arguments, patch)`, which TypeScript accepts against a readonly target.
 * Both need a cast or a call that discards the annotation, which is a deliberate act rather
 * than the accident this closes. The per-provider streaming-argument suites remain the proof
 * that a given provider's accumulated arguments are correct.
 */
import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@veyyon/ai";

// --- Type-level lock (checked by tsgo, never executed) -----------------------
function _toolCallArgumentsAreReadOnly(call: ToolCall, patch: Record<string, unknown>, key: string): void {
	// @ts-expect-error a named property write reaches backwards into every held snapshot
	call.arguments.path = "next";
	// @ts-expect-error and so does an indexed one, which is how a merge loop would spell it
	call.arguments[key] = "next";
	// @ts-expect-error and a delete, which is the same reach through a different operator
	delete call.arguments.path;

	// Replacement is the shape every producer uses and stays legal, however the value is built.
	call.arguments = { ...call.arguments, ...patch };
	call.arguments = patch;
}

describe("a streamed tool argument object is replaced, never mutated", () => {
	/**
	 * The reason the type matters: a copied block hands out the SAME arguments object, so a
	 * write through either reference is visible through the other. If a snapshot ever deep-copies
	 * again this goes red, and the type-level lock above becomes cosmetic rather than wrong.
	 */
	it("shares one arguments object between a block and its shallow copy", () => {
		const call: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.txt" } };
		const copied: ToolCall = { ...call };

		expect(copied.arguments).toBe(call.arguments);
	});

	it("gives a replacement its own object, which is what makes replacement safe", () => {
		const call: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.txt" } };
		const held = call.arguments;

		call.arguments = { path: "a.txt", content: "hello" };

		expect(call.arguments).not.toBe(held);
		expect(held).toEqual({ path: "a.txt" });
	});
});
