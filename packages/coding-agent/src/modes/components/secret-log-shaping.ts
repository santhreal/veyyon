/**
 * Filtering and aggregation over the secret expansion log.
 *
 * The Log view shows the last uses in the order the writer appended them, which answers "what
 * happened recently" and nothing else. The question an operator actually arrives with is narrower:
 * a credential is suspected, and they need to know where that one credential has been spent. That
 * join lives here rather than in the card so it can be tested against exact records instead of
 * against a rendered screen.
 *
 * Nothing in this module reads a file, writes the vault, or touches the audit log. It takes records
 * in and returns records, counts and one sentence out. It also never sees a secret value: a record
 * carries placeholders, a tool name and a command, and those three are the only text considered.
 */
import type { SecretExpansionRecord } from "../../secrets/audit";
import type { LogFilter, LogShapingInput, SecretUsageStats } from "./secret-manager-types";

/**
 * The records the Log view should paint, narrowed by the operator's filter.
 *
 * Input ordering is preserved. The log is read newest-last by the decoder and the table depends on
 * that, so a filter that also reordered would quietly change what "the most recent use" means.
 *
 * Both fields are ANDed and an empty field matches everything, so the unfiltered call is the
 * identity on the record list.
 *
 * THE FREE TEXT IS MATCHED AGAINST EVERY COLUMN THE TABLE PAINTS, which is what it was not. The
 * Log view draws WHEN, TOOL, SECRETS and WHERE, and the search read only TOOL and WHERE. The
 * SECRETS cell is not a restatement of the command: the writer bounds a record independently, so
 * a command cut at its size limit still carries the full list of placeholders that were spent.
 * Typing `GITHUB` therefore answered "No recorded use matches" while `#GITHUB_TOKEN#` was on the
 * row in front of the operator, which reads as a log that has lost the record rather than as a
 * search that cannot see the column. WHEN is left out on purpose: it is a phrase this module
 * computes from the clock (`2h ago`), not text the record holds.
 */
export function filterLogRecords(input: LogShapingInput): readonly SecretExpansionRecord[] {
	const text = normaliseText(input.filter.text);
	const placeholder = normalisePlaceholder(input.filter.placeholder);
	if (text === undefined && placeholder === undefined) return input.records;

	const needle = text?.toLowerCase();
	return input.records.filter(record => {
		if (
			needle !== undefined &&
			!record.tool.toLowerCase().includes(needle) &&
			!record.command.toLowerCase().includes(needle) &&
			!record.secrets.some(secret => secret.toLowerCase().includes(needle))
		) {
			return false;
		}
		if (placeholder !== undefined && !spentPlaceholder(record, placeholder)) return false;
		return true;
	});
}

/**
 * What one stored credential has been used for, joined from the records given.
 *
 * This is what the detail panel renders beside an entry, so it must survive the ordinary case of a
 * credential that has never been spent. An unused placeholder is not an error: it returns a zero
 * count, a `null` timestamp and no tools, and the panel says so.
 */
export function usageStatsFor(placeholder: string, records: readonly SecretExpansionRecord[]): SecretUsageStats {
	const wanted = normalisePlaceholder(placeholder);
	if (wanted === undefined) return { useCount: 0, lastUsedAt: null, tools: [] };

	const uses = records.filter(record => spentPlaceholder(record, wanted));
	if (uses.length === 0) return { useCount: 0, lastUsedAt: null, tools: [] };

	// Most recent first, and stable within a timestamp so two uses recorded in the same
	// millisecond keep the order the log appended them in rather than an arbitrary one.
	const byRecency = uses.map((record, index) => ({ record, index }));
	byRecency.sort((left, right) => right.record.at - left.record.at || left.index - right.index);

	const tools: string[] = [];
	for (const { record } of byRecency) {
		if (!tools.includes(record.tool)) tools.push(record.tool);
	}

	return { useCount: uses.length, lastUsedAt: byRecency[0].record.at, tools };
}

/**
 * The line that tells the operator the list in front of them is narrowed, and by what.
 *
 * It exists because of the failure it prevents: a filtered list that does not announce itself reads
 * exactly like an unfiltered one, and an operator who forgot a leftover query concludes that a
 * credential was never used when in fact it was. That is the wrong conclusion to reach about a
 * credential you are deciding whether to revoke.
 *
 * Returns `undefined` when no field is set, so an unfiltered view spends no row on saying so.
 */
export function describeLogFilter(filter: LogFilter, shown: number, total: number): string | undefined {
	const text = normaliseText(filter.text);
	const placeholder = normalisePlaceholder(filter.placeholder);
	if (text === undefined && placeholder === undefined) return undefined;

	const noun = total === 1 ? "use" : "uses";
	let line = `Showing ${shown} of ${total} ${noun}`;
	if (placeholder !== undefined) line += ` of ${placeholder}`;
	if (text !== undefined) line += ` matching "${text}"`;
	return `${line}.`;
}

/** An absent free-text field, so `""` and whitespace behave the same as never having typed. */
function normaliseText(text: string): string | undefined {
	const trimmed = text.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** An absent placeholder restriction, so a cleared field is not a filter that matches nothing. */
function normalisePlaceholder(placeholder: string | undefined): string | undefined {
	if (placeholder === undefined) return undefined;
	const trimmed = placeholder.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Whether this record is EVIDENCE that the placeholder was spent.
 *
 * `secrets` holds the full placeholder including its hashes, because the writer captures the whole
 * regex match. Comparison is against that exact form: strip the hashes here and the join returns
 * zero for every credential while looking like a working filter.
 *
 * `omittedSecrets` counts placeholders the record did not list, to stay within its size bound. A
 * record with omissions MIGHT have spent the placeholder, but only the listed names are evidence
 * that it did, so an omission never counts as a match. Claiming otherwise would attribute a use to
 * a credential on the strength of a number.
 */
function spentPlaceholder(record: SecretExpansionRecord, placeholder: string): boolean {
	return record.secrets.includes(placeholder);
}
