/**
 * Filtering and aggregation over the secret expansion log.
 *
 * These are the joins an operator's suspicion runs through: narrow the log to one credential, then
 * read back where it was spent. Every failure mode here is silent. A placeholder comparison that
 * drops the hashes returns zero uses for every credential and looks exactly like a clean history; a
 * filter that counts an omission as a match attributes a use to a credential on the strength of a
 * number; a narrowed list with no caption reads like the full one.
 *
 * The module never opens a file, so every case below is exact records in and exact values out.
 */
import { describe, expect, it } from "bun:test";
import { describeLogFilter, filterLogRecords, usageStatsFor } from "../../../src/modes/components/secret-log-shaping";
import type { LogFilter } from "../../../src/modes/components/secret-manager-types";
import type { SecretExpansionRecord } from "../../../src/secrets/audit";

/** Fixed so timestamps are constants in the assertions rather than a function of the wall clock. */
const T0 = Date.parse("2026-07-31T12:00:00Z");

function record(fields: Partial<SecretExpansionRecord> & { at: number }): SecretExpansionRecord {
	return {
		secrets: ["#GITHUB_TOKEN#"],
		tool: "bash",
		command: "curl -H auth",
		...fields,
	};
}

/** No filter at all, so a case can set exactly the one field it is about. */
const NO_FILTER: LogFilter = { text: "", placeholder: undefined };

/**
 * Four records that disagree on every axis the filter reads: tool, command, placeholder and time.
 * They are given oldest first, the order the decoder returns, so ordering claims mean something.
 */
function seed(): SecretExpansionRecord[] {
	return [
		record({ at: T0, tool: "bash", command: "curl -H #GITHUB_TOKEN#", secrets: ["#GITHUB_TOKEN#"] }),
		record({ at: T0 + 1000, tool: "fetch", command: "GET /repos", secrets: ["#GITHUB_TOKEN#"] }),
		record({ at: T0 + 2000, tool: "ssh", command: "ssh -i deploy", secrets: ["#DEPLOY_KEY#"] }),
		record({
			at: T0 + 3000,
			tool: "bash",
			command: "rsync --rsh",
			secrets: ["#DEPLOY_KEY#", "#GITHUB_TOKEN#"],
		}),
	];
}

describe("the log filter narrows by free text", () => {
	/**
	 * THE TOOL NAME IS SEARCHABLE. An operator who knows a credential leaked through `ssh` types
	 * `ssh` and expects the ssh records. Match only the command and this query returns the record
	 * whose command happens to start with `ssh` while missing nothing else, which looks correct.
	 */
	it("matches the tool name", () => {
		const shown = filterLogRecords({ records: seed(), filter: { ...NO_FILTER, text: "fetch" } });

		expect(shown.map(entry => entry.at)).toEqual([T0 + 1000]);
	});

	/**
	 * THE COMMAND IS SEARCHABLE TOO. The command is where the evidence is: the tool is one of a
	 * handful of names, so a filter over tools alone cannot separate two hundred `bash` records.
	 */
	it("matches text that appears only in the command", () => {
		const shown = filterLogRecords({ records: seed(), filter: { ...NO_FILTER, text: "rsync" } });

		expect(shown.map(entry => entry.command)).toEqual(["rsync --rsh"]);
	});

	/**
	 * CASE IS NOT PART OF THE QUERY. Commands are written by the model in whatever case it likes,
	 * and an operator typing `get` who is shown nothing concludes the credential was never used on
	 * a GET. Both directions are asserted: an upper-case query against lower-case evidence and the
	 * reverse, because lower-casing only one side passes half of this.
	 */
	it("ignores case in both the query and the record", () => {
		const upperQuery = filterLogRecords({ records: seed(), filter: { ...NO_FILTER, text: "REPOS" } });
		const lowerQuery = filterLogRecords({ records: seed(), filter: { ...NO_FILTER, text: "get" } });

		expect(upperQuery.map(entry => entry.at)).toEqual([T0 + 1000]);
		expect(lowerQuery.map(entry => entry.at)).toEqual([T0 + 1000]);
	});

	/**
	 * AN EMPTY QUERY IS NOT A QUERY. Treat `""` as text to find and `includes("")` is true for
	 * everything, which is right by accident; treat whitespace as text and the operator who
	 * cleared the field with a stray space sees an empty log. Both must be the identity.
	 */
	it("returns every record for an empty or whitespace query", () => {
		const records = seed();

		expect(filterLogRecords({ records, filter: NO_FILTER })).toHaveLength(4);
		expect(filterLogRecords({ records, filter: { ...NO_FILTER, text: "   " } })).toHaveLength(4);
	});

	/**
	 * A QUERY THAT HITS NOTHING RETURNS NOTHING. The empty result is a real answer, and the
	 * alternative failure, falling back to the full list when nothing matches, would tell the
	 * operator that a credential was used somewhere it never was.
	 */
	it("returns no records when the query hits neither tool nor command", () => {
		const shown = filterLogRecords({ records: seed(), filter: { ...NO_FILTER, text: "kubectl" } });

		expect(shown).toHaveLength(0);
	});

	/**
	 * REGRESSION: the SECRETS column was not searched. The Log view paints WHEN, TOOL, SECRETS and
	 * WHERE, and the free-text filter read TOOL and WHERE only. That is not a redundancy: the
	 * writer bounds a record's command independently of its placeholder list, so a command cut at
	 * `MAX_COMMAND_CHARS` still carries the full `secrets` array. Typing `GITHUB` then answered
	 * `No recorded use matches "GITHUB".` while `#GITHUB_TOKEN#` was on the row in front of the
	 * operator, which reads as a log that lost the record rather than as a search that cannot see
	 * the column. If this regresses, the credential a search is run to find becomes the one thing
	 * the search cannot find it by.
	 */
	it("matches a placeholder that survives in the SECRETS cell after the command was cut", () => {
		const cut = record({
			at: T0 + 4000,
			tool: "bash",
			command: "…dev/null 2>&1 && echo done",
			secrets: ["#GITHUB_TOKEN#"],
			truncated: true,
		});
		const records = [...seed(), cut];

		// The bare name, as an operator reading the column would type it.
		expect(filterLogRecords({ records, filter: { ...NO_FILTER, text: "GITHUB" } }).map(entry => entry.at)).toEqual([
			T0,
			T0 + 1000,
			T0 + 3000,
			T0 + 4000,
		]);
		// The whole placeholder, as it is painted.
		expect(
			filterLogRecords({ records, filter: { ...NO_FILTER, text: "#github_token#" } }).map(entry => entry.at),
		).toEqual([T0, T0 + 1000, T0 + 3000, T0 + 4000]);
		// And a credential no record spent still matches nothing, so this widened the haystack
		// rather than loosening the test.
		expect(filterLogRecords({ records, filter: { ...NO_FILTER, text: "#STRIPE_KEY#" } })).toHaveLength(0);
	});

	/**
	 * The three columns compose under one query rather than one shadowing the others: a record is
	 * shown when the text is in its tool, its command OR its placeholders. Asserting each source
	 * in isolation would pass an implementation that replaced the command match with the secrets
	 * match instead of adding to it.
	 */
	it("keeps tool and command searchable now that the placeholders are too", () => {
		const records = seed();

		expect(filterLogRecords({ records, filter: { ...NO_FILTER, text: "ssh" } }).map(entry => entry.at)).toEqual([
			T0 + 2000,
		]);
		expect(filterLogRecords({ records, filter: { ...NO_FILTER, text: "rsync" } }).map(entry => entry.at)).toEqual([
			T0 + 3000,
		]);
		expect(
			filterLogRecords({ records, filter: { ...NO_FILTER, text: "deploy_key" } }).map(entry => entry.at),
		).toEqual([T0 + 2000, T0 + 3000]);
	});

	/**
	 * THE ORDER IS THE LOG'S ORDER. The table reads "most recent last" off the input order, so a
	 * filter that sorted, reversed, or grouped would silently redefine which row is the latest use.
	 *
	 * The records are handed over newest first, which no sort by timestamp would produce, so a
	 * comparator sneaking into the filter cannot pass this.
	 */
	it("preserves the input ordering rather than sorting by time", () => {
		const records = seed().reverse();
		const shown = filterLogRecords({ records, filter: { ...NO_FILTER, text: "s" } });

		expect(shown.map(entry => entry.at)).toEqual([T0 + 3000, T0 + 2000, T0 + 1000, T0]);
	});
});

describe("the log filter narrows by placeholder", () => {
	/**
	 * THE FULL `#NAME#` FORM IS WHAT IS STORED. The writer captures the whole regex match, so
	 * `secrets` holds `#GITHUB_TOKEN#`. Compare against a bare `GITHUB_TOKEN` and the join returns
	 * zero for every credential in the vault while still looking like a working filter.
	 */
	it("matches the full hashed placeholder as stored", () => {
		const shown = filterLogRecords({
			records: seed(),
			filter: { ...NO_FILTER, placeholder: "#GITHUB_TOKEN#" },
		});

		expect(shown.map(entry => entry.at)).toEqual([T0, T0 + 1000, T0 + 3000]);
	});

	/**
	 * THE UNHASHED NAME IS NOT THE PLACEHOLDER. This is the mirror of the case above and the one
	 * that fails loudly if the comparison is ever relaxed to a substring or a stripped compare:
	 * `GITHUB_TOKEN` is a name, not something the log ever recorded spending.
	 */
	it("does not match a bare name without its hashes", () => {
		const shown = filterLogRecords({
			records: seed(),
			filter: { ...NO_FILTER, placeholder: "GITHUB_TOKEN" },
		});

		expect(shown).toHaveLength(0);
	});

	/**
	 * THE RESTRICTION IS EXACT, NOT A PREFIX. `#GITHUB#` must not sweep up `#GITHUB_TOKEN#`.
	 * A prefix or substring compare would answer "where was this credential spent" with another
	 * credential's history, which is the one wrong answer this whole view exists to avoid.
	 */
	it("does not match a placeholder that merely shares a prefix", () => {
		const records = [...seed(), record({ at: T0 + 4000, secrets: ["#GITHUB#"], tool: "curl" })];
		const shown = filterLogRecords({
			records,
			filter: { ...NO_FILTER, placeholder: "#GITHUB#" },
		});

		expect(shown.map(entry => entry.at)).toEqual([T0 + 4000]);
	});

	/**
	 * AN OMISSION IS NOT EVIDENCE. `omittedSecrets` says the record spent placeholders it did not
	 * name. It might have spent this one. "Might" is not a use: counting it would put a record in
	 * front of an operator as proof that a credential they are about to revoke was spent there,
	 * when the record contains nothing of the kind.
	 */
	it("does not match a record whose only possible hit is among its omitted placeholders", () => {
		const records = [
			record({ at: T0, secrets: ["#OTHER#"], omittedSecrets: 4, tool: "bash" }),
			record({ at: T0 + 1000, secrets: ["#OTHER#", "#DEPLOY_KEY#"], omittedSecrets: 2 }),
		];
		const shown = filterLogRecords({
			records,
			filter: { ...NO_FILTER, placeholder: "#DEPLOY_KEY#" },
		});

		expect(shown.map(entry => entry.at)).toEqual([T0 + 1000]);
	});

	/**
	 * A CLEARED RESTRICTION IS NOT A RESTRICTION THAT MATCHES NOTHING. `undefined` and `""` both
	 * mean the operator is not restricting by credential. Treat `""` as a placeholder to find and
	 * the list empties the instant the field is cleared.
	 */
	it("returns every record when the placeholder is undefined or empty", () => {
		const records = seed();

		expect(filterLogRecords({ records, filter: NO_FILTER })).toHaveLength(4);
		expect(filterLogRecords({ records, filter: { ...NO_FILTER, placeholder: "" } })).toHaveLength(4);
	});
});

describe("the log filter's fields are ANDed", () => {
	/**
	 * BOTH FIELDS MUST HOLD. Ored fields would widen the list every time the operator added a
	 * constraint, which is the opposite of what typing into a filter means. The seed is built so
	 * each field alone returns strictly more than the pair does, so an OR bug cannot pass.
	 */
	it("returns only records satisfying the text and the placeholder together", () => {
		const records = seed();
		const filter: LogFilter = { text: "bash", placeholder: "#GITHUB_TOKEN#" };

		expect(filterLogRecords({ records, filter: { ...NO_FILTER, text: "bash" } })).toHaveLength(2);
		expect(filterLogRecords({ records, filter: { ...NO_FILTER, placeholder: "#GITHUB_TOKEN#" } })).toHaveLength(3);
		expect(filterLogRecords({ records, filter }).map(entry => entry.at)).toEqual([T0, T0 + 3000]);
	});

	/**
	 * AN IMPOSSIBLE COMBINATION IS EMPTY. Each field matches something on its own here, so a
	 * result of zero can only come from the conjunction being applied.
	 */
	it("returns nothing when the two fields cannot both hold", () => {
		const shown = filterLogRecords({
			records: seed(),
			filter: { text: "rsync", placeholder: "#OTHER#" },
		});

		expect(shown).toHaveLength(0);
	});
});

describe("usage stats join a credential to where it was spent", () => {
	/**
	 * AN UNUSED CREDENTIAL IS AN ANSWER, NOT AN ERROR. Most stored credentials have never been
	 * spent, so the detail panel asks this for entries with no records at all. Reading `[0].at` off
	 * an empty list throws and takes the whole card down while the operator is browsing.
	 */
	it("reports zero uses and a null timestamp for a placeholder that never appears", () => {
		const stats = usageStatsFor("#UNUSED#", seed());

		expect(stats.useCount).toBe(0);
		expect(stats.lastUsedAt).toBeNull();
		expect(stats.tools).toEqual([]);
	});

	/** An empty log is the same answer, and is what a fresh profile always has. */
	it("reports zero uses against an empty log", () => {
		const stats = usageStatsFor("#GITHUB_TOKEN#", []);

		expect(stats.useCount).toBe(0);
		expect(stats.lastUsedAt).toBeNull();
		expect(stats.tools).toEqual([]);
	});

	/**
	 * THE COUNT AND THE TIMESTAMP ARE THE HEADLINE. "Used 3 times, last 2 seconds ago" is the whole
	 * reason to open the panel. The timestamp is the MAXIMUM, not the last record read: the log is
	 * appended newest-last but a caller may hand over any slice in any order.
	 */
	it("counts every use and reports the most recent timestamp", () => {
		const stats = usageStatsFor("#GITHUB_TOKEN#", seed());

		expect(stats.useCount).toBe(3);
		expect(stats.lastUsedAt).toBe(T0 + 3000);
	});

	/** Order of the records handed in must not change the answer. */
	it("finds the latest use even when the records arrive newest first", () => {
		const stats = usageStatsFor("#GITHUB_TOKEN#", seed().reverse());

		expect(stats.useCount).toBe(3);
		expect(stats.lastUsedAt).toBe(T0 + 3000);
	});

	/**
	 * TOOLS ARE DEDUPLICATED AND RUN MOST RECENT FIRST. Undeduplicated, a credential used two
	 * hundred times through `bash` renders as `bash, bash, bash, ...` and the one interesting tool
	 * at the end is off the edge of the panel. Recency order is what puts the tool that just spent
	 * it in front. The seed uses `bash` both first and last, so a naive first-seen order yields
	 * `bash, fetch` and only a recency order yields `bash` from the LAST record.
	 */
	it("lists distinct tools most recent first", () => {
		const records = [
			record({ at: T0, tool: "bash" }),
			record({ at: T0 + 1000, tool: "fetch" }),
			record({ at: T0 + 2000, tool: "fetch" }),
			record({ at: T0 + 3000, tool: "ssh" }),
		];

		expect(usageStatsFor("#GITHUB_TOKEN#", records).tools).toEqual(["ssh", "fetch", "bash"]);
	});

	/**
	 * TOOLS FROM RECORDS THAT DID NOT SPEND IT ARE NOT LISTED. The join is per placeholder, and a
	 * tool list that leaked in every tool in the log would name tools the credential never reached.
	 */
	it("names only the tools that received this placeholder", () => {
		expect(usageStatsFor("#DEPLOY_KEY#", seed()).tools).toEqual(["bash", "ssh"]);
	});

	/**
	 * THE OMISSION RULE HOLDS HERE TOO. Stats and the filter must agree: if a record with
	 * `omittedSecrets` counted as a use, the panel's count would exceed the number of rows the
	 * filter can show, and the operator would go looking for a use that cannot be displayed.
	 */
	it("does not count a record whose match could only be among its omitted placeholders", () => {
		const records = [
			record({ at: T0, secrets: ["#OTHER#"], omittedSecrets: 3, tool: "ssh" }),
			record({ at: T0 + 1000, secrets: ["#GITHUB_TOKEN#"], omittedSecrets: 1, tool: "bash" }),
		];
		const stats = usageStatsFor("#GITHUB_TOKEN#", records);

		expect(stats.useCount).toBe(1);
		expect(stats.lastUsedAt).toBe(T0 + 1000);
		expect(stats.tools).toEqual(["bash"]);
	});

	/**
	 * TIES KEEP THE LOG'S ORDER. Two expansions inside one millisecond are ordinary for a tool
	 * that fans out, and an unstable comparator would make the tool list flicker between renders
	 * of identical data.
	 */
	it("keeps the log's order for uses sharing a timestamp", () => {
		const records = [record({ at: T0, tool: "first" }), record({ at: T0, tool: "second" })];

		expect(usageStatsFor("#GITHUB_TOKEN#", records).tools).toEqual(["first", "second"]);
	});

	/** A blank placeholder is not a credential, so it joins to nothing rather than to everything. */
	it("reports zero uses for a blank placeholder", () => {
		const stats = usageStatsFor("   ", seed());

		expect(stats.useCount).toBe(0);
		expect(stats.lastUsedAt).toBeNull();
	});
});

describe("the narrowed list says that it is narrowed", () => {
	/**
	 * SILENCE WHEN NOTHING IS FILTERED. The caption costs a row, and a permanent "showing 20 of 20"
	 * trains the operator to stop reading the line that matters when it is not.
	 */
	it("returns undefined when no field is set", () => {
		expect(describeLogFilter(NO_FILTER, 20, 20)).toBeUndefined();
		expect(describeLogFilter({ text: "  ", placeholder: "" }, 20, 20)).toBeUndefined();
	});

	/**
	 * THE QUERY IS QUOTED BACK. Naming the filter is the point: an operator who forgot a leftover
	 * query and sees an empty list concludes the credential was never used. The counts have to be
	 * both numbers, because "3 uses" alone does not say that seventeen are hidden.
	 */
	it("names the free-text query and both counts", () => {
		expect(describeLogFilter({ text: "curl", placeholder: undefined }, 3, 20)).toBe(
			'Showing 3 of 20 uses matching "curl".',
		);
	});

	/** The credential is named in the full form the operator sees in the table. */
	it("names the placeholder restriction", () => {
		expect(describeLogFilter({ text: "", placeholder: "#GITHUB_TOKEN#" }, 2, 9)).toBe(
			"Showing 2 of 9 uses of #GITHUB_TOKEN#.",
		);
	});

	/** With both fields set the line names both, so neither constraint can be the forgotten one. */
	it("names both fields when both are set", () => {
		expect(describeLogFilter({ text: "curl", placeholder: "#GITHUB_TOKEN#" }, 1, 9)).toBe(
			'Showing 1 of 9 uses of #GITHUB_TOKEN# matching "curl".',
		);
	});

	/**
	 * ZERO SHOWN IS EXACTLY WHEN THE LINE MATTERS MOST. An empty body with no caption is the
	 * screen that reads as "this credential was never used", and it is the one this line exists
	 * to prevent from being believed.
	 */
	it("still describes the filter when nothing matched", () => {
		expect(describeLogFilter({ text: "kubectl", placeholder: undefined }, 0, 20)).toBe(
			'Showing 0 of 20 uses matching "kubectl".',
		);
	});

	/** A one-record log gets a singular noun rather than "1 of 1 uses". */
	it("uses the singular noun for a log holding one record", () => {
		expect(describeLogFilter({ text: "curl", placeholder: undefined }, 0, 1)).toBe(
			'Showing 0 of 1 use matching "curl".',
		);
	});

	/** The query is echoed as typed, not lower-cased, so the line matches the field above it. */
	it("echoes the query in the case the operator typed", () => {
		expect(describeLogFilter({ text: "  CURL  ", placeholder: undefined }, 3, 20)).toBe(
			'Showing 3 of 20 uses matching "CURL".',
		);
	});
});

describe("nothing in the shaping surface can carry a secret value", () => {
	/**
	 * NO VALUES, EVER. A record carries placeholders, a tool and a command, and this module returns
	 * only those. The guard is here so a future field added to the record, or a caption that
	 * decided to be helpful, has to break a test before it can print a credential to the terminal.
	 */
	it("returns records unchanged and a caption built only from placeholders and the query", () => {
		const records = seed();
		const filter: LogFilter = { text: "curl", placeholder: "#GITHUB_TOKEN#" };
		const shown = filterLogRecords({ records, filter });
		const caption = describeLogFilter(filter, shown.length, records.length);

		expect(shown[0]).toBe(records[0]);
		expect(caption).toBe('Showing 1 of 4 uses of #GITHUB_TOKEN# matching "curl".');
		expect(usageStatsFor("#GITHUB_TOKEN#", records).tools).toEqual(["bash", "fetch"]);
	});
});
