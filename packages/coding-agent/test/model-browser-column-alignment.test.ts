import { beforeAll, describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildBrowserItems, ModelBrowser } from "@veyyon/coding-agent/modes/components/model-browser";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

/**
 * The model browser right-aligns a metadata block: context window, then the
 * `$in/out` price pair, then measured perf. Column widths were measured over the
 * VISIBLE WINDOW only, so the widest price currently on screen decided where the
 * whole block started. Scrolling changed which prices were on screen, so the
 * columns slid sideways on every wheel tick and the numbers stopped lining up
 * with each other from row to row. Reported as prices getting desynced while
 * scrolling.
 *
 * Widths are a property of the list, not of where you happen to be looking, so
 * they are now measured across every row and cached. These tests scroll a list
 * whose price widths vary a lot between the top and the bottom, which is the
 * shape that made the drift visible, and assert the columns land in the same
 * place throughout.
 */
describe("model browser column alignment while scrolling", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function makeModel(id: string, cost: { input: number; output: number }, contextWindow: number): Model {
		return buildModel({
			id,
			name: id,
			api: "ollama-chat",
			provider: "test",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: 1024,
		});
	}

	/**
	 * Cheap rows at the top, expensive rows at the bottom. `$0.05/0.2` and
	 * `$150/600` are very different widths, so a per-window measurement produces a
	 * different layout depending on which end is in view.
	 */
	function makeBrowser(): ModelBrowser {
		const models: Model[] = [];
		for (let i = 0; i < 20; i++) models.push(makeModel(`cheap-${i}`, { input: 0.05, output: 0.2 }, 8_000));
		for (let i = 0; i < 20; i++) models.push(makeModel(`costly-${i}`, { input: 150, output: 600 }, 1_000_000));
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems(models));
		browser.setMaxVisible(8);
		return browser;
	}

	const WIDTH = 100;

	/**
	 * List rows only. The detail line under the list also prints the price, in a
	 * `name · 128k ctx · $x/y per M` form, and it is not part of the column being
	 * measured; the interpunct is what separates the two.
	 */
	function listRows(browser: ModelBrowser): string[] {
		return browser
			.render(WIDTH)
			.map(line => Bun.stripANSI(line))
			.filter(line => line.includes("$") && !line.includes("·"));
	}

	/**
	 * Column at which the right-aligned metadata block BEGINS on each row.
	 *
	 * Not the price's own start, and not the row's right edge. The block is padded
	 * to fill the row, so its right edge sits at the terminal width no matter what
	 * and never moves; a test on that would pass even with the bug present. What
	 * actually moved was the block's left boundary, because it is
	 * `ctxWidth + costWidth + padding` wide and both widths were measured per
	 * window. When the widest visible price shrank from `$0.05/0.2` to `$15/6`,
	 * the whole block, context column included, jumped four columns right.
	 */
	function priceColumns(browser: ModelBrowser): number[] {
		return listRows(browser).map(line => {
			const dollar = line.indexOf("$");
			// Walk left off the price, over the gap, and off the context token, to
			// land on the first column the metadata block occupies.
			let i = dollar - 1;
			while (i >= 0 && line[i] === " ") i--;
			while (i >= 0 && line[i] !== " ") i--;
			return i + 1;
		});
	}

	/** Scroll to the bottom the way the keyboard does, one row at a time. */
	function scrollToEnd(browser: ModelBrowser): void {
		for (let i = 0; i < 40; i++) browser.moveSelection(1, { wrap: false });
	}

	it("puts the price column in the same place at the top and at the bottom of the list", () => {
		// REGRESSION, and the direct form of the report. Before the fix the top of
		// the list measured only cheap prices and the bottom only expensive ones, so
		// these two layouts differed and the column visibly jumped mid-scroll.
		const browser = makeBrowser();

		const topColumns = priceColumns(browser);
		scrollToEnd(browser);
		const bottomColumns = priceColumns(browser);

		expect(topColumns.length).toBeGreaterThan(0);
		expect(bottomColumns.length).toBeGreaterThan(0);
		expect(new Set([...topColumns, ...bottomColumns]).size).toBe(1);
	});

	it("holds the column fixed through every intermediate scroll position", () => {
		// The jump happened as the window crossed the boundary between cheap and
		// expensive rows, so checking only the two ends could miss a wobble. This
		// walks every position.
		const browser = makeBrowser();
		const columns = new Set<number>();

		for (let step = 0; step < 40; step++) {
			for (const column of priceColumns(browser)) columns.add(column);
			browser.moveSelection(1, { wrap: false });
		}

		expect(columns.size).toBe(1);
	});

	it("aligns every row within a single frame", () => {
		// The other half of the contract: within one render, all rows share the
		// column. This held before the fix and must keep holding after it.
		const browser = makeBrowser();

		const starts = priceColumns(browser);

		expect(starts.length).toBeGreaterThan(1);
		expect(new Set(starts).size).toBe(1);
	});

	it("re-measures when the list changes rather than serving a stale width", () => {
		// The widths are cached, so the cache has to be dropped when the item list
		// changes. A stale width would misalign every row against the new content.
		const browser = makeBrowser();
		browser.render(WIDTH);

		browser.setItems(buildBrowserItems([makeModel("only", { input: 0.01, output: 0.02 }, 4_000)]));
		const priced = listRows(browser);

		expect(priced).toHaveLength(1);
		// With one narrow row the block sits far right, not padded out to the width
		// the wide catalog needed.
		expect(priced[0]).toContain("$0.01/0.02");
	});

	it("re-measures when a filter narrows the list", () => {
		// Typing a query replaces the visible items through the same path, so the
		// same invalidation has to cover it.
		const browser = makeBrowser();
		browser.render(WIDTH);

		browser.setQuery("cheap");
		const lines = browser.render(WIDTH).map(line => Bun.stripANSI(line));

		expect(lines.some(line => line.includes("$0.05/0.2"))).toBe(true);
		expect(lines.some(line => line.includes("$150/600"))).toBe(false);
	});
});

/**
 * The price column's content, not its position. A zero cost used to render as
 * `free`, which was false for the roughly 1,500 bundled models whose provider
 * simply publishes no pricing.
 */
describe("model browser price labels", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function browserWith(id: string, cost: { input: number; output: number }): ModelBrowser {
		const model = buildModel({
			id,
			name: id,
			api: "ollama-chat",
			provider: "test",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([model]));
		browser.setMaxVisible(4);
		return browser;
	}

	function rendered(browser: ModelBrowser): string {
		return browser
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
	}

	it("shows a dash, not free, for a model whose price was never published", () => {
		// REGRESSION: this row said `free` for a paid model.
		const text = rendered(browserWith("qwen3-max-instruct", { input: 0, output: 0 }));

		expect(text).toContain("—");
		expect(text).not.toContain("free");
	});

	it("says the price is unknown in the detail line", () => {
		// A bare `—` next to a row reads as zero; the detail line has room to say
		// what it means. Kept short deliberately: the perf figures share this line
		// and a longer phrase truncates them away on a narrow terminal.
		const text = rendered(browserWith("qwen3-max-instruct", { input: 0, output: 0 }));

		expect(text).toContain("price unknown");
	});

	it("still says free for a model that is provably free", () => {
		const text = rendered(browserWith("meta-llama/llama-3.3-70b-instruct:free", { input: 0, output: 0 }));

		expect(text).toContain("free");
		expect(text).not.toContain("—");
	});

	it("renders a published price unchanged", () => {
		const text = rendered(browserWith("gpt-4o", { input: 2.5, output: 10 }));

		// Trailing zeros are stripped by the formatter, so 2.5 renders as `2.5`.
		expect(text).toContain("$2.5/10");
	});

	/**
	 * The formatter trimmed trailing zeros to keep the column narrow, but it did so
	 * on the whole string rather than only after a decimal point. On a whole number
	 * that deletes a digit and shifts the decimal: `$150/600` rendered as `$15/6`,
	 * and `azure/gpt-5-pro` at $120 per M output showed as $12. 323 price legs in
	 * the bundled catalog were affected, some understated tenfold.
	 *
	 * A price that is wrong by an order of magnitude is worse than a wide column,
	 * so these cases are pinned individually rather than as one round trip.
	 */
	describe("whole-number prices keep their magnitude", () => {
		const cases: Array<[number, number, string]> = [
			[150, 600, "$150/600"],
			[120, 120, "$120/120"],
			[100, 200, "$100/200"],
			[10, 20, "$10/20"],
			[1000, 2000, "$1000/2000"],
		];

		for (const [input, output, expected] of cases) {
			it(`renders ${input}/${output} as ${expected}`, () => {
				expect(rendered(browserWith("m", { input, output }))).toContain(expected);
			});
		}

		it("still trims the zeros that only pad a decimal", () => {
			// The trimming exists for a reason: `3.00` and `1.50` should not eat
			// column width. Fixing the magnitude bug must not undo that.
			expect(rendered(browserWith("m", { input: 3, output: 1.5 }))).toContain("$3/1.5");
		});

		it("keeps a fractional price that ends in a non-zero digit intact", () => {
			expect(rendered(browserWith("m", { input: 0.25, output: 12.5 }))).toContain("$0.25/12.5");
		});
	});
});
