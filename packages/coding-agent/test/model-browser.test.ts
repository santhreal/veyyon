import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	buildBrowserItems,
	ModelBrowser,
	resolveRoleAssignments,
	sortModelItems,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/model-browser";
import { getThemeByName, initTheme, setThemeInstance, theme } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { motionClock } from "@veyyon/utils/motion";
import { parseSgrMouse } from "@veyyon/utils/mouse";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

/** Browser preloaded with `models`, MRU-sorted like the hub does on sync. */
function makeBrowser(models: Model[], mruOrder: string[]): ModelBrowser {
	const browser = new ModelBrowser(Settings.isolated({}));
	const items = buildBrowserItems(models);
	sortModelItems(items, { mruOrder });
	browser.setMruOrder(mruOrder);
	browser.setItems(items);
	return browser;
}

describe("default-role effort display", () => {
	test("shows the assigned model's own Default Effort row", () => {
		// Runtime resolves Default Effort with a concrete provider/id. The browser
		// must pass the same selector or it skips this row and falsely shows Inherit.
		const model = makeModel("openai", "gpt-5");
		const settings = Settings.isolated({
			modelRoles: { default: "openai/gpt-5" },
			defaultEffort: { "openai/gpt-5": ThinkingLevel.High },
		});

		expect(resolveRoleAssignments(settings, [model]).default).toMatchObject({
			model,
			thinkingLevel: ThinkingLevel.High,
		});
	});
});

describe("ModelBrowser search ranking", () => {
	test("an exact query match outranks the MRU model", () => {
		// Regression: with gpt-5.6-sol as the active (MRU) model, typing
		// "gpt-5.5" must select gpt-5.5, not keep the MRU pinned on top.
		const browser = makeBrowser(
			[
				makeModel("openai-codex", "gpt-5.6-sol"),
				makeModel("openai-codex", "gpt-5.6-luna"),
				makeModel("openai-codex", "gpt-5.5"),
				makeModel("openai-codex", "gpt-5.4"),
			],
			["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
		);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("openai-codex/gpt-5.5");
	});

	test("MRU breaks ties between equally good matches", () => {
		// Same model id under two providers: match quality is identical, so
		// the recently used provider must win over alphabetical order.
		const browser = makeBrowser([makeModel("g0i", "gpt-5.5"), makeModel("zenmux", "gpt-5.5")], ["zenmux/gpt-5.5"]);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("zenmux/gpt-5.5");
	});
});

describe("ModelBrowser perf display", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton.
		await initTheme(false);
	});

	function makePerfBrowser(): ModelBrowser {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));
		browser.setPerfStats(new Map([["openai/gpt-5", { samples: 12, tps: 118.4, ttftMs: 930 }]]));
		return browser;
	}

	function renderPlain(browser: ModelBrowser, width: number): string[] {
		return browser.render(width).map(line => Bun.stripANSI(line));
	}

	test("row perf column scales with width: off, TPS-only, TTFT+TPS", () => {
		const browser = makePerfBrowser();

		expect(renderPlain(browser, 70)[2]).not.toContain("t/s");
		expect(renderPlain(browser, 80)[2]).toContain("118t/s");
		const wideRow = renderPlain(browser, 120)[2];
		expect(wideRow).toContain("0.9s 118t/s");
	});

	test("detail line shows measured perf regardless of width", () => {
		const browser = makePerfBrowser();

		const lines = renderPlain(browser, 70);
		expect(lines[lines.length - 2]).toContain("~118t/s · 0.9s ttft");
	});

	test("models without measurements render no perf cell", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));

		expect(renderPlain(browser, 120)[2]).not.toContain("t/s");
	});
});

describe("ModelBrowser hover controller lifecycle", () => {
	let policy: AnsiPolicy;
	let originalColorterm: string | undefined;
	let originalTheme: typeof theme | undefined;

	beforeEach(async () => {
		originalTheme = theme;
		originalColorterm = Bun.env.COLORTERM;
		Bun.env.COLORTERM = "truecolor";
		const loaded = await getThemeByName("titanium");
		if (loaded) setThemeInstance(loaded);
		policy = getAnsiPolicy();
		setAnsiPolicy("full");
	});

	afterEach(() => {
		motionClock.clear();
		setAnsiPolicy(policy);
		if (originalColorterm === undefined) delete Bun.env.COLORTERM;
		else Bun.env.COLORTERM = originalColorterm;
		if (originalTheme !== undefined) setThemeInstance(originalTheme);
	});

	test("handles pointer changes, no-motion mode, late attachment, callback replacement and disposal", () => {
		const browser = makeBrowser([makeModel("openai", "gpt-5"), makeModel("anthropic", "claude-3")], []);
		browser.render(80);
		// Row 0 is at line 2 (LIST_ROW_START = 2)
		// 1. Without motion lent, routeMouse paints the switched truecolor band
		browser.routeMouse(parseSgrMouse("\x1b[<35;11;3M")!, 2);
		const linesWithHover = browser.render(80);
		expect(linesWithHover[2]).toContain("\x1b[48;2;");

		browser.clearHover();
		const linesWithoutHover = browser.render(80);
		expect(linesWithoutHover[2]).not.toContain("\x1b[48;2;");
		expect(linesWithHover[2]).not.toBe(linesWithoutHover[2]);

		// 2. Motion mode: routeMouse triggers requestRender and registers on motionClock
		let renderCalls = 0;
		browser.setHoverMotion({
			requestRender: () => {
				renderCalls++;
			},
			enabled: true,
		});
		browser.routeMouse(parseSgrMouse("\x1b[<35;11;3M")!, 2);
		expect(renderCalls).toBeGreaterThan(0);
		expect(motionClock.liveCount).toBeGreaterThan(0);
		motionClock.clear();

		// 3. Late render-callback attachment: set hover first, then attach motion
		browser.clearHover();
		browser.routeMouse(parseSgrMouse("\x1b[<35;11;3M")!, 2);
		let lateRenderCalls = 0;
		browser.setHoverMotion({
			requestRender: () => {
				lateRenderCalls++;
			},
			enabled: true,
		});
		expect(motionClock.liveCount).toBeGreaterThan(0);
		expect(lateRenderCalls).toBeGreaterThan(0);
		motionClock.clear();

		// 4. Callback replacement: replacing motion options cleans up prior fade
		let replacementCalls = 0;
		const lateCallsBeforeReplacement = lateRenderCalls;
		browser.setHoverMotion({
			requestRender: () => {
				replacementCalls++;
			},
			enabled: false,
		});
		const callsBeforePointer = replacementCalls;
		browser.routeMouse(parseSgrMouse("\x1b[<35;11;4M")!, 3);
		expect(replacementCalls).toBeGreaterThan(callsBeforePointer);
		expect(lateRenderCalls).toBe(lateCallsBeforeReplacement);
		expect(motionClock.liveCount).toBe(0);

		// 5. Dispose cleans up hover and fade
		browser.disposeHoverMotion();
		const linesAfterDispose = browser.render(80);
		expect(linesAfterDispose[3]).not.toContain("\x1b[48;2;");
	});
});
