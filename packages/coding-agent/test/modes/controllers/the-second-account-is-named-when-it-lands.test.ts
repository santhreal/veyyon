/**
 * WHY: naming an account belonged at the moment the account was created, and lived only on the
 * account card.
 *
 * An operator who logged in twice to the same provider got two rows that look alike everywhere they
 * appear, and the only way to tell them apart was to open `/account`, find the right row among the
 * others, and press `n` - recognizing later exactly what a name would have told them. The login flow
 * now offers the name while they still know which account it was.
 *
 * THE CLASS THIS CLOSES: the offer is made on the second account and never on the first, is written
 * to the row the login actually created, and cannot cost the operator the login. Every case drives
 * the real `SelectorController` login path; the outcomes are the four ways this can go wrong - asked
 * when it should not be, not asked when it should be, written to nothing, and a refused write
 * reported as success.
 *
 * WHAT IT DOES NOT CATCH: how the prompt looks (the dialog's own suite owns the frame), whether
 * `setAccountName` persists (`packages/ai` owns that), and the account-card `n` path, which is
 * unchanged and separately covered.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";

interface Renderable {
	render(width: number): string[];
	handleInput?(data: string): void;
	pasteText?(text: string): void;
}

beforeAll(async () => {
	await initTheme();
});

/**
 * One stored row per entry. The rows carry their provider because the same call answers two readers:
 * the naming offer asks for one provider's rows, and the account manager the login opens afterwards
 * asks for all of them and groups by that field.
 */
function storedRows(count: number): { provider: string; id: number; credential: { type: "api_key"; key: string } }[] {
	return Array.from({ length: count }, (_, index) => ({
		provider: "groq",
		id: index + 1,
		credential: { type: "api_key" as const, key: `key-${index + 1}` },
	}));
}

function harness(options: { rows: number; credentialId?: number; nameAccepted?: boolean }) {
	const setAccountName = vi.fn(() => options.nameAccepted !== false);
	const authStorage = {
		login: vi.fn(async () => ({
			type: "api_key" as const,
			...(options.credentialId !== undefined ? { credentialId: options.credentialId } : {}),
		})),
		listStoredCredentials: vi.fn((provider?: string) =>
			provider === undefined || provider === "groq" ? storedRows(options.rows) : [],
		),
		setAccountName,
		// The account manager opens once the login settles; it reloads and reads the rows back.
		reload: vi.fn(async () => {}),
		listProvidersWithFailedRefresh: vi.fn(() => []),
		getAccountName: vi.fn(() => undefined),
		getCredentialOrigin: vi.fn(() => undefined),
		sessionCredentialRouting: vi.fn(() => undefined),
		credentialBlockedUntil: vi.fn(() => undefined),
		disabledCredentialCause: vi.fn(() => undefined),
		checkCredentials: vi.fn(async () => []),
		listUsageWindows: vi.fn(() => []),
	} as unknown as AuthStorage;
	const editorSlot: unknown[] = [];
	const presented: unknown[] = [];
	const editor = {};
	const ctx = {
		oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
		session: {
			modelRegistry: { authStorage, refresh: vi.fn(), refreshInBackground: vi.fn() },
			// The account card the login opens reads the balancing setting and probes usage.
			settings: { get: () => undefined },
			fetchUsageReports: async () => [],
		},
		editorContainer: {
			clear: () => {
				editorSlot.length = 0;
			},
			addChild: (child: unknown) => {
				editorSlot.push(child);
			},
			children: editorSlot,
		},
		editor,
		ui: {
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			// The finished login opens the account card in an overlay; this case is about the login.
			showOverlay: vi.fn(() => ({ close: vi.fn(), update: vi.fn() })),
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		present: (block: unknown) => {
			presented.push(block);
		},
		openInBrowser: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new SelectorController(ctx);
	const dialog = (): Renderable | undefined => editorSlot.find(child => child !== editor) as Renderable | undefined;
	const transcript = () =>
		presented
			.flatMap(block => (block as Renderable).render(120))
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	return { controller, ctx, setAccountName, dialog, transcript, editorSlot, editor };
}

/** The login promise resolves through several awaits before the offer is on screen. */
async function settle(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("the second account is named when it lands", () => {
	it("does not ask about the first account for a provider", async () => {
		const h = harness({ rows: 1, credentialId: 1 });

		await h.controller.showOAuthSelector("login", "groq");

		expect(h.setAccountName).not.toHaveBeenCalled();
		expect(h.transcript()).toContain("Successfully logged in to Groq");
		expect(h.transcript()).not.toContain("Named");
	});

	it("asks once a provider holds two accounts, and names the row the login created", async () => {
		const h = harness({ rows: 2, credentialId: 7 });
		const done = h.controller.showOAuthSelector("login", "groq");
		await settle();

		const frame = h
			.dialog()
			?.render(100)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
		expect(frame).toContain("Name this Groq account (optional)");
		expect(frame).toContain("Enter  save    Esc  skip");

		h.dialog()?.pasteText?.("work laptop");
		h.dialog()?.handleInput?.("\r");
		await done;

		expect(h.setAccountName).toHaveBeenCalledWith("groq", 7, "work laptop");
		expect(h.transcript()).toContain('Named "work laptop"');
	});

	it("keeps the login when the name is skipped", async () => {
		const h = harness({ rows: 2, credentialId: 7 });
		const done = h.controller.showOAuthSelector("login", "groq");
		await settle();

		h.dialog()?.handleInput?.("\x1b");
		await done;

		expect(h.setAccountName).not.toHaveBeenCalled();
		expect(h.ctx.showError).not.toHaveBeenCalled();
		expect(h.transcript()).toContain("Successfully logged in to Groq");
		expect(h.transcript()).not.toContain("Named");
	});

	it("does not ask when the store could not say which row it wrote", async () => {
		const h = harness({ rows: 2 });

		await h.controller.showOAuthSelector("login", "groq");

		// Naming a sibling is worse than not asking.
		expect(h.setAccountName).not.toHaveBeenCalled();
		expect(h.transcript()).toContain("Successfully logged in to Groq");
	});

	it("says so when the name could not be kept, instead of reporting one", async () => {
		const h = harness({ rows: 2, credentialId: 7, nameAccepted: false });
		const done = h.controller.showOAuthSelector("login", "groq");
		await settle();

		h.dialog()?.pasteText?.("work laptop");
		h.dialog()?.handleInput?.("\r");
		await done;

		expect(h.ctx.showWarning).toHaveBeenCalledWith(
			"Could not name that account: Groq credentials are stored where names cannot be kept",
		);
		expect(h.transcript()).not.toContain("Named");
	});
});
