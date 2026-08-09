import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@veyyon/ai/oauth/types";
import { SignInTab } from "@veyyon/coding-agent/modes/setup-wizard/scenes/sign-in";
import type { SetupSceneHost } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import * as clipboard from "@veyyon/coding-agent/utils/clipboard";
import type { Component } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SignInTab", () => {
	it("keeps the OSC8 login link and manual-code prompt above clipped wizard rows", async () => {
		const url = `https://example.com/oauth/authorize?client_id=veyyon&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		let focusTarget: Component | undefined;
		const openedUrls: string[] = [];

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				const prompt = ctrl.onManualCodeInput?.();
				await loginGate.promise;
				await prompt;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(openedUrl: string): void {
					openedUrls.push(openedUrl);
				},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(component: Component | null): void {
				focusTarget = component ?? undefined;
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");

			const rendered = tab.render(36);
			const compact = rendered.map(line => Bun.stripANSI(line).trim()).join("");
			expect(compact).toContain(url);
			expect(compact).not.toContain("…");
			expect(rendered.join("\n")).toContain(`\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`);
			expect(openedUrls).toEqual([url]);
			expect(focusTarget).toBeDefined();
			focusTarget?.handleInput?.("\x1bc");
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);

			// On a ~24-row terminal the wizard body ends up ~8 rows; the OSC8
			// link, the code prompt, and the focused input must survive that
			// clip. The full plain URL renders exactly once, directly below the
			// input (a 2-line teaser above it used to print the URL head twice).
			const clippedBody = rendered.slice(0, 8).map(line => Bun.stripANSI(line).trim());
			const plainBody = rendered.map(line => Bun.stripANSI(line).trim());
			const inputIndex = clippedBody.findIndex(line => line.startsWith(">"));
			expect(clippedBody.some(line => line.startsWith("Browser login: Open login URL"))).toBe(true);
			expect(clippedBody).toContain("Paste the authorization code (or full redirect URL):");
			expect(inputIndex).toBeGreaterThanOrEqual(0);
			const urlStartRows = plainBody.filter(line => line.startsWith("https://example.com/oauth/authorize?"));
			expect(urlStartRows).toHaveLength(1);
			expect(plainBody.indexOf(urlStartRows[0])).toBeGreaterThan(inputIndex);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});

	it("routes multi-character terminal paste to the prompt and skips without submitting partial input", async () => {
		const promptShown = Promise.withResolvers<void>();
		const submittedCodes: string[] = [];
		let focusTarget: (Component & { pasteText(text: string): void }) | undefined;
		const skipSetup = vi.fn();
		const finish = vi.fn();

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				const prompt = ctrl.onManualCodeInput?.();
				promptShown.resolve();
				submittedCodes.push((await prompt) ?? "");
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(): void {},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish,
			skipSetup,
			setFocus(component: Component | null): void {
				focusTarget = (component as (Component & { pasteText(text: string): void }) | null) ?? undefined;
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") tab.handleInput(char);
			tab.handleInput("\n");
			await promptShown.promise;

			expect(focusTarget).toBeDefined();
			focusTarget?.pasteText("code-from-terminal-paste");
			// The field takes the paste and masks it: an authorization code is exchangeable for tokens,
			// and onboarding is exactly where someone is watching the screen.
			const drawn = Bun.stripANSI(tab.render(80).join("\n"));
			expect(drawn).not.toContain("code-from-terminal-paste");
			expect(drawn).toContain(`> ${"•".repeat("code-from-terminal-paste".length)}`);

			focusTarget?.handleInput?.("\x03");
			expect(skipSetup).toHaveBeenCalledTimes(1);
			expect(finish).not.toHaveBeenCalled();
			expect(submittedCodes).toEqual([]);
		} finally {
			tab.dispose();
			await Promise.resolve();
		}
	});

	/**
	 * ABSENT MEANS MASKED, on the onboarding surface too.
	 *
	 * WHY BOTH SURFACES. The wizard builds its own prompt field rather than reusing the login dialog,
	 * so it reads the same flag through different code, and it was the surface where a pasted key was
	 * drawn in clear text with a stranger's onboarding recording running. A flow that says nothing is
	 * asking for a credential far more often than not, so silence masks here as well, and only a flow
	 * that declares `secret: false` gets a readable field.
	 */
	it.each([
		["says nothing about the answer", undefined, false],
		["declares a credential", true, false],
		["declares a readable field", false, true],
	])("masks the onboarding field when the flow %s", async (_label, secret, expectReadable) => {
		const promptShown = Promise.withResolvers<void>();
		let focusTarget: (Component & { pasteText(text: string): void }) | undefined;
		const typed = "sk-live-onboarding-0123456789";

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				const answered = ctrl.onPrompt({
					message: "Paste your Anthropic API key",
					...(secret === undefined ? {} : { secret }),
				});
				promptShown.resolve();
				await answered;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(): void {},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			skipSetup(): void {},
			setFocus(component: Component | null): void {
				focusTarget = (component as (Component & { pasteText(text: string): void }) | null) ?? undefined;
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") tab.handleInput(char);
			tab.handleInput("\n");
			await promptShown.promise;

			focusTarget?.pasteText(typed);
			const drawn = Bun.stripANSI(tab.render(80).join("\n"));
			expect(drawn.includes(typed)).toBe(expectReadable);
			expect(drawn.includes("•".repeat(typed.length))).toBe(!expectReadable);
		} finally {
			tab.dispose();
			await Promise.resolve();
		}
	});

	it("copies the active login URL from the keyboard while the setup TUI owns selection", async () => {
		const url = "https://example.com/oauth/authorize?client_id=veyyon&state=copy";
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				await loginGate.promise;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(): void {},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(1);

			tab.handleInput("\x1bc");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});
});
