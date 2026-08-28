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
import type { ComposerMode, DialogResult, SelectOption, SessionActivity } from "@veyyon/wire/presentation";
import {
	type ComposerInput,
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
import {
	emptyCost,
	resolveActivity,
	resolveContextGauge,
	type StatusInput,
	toStatusLineState,
} from "../../src/presentation/status-builder";

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

function statusInput(overrides: Partial<StatusInput> = {}): StatusInput {
	return {
		streaming: false,
		thinking: false,
		runningToolCalls: 0,
		compacting: false,
		awaitingApproval: false,
		model: "mock/mock-model",
		usedTokens: 0,
		contextWindow: 200_000,
		contextWindowFromProvider: false,
		cost: emptyCost(),
		workingDirectory: "/repo",
		elapsedMs: 0,
		queuedMessages: 0,
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
});

describe("the status line reports the activity that blocks the operator", () => {
	const cases: readonly [StatusInput, SessionActivity][] = [
		[
			statusInput({
				streaming: true,
				thinking: true,
				runningToolCalls: 2,
				compacting: true,
				awaitingApproval: true,
			}),
			"waiting-approval",
		],
		[statusInput({ streaming: true, runningToolCalls: 2, compacting: true }), "compacting"],
		[statusInput({ streaming: true, thinking: true, runningToolCalls: 1 }), "tool-running"],
		[statusInput({ streaming: true, thinking: true }), "thinking"],
		[statusInput({ streaming: true }), "streaming"],
		[statusInput(), "idle"],
	];
	test.each(cases)("%o resolves to %s", (input, expected) => {
		expect(resolveActivity(input)).toBe(expected);
	});

	test("the context gauge never reads over full and never divides by zero", () => {
		expect(resolveContextGauge(statusInput({ usedTokens: 300, contextWindow: 100 }))).toEqual({
			used: 100,
			total: 100,
			providerReported: false,
		});
		expect(resolveContextGauge(statusInput({ usedTokens: 5, contextWindow: 0 }))).toEqual({
			used: 1,
			total: 1,
			providerReported: false,
		});
		expect(resolveContextGauge(statusInput({ usedTokens: -20, contextWindow: 50 })).used).toBe(0);
	});

	test("the gauge records whether the window came from the provider", () => {
		// A catalog figure and a provider figure disagree, and an operator reading a
		// percentage needs to know which one they are looking at.
		expect(resolveContextGauge(statusInput({ contextWindowFromProvider: true })).providerReported).toBe(true);
	});

	test("an idle session is in no activity rather than zero milliseconds into one", () => {
		expect(toStatusLineState(statusInput({ elapsedMs: 9_000 })).elapsedMs).toBe(0);
		expect(toStatusLineState(statusInput({ streaming: true, elapsedMs: 9_000 })).elapsedMs).toBe(9_000);
	});

	test("counters never go negative", () => {
		const state = toStatusLineState(statusInput({ streaming: true, elapsedMs: -5, queuedMessages: -3 }));
		expect(state.elapsedMs).toBe(0);
		expect(state.queuedMessages).toBe(0);
	});

	test("optional fields are omitted when the session has nothing to say", () => {
		const bare = toStatusLineState(statusInput());
		expect("thinkingLevel" in bare).toBe(false);
		expect("gitBranch" in bare).toBe(false);
		expect("notice" in bare).toBe(false);
		const full = toStatusLineState(
			statusInput({
				thinkingLevel: "high",
				gitBranch: "tui-decoupling",
				notice: { level: "warning", text: "rate limited" },
			}),
		);
		expect(full.thinkingLevel).toBe("high");
		expect(full.gitBranch).toBe("tui-decoupling");
		expect(full.notice).toEqual({ level: "warning", text: "rate limited" });
	});

	test("a fresh session has spent nothing", () => {
		expect(emptyCost()).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalUsd: 0,
		});
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
