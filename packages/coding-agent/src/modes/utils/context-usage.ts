/**
 * The `/context` panel: a 20x10 grid of the context window paired with a legend.
 *
 * The numbers come from `session/context-usage.ts`, which is where they belong,
 * because `session/agent-session.ts` needs them and the session engine must not
 * reach into the terminal UI for them. What is left here is the drawing: which
 * glyph and colour each category gets, how the token counts are rounded into
 * cells, and how the two columns are laid out beside each other.
 */

import { formatBytes, formatNumber } from "@veyyon/utils/format";
import type { CategoryId, ContextBreakdown } from "../../session/context-usage";
import type { theme as Theme } from "../theme/theme";

const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";

const CELL_FILLED = "⛁";
const CELL_FILLED_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

type CellColor = "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel" | "muted" | "dim";

/**
 * How each category is drawn. Keyed on the category id rather than carried on the
 * breakdown, so the accounting module stays free of palette names: a category is a
 * label and a token count there, and only this table decides what it looks like.
 * Messages get their own glyph because they are the one category that grows while
 * you watch, and the grid is easier to read when that band is distinguishable from
 * the fixed overhead above it.
 */
const CATEGORY_STYLE: Record<CategoryId, { color: CellColor; glyph: string }> = {
	systemPrompt: { color: "accent", glyph: CELL_FILLED },
	systemTools: { color: "warning", glyph: CELL_FILLED },
	systemContext: { color: "customMessageLabel", glyph: CELL_FILLED },
	skills: { color: "success", glyph: CELL_FILLED },
	messages: { color: "userMessageText", glyph: CELL_FILLED_MESSAGES },
};

interface CellSpec {
	glyph: string;
	color: CellColor;
}

function planCells(breakdown: ContextBreakdown): CellSpec[] {
	const cells: CellSpec[] = [];
	const window = breakdown.contextWindow;

	if (window <= 0) {
		for (let i = 0; i < GRID_CELLS; i++) {
			cells.push({ glyph: CELL_FREE, color: "dim" });
		}
		return cells;
	}

	const tokensPerCell = window / GRID_CELLS;

	const ratioCells = (tokens: number): number => {
		if (tokens <= 0) return 0;
		return Math.max(1, Math.round(tokens / tokensPerCell));
	};

	const categoryCounts = breakdown.categories.map(category => ({
		category,
		count: ratioCells(category.tokens),
	}));

	let bufferCount = ratioCells(breakdown.autoCompactBufferTokens);

	let usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);

	// Prevent the visualization from over-running the grid.
	const maxUsable = GRID_CELLS - bufferCount;
	if (usedCount > maxUsable) {
		// Scale categories proportionally down to fit.
		let overflow = usedCount - maxUsable;
		// Trim from the largest categories first to preserve visibility for small ones.
		const order = [...categoryCounts].sort((a, b) => b.count - a.count);
		for (const entry of order) {
			while (overflow > 0 && entry.count > 1) {
				entry.count -= 1;
				overflow -= 1;
			}
		}
		usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
		if (usedCount + bufferCount > GRID_CELLS) {
			bufferCount = Math.max(0, GRID_CELLS - usedCount);
		}
	}

	for (const { category, count } of categoryCounts) {
		const style = CATEGORY_STYLE[category.id];
		for (let i = 0; i < count; i++) {
			cells.push({ glyph: style.glyph, color: style.color });
		}
	}

	const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
	for (let i = 0; i < freeCount; i++) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	for (let i = 0; i < bufferCount; i++) {
		cells.push({ glyph: CELL_BUFFER, color: "warning" });
	}

	// Pad to exactly GRID_CELLS in case rounding undershot.
	while (cells.length < GRID_CELLS) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	return cells.slice(0, GRID_CELLS);
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct > 0 && pct < 0.05) return "<0.1%";
	return `${pct.toFixed(fractionDigits)}%`;
}

function buildLegendLines(breakdown: ContextBreakdown, theme: typeof Theme): string[] {
	const lines: string[] = [];
	const { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens, elidedBytes } = breakdown;

	const modelName = model?.name ?? model?.id ?? "no model";
	const modelId = model?.id ?? "unknown";
	const windowLabel = formatNumber(contextWindow).toLowerCase();

	lines.push(theme.bold(`${modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
	lines.push(theme.fg("muted", `${modelId}[${windowLabel}]`));
	lines.push(
		`${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}` +
			theme.fg("muted", ` (${percentString(usedTokens, contextWindow)})`),
	);
	lines.push("");
	lines.push(theme.fg("muted", "Estimated usage by category"));

	for (const category of categories) {
		const style = CATEGORY_STYLE[category.id];
		const dot = theme.fg(style.color, style.glyph);
		const label = category.label;
		const tokens = formatNumber(category.tokens);
		const pct = percentString(category.tokens, contextWindow);
		lines.push(`${dot} ${label}: ${theme.bold(tokens)} ${theme.fg("dim", `tokens (${pct})`)}`);
	}

	const freeDot = theme.fg("dim", CELL_FREE);
	lines.push(
		`${freeDot} Free space: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`,
	);

	// Bytes kept out of the request, which the grid above cannot show because they
	// are not in the context. Rendered only when a mechanism actually elided
	// something, so a session with both turned off reads exactly as it did before.
	const { wirePaths, thoughtSignatures } = elidedBytes;
	if (wirePaths > 0 || thoughtSignatures > 0) {
		const parts: string[] = [];
		if (thoughtSignatures > 0) parts.push(`${formatBytes(thoughtSignatures)} of thought signatures`);
		if (wirePaths > 0) parts.push(`${formatBytes(wirePaths)} of absolute paths`);
		lines.push(`${theme.fg("dim", "·")} Kept out of context: ${theme.fg("dim", parts.join(", "))}`);
	}

	if (autoCompactBufferTokens > 0) {
		const bufferDot = theme.fg("warning", CELL_BUFFER);
		lines.push(
			`${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg(
				"dim",
				`tokens (${percentString(autoCompactBufferTokens, contextWindow)})`,
			)}`,
		);
	}

	return lines;
}

/**
 * Render a colorful context-usage panel as ANSI text. Output is a series of
 * lines pairing the grid (left) with the legend (right).
 */
export function renderContextUsage(breakdown: ContextBreakdown, theme: typeof Theme): string {
	if (breakdown.contextWindow <= 0) {
		return theme.fg("muted", "Context usage is unavailable: no model is selected for this session.");
	}

	const cells = planCells(breakdown);
	const legend = buildLegendLines(breakdown, theme);

	const totalLines = Math.max(GRID_ROWS, legend.length);
	const lines: string[] = [];

	for (let row = 0; row < totalLines; row++) {
		let gridSegment = "";
		if (row < GRID_ROWS) {
			const rowCells: string[] = [];
			for (let col = 0; col < GRID_COLS; col++) {
				const cell = cells[row * GRID_COLS + col];
				rowCells.push(theme.fg(cell.color, cell.glyph));
			}
			gridSegment = rowCells.join(" ");
		} else {
			// Pad with blanks the same visible width as a grid row so legend lines
			// past the grid stay aligned with their column.
			const blank = " ".repeat(GRID_COLS * 2 - 1);
			gridSegment = blank;
		}

		const legendSegment = legend[row] ?? "";
		const line = legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
		lines.push(line);
	}

	return lines.join("\n");
}
