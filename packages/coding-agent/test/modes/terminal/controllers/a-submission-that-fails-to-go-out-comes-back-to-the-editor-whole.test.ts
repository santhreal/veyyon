/**
 * A submission whose dispatch fails comes back to the editor whole: its text, every pending image, and each
 * image's blob link (an unlinked slot per image when it had none), with the error shown.
 *
 * The class is every route a draft leaves the composer by: Enter and Ctrl+Enter on the main session, streaming
 * and idle, both keys in a focused agent view, both keys on a skill command, and the `/queue` and `=>` yield
 * queue, including a queue that fails partway and hands back only the messages that did not go out. Enter is
 * driven the way the composer delivers it: the composer empties itself and hands the line to `submit`, so a
 * route that restores "what the editor held" restores nothing. A route that drops the text, an image, or a link
 * on a failed dispatch loses what was typed. Each route also pins the session it dispatches to, the streaming
 * behavior it dispatches with, and the images that ride along.
 *
 * The rows are the routes `InputController` exposes today; a route added to the controller without a row here
 * is not caught. A skill whose file fails to load fails before dispatch and is not exercised.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@veyyon/ai";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { InputController } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { TempDir } from "@veyyon/utils";

const IMAGE_A: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2UtYQ==" };
const IMAGE_B: ImageContent = { type: "image", mimeType: "image/jpeg", data: "aW1hZ2UtYg==" };
const FAILURE = "dispatch rejected";

interface StubEditor {
	setText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	addToHistory(text: string): void;
	clearDraft(historyText?: string): void;
	imageLinks: (string | undefined)[] | undefined;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
}

interface Draft {
	readonly images: ImageContent[];
	readonly links: (string | undefined)[] | undefined;
}

const NO_DRAFT: Draft = { images: [], links: undefined };

type Key = "enter" | "ctrl+enter";

interface Setup {
	readonly streaming: boolean;
	readonly focused?: boolean;
	readonly draft?: Draft;
	/** The composer line. */
	readonly text?: string;
	/** Messages already queued on the session. */
	readonly queued?: number;
	/** The main loop waits for input, so an idle submission goes to it rather than to `prompt`. */
	readonly inputWaiter?: boolean;
	readonly compacting?: boolean;
}

interface Harness {
	readonly editor: StubEditor;
	readonly errors: string[];
	readonly statuses: string[];
	/** `<session>.<method>[:<streaming behavior>]` of every dispatch, in order. */
	readonly dispatched: string[];
	/** The number of images each dispatch carried, in dispatch order. */
	readonly imagesSent: number[];
	readonly compactionQueue: CompactionQueuedMessage[];
	/** Dispatches at this index and after reject. */
	failFrom: number;
	/** Runs inside a dispatch before it settles, as an edit made while the dispatch is in flight. */
	duringDispatch: (() => void) | undefined;
	/** Presses `key` the way the composer delivers it. */
	press(key: Key): Promise<void>;
	queue(message: string): Promise<void>;
}

let skillDir: TempDir;
let skillCommands: Map<string, Skill>;

beforeAll(async () => {
	skillDir = TempDir.createSync("@a-failed-submission-");
	const filePath = path.join(skillDir.path(), "test-skill.md");
	await fs.writeFile(filePath, "---\nname: test-skill\n---\nDo the thing.\n");
	skillCommands = new Map([
		["skill:test-skill", { name: "test-skill", description: "", filePath, baseDir: skillDir.path(), source: "test" }],
	]);
});

afterAll(() => {
	skillDir.removeSync();
});

function harness(setup: Setup): Harness {
	const draft = setup.draft ?? NO_DRAFT;
	let editorText = setup.text ?? "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		addToHistory() {},
		clearDraft(historyText) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		imageLinks: undefined,
		pendingImages: [...draft.images],
		pendingImageLinks: draft.links ? [...draft.links] : draft.images.map(() => undefined),
	};
	const dispatched: string[] = [];
	const imagesSent: number[] = [];
	const record = (to: string, images: number): number => {
		imagesSent.push(images);
		return dispatched.push(to) - 1;
	};
	const dispatch = async (to: string, images: number): Promise<void> => {
		const index = record(to, images);
		h.duringDispatch?.();
		if (index >= h.failFrom) throw new Error(FAILURE);
	};
	const session = (name: string) => ({
		isStreaming: setup.streaming,
		isCompacting: setup.compacting ?? false,
		isBashRunning: false,
		isEvalRunning: false,
		queuedMessageCount: setup.queued ?? 0,
		extensionRunner: undefined,
		prompt: (_text: string, options?: { streamingBehavior?: string; images?: ImageContent[] }) =>
			dispatch(`${name}.prompt:${options?.streamingBehavior ?? "-"}`, options?.images?.length ?? 0),
		followUp: (_text: string, images?: ImageContent[]) => dispatch(`${name}.followUp`, images?.length ?? 0),
		promptCustomMessage: (
			message: { content: string | { type: string }[] },
			options?: { streamingBehavior?: string },
		) =>
			dispatch(
				`${name}.promptCustomMessage:${options?.streamingBehavior ?? "-"}`,
				typeof message.content === "string" ? 0 : message.content.filter(block => block.type === "image").length,
			),
	});
	const errors: string[] = [];
	const statuses: string[] = [];
	const compactionQueue: CompactionQueuedMessage[] = [];
	const main = session("main");
	const ctx = {
		editor,
		ui: { requestRender() {}, scrollToLiveTail() {} },
		skillCommands,
		session: main,
		viewSession: setup.focused ? session("view") : main,
		focusedAgentId: setup.focused ? "agent-1" : undefined,
		collabGuest: undefined,
		onInputCallback: setup.inputWaiter
			? (submission: { images?: ImageContent[] }) => record("main.inputWaiter", submission.images?.length ?? 0)
			: undefined,
		startPendingSubmission: (submission: { images?: ImageContent[] }) => submission,
		sessionManager: { getSessionName: () => "named session" },
		loopModeEnabled: false,
		isBashMode: false,
		isPythonMode: false,
		compactionQueuedMessages: compactionQueue,
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: (_text: string, fn: () => Promise<unknown>) => fn(),
		handleQueueCommand: (message: string) => controller.handleQueueCommand(message),
		flushPendingBashComponents() {},
		updatePendingMessagesDisplay() {},
		showError: (message: string) => errors.push(message),
		showStatus: (message: string) => statuses.push(message),
		showWarning: (message: string) => statuses.push(message),
		refreshComposerShortcuts() {},
		dismissWelcome() {},
	};
	const controller = new InputController(ctx as unknown as InteractiveModeContext);
	const h: Harness = {
		editor,
		errors,
		statuses,
		dispatched,
		imagesSent,
		compactionQueue,
		failFrom: 0,
		duringDispatch: undefined,
		press(key) {
			if (key === "ctrl+enter") return controller.handleFollowUp();
			// The composer empties itself on Enter and hands its line to the submit handler.
			const line = editor.getText();
			editor.setText("");
			return controller.submit(line);
		},
		queue: message => controller.handleQueueCommand(message),
	};
	return h;
}

interface Route {
	readonly name: string;
	readonly key: Key;
	readonly streaming: boolean;
	readonly focused?: boolean;
	/** The composer line when the key is pressed. */
	readonly text: string;
	/** The one dispatch the route makes before it fails. */
	readonly dispatch: string;
	/** The editor text after the failure, when it is not `text` as typed. */
	readonly handedBack?: string;
}

const TEXT = "look at this";
const SKILL = "/skill:test-skill go";

const ROUTES: readonly Route[] = [
	{
		name: "Enter while the session streams",
		key: "enter",
		streaming: true,
		text: TEXT,
		dispatch: "main.prompt:steer",
	},
	{
		name: "Enter while idle with no input waiter",
		key: "enter",
		streaming: false,
		text: TEXT,
		dispatch: "main.prompt:steer",
	},
	{
		name: "Ctrl+Enter while the session streams",
		key: "ctrl+enter",
		streaming: true,
		text: TEXT,
		dispatch: "main.prompt:followUp",
	},
	{ name: "Ctrl+Enter while idle", key: "ctrl+enter", streaming: false, text: TEXT, dispatch: "main.prompt:-" },
	{
		name: "Enter in a focused view",
		key: "enter",
		streaming: true,
		focused: true,
		text: TEXT,
		dispatch: "view.prompt:steer",
	},
	{
		name: "Ctrl+Enter in a focused view",
		key: "ctrl+enter",
		streaming: false,
		focused: true,
		text: TEXT,
		dispatch: "view.prompt:followUp",
	},
	{ name: "Enter on a skill", key: "enter", streaming: true, text: SKILL, dispatch: "main.promptCustomMessage:steer" },
	{
		name: "Ctrl+Enter on a skill",
		key: "ctrl+enter",
		streaming: false,
		text: SKILL,
		dispatch: "main.promptCustomMessage:followUp",
	},
	{
		name: "Enter on /queue while the session streams",
		key: "enter",
		streaming: true,
		text: `/queue ${TEXT}`,
		dispatch: "main.followUp",
		handedBack: `=> ${TEXT}`,
	},
	{
		name: "Enter on /queue while idle, which starts the turn",
		key: "enter",
		streaming: false,
		text: `/queue ${TEXT}`,
		dispatch: "main.prompt:followUp",
		handedBack: `=> ${TEXT}`,
	},
	{
		name: "Ctrl+Enter on /queue",
		key: "ctrl+enter",
		streaming: true,
		text: `/queue ${TEXT}`,
		dispatch: "main.followUp",
	},
	{ name: "Enter on =>", key: "enter", streaming: true, text: `=> ${TEXT}`, dispatch: "main.followUp" },
	{
		name: "Enter on an => list",
		key: "enter",
		streaming: true,
		text: "=> 1. first\n2. second",
		dispatch: "main.followUp",
		handedBack: "=>\n1. first\n2. second",
	},
];

const DRAFTS: readonly (readonly [string, Draft])[] = [
	["text only", NO_DRAFT],
	["two linked images", { images: [IMAGE_A, IMAGE_B], links: ["local://a.png", "local://b.jpg"] }],
	["one unlinked image", { images: [IMAGE_A], links: undefined }],
	["a linked and an unlinked image", { images: [IMAGE_A, IMAGE_B], links: ["local://a.png", undefined] }],
	// A pending submission handed back without links leaves the editor's link list empty beside its images.
	["two images and an empty link list", { images: [IMAGE_A, IMAGE_B], links: [] }],
];

function harnessFor(route: Route, draft: Draft): Harness {
	return harness({ streaming: route.streaming, focused: route.focused, draft, text: route.text });
}

describe("a submission that fails to go out comes back to the editor whole", () => {
	for (const route of ROUTES) {
		for (const [draftName, draft] of DRAFTS) {
			it(`${route.name}, with ${draftName}`, async () => {
				const h = harnessFor(route, draft);
				await h.press(route.key);

				expect(h.dispatched).toEqual([route.dispatch]);
				expect(h.imagesSent).toEqual([draft.images.length]);
				expect(h.errors).toEqual([FAILURE]);
				expect(h.editor.getText()).toBe(route.handedBack ?? route.text);
				expect(h.editor.pendingImages).toEqual(draft.images);
				// `toEqual` passes an array missing its undefined slots; a missing slot unpairs an image from its link.
				const links = draft.images.map((_, index) => draft.links?.[index]);
				expect(h.editor.pendingImageLinks).toStrictEqual(links);
				expect(h.editor.imageLinks).toStrictEqual(draft.images.length > 0 ? links : undefined);
			});
		}
	}

	it("a submission that goes out leaves the editor empty and shows no error", async () => {
		for (const route of ROUTES) {
			const h = harnessFor(route, { images: [IMAGE_A], links: ["local://a.png"] });
			h.failFrom = Number.POSITIVE_INFINITY;
			await h.press(route.key);
			expect({
				route: route.name,
				text: h.editor.getText(),
				images: h.editor.pendingImages,
				errors: h.errors,
			}).toEqual({
				route: route.name,
				text: "",
				images: [],
				errors: [],
			});
		}
	});

	for (const key of ["enter", "ctrl+enter"] as const) {
		it(`${key} while streaming keeps a draft typed during the failed dispatch only when it steers`, async () => {
			const h = harness({ streaming: true, draft: { images: [IMAGE_A], links: ["local://a.png"] }, text: TEXT });
			h.duringDispatch = () => h.editor.setText("typed meanwhile");
			await h.press(key);

			expect(h.errors).toEqual([FAILURE]);
			// Enter steers, and a failed steer leaves a newer draft in place; Ctrl+Enter hands its message back over it.
			if (key === "enter") {
				expect(h.editor.getText()).toBe("typed meanwhile");
				expect(h.editor.pendingImages).toEqual([]);
			} else {
				expect(h.editor.getText()).toBe(TEXT);
				expect(h.editor.pendingImages).toEqual([IMAGE_A]);
			}
		});
	}

	it("an image-only /queue that fails hands back its images and no text", async () => {
		const h = harness({ streaming: true, draft: { images: [IMAGE_A], links: ["local://a.png"] }, text: "/queue" });
		await h.press("enter");

		expect(h.dispatched).toEqual(["main.followUp"]);
		expect(h.imagesSent).toEqual([1]);
		expect(h.errors).toEqual([FAILURE]);
		expect(h.editor.getText()).toBe("");
		expect(h.editor.pendingImages).toEqual([IMAGE_A]);
		expect(h.editor.pendingImageLinks).toEqual(["local://a.png"]);
	});
});

describe("a queue that fails partway hands back only the messages that did not go out", () => {
	const LIST = "1. first\n2. second\n3. third";
	for (const [failFrom, expected] of [
		[1, "=>\n1. second\n2. third"],
		[2, "=> third"],
	] as const) {
		it(`failing at message ${failFrom + 1} of 3 leaves ${JSON.stringify(expected)} with no image`, async () => {
			const h = harness({
				streaming: true,
				draft: { images: [IMAGE_A], links: ["local://a.png"] },
				text: `/queue ${LIST}`,
			});
			h.failFrom = failFrom;
			await h.queue(LIST);

			expect(h.dispatched).toEqual(["main.followUp", "main.followUp", "main.followUp"].slice(0, failFrom + 1));
			expect(h.errors).toEqual([FAILURE]);
			expect(h.editor.getText()).toBe(expected);
			expect(h.editor.pendingImages).toEqual([]);
			expect(h.statuses).toEqual([]);
		});
	}

	it("a queue whose first message went to the waiting loop hands back the rest when the next fails", async () => {
		const h = harness({ streaming: false, inputWaiter: true, text: `/queue ${LIST}` });
		h.failFrom = 1;
		await h.queue(LIST);

		expect(h.dispatched).toEqual(["main.inputWaiter", "main.followUp"]);
		expect(h.errors).toEqual([FAILURE]);
		expect(h.editor.getText()).toBe("=>\n1. second\n2. third");
	});

	it("a multi-line message handed back indents its continuation lines under its number", async () => {
		const h = harness({ streaming: true });
		h.failFrom = 1;
		await h.queue("1. first\n2. second\nmore of second\n3. third");
		expect(h.editor.getText()).toBe("=>\n1. second\n   more of second\n2. third");
	});
});

describe("a queue that goes out sends its images with the first message and reports what it sent", () => {
	const TWO_IMAGES: Draft = { images: [IMAGE_A, IMAGE_B], links: undefined };
	for (const [name, setup, list, dispatched, status] of [
		["idle", { streaming: false }, "only", ["main.prompt:followUp"], "Sent queued message"],
		[
			"idle",
			{ streaming: false },
			"1. first\n2. second\n3. third",
			["main.prompt:followUp", "main.followUp", "main.followUp"],
			"Sent first message; queued 2 for later yields",
		],
		[
			"idle with the loop waiting for input",
			{ streaming: false, inputWaiter: true },
			"1. first\n2. second",
			["main.inputWaiter", "main.followUp"],
			"Sent first message; queued 1 for later yields",
		],
		[
			"idle behind messages already queued",
			{ streaming: false, queued: 2 },
			"only",
			["main.followUp"],
			"Queued message for when the agent yields",
		],
		["streaming", { streaming: true }, "only", ["main.followUp"], "Queued message for when the agent yields"],
		[
			"streaming",
			{ streaming: true },
			"1. first\n2. second",
			["main.followUp", "main.followUp"],
			"Queued 2 messages for when the agent yields",
		],
	] as const) {
		it(`${name}, ${JSON.stringify(list)} dispatches ${dispatched.join(", ")} and reports ${JSON.stringify(status)}`, async () => {
			const h = harness({ ...setup, draft: TWO_IMAGES });
			h.failFrom = Number.POSITIVE_INFINITY;
			await h.queue(list);
			expect(h.dispatched).toEqual([...dispatched]);
			expect(h.imagesSent).toEqual(dispatched.map((_, index) => (index === 0 ? 2 : 0)));
			expect(h.statuses).toEqual([status]);
			expect(h.errors).toEqual([]);
		});
	}

	for (const [list, status] of [
		["only", "Queued message for after compaction"],
		["1. first\n2. second", "Queued 2 messages for after compaction"],
	] as const) {
		it(`while compacting, ${JSON.stringify(list)} waits for compaction with its images on the first message`, async () => {
			const h = harness({ streaming: true, compacting: true, draft: { images: [IMAGE_A], links: undefined } });
			await h.queue(list);
			const messages = list === "only" ? ["only"] : ["first", "second"];
			expect(h.compactionQueue).toEqual(
				messages.map((text, index) => ({ text, mode: "followUp", images: index === 0 ? [IMAGE_A] : undefined })),
			);
			expect(h.dispatched).toEqual([]);
			expect(h.statuses).toEqual([status]);
		});
	}
});
