/**
 * WHY: choosing "OpenAI" in `/login` opened a browser on platform.openai.com and, under it, asked for
 * a pasted key. The dialog launched every `onAuth` URL, the wizard launched AND copied it, and the
 * picker listed "OpenAI" and "OpenAI Codex" with nothing to tell a key paste from a subscription
 * login. The class is a login surface that decides what to do with an `onAuth` URL without reading
 * what the provider's login asks for.
 *
 * What this file closes: every login surface in the TUI is driven for every registry provider with
 * a login, split by the row's declared credential. An `api-key` row's URL is shown as the place to
 * get a key and is never launched or copied; an `oauth` row's URL is launched (and, in the wizard,
 * copied). The picker prints the credential beside every row, and the two OpenAI rows are told
 * apart by name. Sweeping the registry means a provider added with either declaration is exercised
 * on every surface without a change here.
 *
 * What it does NOT catch: whether the declaration on a row is right (that is
 * `packages/ai/test/a-login-that-asks-for-a-key-is-not-launched.test.ts`), the RPC host's own
 * choice (the frame carries `credential`; the host is not a TUI), and the auth broker CLI's wording.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AuthStorage } from "@veyyon/ai";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import type { OAuthLoginCallbacks, OAuthProviderId, OAuthProviderInfo } from "@veyyon/ai/oauth/types";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/components/login-dialog";
import { OAuthSelectorComponent } from "@veyyon/coding-agent/modes/components/oauth-selector";
import { SignInTab } from "@veyyon/coding-agent/modes/setup-wizard/scenes/sign-in";
import type { SetupSceneHost } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import * as clipboard from "@veyyon/coding-agent/utils/clipboard";
import * as openModule from "@veyyon/coding-agent/utils/open";
import type { Component, TUI } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const AUTH_URL = "https://auth.example.test/where-the-flow-sent-us";

/** Built-in rows the picker offers, split by what choosing one asks for. */
const rows = getOAuthProviders().filter(provider => provider.available);
const keyRows = rows.filter(row => row.credential === "api-key");
const browserRows = rows.filter(row => row.credential === "oauth");

function plain(lines: readonly string[]): string {
	return lines.map(line => stripVTControlCharacters(line)).join("\n");
}

function makeDialog(providerId: string): { dialog: LoginDialogComponent; opened: string[]; frame: () => string } {
	const opened: string[] = [];
	vi.spyOn(openModule, "openPath").mockImplementation((target: string) => {
		opened.push(target);
	});
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const dialog = new LoginDialogComponent(tui, providerId, () => {});
	return { dialog, opened, frame: () => plain(dialog.render(100)) };
}

type WizardDrive = {
	tab: SignInTab;
	opened: string[];
	copied: string[];
	/** The row the flow was started for; the picker is fuzzy, so the drive proves which one it chose. */
	chosen: string[];
	/** Resolves once the flow has reported its URL and is waiting on the operator. */
	reported: Promise<void>;
	release: () => void;
};

function driveWizard(row: OAuthProviderInfo): WizardDrive {
	const opened: string[] = [];
	const copied: string[] = [];
	const chosen: string[] = [];
	vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async (text: string) => {
		copied.push(text);
	});
	const reported = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const authStorage = {
		has: () => false,
		hasAuth: () => false,
		getCredentialOrigin: () => undefined,
		async login(provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
			chosen.push(provider);
			ctrl.onAuth({ url: AUTH_URL });
			reported.resolve();
			await gate.promise;
		},
	} as unknown as AuthStorage;
	const host = {
		ctx: {
			openInBrowser(url: string): void {
				opened.push(url);
			},
			session: { modelRegistry: { authStorage, async refresh(): Promise<void> {} } },
		},
		requestRender(): void {},
		finish(): void {},
		setFocus(_component: Component | null): void {},
		restoreFocus(): void {},
	} as unknown as SetupSceneHost;
	const tab = new SignInTab(host);
	// The id is a prefix of sibling ids ("google" lists "google-antigravity" first) and a name is a
	// prefix of sibling names ("xAI" lists "xAI Grok OAuth" first), so after typing the id the
	// cursor is walked to the row whose name ends where the credential label begins.
	for (const char of row.id) tab.handleInput(char);
	const cursorRow = (): string | undefined =>
		plain(tab.render(200))
			.split("\n")
			.find(line => line.trimStart().startsWith(`${theme.nav.cursor} `));
	const marker = `${theme.nav.cursor} ${row.name} · `;
	for (let step = 0; step < rows.length && !cursorRow()?.includes(marker); step++) tab.handleInput("\x1b[B");
	if (!cursorRow()?.includes(marker)) throw new Error(`${row.id} is not reachable in the picker`);
	tab.handleInput("\n");
	return { tab, opened, copied, chosen, reported: reported.promise, release: () => gate.resolve() };
}

describe("a login dialog launches only a browser login", () => {
	it("the registry offers both kinds, so neither sweep below is vacuous", () => {
		expect(keyRows.length).toBeGreaterThan(0);
		expect(browserRows.length).toBeGreaterThan(0);
	});

	it.each(keyRows.map(row => [row.id] as const))("%s: the dialog shows the key page and does not open it", id => {
		const { dialog, opened, frame } = makeDialog(id);
		dialog.showAuth(AUTH_URL, "Copy a key from the dashboard");
		expect(opened).toEqual([]);
		const drawn = frame();
		expect(drawn).toContain("Get an API key at");
		expect(drawn).toContain(AUTH_URL);
	});

	it.each(browserRows.map(row => [row.id] as const))("%s: the dialog opens the URL the flow waits on", id => {
		const { dialog, opened, frame } = makeDialog(id);
		dialog.showAuth(AUTH_URL, "Approve the request");
		expect(opened).toEqual([AUTH_URL]);
		expect(frame()).not.toContain("Get an API key at");
	});

	it.each(keyRows.map(row => [row.id, row] as const))(
		"%s: the wizard shows the key page and neither opens nor copies it",
		async (id, row) => {
			const drive = driveWizard(row);
			await drive.reported;
			try {
				expect(drive.chosen).toEqual([id]);
				expect(drive.opened).toEqual([]);
				expect(drive.copied).toEqual([]);
				const drawn = plain(drive.tab.render(120));
				expect(drawn).toContain("Get an API key at");
				expect(drawn).toContain(AUTH_URL);
				expect(drawn).not.toContain("Browser login");
			} finally {
				drive.release();
			}
		},
	);

	it.each(browserRows.map(row => [row.id, row] as const))(
		"%s: the wizard opens and copies the URL it waits on",
		async (id, row) => {
			const drive = driveWizard(row);
			await drive.reported;
			try {
				expect(drive.chosen).toEqual([id]);
				expect(drive.opened).toEqual([AUTH_URL]);
				expect(drive.copied).toEqual([AUTH_URL]);
				expect(plain(drive.tab.render(120))).toContain("Browser login");
			} finally {
				drive.release();
			}
		},
	);

	it("the picker prints what every row asks for beside its name", () => {
		const authStorage = {
			has: () => false,
			hasAuth: () => false,
			getCredentialOrigin: () => undefined,
		} as unknown as AuthStorage;
		const label: Record<OAuthProviderInfo["credential"], string> = { "api-key": "api key", oauth: "browser login" };
		for (const row of rows) {
			const picker = new OAuthSelectorComponent(
				authStorage,
				() => {},
				() => {},
			);
			for (const char of row.id) picker.handleInput(char);
			const rendered = plain(picker.render(120));
			const line = rendered.split("\n").find(candidate => candidate.includes(row.name));
			expect(line, `${row.id} is not listed`).toBeDefined();
			expect(line).toContain(`· ${label[row.credential]}`);
		}
	});

	it("the two OpenAI rows are told apart by name before either is chosen", () => {
		const names = new Map(rows.map(row => [row.id, row.name]));
		expect(names.get("openai")).toBe("OpenAI Platform");
		expect(names.get("openai-codex")).toBe("ChatGPT (Codex subscription)");
	});
});
