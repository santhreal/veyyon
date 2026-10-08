/**
 * How a session file stores an eval result without repeating raw cell output that content holds.
 *
 * The model reads the cell's output in the tool result's first text block, optionally with test
 * folding or an exit code notice appended, and `details.cells[i].output` holds the raw cell output.
 * When the content text holds `output` verbatim, {@link evalResultCodec} drops `output` from the
 * written line and records its span in the content text (`outputSpan`), restoring it as a slice of
 * that text when the session loads; a result the session records holds the same slice, so the entry
 * holds the output once.
 *
 * For single-cell calls, top-level `details.statusEvents` equals `cells[0].statusEvents`. When they
 * deep-equal, the top-level array is dropped from the written line with `statusEventsFrom: "cell0"`
 * and rebuilt on load.
 */
import { isDeepStrictEqual } from "node:util";
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BuiltinToolName } from "../core/builtin-names";
import {
	type CodedResultContent,
	firstResultText,
	MIN_CODED_TEXT,
	type ResultTextSpan,
	resultTextSpan,
	sliceResultSpan,
} from "../core/output-notice";

/** The tag a written line carries in place of top-level `statusEvents`: the first cell's events. */
export const FROM_CELL0 = "cell0";

/** A cell as a written line holds it: `outputSpan` stands in for a dropped `output`. */
interface CodedCell {
	output?: string;
	outputSpan?: unknown;
}

function firstCellEvents(cells: unknown): unknown[] | undefined {
	if (!Array.isArray(cells) || !isRecord(cells[0])) return undefined;
	const events = cells[0].statusEvents;
	return Array.isArray(events) ? events : undefined;
}

/** Each cell whose output `body` holds verbatim, with its index and that output's span in `body`. */
function* heldOutputs(
	cells: readonly unknown[],
	body: string,
): Generator<[cell: Record<string, unknown>, index: number, span: ResultTextSpan]> {
	// Cells print in order, so each one's output is looked for after the previous one's.
	let from = 0;
	for (let index = 0; index < cells.length; index++) {
		const cell = cells[index];
		if (!isRecord(cell) || typeof cell.output !== "string" || cell.output.length < MIN_CODED_TEXT) continue;
		const span = resultTextSpan(body, cell.output, from) ?? resultTextSpan(body, cell.output);
		if (span === undefined) continue;
		from = span[1];
		yield [cell, index, span];
	}
}

/** `cells` with each output the content text holds replaced by its span, else `cells` itself. */
function slimCells(cells: unknown[], body: string): unknown[] {
	let slimmed: unknown[] | undefined;
	for (const [cell, index, span] of heldOutputs(cells, body)) {
		slimmed ??= cells.slice();
		const { output: _dropped, ...kept } = cell;
		slimmed[index] = { ...kept, outputSpan: span };
	}
	return slimmed ?? cells;
}

/** How an eval result is written to a session file and read back. */
export const evalResultCodec: ToolResultCodec = {
	toolName: "eval" satisfies BuiltinToolName,
	slim(details, content) {
		if (!isRecord(details)) return details;
		const body = firstResultText(content);
		const cells = Array.isArray(details.cells) && body !== undefined ? slimCells(details.cells, body) : details.cells;
		const events = details.statusEvents;
		const eventsFromCell0 =
			Array.isArray(events) && events.length > 0 && isDeepStrictEqual(events, firstCellEvents(details.cells));
		if (cells === details.cells && !eventsFromCell0) return details;
		const slimmed: Record<string, unknown> = { ...details, cells };
		if (eventsFromCell0) {
			delete slimmed.statusEvents;
			slimmed.statusEventsFrom = FROM_CELL0;
		}
		return slimmed;
	},
	restore(details, content) {
		if (!isRecord(details)) return;
		const body = firstResultText(content);
		if (Array.isArray(details.cells)) {
			for (const cell of details.cells) {
				if (!isRecord(cell) || cell.output !== undefined) continue;
				const output = sliceResultSpan(body, cell.outputSpan);
				if (output === undefined) continue;
				cell.output = output;
				delete cell.outputSpan;
			}
		}
		if (details.statusEventsFrom === FROM_CELL0 && details.statusEvents === undefined) {
			const events = firstCellEvents(details.cells);
			if (events !== undefined) {
				details.statusEvents = events.slice();
				delete details.statusEventsFrom;
			}
		}
	},
	// A recorded cell's output the content text holds verbatim becomes a slice of that text, as a load
	// rebuilds it, so the entry holds the output once.
	settle(details, content) {
		const body = firstResultText(content);
		if (!isRecord(details) || !Array.isArray(details.cells) || body === undefined) return;
		for (const [cell, , [start, end]] of heldOutputs(details.cells, body)) cell.output = body.slice(start, end);
	},
};

/**
 * The cells a card draws for an eval result. A session loaded with the codec registered holds them
 * whole; a transcript read without that restore holds the written form, which is rebuilt here from
 * the result's text.
 */
export function resolveEvalCells<T extends CodedCell>(
	cells: readonly T[] | undefined,
	content: CodedResultContent,
): readonly T[] | undefined {
	if (cells === undefined || !cells.some(cell => cell.output === undefined && cell.outputSpan !== undefined)) {
		return cells;
	}
	const body = firstResultText(content);
	return cells.map(cell => {
		if (cell.output !== undefined) return cell;
		const output = sliceResultSpan(body, cell.outputSpan);
		return output === undefined ? cell : { ...cell, output };
	});
}

/**
 * The status events for an eval result, resolving the top-level list from the first cell when
 * stored in slimmed form.
 */
export function resolveEvalStatusEvents<E>(
	details:
		| {
				statusEvents?: readonly E[];
				statusEventsFrom?: string;
				cells?: readonly { statusEvents?: readonly E[] }[];
		  }
		| undefined,
): readonly E[] | undefined {
	if (details === undefined || details.statusEvents !== undefined) return details?.statusEvents;
	return details.statusEventsFrom === FROM_CELL0 ? details.cells?.[0]?.statusEvents : undefined;
}
