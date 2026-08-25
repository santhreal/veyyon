/**
 * The model browser's detail block rides the selection.
 *
 * WHY THIS SUITE EXISTS. The browser reserved its full window height in blanks
 * BETWEEN the model rows and the detail block, so on a short or filtered list
 * the sentence explaining the selected model sat a viewport away from the rows
 * — two matches, eight blank rows, then "GPT-5 · 400k ctx · …" floating above
 * the footer like detached chrome. The reservation still exists (host mouse
 * geometry depends on a stable total height) but it now trails the detail, so
 * the detail always lands directly under the rows.
 *
 * What this does not catch: the hub's long-list case, where the reservation is
 * empty by construction and nothing moves.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildBrowserItems, ModelBrowser, sortModelItems } from "@veyyon/coding-agent/modes/components/model-browser";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

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

describe("the detail block rides the selection", () => {
	test("the detail lands directly under the rows on a short list", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		const items = buildBrowserItems([makeModel("openai", "gpt-5"), makeModel("azure", "gpt-5.1")]);
		sortModelItems(items, {});
		browser.setItems(items);
		browser.setMaxVisible(12);

		const lines = browser.render(100).map(stripVTControlCharacters);
		const detail = lines.findIndex(line => line.includes("128k ctx"));
		// The row needle must name the provider: the detail line carries the bare
		// id too, so matching the id alone finds the detail as the "last row".
		const lastRow = lines.reduce((acc, line, index) => (index < detail && line.includes("/gpt-5") ? index : acc), -1);
		expect(lastRow).toBeGreaterThanOrEqual(0);
		expect(detail).toBeGreaterThanOrEqual(0);
		// Rows, one blank, detail — never a window of blanks between them.
		expect(detail - lastRow).toBeLessThanOrEqual(2);
	});

	test("the total rendered height is unchanged by the reorder", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		const items = buildBrowserItems([makeModel("openai", "gpt-5")]);
		sortModelItems(items, {});
		browser.setItems(items);
		// Hosts size their mouse geometry off renderedRows; the reorder must not
		// add or drop a line.
		expect(browser.render(100).length).toBe(browser.renderedRows);
	});
});
