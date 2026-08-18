import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@veyyon/ai";
import { InputController, shouldSkipHistory } from "@veyyon/coding-agent/modes/controllers/input-controller";
import { isQueuedMessageList, splitQueuedMessages } from "@veyyon/coding-agent/modes/queue-input";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { normalizeSubmittedPrompt } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import * as secretHelper from "@veyyon/coding-agent/slash-commands/helpers/secret";

// Drives the real editor submit handler through the builtin slash dispatch
// path. Before #3148 only a handful of commands recorded their text (each
// added it inside its own handler); everything else returned `true` from
// executeBuiltinSlashCommand and the controller returned before any
// addToHistory call. The fix centralizes recording after dispatch, with a
// secret filter (shouldSkipHistory) for credential-bearing commands.
function makeCtx(isStreaming = false) {
	const addToHistory = vi.fn();
	const handleMCPCommand = vi.fn(async () => {});
	const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
	const onInputCallback = vi.fn();
	let text = "";
	const editor = {
		onSubmit: undefined as undefined | ((t: string) => Promise<void>),
		getText: () => text,
		setText: (t: string) => {
			text = t;
		},
		getExpandedText: () => text,
		addToHistory,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			text = "";
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	const ctx = {
		editor,
		session: {
			isStreaming,
			isCompacting: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			followUp,
			steer,
		},
		sessionManager: { getCwd: () => "/tmp" },
		settings: {},
		focusedAgentId: undefined,
		collabGuest: undefined,
		handleHotkeysCommand: vi.fn(),
		handleMCPCommand,
		showStatus: vi.fn(),
		onInputCallback,
		startPendingSubmission: (input: {
			text: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
			customType?: string;
			display?: boolean;
			streamingBehavior?: "steer" | "followUp";
		}) => ({ ...input, cancelled: false, started: false }),
		ui: { requestRender: vi.fn(), scrollToLiveTail: vi.fn() },
		compactionQueuedMessages: [],
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editor,
		addToHistory,
		followUp,
		steer,
		onInputCallback,
		handleMCPCommand,
		showStatus: ctx.showStatus,
	};
}

function controllerFor(ctx: InteractiveModeContext) {
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	ctx.handleQueueCommand = message => controller.handleQueueCommand(message);
	return controller;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("input controller — slash command history (#3148)", () => {
	it("records a plain handled command (/hotkeys) that has no per-handler history call", async () => {
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/hotkeys");

		expect(addToHistory).toHaveBeenCalledWith("/hotkeys");
	});

	it("records a non-secret /mcp subcommand", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp list");

		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp list");
		expect(addToHistory).toHaveBeenCalledWith("/mcp list");
	});

	it("does NOT record /mcp add carrying a token as a plain word (would leak the bearer token)", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp add srv url http://x token sk-secret123");

		// Command still executes...
		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp add srv url http://x token sk-secret123");
		// ...but the secret-bearing text is kept out of recallable history.
		expect(addToHistory).not.toHaveBeenCalled();
	});

	/**
	 * The grammars became plain words, and the predicate that decides what may
	 * become durable matched a credential only by its DASH spelling. This is the
	 * pairing that proves the widened matcher: the plain-word line above and the
	 * removed dashed line below are the same credential, and both must be excluded.
	 */
	it("does NOT record /mcp add with a --token, the spelling the grammar no longer has", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp add srv --url http://x --token sk-secret123");

		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp add srv --url http://x --token sk-secret123");
		expect(addToHistory).not.toHaveBeenCalled();
	});

	/**
	 * Locks out the disagreement where isSensitiveSlashCommand's regex required
	 * whitespace or end-of-string after `--token`, so the equally common
	 * `--token=VALUE` spelling was classified as non-sensitive and the bearer token
	 * was written to recallable history. Both spellings carry a credential.
	 */
	it("does NOT record /mcp add with --token=VALUE (the equals spelling is a bearer token too)", async () => {
		const { ctx, editor, addToHistory, handleMCPCommand } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp add srv --url http://x --token=sk-secret123");

		expect(handleMCPCommand).toHaveBeenCalledWith("/mcp add srv --url http://x --token=sk-secret123");
		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("records a /mcp add that carries no credential", async () => {
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp add srv url http://x");

		expect(addToHistory).toHaveBeenCalledWith("/mcp add srv url http://x");
	});

	it("still records a command whose word merely starts with the credential name", async () => {
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.("/mcp smithery-search tokenizer");

		expect(addToHistory).toHaveBeenCalledWith("/mcp smithery-search tokenizer");
	});

	it.each([
		["inline plaintext", "/secret add API_TOKEN inline-history-secret"],
		["environment lookup", "/secret from-env HISTORY_SECRET_ENV API_TOKEN"],
	] as const)("does NOT record /secret add via %s on normal Enter", async (_case, command) => {
		vi.spyOn(secretHelper, "runSecretCommandForSurface").mockResolvedValue({ message: "Stored secret" });
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);

		await editor.onSubmit?.(command);

		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("does NOT record malformed /secret input even when parsing rejects it", async () => {
		const { ctx, editor, addToHistory } = makeCtx();
		controllerFor(ctx);
		const command = "/secret rm API_TOKEN malformed-history-secret";

		await editor.onSubmit?.(command);

		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("does NOT record plaintext /secret input submitted through the follow-up operator path", async () => {
		vi.spyOn(secretHelper, "runSecretCommandForSurface").mockResolvedValue({ message: "Stored secret" });
		const { ctx, editor, addToHistory } = makeCtx(true);
		const controller = controllerFor(ctx);
		editor.setText("/secret add FOLLOW_UP_TOKEN follow-up-history-secret");

		await controller.handleFollowUp();

		expect(addToHistory).not.toHaveBeenCalled();
	});

	/**
	 * Inline credentials are raw suffixes, so normal Enter must not erase a
	 * trailing tab, CR/LF or spaces before canonical slash dispatch reads them.
	 */
	it("preserves trailing credential bytes through normal Enter dispatch", async () => {
		const runSecret = vi.spyOn(secretHelper, "runSecretCommandForSurface").mockResolvedValue({ message: "Stored" });
		const { ctx, editor } = makeCtx();
		controllerFor(ctx);
		const args = "add BYTE_TOKEN raw\tvalue\r\n  ";

		await editor.onSubmit?.(`/secret ${args}`);

		expect(runSecret.mock.calls[0]?.[0]).toBe(args);
	});

	/**
	 * Ctrl+Enter uses a separate follow-up path. It must apply the same canonical
	 * normalization rather than silently storing a different credential.
	 */
	it("preserves trailing credential bytes through follow-up dispatch", async () => {
		const runSecret = vi.spyOn(secretHelper, "runSecretCommandForSurface").mockResolvedValue({ message: "Stored" });
		const { ctx, editor } = makeCtx(true);
		const controller = controllerFor(ctx);
		const args = "add FOLLOW_BYTES raw\tvalue\r\n  ";
		editor.setText(`/secret ${args}`);

		await controller.handleFollowUp();

		expect(runSecret.mock.calls[0]?.[0]).toBe(args);
	});

	/**
	 * The exception is exact: ordinary chat and prefix lookalikes retain the
	 * longstanding outer trim, while leading editor whitespace before a real
	 * `/secret` is removed without touching its trailing payload.
	 */
	it("keeps ordinary trim and does not treat /secretive as sensitive", () => {
		expect(normalizeSubmittedPrompt(" \t ordinary chat \r\n ")).toBe("ordinary chat");
		expect(normalizeSubmittedPrompt("/secretive visible prose  ")).toBe("/secretive visible prose");
		expect(normalizeSubmittedPrompt("  /secret add TOKEN bytes  \t")).toBe("/secret add TOKEN bytes  \t");
	});
	it.each([
		"/secret",
		"/secret list",
		"/secret:add API_TOKEN inline-history-secret",
		"/secret unknown inline-history-secret",
	])("excludes every /secret command shape from persistent history: %s", command => {
		expect(shouldSkipHistory(command)).toBe(true);
	});

	it("does not suppress ordinary commands whose names merely share the prefix", () => {
		expect(shouldSkipHistory("/secretary add meeting")).toBe(false);
		expect(shouldSkipHistory("/hotkeys")).toBe(false);
	});

	it("routes /queue through the yield-only follow-up queue while streaming", async () => {
		const { ctx, editor, addToHistory, followUp, showStatus } = makeCtx(true);
		controllerFor(ctx);
		editor.setText("/queue inspect the final result");

		await editor.onSubmit?.("/queue inspect the final result");

		expect(followUp).toHaveBeenCalledWith("inspect the final result", undefined);
		expect(addToHistory).toHaveBeenCalledWith("/queue inspect the final result");
		expect(showStatus).toHaveBeenCalledWith("Queued message for when the agent yields");
	});

	it("starts the first queued item immediately when the session is idle", async () => {
		const { ctx, editor, followUp, steer, onInputCallback, showStatus } = makeCtx();
		controllerFor(ctx);
		const input = "=>\n1. inspect types\n2. run focused tests\n3. summarize failures";
		editor.setText(input);

		await editor.onSubmit?.(input);

		expect(onInputCallback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "inspect types", streamingBehavior: "followUp" }),
		);
		expect(steer).not.toHaveBeenCalled();
		expect(followUp.mock.calls.map(call => call[0])).toEqual(["run focused tests", "summarize failures"]);
		expect(showStatus).toHaveBeenCalledWith("Sent first message; queued 2 for later yields");
	});

	it("queues an enumerated shorthand prompt as separate ordered follow-ups", async () => {
		const { ctx, editor, addToHistory, followUp, showStatus } = makeCtx(true);
		controllerFor(ctx);
		const input = "=>\n1. inspect types\n2. run focused tests\n3. summarize failures";
		editor.setText(input);

		await editor.onSubmit?.(input);

		expect(followUp.mock.calls.map(call => call[0])).toEqual([
			"inspect types",
			"run focused tests",
			"summarize failures",
		]);
		expect(addToHistory).toHaveBeenCalledWith(input);
		expect(showStatus).toHaveBeenCalledWith("Queued 3 messages for when the agent yields");
	});
});

describe("yield queue list parsing", () => {
	it("recognizes numeric, Roman, and alphabetic sequences", () => {
		const expected = ["first", "second", "third"];
		for (const input of [
			"1. first\n2. second\n3. third",
			"I. first\nII. second\nIII. third",
			"i. first\nii. second\niii. third",
			"A. first\nB. second\nC. third",
			"a) first\nb) second\nc) third",
		]) {
			expect(splitQueuedMessages(input)).toEqual(expected);
		}
	});

	it("keeps continuation lines together and rejects non-sequential markers", () => {
		expect(splitQueuedMessages("1. first line\n   more detail\n2. second")).toEqual([
			"first line\n   more detail",
			"second",
		]);
		expect(splitQueuedMessages("1. first\n3. third")).toEqual(["1. first\n3. third"]);
		expect(isQueuedMessageList("1. first\n2. second\n3. third\n4.")).toBe(true);
		expect(splitQueuedMessages("1. first\n2. second\n3. third\n4.")).toEqual(["first", "second", "third"]);
	});
});
