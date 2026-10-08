/**
 * A `tool_call` vetting step that fails blocks the call, whatever value it fails with.
 *
 * WHY THIS SUITE EXISTS. `ExtensionToolWrapper` sends every call to the extensions that vet
 * calls before it runs the tool. Vetting is a pre-execution check, so a vetting step that fails
 * must refuse the call: running it would treat a crashed check as consent. JavaScript lets a
 * failure be any value, not only an `Error`, and the wrapper's catch has a separate branch for
 * the values that are not one. A catch that rethrew errors and fell through on everything else
 * would run the tool unchecked exactly when the failure was strangest.
 *
 * THE CLASS. Every kind of value `throw` accepts, through both places the vetting step runs
 * code it does not own: the runner's dispatch, and an `edit` tool's own event-input resolver,
 * which the wrapper calls to build the event. The rows cover every `typeof` result plus `null`,
 * an `Error`, and a null-prototype object, whose `String()` itself throws.
 *
 * NOT CAUGHT. A runner that resolves instead of failing, with no `block` field, is consent by
 * contract and runs the call; this suite does not judge that shape.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { type } from "arktype";

/** One value per kind `throw` accepts. Each is built fresh so no row shares an object. */
const THROWN: Record<string, () => unknown> = {
	"an Error": () => new Error("the vetting extension crashed"),
	"a string": () => "the vetting extension crashed",
	"a number": () => 42,
	"a bigint": () => 42n,
	"a boolean": () => false,
	"a symbol": () => Symbol("vetting"),
	undefined: () => undefined,
	null: () => null,
	"a plain object": () => ({ code: "E_VET" }),
	"a null-prototype object": () => Object.create(null),
	"a function": () => () => "vetting",
};

interface Harness {
	tool: AgentTool;
	runner: ExtensionRunner;
	/** How many times the tool's own `execute` ran. */
	runs: () => number;
}

/** A runner with one `tool_call` handler, dispatching through `emitToolCall`. */
function vettingRunner(emitToolCall: () => Promise<unknown>): ExtensionRunner {
	return {
		hasHandlers: (event: string) => event === "tool_call",
		hasUI: () => false,
		getUIContext: () => ({}),
		emit: async () => undefined,
		emitToolCall,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	} as unknown as ExtensionRunner;
}

/** An `edit` tool, whose event input the wrapper resolves through the tool before dispatch. */
function editTool(resolveEventInput: (input: string) => string): Omit<Harness, "runner"> {
	let runs = 0;
	const tool = {
		name: "edit",
		label: "edit",
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({ "input?": "string" }),
		resolveEventInput,
		execute: async () => {
			runs++;
			return { content: [{ type: "text", text: "the tool ran" }] };
		},
	} as unknown as AgentTool;
	return { tool, runs: () => runs };
}

/** The two places a vetting step runs code the wrapper does not own. */
const SEAMS: Record<string, (thrown: unknown) => Harness> = {
	"the runner's dispatch": thrown => ({
		...editTool(input => input),
		runner: vettingRunner(() => Promise.reject(thrown)),
	}),
	"the tool's event-input resolver": thrown => ({
		...editTool(() => {
			throw thrown;
		}),
		runner: vettingRunner(async () => undefined),
	}),
};

/** Run the wrapped tool in yolo mode, so no approval prompt stands before vetting. */
async function rejectionOf(harness: Harness): Promise<unknown> {
	const wrapped = new ExtensionToolWrapper(harness.tool, harness.runner);
	return await wrapped
		.execute("call-1", { input: "replace a with b" } as never, undefined, undefined, {
			settings: { get: (path: string) => (path === "tools.approvalMode" ? "yolo" : undefined) },
		} as never)
		.then(
			() => "resolved",
			(err: unknown) => err,
		);
}

const ROWS = Object.entries(SEAMS).flatMap(([seam, build]) =>
	Object.entries(THROWN).map(([kind, make]) => ({ seam, kind, build, make })),
);

describe("a vetting step that fails", () => {
	it.each(ROWS)("blocks the call when $seam fails with $kind", async ({ build, make }) => {
		const harness = build(make());

		const outcome = await rejectionOf(harness);

		expect(outcome).toBeInstanceOf(Error);
		expect(harness.runs()).toBe(0);
	});

	it.each(ROWS.filter(row => row.kind !== "an Error"))(
		"names the tool and the block when $seam fails with $kind",
		async ({ build, make }) => {
			const outcome = await rejectionOf(build(make()));

			expect((outcome as Error).message).toContain("while vetting this edit call, so the call was blocked");
		},
	);

	/** An `Error` already carries the extension's own message, so it reaches the model unchanged. */
	it.each(Object.keys(SEAMS))("rethrows the Error itself when %s fails with one", async seam => {
		const thrown = new Error("the vetting extension crashed");

		const outcome = await rejectionOf(SEAMS[seam](thrown));

		expect(outcome).toBe(thrown);
	});
});
