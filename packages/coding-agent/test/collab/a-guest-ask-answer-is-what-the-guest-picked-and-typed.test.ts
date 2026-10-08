/**
 * A collab guest answering an ask dialog submits the options it left checked and the text it typed after picking
 * Other, and nothing else; Chat, a cancel and a lost transport each end the ask the way the local dialog would.
 *
 * WHY THIS SUITE EXISTS. The guest mirror of the ask dialog is a loop over select and editor requests whose state is
 * a set of checked labels and an optional free-text answer. The paths a guest reaches only by a sequence of picks
 * (unchecking an option, cancelling the Other editor and returning to the list, typing an Other answer after checking
 * options, a recommended index outside the option list) had no test, so a split of the loop could drop the checked
 * options on an Other answer, cancel the whole ask when the Other editor was cancelled, or lose the recommended row.
 *
 * CLASS CLOSED. Each sequence of guest replies is driven through `ExtensionUiController.showAskDialog` with a scripted
 * guest, and both the requests the guest received and the submitted result are compared whole.
 *
 * NOT CAUGHT. The wire transport and its ui-request frames (`guest-ui-request.test.ts`) and the local dialog's own
 * rendering (`ask-dialog` suites).
 */
import { describe, expect, it } from "bun:test";
import type { CollabGuestUiResult } from "@veyyon/coding-agent/collab/host";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogSubmitResult,
} from "@veyyon/coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import type { CollabUiRequestDraft } from "@veyyon/wire";

const OTHER = "Other (type your own)";
const NEXT = "Next →";
const CHAT = "Chat about this";
/** A reply that loses the transport instead of answering. */
const LOST = Symbol("lost transport");

type Reply = string | undefined | typeof LOST;

interface GuestAsk {
	requests: CollabUiRequestDraft[];
	result: ExtensionAskDialogResult | undefined;
	/** True when the guest path ended without an answer and the ask still waited on the local dialog. */
	awaitingLocal: boolean;
}

/**
 * Runs `questions` against a guest that answers each request with the next reply, and closes the ask through its
 * parent signal once every queued reaction has run. The scripted guest answers at once, so an ask the guest decided
 * has settled by then; one still pending is waiting on the local dialog, which never answers on its own.
 */
async function askGuest(questions: ExtensionAskDialogQuestion[], replies: Reply[]): Promise<GuestAsk> {
	const requests: CollabUiRequestDraft[] = [];
	const parent = new AbortController();
	const requestGuestUi = (request: CollabUiRequestDraft): Promise<CollabGuestUiResult> => {
		requests.push(request);
		const reply = replies[requests.length - 1];
		if (reply === LOST || requests.length > replies.length) return Promise.resolve({ kind: "unavailable" });
		return Promise.resolve({ kind: "answered", value: reply });
	};
	const ctx = {
		settings: { get: () => "" },
		session: { isStreaming: false },
		editorContainer: { clear: () => {}, addChild: () => {} },
		editor: { getText: () => "", setText: () => {} },
		focusActiveEditorArea: () => {},
		clearWorkingLoader: () => false,
		ui: {
			requestRender: () => {},
			setFocus: () => {},
			terminal: { rows: 40, columns: 80 },
			addInputListener: () => () => {},
			showOverlay: () => ({ hide: () => {}, setHidden: () => {} }),
		},
		collabHost: { requestGuestUi },
	} as unknown as InteractiveModeContext;
	const pending = new ExtensionUiController(ctx).showAskDialog(questions, { signal: parent.signal });
	let settled = false;
	void pending.then(() => {
		settled = true;
	});
	// Every reaction of the scripted guest is a microtask, so the queue is empty when the next macrotask runs.
	const drained = Promise.withResolvers<void>();
	setImmediate(drained.resolve);
	await drained.promise;
	const awaitingLocal = !settled;
	parent.abort();
	return { requests, result: await pending, awaitingLocal };
}

function rows(request: CollabUiRequestDraft | undefined): string[] {
	if (request?.kind !== "select") return [];
	return request.options.map(option => (typeof option === "string" ? option : option.label));
}

const single: ExtensionAskDialogQuestion = {
	id: "s",
	question: "Pick one?",
	options: [{ label: "A" }, { label: "B" }],
};
const multi: ExtensionAskDialogQuestion = { ...single, id: "m", question: "Pick several?", multi: true };

function submitted(
	question: ExtensionAskDialogQuestion,
	selectedOptions: string[],
	customInput?: string,
): ExtensionAskDialogSubmitResult {
	return {
		kind: "submit",
		results: [
			{
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions,
				customInput,
			},
		],
	};
}

describe("a guest ask answer is what the guest picked and typed", () => {
	it("submits the one option a guest picks from a single-choice question", async () => {
		const ask = await askGuest([single], ["B"]);
		expect(ask.result).toEqual(submitted(single, ["B"]));
		expect(rows(ask.requests[0])).toEqual(["A", "B", OTHER, CHAT]);
	});

	for (const [recommended, initialIndex] of [
		[undefined, 0],
		[1, 1],
		[5, 1],
		[-3, 0],
		[1.5, 0],
	] as const) {
		it(`starts a single-choice guest on row ${initialIndex} when the recommended index is ${recommended}`, async () => {
			const ask = await askGuest([{ ...single, recommended }], ["A"]);
			expect(ask.requests[0]).toMatchObject({ kind: "select", selectionMarker: "radio", initialIndex });
		});
	}

	it("submits the text a guest types after picking Other, with no option selected", async () => {
		const ask = await askGuest([single], [OTHER, "typed"]);
		expect(ask.result).toEqual(submitted(single, [], "typed"));
		expect(ask.requests[1]).toEqual({ kind: "editor", title: "Custom answer: Pick one?" });
	});

	it("shows a single-choice guest the list again when it cancels the Other editor", async () => {
		const ask = await askGuest([single], [OTHER, undefined, "A"]);
		expect(ask.result).toEqual(submitted(single, ["A"]));
		expect(ask.requests[2]).toEqual(ask.requests[0]);
	});

	it("checks and unchecks the options a multi-choice guest toggles, and submits the ones left checked", async () => {
		const ask = await askGuest([multi], ["A", "B", "A", NEXT]);
		expect(ask.result).toEqual(submitted(multi, ["B"]));
		expect(ask.requests.map(request => (request.kind === "select" ? request.checkedIndices : undefined))).toEqual([
			[],
			[0],
			[0, 1],
			[1],
		]);
		expect(ask.requests.map(request => rows(request).includes(NEXT))).toEqual([false, true, true, true]);
		expect(ask.requests.map(request => (request.kind === "select" ? request.helpText : undefined))).toEqual([
			"up/down navigate  enter toggle  esc cancel",
			"up/down navigate  enter toggle  Next → continue  esc cancel",
			"up/down navigate  enter toggle  Next → continue  esc cancel",
			"up/down navigate  enter toggle  Next → continue  esc cancel",
		]);
	});

	it("keeps the options a multi-choice guest checked when it ends with an Other answer", async () => {
		const ask = await askGuest([multi], ["B", OTHER, "typed"]);
		expect(ask.result).toEqual(submitted(multi, ["B"], "typed"));
	});

	it("returns a multi-choice guest to its unchanged list when it cancels the Other editor", async () => {
		const ask = await askGuest([multi], ["A", OTHER, undefined, NEXT]);
		expect(ask.result).toEqual(submitted(multi, ["A"]));
		expect(ask.requests[3]).toEqual(ask.requests[1]);
	});

	it("asks the next question only after the guest answers the one before it", async () => {
		const ask = await askGuest([single, multi], ["A", "B", NEXT]);
		expect(ask.requests.map(request => (request.kind === "select" ? request.title : request.kind))).toEqual([
			"Pick one?",
			"Pick several?",
			"Pick several?",
		]);
		expect(ask.result).toEqual({
			kind: "submit",
			results: [submitted(single, ["A"]).results[0], submitted(multi, ["B"]).results[0]],
		});
	});

	for (const question of [single, multi]) {
		const kind = question.multi ? "multi" : "single";
		it(`ends a ${kind}-choice ask in chat when the guest picks Chat`, async () => {
			const ask = await askGuest([question, single], [CHAT]);
			expect(ask.result).toEqual({ kind: "chat" });
			expect(ask.awaitingLocal).toBe(false);
			expect(ask.requests).toHaveLength(1);
		});

		it(`cancels a ${kind}-choice ask when the guest cancels the list`, async () => {
			const ask = await askGuest([question, single], [undefined]);
			expect(ask.result).toBeUndefined();
			expect(ask.awaitingLocal).toBe(false);
			expect(ask.requests).toHaveLength(1);
		});

		for (const replies of [[LOST], [OTHER, LOST]] as const) {
			it(`leaves a ${kind}-choice ask to the local dialog when the transport is lost after ${replies.length - 1} picks`, async () => {
				const ask = await askGuest([question, single], [...replies]);
				expect(ask.awaitingLocal).toBe(true);
				expect(ask.requests).toHaveLength(replies.length);
				expect(ask.result).toBeUndefined();
			});
		}
	}

	it("sends a trimmed description and drops a blank one", async () => {
		const ask = await askGuest(
			[
				{
					...single,
					options: [
						{ label: "A", description: "  first  " },
						{ label: "B", description: "   " },
					],
				},
			],
			["A"],
		);
		expect(ask.requests[0]).toMatchObject({ options: [{ label: "A", description: "first" }, "B", OTHER, CHAT] });
	});
});
