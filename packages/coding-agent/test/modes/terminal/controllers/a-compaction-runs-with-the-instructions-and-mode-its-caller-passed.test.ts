/**
 * `CommandController.executeCompaction` has two callers that pass a compaction differently: the `/compact` slash
 * path passes instructions as a string and the mode positionally, and the extension path passes an options object
 * that may hold the mode. The session's `compact` receives one shape either way.
 *
 * Contracts, swept over every combination of the two argument forms:
 *  - string instructions reach `compact` as instructions, never as options;
 *  - an options object reaches `compact` with every field it holds, and never as instructions;
 *  - a mode from either form is set on the options; a positional mode is added to a copy of an options object, so
 *    the caller's object is never changed;
 *  - with neither options nor a mode, `compact` receives no options at all.
 *
 * Gap: both forms carry the same mode today (`CompactMode` has one member), so which form wins a disagreement is
 * not observable and not asserted.
 */
import { describe, expect, it } from "bun:test";
import type { CompactOptions } from "@veyyon/coding-agent/extensibility/extensions/types";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import type { CompactMode } from "@veyyon/kernel/session/compact-modes";
import { Container } from "@veyyon/tui";
import { useTruecolorTheme } from "../../../helpers/theme-assertions";

useTruecolorTheme("dark");

async function compactWith(
	instructionsOrOptions: string | CompactOptions | undefined,
	mode: CompactMode | undefined,
): Promise<[string | undefined, CompactOptions | undefined]> {
	const calls: [string | undefined, CompactOptions | undefined][] = [];
	const ctx = {
		clearWorkingLoader: () => false,
		statusContainer: new Container(),
		chatContainer: new Container(),
		ui: { requestRender: () => {}, requestComponentRender: () => {} },
		session: {
			compact: async (instructions?: string, options?: CompactOptions) => {
				calls.push([instructions, options]);
			},
			model: undefined,
			settings: { get: () => false },
		},
		rebuildChatFromMessages: () => {},
		statusLine: { invalidate: () => {} },
		showError: () => {},
		flushCompactionQueue: async () => {},
		settings: { get: () => false },
	} as unknown as CommandControllerContext;
	const outcome = await new CommandController(ctx).executeCompaction(instructionsOrOptions, false, undefined, mode);
	expect(outcome).toBe("ok");
	expect(calls).toHaveLength(1);
	return calls[0]!;
}

const onComplete = () => {};
const MODE: CompactMode = "summary";

const CASES: {
	name: string;
	instructionsOrOptions: string | CompactOptions | undefined;
	mode: CompactMode | undefined;
	expected: [string | undefined, CompactOptions | undefined];
}[] = [
	{ name: "nothing passed", instructionsOrOptions: undefined, mode: undefined, expected: [undefined, undefined] },
	{
		name: "instructions only",
		instructionsOrOptions: "keep the API notes",
		mode: undefined,
		expected: ["keep the API notes", undefined],
	},
	{ name: "empty instructions", instructionsOrOptions: "", mode: undefined, expected: ["", undefined] },
	{
		name: "instructions and a positional mode",
		instructionsOrOptions: "keep the API notes",
		mode: MODE,
		expected: ["keep the API notes", { mode: MODE }],
	},
	{
		name: "a positional mode only",
		instructionsOrOptions: undefined,
		mode: MODE,
		expected: [undefined, { mode: MODE }],
	},
	{ name: "an empty options object", instructionsOrOptions: {}, mode: undefined, expected: [undefined, {}] },
	{
		name: "options without a mode",
		instructionsOrOptions: { onComplete },
		mode: undefined,
		expected: [undefined, { onComplete }],
	},
	{
		name: "options holding the mode",
		instructionsOrOptions: { onComplete, mode: MODE },
		mode: undefined,
		expected: [undefined, { onComplete, mode: MODE }],
	},
	{
		name: "options and a positional mode",
		instructionsOrOptions: { onComplete },
		mode: MODE,
		expected: [undefined, { onComplete, mode: MODE }],
	},
	{
		name: "an options mode of undefined",
		instructionsOrOptions: { onComplete, mode: undefined },
		mode: undefined,
		expected: [undefined, { onComplete, mode: undefined }],
	},
];

describe("a compaction runs with the instructions and mode its caller passed", () => {
	for (const testCase of CASES) {
		it(testCase.name, async () => {
			const [instructions, options] = await compactWith(testCase.instructionsOrOptions, testCase.mode);
			expect(instructions).toBe(testCase.expected[0]);
			expect(options).toStrictEqual(testCase.expected[1]);
		});
	}

	it("a positional mode is added to a copy, so the caller's options object is not changed", async () => {
		const passed: CompactOptions = { onComplete };
		const [, options] = await compactWith(passed, MODE);
		expect(options).not.toBe(passed);
		expect(passed).toStrictEqual({ onComplete });
	});
});
