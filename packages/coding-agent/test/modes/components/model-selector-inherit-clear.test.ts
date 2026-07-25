import { beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { INHERIT_ROW_SELECTOR } from "@veyyon/coding-agent/modes/components/model-browser";
import { ModelSelectorPanel } from "@veyyon/coding-agent/modes/components/model-selector";
import { barePickerSelector } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

/**
 * Regression suite for BUG-MODEL-PICKER-INHERIT-RETURN: after assigning a
 * model to an inherit-able slot (subagent.model, compaction.model, roles,
 * default model), the way back to "inherit" was a hidden forward-Delete-only
 * gesture — Backspace fell through as a no-op and no visible row offered the
 * unset state, so users on keyboards without forward-Delete could not return
 * at all. These tests pin the fix: a pinned first-class (inherit) row plus
 * Del AND Backspace both clearing when the search is empty.
 */

const KEY = { enter: "\r", backspace: "\x7f", delete: "\x1b[3~", down: "\x1b[B" } as const;

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

const MODELS = [makeModel("openai", "gpt-5"), makeModel("anthropic", "claude-sonnet-4-6")];

/** Minimal registry: every model reads as authenticated. */
const REGISTRY = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => false },
} as never;

interface Harness {
	panel: ModelSelectorPanel;
	picks: string[];
	clears: number;
	cancels: number;
}

function makePanel(options: { allowClear?: boolean; currentSelector?: string; clearLabel?: string }): Harness {
	const harness: Harness = {
		// Assigned below, once the callbacks that close over it exist.
		panel: undefined!,
		picks: [],
		clears: 0,
		cancels: 0,
	};
	harness.panel = new ModelSelectorPanel(
		Settings.isolated({}),
		REGISTRY,
		MODELS,
		{
			title: "Subagent model",
			allowClear: options.allowClear,
			currentSelector: options.currentSelector,
			clearLabel: options.clearLabel,
		},
		{
			onPick: (_model, selector) => {
				harness.picks.push(selector);
			},
			onClear: () => {
				harness.clears += 1;
			},
			onCancel: () => {
				harness.cancels += 1;
			},
		},
	);
	return harness;
}

beforeAll(async () => {
	// render() reads the global theme singleton.
	await initTheme(false);
});

function plain(panel: ModelSelectorPanel, width = 80): string[] {
	return panel.render(width).map(line => Bun.stripANSI(line));
}

describe("pinned (inherit) row", () => {
	test("allowClear prepends the (inherit) row ahead of every model row", () => {
		const h = makePanel({ allowClear: true });
		const lines = plain(h.panel);
		const inheritIndex = lines.findIndex(line => line.includes("(inherit main model)"));
		const modelIndex = lines.findIndex(line => line.includes("gpt-5"));
		expect(inheritIndex).toBeGreaterThanOrEqual(0);
		expect(modelIndex).toBeGreaterThanOrEqual(0);
		expect(inheritIndex).toBeLessThan(modelIndex);
	});

	test("without allowClear no (inherit) row is rendered", () => {
		const h = makePanel({});
		expect(plain(h.panel).some(line => line.includes("(inherit"))).toBe(false);
	});

	test("an unset slot marks the (inherit) row as current and explains it in the detail block", () => {
		const h = makePanel({ allowClear: true });
		const lines = plain(h.panel);
		const inheritLine = lines.find(line => line.includes("(inherit main model)")) ?? "";
		expect(inheritLine).toContain(theme.status.enabled);
		expect(lines.some(line => line.includes("Clear the assignment — inherit main model."))).toBe(true);
	});

	test("an assigned slot preselects the assigned model so a quick Enter re-picks it", () => {
		const h = makePanel({ allowClear: true, currentSelector: "openai/gpt-5" });
		const inheritLine = plain(h.panel).find(line => line.includes("(inherit main model)")) ?? "";
		expect(inheritLine).not.toContain(theme.status.enabled);
		h.panel.handleInput(KEY.enter);
		expect(h.picks).toEqual(["openai/gpt-5"]);
		expect(h.clears).toBe(0);
	});

	test("Enter on the (inherit) row fires onClear, never onPick", () => {
		const h = makePanel({ allowClear: true });
		// Unset slot: selection opens on the pinned row (it is the current value).
		h.panel.handleInput(KEY.enter);
		expect(h.clears).toBe(1);
		expect(h.picks).toEqual([]);
	});

	test("a custom clearLabel drives the row text and the detail line (auto-select slot)", () => {
		const h = makePanel({ allowClear: true, clearLabel: "(auto-select on launch)" });
		const lines = plain(h.panel);
		expect(lines.some(line => line.includes("(auto-select on launch)"))).toBe(true);
		expect(lines.some(line => line.includes("Clear the assignment — auto-select on launch."))).toBe(true);
		expect(lines.some(line => line.includes("(inherit main model)"))).toBe(false);
	});

	test("navigating past the pinned row picks models normally", () => {
		const h = makePanel({ allowClear: true });
		h.panel.handleInput(KEY.down);
		h.panel.handleInput(KEY.enter);
		expect(h.clears).toBe(0);
		expect(h.picks).toHaveLength(1);
		expect(h.picks[0]).toMatch(/^(openai\/gpt-5|anthropic\/claude-sonnet-4-6)$/);
	});

	test("typing 'inherit' keeps the clear row visible; a model query hides it", () => {
		const byLabel = makePanel({ allowClear: true });
		for (const ch of "inherit") byLabel.panel.handleInput(ch);
		expect(plain(byLabel.panel).some(line => line.includes("(inherit main model)"))).toBe(true);

		const byModel = makePanel({ allowClear: true });
		for (const ch of "gpt") byModel.panel.handleInput(ch);
		const lines = plain(byModel.panel);
		expect(lines.some(line => line.includes("gpt-5"))).toBe(true);
		expect(lines.some(line => line.includes("(inherit main model)"))).toBe(false);
	});
});

describe("clear gesture", () => {
	test("Backspace with an empty search clears the assignment", () => {
		const h = makePanel({ allowClear: true });
		h.panel.handleInput(KEY.backspace);
		expect(h.clears).toBe(1);
	});

	test("forward-Delete with an empty search clears the assignment", () => {
		const h = makePanel({ allowClear: true });
		h.panel.handleInput(KEY.delete);
		expect(h.clears).toBe(1);
	});

	test("Backspace with a non-empty search edits the query and never clears", () => {
		const h = makePanel({ allowClear: true });
		h.panel.handleInput("g");
		h.panel.handleInput("p");
		h.panel.handleInput(KEY.backspace);
		expect(h.clears).toBe(0);
		// The query lost one character: the search line shows "g", not "gp".
		const searchLine = plain(h.panel)[0] ?? "";
		expect(searchLine).toContain("g");
		expect(searchLine).not.toContain("gp");
	});

	test("the clear gesture is inert when allowClear is off", () => {
		const h = makePanel({});
		h.panel.handleInput(KEY.backspace);
		h.panel.handleInput(KEY.delete);
		expect(h.clears).toBe(0);
	});

	test("the footer hint names both clear paths and fits one line at 80 columns", () => {
		const h = makePanel({ allowClear: true });
		const hintLines = plain(h.panel).filter(line => line.includes("type to search"));
		expect(hintLines).toHaveLength(1);
		expect(hintLines[0]).toContain("Del or (inherit) clears");
		expect(hintLines[0]).toContain("Esc back");
	});
});

describe("INHERIT_ROW_SELECTOR", () => {
	// The pinned row's key must never collide with a canonical provider/id
	// selector, or activating a real model could be misread as a clear.
	test("cannot be mistaken for a provider/id selector", () => {
		expect(INHERIT_ROW_SELECTOR).not.toContain("/");
	});
});

describe("barePickerSelector", () => {
	// Role/default slots persist `provider/id:level` (renderEffortStep), but
	// the picker lists bare `provider/id` rows: without stripping, preselection
	// misses and selection lands on the (inherit) row, so Enter clears instead
	// of re-picking the assigned model.
	test("strips the :effort suffix so the assigned model preselects", () => {
		const models = MODELS as never;
		expect(barePickerSelector("openai/gpt-5:high", models)).toBe("openai/gpt-5");
	});

	test("passes a bare selector through unchanged", () => {
		const models = MODELS as never;
		expect(barePickerSelector("openai/gpt-5", models)).toBe("openai/gpt-5");
	});

	test("falls back to the raw string when the value does not resolve", () => {
		const models = MODELS as never;
		expect(barePickerSelector("ghost/missing:low", models)).toBe("ghost/missing:low");
	});

	test("undefined stays undefined (unset slot)", () => {
		expect(barePickerSelector(undefined, MODELS as never)).toBeUndefined();
	});
});
