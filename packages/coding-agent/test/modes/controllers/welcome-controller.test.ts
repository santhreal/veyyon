/**
 * WelcomeController — the ARCH-2 extraction of the welcome lane from
 * interactive-mode. The controller owns the hero card and its spacers; the
 * host keeps the fill/anchor math behind the layout port. These tests lock
 * the contract at that seam, because the original inline code had exactly
 * one subtle bug class: dismissal must report the right removed-row count
 * (card + spacers + top margin) or the composer jumps off the viewport
 * bottom for one frame, and `/welcome` must dismiss the home hero before
 * mounting the full card or two suns render and the anchor slack pushes the
 * card off-screen (live capture 2026-07-22).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { WelcomeController, type WelcomeLayoutPort } from "@veyyon/coding-agent/modes/controllers/welcome-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { Component } from "@veyyon/tui";

interface FakePort extends WelcomeLayoutPort {
	uiChildren: Component[];
	chatChildren: Component[];
	dismissed: number[];
	remeasures: number;
}

function makePort(topRows = 4): FakePort {
	const uiChildren: Component[] = [];
	const chatChildren: Component[] = [];
	const dismissed: number[] = [];
	const port: FakePort = {
		uiChildren,
		chatChildren,
		dismissed,
		remeasures: 0,
		ui: {
			terminal: { columns: 80, rows: 24 },
			addChild: (c: Component) => uiChildren.push(c),
			removeChild: (c: Component) => {
				const i = uiChildren.indexOf(c);
				if (i >= 0) uiChildren.splice(i, 1);
			},
			requestComponentRender: () => {},
			requestRender: () => {},
			// biome-ignore lint/suspicious/noExplicitAny: minimal TUI stand-in
		} as any,
		chatContainer: {
			addChild: (c: Component) => chatChildren.push(c),
			// biome-ignore lint/suspicious/noExplicitAny: minimal container stand-in
		} as any,
		topFillRows: () => topRows,
		onHeroDismissed: rows => dismissed.push(rows),
		remeasureAnchor: () => port.remeasures++,
	};
	return port;
}

const INPUTS = { version: "1.2.3", modelName: "m", providerName: "p", recentSessions: [] };

describe("WelcomeController", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	/** The hero block is spacer · card · spacer, in that order, and hasHero
	 * gates the layout's centring margin — both must flip on mount. */
	it("mounts the hero as spacer-card-spacer and reports hasHero", () => {
		const port = makePort();
		const controller = new WelcomeController(port);
		expect(controller.hasHero).toBe(false);
		controller.mountHero(INPUTS, { playIntro: false });
		expect(controller.hasHero).toBe(true);
		expect(port.uiChildren.length).toBe(3);
		const cardRows = port.uiChildren[1]!.render(80).length;
		expect(cardRows).toBeGreaterThan(3);
		expect(port.uiChildren[0]!.render(80)).toEqual([""]);
		expect(port.uiChildren[2]!.render(80)).toEqual([""]);
	});

	/** Dismissal must remove every mounted child AND report card + spacers +
	 * top-margin rows, or the host's same-frame anchor correction is off by
	 * the difference and the composer visibly jumps. */
	it("dismisses the hero, removing all children and reporting exact removed rows", () => {
		const port = makePort(4);
		const controller = new WelcomeController(port);
		controller.mountHero(INPUTS, { playIntro: false });
		const cardRows = port.uiChildren[1]!.render(80).length;
		controller.dismiss();
		expect(controller.hasHero).toBe(false);
		expect(port.uiChildren).toEqual([]);
		expect(port.dismissed).toEqual([cardRows + 2 + 4]);
	});

	/** Idempotence: the first keystroke and a later explicit dismiss can both
	 * fire; the second call must not re-run the host's fill math. */
	it("is idempotent — a second dismiss never re-notifies the layout", () => {
		const port = makePort();
		const controller = new WelcomeController(port);
		controller.mountHero(INPUTS, { playIntro: false });
		controller.dismiss();
		controller.dismiss();
		expect(port.dismissed.length).toBe(1);
	});

	/** `/welcome` supersedes the home hero: the full card mounts into the
	 * TRANSCRIPT (spacer · card · spacer), the hero leaves the UI tree first,
	 * and the anchor is remeasured on this frame. Two suns / blank-screen
	 * regression (2026-07-22). */
	it("showFull dismisses the hero, mounts into the chat container, and remeasures", () => {
		const port = makePort();
		const controller = new WelcomeController(port);
		controller.mountHero(INPUTS, { playIntro: false });
		controller.showFull(INPUTS);
		expect(controller.hasHero).toBe(false);
		expect(port.uiChildren).toEqual([]);
		expect(port.dismissed.length).toBe(1);
		expect(port.chatChildren.length).toBe(3);
		// The full card renders the sunrise header + menu — taller than the home hero.
		expect(port.chatChildren[1]!.render(80).length).toBeGreaterThan(3);
		expect(port.remeasures).toBe(1);
	});

	/** Without a mounted hero, playIntro and dismiss are safe no-ops — the
	 * quiet-startup path (`startup.quiet`) never mounts one. */
	it("no-ops playIntro and dismiss when nothing is mounted", () => {
		const port = makePort();
		const controller = new WelcomeController(port);
		expect(() => controller.playIntro()).not.toThrow();
		controller.dismiss();
		expect(port.dismissed).toEqual([]);
	});

	/** Source lock: interactive-mode must DELEGATE the welcome lane, never
	 * re-inline it. This extraction was clobbered once by a parallel landing
	 * that restored the inline `#welcomeComponent` fields, silently orphaning
	 * this controller as dead code (2026-07-22) — with no failing test to
	 * show for it. Now a re-inline fails here. */
	it("interactive-mode delegates to the controller and keeps no inline welcome state", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const src = readFileSync(join(import.meta.dir, "../../../src/modes/interactive-mode.ts"), "utf8");
		expect(src).toContain("this.#welcomeController.dismiss()");
		expect(src).toContain("this.#welcomeController.mountHero(");
		expect(src).toContain("this.#welcomeController.showFull(");
		expect(src).not.toContain("#welcomeComponent");
		expect(src).not.toContain("#welcomeSpacers");
	});
});
