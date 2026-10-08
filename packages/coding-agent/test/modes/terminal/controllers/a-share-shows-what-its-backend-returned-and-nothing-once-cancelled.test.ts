/**
 * `/share` (`CommandController.handleShareCommand`) swaps the editor for a cancellable loader, runs one of two
 * backends, puts the editor back, and shows the outcome: a custom share script handed a standalone HTML export, or
 * the default encrypted share.
 *
 * Contracts, swept over every outcome of both backends, each run to completion and each cancelled mid-run:
 *  - a completed share shows exactly the lines its result states and opens exactly the URL it returned;
 *  - a failed share shows one error naming the backend that failed;
 *  - a cancelled share shows only "Share cancelled", whatever its backend later returns or throws;
 *  - the editor is back in place and focused afterwards, and the custom share's HTML export is deleted;
 *  - a share script that fails to load shows its error before the editor is touched;
 *  - the default share redacts the snapshot only while `share.redactSecrets` is on.
 *
 * Gap: what the share backends upload is owned by `export/share.ts` and its tests; this suite stubs both at the
 * module boundary and asserts only what the controller does with their results.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { CustomShareResult } from "@veyyon/coding-agent/export/custom-share";
import * as customShareModule from "@veyyon/coding-agent/export/custom-share";
import type { ShareSessionResult } from "@veyyon/coding-agent/export/share";
import * as shareModule from "@veyyon/coding-agent/export/share";
import {
	CommandController,
	type CommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import * as openModule from "@veyyon/coding-agent/utils/open";
import { type Component, Container, Text } from "@veyyon/tui";
import { useTruecolorTheme } from "../../../helpers/theme-assertions";

useTruecolorTheme("dark");

const URL_A = "https://share.example.test/abc#key";
const GIST = "https://gist.example.test/abc";
const ESCAPE = "\x1b";

interface ShareRun {
	statuses: string[];
	errors: string[];
	opened: string[];
	exports: string[];
	editorRestored: boolean;
	shareOptions: unknown;
	obfuscator: unknown;
}

type Backend =
	| { kind: "custom"; outcome: () => Promise<CustomShareResult | string | undefined> }
	| { kind: "default"; outcome: () => Promise<ShareSessionResult> };

const REDACTOR = { redact: (value: unknown) => value };

/**
 * Runs `/share` against `backend`. With `cancel`, the loader receives Escape while the backend is still running,
 * and the backend settles afterwards.
 */
async function runShare(backend: Backend, options: { cancel?: boolean; redactSecrets?: boolean } = {}) {
	const editor = new Text("editor", 0, 0);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	let focused: Component | undefined = editor;
	const run: ShareRun = {
		statuses: [],
		errors: [],
		opened: [],
		exports: [],
		editorRestored: false,
		shareOptions: undefined,
		obfuscator: undefined,
	};
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const settleAfterRelease = async <T>(outcome: () => Promise<T>): Promise<T> => {
		started.resolve();
		if (options.cancel) await release.promise;
		return outcome();
	};

	vi.spyOn(openModule, "openPath").mockImplementation((target: string) => {
		run.opened.push(target);
	});
	if (backend.kind === "custom") {
		vi.spyOn(customShareModule, "loadCustomShare").mockResolvedValue({
			path: "share.ts",
			fn: () => settleAfterRelease(backend.outcome),
		});
	} else {
		vi.spyOn(customShareModule, "loadCustomShare").mockResolvedValue(null);
		vi.spyOn(shareModule, "shareSession").mockImplementation((_sm, shareOptions) => {
			run.shareOptions = shareOptions;
			run.obfuscator = shareOptions?.obfuscator;
			return settleAfterRelease(backend.outcome);
		});
	}

	const settings: Record<string, unknown> = {
		"share.serverUrl": "https://share.example.test",
		"share.store": "gist",
		"share.redactSecrets": options.redactSecrets ?? false,
	};
	const ctx = {
		ui: {
			setFocus: (component: Component) => {
				focused = component;
			},
			requestRender: () => {},
			requestComponentRender: () => {},
			requestDirectWrite: () => {},
		},
		editor,
		editorContainer,
		session: {
			exportToHtml: async (target: string) => {
				run.exports.push(target);
				await fs.writeFile(target, "<html></html>");
			},
			sessionManager: {},
			state: {},
			providerRedactor: REDACTOR,
		},
		settings: { get: (key: string) => settings[key] },
		showStatus: (message: string) => run.statuses.push(message),
		showError: (message: string) => run.errors.push(message),
	} as unknown as CommandControllerContext;

	const pending = new CommandController(ctx).handleShareCommand();
	if (options.cancel) {
		await started.promise;
		const loader = editorContainer.children[0];
		expect(loader).not.toBe(editor);
		loader?.handleInput?.(ESCAPE);
		release.resolve();
	}
	await pending;
	run.editorRestored =
		editorContainer.children.length === 1 && editorContainer.children[0] === editor && focused === editor;
	return run;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

interface OutcomeCase<T> {
	name: string;
	outcome: () => Promise<T>;
	statuses: string[];
	errors: string[];
	opened: string[];
}

const CUSTOM_OUTCOMES: OutcomeCase<CustomShareResult | string | undefined>[] = [
	{
		name: "a bare string is the share URL",
		outcome: async () => URL_A,
		statuses: [`Share URL: ${URL_A}`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a URL and a message show on two lines",
		outcome: async () => ({ url: URL_A, message: "Link copied." }),
		statuses: [`Share URL: ${URL_A}\nLink copied.`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a URL alone",
		outcome: async () => ({ url: URL_A }),
		statuses: [`Share URL: ${URL_A}`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a message alone opens nothing",
		outcome: async () => ({ message: "Posted to the team channel." }),
		statuses: ["Posted to the team channel."],
		errors: [],
		opened: [],
	},
	{
		name: "an empty result object shows nothing",
		outcome: async () => ({}),
		statuses: [],
		errors: [],
		opened: [],
	},
	{
		name: "no result means the share went through",
		outcome: async () => undefined,
		statuses: ["Session shared"],
		errors: [],
		opened: [],
	},
	{
		name: "a throwing script is a custom share failure",
		outcome: async () => {
			throw new Error("upload quota exceeded");
		},
		statuses: [],
		errors: ["Custom share failed: upload quota exceeded"],
		opened: [],
	},
];

const DEFAULT_RESULT: ShareSessionResult = { url: URL_A, method: "server", truncated: false, sealedBytes: 10 };
const TRIMMED_NOTE = "Note: large content was trimmed to fit the share size limit.";

const DEFAULT_OUTCOMES: OutcomeCase<ShareSessionResult>[] = [
	{
		name: "a server share shows its URL",
		outcome: async () => DEFAULT_RESULT,
		statuses: [`Share URL: ${URL_A}`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a gist share adds the gist line",
		outcome: async () => ({ ...DEFAULT_RESULT, method: "gist", gistUrl: GIST }),
		statuses: [`Share URL: ${URL_A}\nGist: ${GIST}`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a trimmed share adds the trim note",
		outcome: async () => ({ ...DEFAULT_RESULT, truncated: true }),
		statuses: [`Share URL: ${URL_A}\n${TRIMMED_NOTE}`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a trimmed gist share shows all three lines in order",
		outcome: async () => ({ ...DEFAULT_RESULT, method: "gist", gistUrl: GIST, truncated: true }),
		statuses: [`Share URL: ${URL_A}\nGist: ${GIST}\n${TRIMMED_NOTE}`],
		errors: [],
		opened: [URL_A],
	},
	{
		name: "a thrown error is a share failure with its message",
		outcome: async () => {
			throw new Error("share server unreachable");
		},
		statuses: [],
		errors: ["Failed to share session: share server unreachable"],
		opened: [],
	},
	{
		name: "a thrown non-error is a share failure with no message",
		outcome: async () => {
			throw "offline";
		},
		statuses: [],
		errors: ["Failed to share session: Unknown error"],
		opened: [],
	},
];

describe("a completed share shows what its backend returned", () => {
	for (const testCase of CUSTOM_OUTCOMES) {
		it(`custom share: ${testCase.name}`, async () => {
			const run = await runShare({ kind: "custom", outcome: testCase.outcome });
			expect(run.statuses).toEqual(testCase.statuses);
			expect(run.errors).toEqual(testCase.errors);
			expect(run.opened).toEqual(testCase.opened);
			expect(run.editorRestored).toBe(true);
			expect(await Promise.all(run.exports.map(exists))).toEqual([false]);
		});
	}

	for (const testCase of DEFAULT_OUTCOMES) {
		it(`default share: ${testCase.name}`, async () => {
			const run = await runShare({ kind: "default", outcome: testCase.outcome });
			expect(run.statuses).toEqual(testCase.statuses);
			expect(run.errors).toEqual(testCase.errors);
			expect(run.opened).toEqual(testCase.opened);
			expect(run.editorRestored).toBe(true);
			expect(run.exports).toEqual([]);
		});
	}
});

describe("a cancelled share shows nothing but its cancellation", () => {
	for (const testCase of CUSTOM_OUTCOMES) {
		it(`custom share cancelled while running: ${testCase.name}`, async () => {
			const run = await runShare({ kind: "custom", outcome: testCase.outcome }, { cancel: true });
			expect(run.statuses).toEqual(["Share cancelled"]);
			expect(run.errors).toEqual([]);
			expect(run.opened).toEqual([]);
			expect(run.editorRestored).toBe(true);
			expect(await Promise.all(run.exports.map(exists))).toEqual([false]);
		});
	}

	for (const testCase of DEFAULT_OUTCOMES) {
		it(`default share cancelled while running: ${testCase.name}`, async () => {
			const run = await runShare({ kind: "default", outcome: testCase.outcome }, { cancel: true });
			expect(run.statuses).toEqual(["Share cancelled"]);
			expect(run.errors).toEqual([]);
			expect(run.opened).toEqual([]);
			expect(run.editorRestored).toBe(true);
		});
	}
});

describe("a share's failures before the backend runs", () => {
	it("a share script that fails to load shows its error and leaves the editor alone", async () => {
		vi.spyOn(customShareModule, "loadCustomShare").mockRejectedValue(
			new Error("Failed to load share script: share script must export a default function"),
		);
		const shareSession = vi.spyOn(shareModule, "shareSession");
		const errors: string[] = [];
		const editor = new Text("editor", 0, 0);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const ctx = {
			editor,
			editorContainer,
			showError: (message: string) => errors.push(message),
		} as unknown as CommandControllerContext;

		await new CommandController(ctx).handleShareCommand();

		expect(errors).toEqual(["Failed to load share script: share script must export a default function"]);
		expect(editorContainer.children).toEqual([editor]);
		expect(shareSession).not.toHaveBeenCalled();
	});

	it("a custom share whose export fails never runs the script", async () => {
		const fn = vi.fn(async () => URL_A);
		vi.spyOn(customShareModule, "loadCustomShare").mockResolvedValue({ path: "share.ts", fn });
		const errors: string[] = [];
		const editor = new Text("editor", 0, 0);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const ctx = {
			ui: { setFocus: () => {}, requestRender: () => {}, requestComponentRender: () => {} },
			editor,
			editorContainer,
			session: {
				exportToHtml: async () => {
					throw new Error("disk full");
				},
			},
			showStatus: () => {},
			showError: (message: string) => errors.push(message),
		} as unknown as CommandControllerContext;

		await new CommandController(ctx).handleShareCommand();

		expect(errors).toEqual(["Custom share failed: disk full"]);
		expect(fn).not.toHaveBeenCalled();
		expect(editorContainer.children).toEqual([editor]);
	});
});

describe("the default share redacts only while redaction is on", () => {
	for (const redactSecrets of [true, false]) {
		it(`share.redactSecrets ${redactSecrets ? "on passes" : "off withholds"} the session redactor`, async () => {
			const run = await runShare({ kind: "default", outcome: async () => DEFAULT_RESULT }, { redactSecrets });
			expect(run.shareOptions).toEqual({
				serverUrl: "https://share.example.test",
				store: "gist",
				state: {},
				obfuscator: redactSecrets ? REDACTOR : undefined,
			});
			if (redactSecrets) expect(run.obfuscator).toBe(REDACTOR);
		});
	}
});
