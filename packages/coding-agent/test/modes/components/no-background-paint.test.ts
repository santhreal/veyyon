/**
 * The inline TUI paints NO backgrounds. Ever.
 *
 * Why this suite exists: every painted surface (the user-message bubble,
 * custom/skill/hook message cards, tool-state tints, the composer band, the
 * status bar) rendered as a colored SLAB on any terminal whose ground differed
 * from the theme's — black slabs on grey terminals, grey slabs on white ones
 * (operator screenshots 2026-07-22..24). The 2026-07-23 stopgap that hid every
 * theme but alabaster and force-painted its ground made a white terminal
 * strictly worse and is reverted; the root fix is that transcript components
 * simply never emit a background SGR, so the terminal's own background is the
 * ground everywhere and a mismatch is impossible by construction.
 *
 * The theme under test is alabaster ON PURPOSE: it declares loud, non-empty
 * bg roles (userMsgBg #f5f4f5, customMsgBg #f6f4f7, statusLineBg #ececf0), so
 * if any component starts consuming a bg role again, these assertions go red.
 * A theme with empty bg roles would make every check vacuous.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CustomMessageComponent } from "@veyyon/coding-agent/modes/components/custom-message";
import { HookMessageComponent } from "@veyyon/coding-agent/modes/components/hook-message";
import { UserMessageComponent } from "@veyyon/coding-agent/modes/components/user-message";
import { initTheme, setTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { CustomMessage, HookMessage } from "@veyyon/coding-agent/session/messages";

/** Any ANSI background attribute: truecolor (48;2), 256 (48;5), or the classic
 * 40-47/100-107 range. The terminal-default reset `\x1b[49m` is allowed — it
 * paints nothing. */
const BG_SGR = /\x1b\[(?:[0-9;]*;)?(?:48;[25];|4[0-7]m|10[0-7]m)/;

function expectNoBgPaint(lines: readonly string[], label: string): void {
	for (const [i, line] of lines.entries()) {
		expect(line, `${label}: line ${i} emits a background SGR: ${JSON.stringify(line)}`).not.toMatch(BG_SGR);
	}
}

describe("inline transcript components emit no background SGR", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
		// Loud-bg theme (see the suite doc): failures here mean a component
		// started painting again, not that the theme changed.
		await setTheme("alabaster");
		expect(theme.getBgAnsi("userMessageBg")).toMatch(/\x1b\[48;/);
	});

	/** The user bubble was the loudest slab (userMessageBg painted full-width
	 * padding rows). It must render fg-only. */
	it("UserMessageComponent renders without painting userMessageBg", () => {
		const lines = new UserMessageComponent("profile the render loop **now**\nsecond line").render(60);
		expect(lines.length).toBeGreaterThan(0);
		expectNoBgPaint(lines, "user-message");
	});

	/** Extension-injected custom messages boxed the text in customMessageBg. */
	it("CustomMessageComponent renders without painting customMessageBg", () => {
		const message: CustomMessage = {
			role: "custom",
			customType: "note",
			content: "an extension note with `code`",
			display: true,
			timestamp: 0,
		};
		const lines = new CustomMessageComponent(message).render(60);
		expect(lines.length).toBeGreaterThan(0);
		expectNoBgPaint(lines, "custom-message");
	});

	/** Legacy hook messages used the same painted card. */
	it("HookMessageComponent renders without painting customMessageBg", () => {
		const message: HookMessage = {
			role: "hookMessage",
			customType: "hook",
			content: "hook output line",
			display: true,
			timestamp: 0,
		};
		const lines = new HookMessageComponent(message).render(60);
		expect(lines.length).toBeGreaterThan(0);
		expectNoBgPaint(lines, "hook-message");
	});

	/** The composer quiet card resolves to the unpainted sentinel under a theme
	 * that declares no composerBg — alabaster relies on the old statusLineBg
	 * inheritance, which is exactly the fallback that painted the grey band. */
	it("composerBg resolves to the terminal-default sentinel, not statusLineBg", () => {
		expect(theme.getBgAnsi("composerBg")).toBe("\x1b[49m");
		expect(theme.getBgAnsi("statusLineBg")).toMatch(/\x1b\[48;/);
	});
});
