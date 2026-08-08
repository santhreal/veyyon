/**
 * WHY: the login screen was an append-only log of everything the flow had ever said.
 *
 * Every `show*` pushed rows onto one container, so an API-key login that failed validation and asked
 * again rendered two prompt messages, two footers, one "Validating..." line per attempt, and its
 * second question BELOW the input that question belonged to (the input only moved if it had never
 * been mounted). The frame also printed the raw provider slug in its title, and echoed a pasted API
 * key in clear text.
 *
 * THE CLASS THIS CLOSES: there are four things this frame can show - where to authorize, what is
 * happening now, what is being asked, and which keys work - and setting one REPLACES it. Every case
 * below re-drives the same surface twice (two progress messages, two prompts, two auth calls) and
 * asserts the second did not accumulate on the first, which is the mistake in every one of the
 * symptoms above. The footer is asserted by count as well as by text, because "which keys work" is
 * the row that was duplicated most visibly.
 *
 * WHAT IT DOES NOT CATCH: how the frame looks at a narrow width (no wrapping assertions here; the
 * rows are single `Text` children and wrapping is the TUI's), whether the browser actually opens,
 * whether a login stores anything (`AuthStorage` owns that), and the onboarding wizard's own
 * hand-built prompt, which is a separate surface that shares only the `secret` flag.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/components/login-dialog";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { formatProviderName } from "@veyyon/coding-agent/slash-commands/helpers/format";
import * as openModule from "@veyyon/coding-agent/utils/open";
import type { TUI } from "@veyyon/tui";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeDialog(providerId = "groq"): {
	dialog: LoginDialogComponent;
	frame: () => string;
	rows: () => string[];
	completed: ReturnType<typeof vi.fn>;
	opened: string[];
} {
	// The dialog opens the authorize URL best-effort. A test must not spawn the operator's browser.
	const opened: string[] = [];
	vi.spyOn(openModule, "openPath").mockImplementation((target: string) => {
		opened.push(target);
	});
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const completed = vi.fn();
	const dialog = new LoginDialogComponent(tui, providerId, completed);
	const rows = () => dialog.render(100).map(line => stripVTControlCharacters(line).trimEnd());
	return { dialog, rows, frame: () => rows().join("\n"), completed, opened };
}

/** How many rows carry `needle`, which is the question every append bug answers wrongly. */
function rowsWith(rows: string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

describe("the login screen is one frame", () => {
	it("names the provider through the one label owner", () => {
		expect(makeDialog("groq").frame()).toContain(`Login to ${formatProviderName("groq")}`);
		// The slug-printing case: no browser-login table has a row for a key-paste provider.
		expect(makeDialog("openai").frame()).toContain("Login to OpenAI");
	});

	it("shows one footer, naming the keys that actually work right now", () => {
		const { dialog, rows } = makeDialog();
		expect(rowsWith(rows(), "Esc  cancel")).toBe(1);
		expect(rowsWith(rows(), "Enter")).toBe(0);

		void dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		expect(rowsWith(rows(), "Enter  submit    Esc  cancel")).toBe(1);
		expect(rows().filter(row => row.includes("Esc")).length).toBe(1);
	});

	it("replaces the status line instead of stacking one line per attempt", () => {
		const { dialog, rows } = makeDialog();
		dialog.showProgress("Validating API key...");
		dialog.showProgress("Validating API key...");
		dialog.showProgress("Saving credentials...");

		expect(rowsWith(rows(), "Validating API key...")).toBe(0);
		expect(rowsWith(rows(), "Saving credentials...")).toBe(1);
	});

	it("replaces a re-asked question, and keeps the input under it", async () => {
		const { dialog, rows } = makeDialog();
		const first = dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		dialog.pasteText("gsk_first");
		dialog.handleInput("\r");
		dialog.showProgress("That key was rejected.");
		void dialog.showPrompt({ message: "Paste your Groq API key", secret: true, placeholder: "gsk_..." });
		dialog.pasteText("gsk_second");

		const drawn = rows();
		expect(rowsWith(drawn, "Paste your Groq API key")).toBe(1);
		expect(rowsWith(drawn, "looks like gsk_...")).toBe(1);
		// Ordering: the question, then the field it is asking about, then the format hint.
		const question = drawn.findIndex(row => row.includes("Paste your Groq API key"));
		const field = drawn.findIndex(row => row.includes("•"));
		const hint = drawn.findIndex(row => row.includes("looks like"));
		expect(question).toBeLessThan(field);
		expect(field).toBeLessThan(hint);
		// The first answer was delivered, and the re-ask started from an empty field rather than
		// re-offering the key that had just been refused.
		await expect(first).resolves.toBe("gsk_first");
		expect(rowsWith(drawn, "gsk_second")).toBe(0);
	});

	it("masks a credential and still returns the bytes that were pasted", async () => {
		const { dialog, rows } = makeDialog();
		const answer = dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		dialog.pasteText("gsk_LIVE_secret_0123456789");

		expect(rowsWith(rows(), "gsk_LIVE_secret_0123456789")).toBe(0);
		expect(rowsWith(rows(), "•")).toBe(1);

		dialog.handleInput("\r");
		await expect(answer).resolves.toBe("gsk_LIVE_secret_0123456789");
	});

	it("leaves a non-credential answer readable", () => {
		const { dialog, rows } = makeDialog();
		void dialog.showPrompt({ message: "Enter the code shown in your browser" });
		dialog.pasteText("WDJB-MJHT");

		expect(rowsWith(rows(), "WDJB-MJHT")).toBe(1);
	});

	it("draws one authorization block however many times the flow reports it", () => {
		const { dialog, rows, opened } = makeDialog();
		dialog.showAuth("https://auth.example.test/authorize?code_challenge_method=S256", "Approve the request");
		dialog.showAuth("https://auth.example.test/authorize?code_challenge_method=S256", "Approve the request");

		const drawn = rows();
		expect(rowsWith(drawn, "code_challenge_method=S256")).toBe(1);
		expect(rowsWith(drawn, "Approve the request")).toBe(1);
		expect(rowsWith(drawn, "click to open")).toBe(1);
		// Each report opens the browser once; a relayout must not.
		expect(opened.length).toBe(2);
		dialog.showProgress("Waiting for the browser...");
		expect(opened.length).toBe(2);
	});

	it("offers the local shortcut only when it differs from the URL being copied", () => {
		const { dialog, rows } = makeDialog();
		dialog.showAuth("https://auth.example.test/authorize", undefined, "http://127.0.0.1:8976/start");
		expect(rowsWith(rows(), "Local shortcut (this machine only): http://127.0.0.1:8976/start")).toBe(1);

		const same = makeDialog();
		same.dialog.showAuth("https://auth.example.test/authorize", undefined, "https://auth.example.test/authorize");
		expect(rowsWith(same.rows(), "Local shortcut")).toBe(0);
	});

	it("cancels the login when Esc answers a credential question", async () => {
		const { dialog, completed } = makeDialog();
		const answer = dialog.showPrompt({ message: "Paste your Groq API key", secret: true });

		dialog.handleInput("\x1b");

		expect(dialog.signal.aborted).toBe(true);
		expect(completed).toHaveBeenCalledWith(false, "Login cancelled");
		await expect(answer).rejects.toThrow("Login cancelled");
	});

	it("skips the optional name when Esc answers it, without undoing the login", async () => {
		const { dialog, completed, rows } = makeDialog();
		const named = dialog.askOptionalName("Name this account (optional)", "work");

		expect(rowsWith(rows(), "Enter  save    Esc  skip")).toBe(1);
		dialog.handleInput("\x1b");

		// The credential is already stored: Esc here means "leave it unnamed", not "cancel".
		await expect(named).resolves.toBeUndefined();
		expect(dialog.signal.aborted).toBe(false);
		expect(completed).not.toHaveBeenCalled();
		expect(rowsWith(rows(), "Name this account")).toBe(0);
	});

	it("returns a trimmed name and treats a blank one as unnamed", async () => {
		const typed = makeDialog();
		const named = typed.dialog.askOptionalName("Name this account (optional)");
		typed.dialog.pasteText("  work laptop  ");
		typed.dialog.handleInput("\r");
		await expect(named).resolves.toBe("work laptop");

		const blank = makeDialog();
		const nothing = blank.dialog.askOptionalName("Name this account (optional)");
		blank.dialog.pasteText("   ");
		blank.dialog.handleInput("\r");
		await expect(nothing).resolves.toBeUndefined();
	});
});
