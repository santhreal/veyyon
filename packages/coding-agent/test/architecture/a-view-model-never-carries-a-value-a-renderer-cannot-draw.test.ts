/**
 * WHY: `packages/coding-agent/src/presentation/composer-builder.ts`,
 * `status-builder.ts` and `overlay-builder.ts` are the only place session facts
 * become a view-model, and every renderer downstream trusts what they produce.
 * The defect class is a view-model carrying a value the renderer has no way to
 * draw: a caret past the end of the buffer, a context gauge over 100%, a
 * selected index outside the option list, a dialog id that differs between two
 * questions about the same tool call. Each of those surfaces as a corrupted
 * frame or a duplicate prompt far from the line that produced it, so the
 * clamping is asserted here, at the one choke point every field passes through.
 *
 * The builders are pure reductions over explicit input structs, so this drives
 * them directly rather than through a session — the session's own wiring is
 * covered by `integration-event-bridge-wires-agent-to-presentation.test.ts` and
 * `integration-full-terminal-session.test.ts`.
 *
 * What it does NOT catch: whether a renderer honors the view-model it is handed
 * (that is `integration-terminal-driver-renders-view-models.test.ts`), and
 * whether the session passes the right inputs in the first place.
 */

import { describe, expect, test } from "bun:test";
import type { ComposerMode, DialogResult, SelectOption } from "@veyyon/wire/presentation";
import {
	type ComposerInput,
	cursorToOffset,
	offsetToCursor,
	resolveComposerMode,
	resolvePlaceholder,
	toComposerState,
} from "../../src/presentation/composer-builder";
import {
	isApproval,
	toConfirmDialog,
	toOverlayViewModel,
	toPromptDialog,
	toSelectDialog,
	toToolApprovalDialog,
} from "../../src/presentation/overlay-builder";
import { messageFingerprint, structuralTextSize } from "../../src/presentation/status-producer";
import { calculateTokensPerSecond, MIN_RATE_DURATION_MS, tokensPerSecond } from "../../src/presentation/token-rate";

function composerInput(overrides: Partial<ComposerInput> = {}): ComposerInput {
	return {
		text: "",
		cursorOffset: 0,
		busy: false,
		awaitingApproval: false,
		locked: false,
		...overrides,
	};
}

describe("the composer's mode is decided once, in precedence order", () => {
	// A locked session outranks an approval, an approval outranks the text, and
	// the prefixes only decide when nothing else does. Each row states which
	// condition wins over which.
	const cases: readonly [ComposerInput, ComposerMode][] = [
		[composerInput({ locked: true, awaitingApproval: true, text: "!ls" }), "disabled"],
		[composerInput({ awaitingApproval: true, text: "!ls" }), "awaiting-approval"],
		[composerInput({ text: "!ls" }), "shell"],
		[composerInput({ text: "$1 + 1" }), "shell"],
		[composerInput({ text: "/model" }), "search"],
		[composerInput({ text: "hello" }), "input"],
		[composerInput({ busy: true, text: "hello" }), "input"],
	];
	test.each(cases)("%o resolves to %s", (input, expected) => {
		expect(resolveComposerMode(input)).toBe(expected);
	});

	test("a busy session still accepts input and says the submit will queue", () => {
		expect(toComposerState(composerInput({ busy: true, text: "next" })).queueOnSubmit).toBe(true);
	});

	test("a locked session never reports a queueing submit, busy or not", () => {
		// Otherwise the composer offers to queue a message the session will drop.
		const state = toComposerState(composerInput({ locked: true, busy: true, text: "next" }));
		expect(state.mode).toBe("disabled");
		expect(state.queueOnSubmit).toBe(false);
	});

	test("the caret is clamped into the text it belongs to", () => {
		expect(toComposerState(composerInput({ text: "abc", cursorOffset: 99 })).cursorOffset).toBe(3);
		expect(toComposerState(composerInput({ text: "abc", cursorOffset: -4 })).cursorOffset).toBe(0);
		expect(toComposerState(composerInput({ text: "abc", cursorOffset: 1.7 })).cursorOffset).toBe(1);
	});

	test("a placeholder appears only while the composer is empty", () => {
		expect(resolvePlaceholder("input", false)).toBe("Ask, or / for commands");
		expect(resolvePlaceholder("input", true)).toBe("");
		expect(toComposerState(composerInput({ text: "typed" })).placeholder).toBe("");
	});

	test("an absent completion or hint is absent, not undefined-valued", () => {
		// A renderer that spreads the state onto a component would otherwise clear
		// a live completion popup by assigning `undefined` over it.
		const state = toComposerState(composerInput({ text: "a" }));
		expect("completion" in state).toBe(false);
		expect("hint" in state).toBe(false);
		expect(state.attachments).toEqual([]);
	});

	test("offsetToCursor and cursorToOffset round-trip positions across multiline text", () => {
		const lines = ["first", "second line", "end"];
		expect(offsetToCursor(lines, 0)).toEqual({ line: 0, col: 0 });
		expect(offsetToCursor(lines, 5)).toEqual({ line: 0, col: 5 });
		expect(offsetToCursor(lines, 6)).toEqual({ line: 1, col: 0 });
		expect(offsetToCursor(lines, 12)).toEqual({ line: 1, col: 6 });
		expect(offsetToCursor(lines, 17)).toEqual({ line: 1, col: 11 });
		expect(offsetToCursor(lines, 18)).toEqual({ line: 2, col: 0 });
		expect(offsetToCursor(lines, 21)).toEqual({ line: 2, col: 3 });
		expect(offsetToCursor(lines, 999)).toEqual({ line: 2, col: 3 });
		expect(offsetToCursor(lines, -10)).toEqual({ line: 0, col: 0 });

		expect(cursorToOffset(lines, { line: 0, col: 0 })).toBe(0);
		expect(cursorToOffset(lines, { line: 0, col: 5 })).toBe(5);
		expect(cursorToOffset(lines, { line: 1, col: 0 })).toBe(6);
		expect(cursorToOffset(lines, { line: 1, col: 6 })).toBe(12);
		expect(cursorToOffset(lines, { line: 1, col: 11 })).toBe(17);
		expect(cursorToOffset(lines, { line: 2, col: 0 })).toBe(18);
		expect(cursorToOffset(lines, { line: 2, col: 3 })).toBe(21);
		expect(cursorToOffset(lines, { line: 10, col: 99 })).toBe(21);
	});
});

describe("status presentation invariant reductions", () => {
	test("structural text size measures primitives and structures without throwing or allocating", () => {
		expect(structuralTextSize("hello")).toBe(5);
		expect(structuralTextSize(12345)).toBe(8);
		expect(structuralTextSize(true)).toBe(1);
		expect(structuralTextSize(null)).toBe(1);
		expect(structuralTextSize(undefined)).toBe(1);
		expect(structuralTextSize(["a", "bc"])).toBe(2 + (1 + 1) + (1 + 2));
		expect(structuralTextSize({ key: "value" })).toBe(2 + 3 + 1 + 5);
	});

	test("message fingerprint produces stable fingerprints and changes on message mutation", () => {
		const userMsg = { role: "user", content: "hello" } as unknown as never;
		const fp1 = messageFingerprint(userMsg);
		const fp2 = messageFingerprint(userMsg);
		expect(fp1).toBe(fp2);
		expect(fp1).toContain("user:5");

		const mutatedUserMsg = { role: "user", content: "hello world" } as unknown as never;
		expect(messageFingerprint(mutatedUserMsg)).not.toBe(fp1);

		expect(messageFingerprint({ role: "bashExecution", command: "ls", output: "out" } as unknown as never)).toBe(
			"bash:2:3",
		);
	});

	test("tokens per second returns null for zero tokens, short turns, or invalid inputs", () => {
		expect(tokensPerSecond(0, 1000)).toBeNull();
		expect(tokensPerSecond(-5, 1000)).toBeNull();
		expect(tokensPerSecond(100, null)).toBeNull();
		expect(tokensPerSecond(100, undefined)).toBeNull();
		expect(tokensPerSecond(100, MIN_RATE_DURATION_MS - 1)).toBeNull();
		expect(tokensPerSecond(100, 1000)).toBe(100);
		expect(tokensPerSecond(250, 500)).toBe(500);
	});

	test("calculateTokensPerSecond resolves rates from assistant messages", () => {
		const messages = [
			{ role: "user", timestamp: 1000, content: "hi" },
			{
				role: "assistant",
				timestamp: 2000,
				duration: 500,
				usage: { output: 100 },
			},
		];
		expect(calculateTokensPerSecond(messages as never, false)).toBe(200);
		expect(calculateTokensPerSecond([{ role: "user", timestamp: 1000 }], false)).toBeNull();
	});
});

describe("a dialog is identified by the question it asks", () => {
	test("two approvals for one tool call are one question", () => {
		const first = toToolApprovalDialog({ toolCallId: "call_1", toolName: "bash", input: "rm -rf build" });
		const second = toToolApprovalDialog({ toolCallId: "call_1", toolName: "bash", input: "rm -rf build" });
		const other = toToolApprovalDialog({ toolCallId: "call_2", toolName: "bash", input: "rm -rf build" });
		expect(first.id).toBe(second.id);
		expect(first.id).not.toBe(other.id);
		expect(first.id).toContain("call_1");
		expect("impact" in first).toBe(false);
	});

	test("an impact the tool can state reaches the dialog", () => {
		const dialog = toToolApprovalDialog({
			toolCallId: "call_3",
			toolName: "write",
			input: "src/a.ts",
			impact: "creates 1 file",
		});
		expect(dialog.impact).toBe("creates 1 file");
	});

	test("a destructive confirm never defaults to yes", () => {
		const plain = toConfirmDialog({ id: "d1", title: "Continue?", body: "" });
		expect(plain.destructive).toBe(false);
		expect(plain.confirmLabel).toBe("Confirm");
		expect(plain.cancelLabel).toBe("Cancel");
		const destructive = toConfirmDialog({
			id: "d2",
			title: "Delete?",
			body: "",
			destructive: true,
			confirmLabel: "Delete",
		});
		expect(destructive.destructive).toBe(true);
		expect(destructive.confirmLabel).toBe("Delete");
	});

	test("the highlighted row is always a row that exists", () => {
		const options: SelectOption[] = [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		];
		expect(toSelectDialog({ id: "s", title: "Pick", options, selectedIndex: 9 }).selectedIndex).toBe(1);
		expect(toSelectDialog({ id: "s", title: "Pick", options, selectedIndex: -2 }).selectedIndex).toBe(0);
		expect(toSelectDialog({ id: "s", title: "Pick", options: [], selectedIndex: 3 }).selectedIndex).toBe(-1);
	});

	test("a list long enough to need a filter gets one without being asked", () => {
		const rows = (count: number): SelectOption[] =>
			Array.from({ length: count }, (_, index) => ({ value: `v${index}`, label: `L${index}` }));
		expect(toSelectDialog({ id: "s", title: "Pick", options: rows(12) }).filterable).toBe(false);
		expect(toSelectDialog({ id: "s", title: "Pick", options: rows(13) }).filterable).toBe(true);
		// An explicit answer outranks the threshold in both directions.
		expect(toSelectDialog({ id: "s", title: "Pick", options: rows(13), filterable: false }).filterable).toBe(false);
		expect(toSelectDialog({ id: "s", title: "Pick", options: rows(2), filterable: true }).filterable).toBe(true);
	});

	test("a prompt is never masked by accident", () => {
		const prompt = toPromptDialog({ id: "p", title: "Name" });
		expect(prompt.masked).toBe(false);
		expect(prompt.placeholder).toBe("");
		expect(prompt.initialValue).toBe("");
		expect(toPromptDialog({ id: "p", title: "Token", masked: true }).masked).toBe(true);
	});

	test("an overlay can be dismissed unless it deliberately cannot", () => {
		const overlay = toOverlayViewModel({ id: "o", rows: ["one"] });
		expect(overlay.dismissable).toBe(true);
		expect(overlay.anchor).toBe("center");
		expect(overlay.interactive).toBe(false);
		expect("title" in overlay).toBe(false);
		const trapped = toOverlayViewModel({
			id: "o",
			rows: [],
			anchor: "fullscreen",
			dismissable: false,
			title: "Help",
		});
		expect(trapped.dismissable).toBe(false);
		expect(trapped.anchor).toBe("fullscreen");
		expect(trapped.title).toBe("Help");
	});
});

/**
 * Every `DialogResult` member. `satisfies` rejects a stale entry, and the lock
 * below rejects a missing one, so a new outcome fails this file until someone
 * decides whether it consents to a tool call.
 */
const DIALOG_RESULTS = [
	{ outcome: "cancelled" },
	{ outcome: "confirmed" },
	{ outcome: "selected", values: ["a"] },
	{ outcome: "entered", value: "a" },
	{ outcome: "approved", remember: false },
	{ outcome: "rejected" },
] as const satisfies readonly DialogResult[];

type UncoveredOutcome = Exclude<DialogResult["outcome"], (typeof DIALOG_RESULTS)[number]["outcome"]>;
const _every_outcome_is_covered: UncoveredOutcome extends never ? true : UncoveredOutcome = true;
void _every_outcome_is_covered;

describe("only an explicit approval consents to a tool call", () => {
	test.each(DIALOG_RESULTS.map(result => [result.outcome, result] as const))(
		"%s consents only when it is an approval",
		(outcome, result) => {
			expect(isApproval(result)).toBe(outcome === "approved");
		},
	);
});
