import { beforeAll, describe, expect, it, vi } from "bun:test";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/components/login-dialog";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { formatProviderName } from "@veyyon/coding-agent/slash-commands/helpers/format";
import type { TUI } from "@veyyon/tui";

interface RenderableBlock {
	render(width: number): string[];
}

function renderPresented(blocks: unknown[]): string {
	return blocks
		.flatMap(block => {
			const maybeRenderable = block as Partial<RenderableBlock>;
			return maybeRenderable.render ? maybeRenderable.render(120) : [String(block)];
		})
		.join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("SelectorController login", () => {
	it("presents OAuth success as soon as credentials are saved", async () => {
		const loginSaved = Promise.withResolvers<void>();
		const presentedBlocks: unknown[] = [];
		const authStorage = {
			login: vi.fn(async () => {
				loginSaved.resolve();
			}),
			// A finished login now opens the account manager, which reloads storage and reads the rows
			// back. The stub answers that with an empty account list: this case is about the success
			// block, and an incomplete stub turned a passing assertion into an unhandled rejection.
			reload: vi.fn(async () => {}),
			listStoredCredentials: vi.fn(() => []),
			listProvidersWithFailedRefresh: vi.fn(() => []),
			getAccountName: vi.fn(() => undefined),
			getCredentialOrigin: vi.fn(() => undefined),
			sessionCredentialRouting: vi.fn(() => undefined),
			credentialBlockedUntil: vi.fn(() => undefined),
			disabledCredentialCause: vi.fn(() => undefined),
			checkCredentials: vi.fn(async () => []),
			listUsageWindows: vi.fn(() => []),
		} as unknown as AuthStorage;
		const refresh = vi.fn(() => new Promise<void>(() => {}));
		const refreshInBackground = vi.fn();
		const ctx = {
			oauthManualInput: {
				waitForInput: vi.fn(),
				clear: vi.fn(),
			},
			session: {
				modelRegistry: {
					authStorage,
					refresh,
					refreshInBackground,
				},
				// The account manager the finished login opens reads the balancing setting.
				settings: { get: () => undefined },
				fetchUsageReports: async () => [],
			},
			// The login flow swaps the editor slot for the cancellable dialog
			// and restores it when the flow settles.
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				// The login dialog and the account card the finished login opens are
				// both fullscreen overlays; this case is about the success block.
				showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		void controller.showLogin("xai-oauth");
		await loginSaved.promise;
		await Promise.resolve();

		// Through the label owner, not the slug: pinning `xai-oauth` here made a correct label change
		// (the whole product now says "xAI OAuth") look like a routing regression.
		expect(renderPresented(presentedBlocks)).toContain(
			`Successfully logged in to ${formatProviderName("xai-oauth")}`,
		);
		expect(refreshInBackground).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("Esc during a pending login aborts the flow and takes the overlay down", async () => {
		const login = vi.fn(
			(_provider: string, ctrl: { signal?: AbortSignal }) =>
				new Promise<void>((_resolve, reject) => {
					ctrl.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const authStorage = { login } as unknown as AuthStorage;
		const overlays: unknown[] = [];
		const hide = vi.fn();
		const editor = {};
		const presentedBlocks: unknown[] = [];
		const ctx = {
			oauthManualInput: { waitForInput: vi.fn(), clear: vi.fn() },
			session: { modelRegistry: { authStorage, refreshInBackground: vi.fn() } },
			// The dialog is a fullscreen overlay now, so the editor never leaves
			// its own container; the slot stays empty and focus returns to it.
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor,
			ui: {
				setFocus: vi.fn(),
				requestRender: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					overlays.push(component);
					return { hide, setHidden: vi.fn(), isHidden: () => false };
				}),
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
			present: vi.fn((block: unknown) => {
				presentedBlocks.push(block);
			}),
			openInBrowser: vi.fn(),
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const loginDone = controller.showLogin("xai-oauth");
		const dialog = overlays[0] as { handleInput(data: string): void };
		expect(dialog).toBeDefined();
		expect(dialog).not.toBe(editor);

		dialog.handleInput("\x1b"); // Esc cancels the pairing wait
		await loginDone;

		// The abort is user-driven: no error surfaced, the cancellation is
		// announced, the overlay comes down, and focus goes back to the editor.
		expect(ctx.showError).not.toHaveBeenCalled();
		expect(ctx.showStatus).toHaveBeenCalledWith("Login cancelled");
		expect(hide).toHaveBeenCalled();
		expect(ctx.ui.setFocus).toHaveBeenLastCalledWith(editor);
		expect(renderPresented(presentedBlocks)).not.toContain("Successfully logged in");
	});
	it("routes enhanced paste into a direct API-key prompt", async () => {
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "openrouter", vi.fn());
		const prompt = dialog.showPrompt({ message: "Paste your OpenRouter API key", secret: true });

		dialog.pasteText("VEYYON_PASTE_TEST_123");
		dialog.handleInput("\n");

		await expect(prompt).resolves.toBe("VEYYON_PASTE_TEST_123");
	});
});
