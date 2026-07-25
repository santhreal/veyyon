/**
 * The version picker's behaviour, asserted on real renders and real keystrokes.
 *
 * A picker that installs software is the one place where "looks right" is not
 * good enough: the failure is not a misdrawn row, it is moving the install to a
 * version the operator did not choose. So the tests assert the exact version
 * handed to the callback, the exact URL handed to the browser, and the exact
 * text drawn for each marker.
 *
 * Two behaviours here exist only because of how the underlying list works, and
 * would regress silently without a test:
 *
 *   - `c` must be intercepted BEFORE the list sees it. `SelectList` treats a
 *     printable character as a filter keystroke, so an unintercepted `c` would
 *     quietly start filtering rather than opening a changelog, and the only
 *     symptom would be a list that shrank.
 *   - Selecting the running version must not install anything. It is drawn as
 *     `current`, so raising an installer error for it would be the picker
 *     contradicting its own row.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { RollbackRow } from "@veyyon/coding-agent/cli/rollback-cli";
import { buildRollbackRows, formatRollbackList, rollbackMarkers } from "@veyyon/coding-agent/cli/rollback-cli";
import {
	CHANGELOG_KEY,
	describeRollbackRow,
	RollbackPickerComponent,
	rollbackSelectItems,
} from "@veyyon/coding-agent/modes/components/rollback-picker";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

const ROWS: RollbackRow[] = buildRollbackRows(
	[
		{ tag: "v1.3.0", version: "1.3.0", publishedAt: "2026-07-01T00:00:00Z" },
		{ tag: "v1.2.0", version: "1.2.0", publishedAt: "2026-06-01T00:00:00Z" },
		{ tag: "v1.1.0", version: "1.1.0", publishedAt: "2026-05-01T00:00:00Z" },
	],
	"1.2.0",
	[{ from: "1.1.0", to: "1.2.0", at: "2026-06-02T00:00:00Z" }],
);

interface Harness {
	picker: RollbackPickerComponent;
	selected: string[];
	opened: string[];
	cancels: number;
}

function harness(rows: readonly RollbackRow[] = ROWS): Harness {
	const selected: string[] = [];
	const opened: string[] = [];
	const state = { cancels: 0 };
	const picker = new RollbackPickerComponent(rows, {
		onSelect: version => selected.push(version),
		onCancel: () => {
			state.cancels++;
		},
		openUrl: url => opened.push(url),
	});
	return {
		picker,
		selected,
		opened,
		get cancels() {
			return state.cancels;
		},
	} as Harness;
}

describe("describeRollbackRow", () => {
	it("dates the release, since recency is half the decision", () => {
		expect(describeRollbackRow(ROWS[1] as RollbackRow)).toContain("2026-06-01");
	});

	it("marks the running version", () => {
		expect(describeRollbackRow(ROWS[1] as RollbackRow)).toContain("current");
	});

	it("marks a newer version as a move forward, not as a rollback", () => {
		const description = describeRollbackRow(ROWS[0] as RollbackRow);

		expect(description).toContain("newer");
		expect(description).not.toContain("current");
	});

	it("marks a version this machine has run before", () => {
		// Usually the exact row somebody is hunting for: "the one that worked".
		expect(describeRollbackRow(ROWS[2] as RollbackRow)).toContain("previously run");
	});

	it("never calls the running version previously run, which would be noise", () => {
		expect(describeRollbackRow(ROWS[1] as RollbackRow)).not.toContain("previously run");
	});

	it("omits the date rather than the row when there is no timestamp", () => {
		const row = buildRollbackRows([{ tag: "v1.0.0", version: "1.0.0" }], "1.2.0")[0] as RollbackRow;

		expect(describeRollbackRow(row)).toBe("");
	});
});

describe("the picker and `rollback --list` agree", () => {
	// The two surfaces used to compute the markers separately, which is how a
	// list and a picker end up disagreeing about which version is current. Each
	// one is self-consistent, so nothing short of comparing them catches it.
	it("shows the same markers for every row, in the same order", () => {
		const listing = formatRollbackList(ROWS);
		for (const row of ROWS) {
			const markers = rollbackMarkers(row);
			const description = describeRollbackRow(row);
			for (const marker of markers) {
				expect(description, `picker omits "${marker}" for ${row.version}`).toContain(marker);
				expect(listing, `listing omits "${marker}" for ${row.version}`).toContain(marker);
			}
		}
	});

	it("marks exactly one row current on both surfaces", () => {
		// Two current rows, or none, is the specific corruption the shared owner
		// exists to make impossible.
		expect(ROWS.filter(row => rollbackMarkers(row).includes("current")).length).toBe(1);
		expect(formatRollbackList(ROWS).match(/current/g)?.length).toBe(1);
	});

	it("shows the same publish date on both surfaces", () => {
		expect(describeRollbackRow(ROWS[2] as RollbackRow)).toContain("2026-05-01");
		expect(formatRollbackList(ROWS)).toContain("2026-05-01");
	});
});

describe("the rows the list is given", () => {
	it("keeps the running version in the list rather than hiding it", () => {
		// Removing it would leave the list unanchored, and its absence reads as the
		// version having been unpublished.
		expect(rollbackSelectItems(ROWS).map(item => item.value)).toEqual(["1.3.0", "1.2.0", "1.1.0"]);
	});

	it("labels each row with its bare version", () => {
		expect(rollbackSelectItems(ROWS)[0]).toMatchObject({ value: "1.3.0", label: "1.3.0" });
	});
});

describe("choosing a version", () => {
	it("hands the installer exactly the highlighted version", () => {
		const h = harness();
		// Opens on the current version (1.2.0); one row down is 1.1.0.
		h.picker.handleInput("\x1b[B");
		h.picker.handleInput("\r");

		expect(h.selected).toEqual(["1.1.0"]);
	});

	it("does not install when the running version is chosen", () => {
		// It is drawn as `current`; installing it would contradict the row, and
		// `rollbackToVersion` would refuse it anyway.
		const h = harness();
		h.picker.handleInput("\r");

		expect(h.selected).toEqual([]);
	});

	it("closes rather than erroring when the running version is chosen", () => {
		const h = harness();
		h.picker.handleInput("\r");

		expect(h.cancels).toBe(1);
	});
});

describe("the per-row changelog key", () => {
	it("opens the highlighted version's changelog", () => {
		const h = harness();
		h.picker.handleInput(CHANGELOG_KEY);

		expect(h.opened).toEqual(["https://veyyon.dev/changelog#v1-2-0"]);
	});

	it("follows the cursor rather than opening a fixed page", () => {
		const h = harness();
		h.picker.handleInput("\x1b[B");
		h.picker.handleInput(CHANGELOG_KEY);

		expect(h.opened).toEqual(["https://veyyon.dev/changelog#v1-1-0"]);
	});

	it("does not leak the keypress into the filter", () => {
		// The whole reason it is intercepted: an unintercepted `c` filters the list
		// down to versions containing "c", which is none of them, and the only
		// symptom is a list that mysteriously emptied.
		const h = harness();
		h.picker.handleInput(CHANGELOG_KEY);

		expect(h.picker.selectedRow()?.version).toBe("1.2.0");
	});

	it("installs nothing", () => {
		const h = harness();
		h.picker.handleInput(CHANGELOG_KEY);

		expect(h.selected).toEqual([]);
	});
});

describe("rendering", () => {
	it("draws every version with its markers", () => {
		const rendered = harness().picker.render(80).join("\n");

		for (const expected of ["1.3.0", "1.2.0", "1.1.0", "current", "newer", "previously run"]) {
			expect(rendered).toContain(expected);
		}
	});

	it("starts on the running version, so the neighbours are the real choices", () => {
		expect(harness().picker.selectedRow()?.version).toBe("1.2.0");
	});

	it("says a version change takes effect on restart, in the title", () => {
		// Without it, the obvious reading of a picker that closes cleanly is that
		// the running process is now the version you picked. It is in the title
		// rather than among the tips because the tips rotate, and a caveat shown
		// one launch in three is not a caveat.
		const rendered = harness().picker.render(80).join("\n");

		expect(rendered).toContain("takes effect on restart");
	});

	it("filters to the typed query", () => {
		const h = harness();
		h.picker.getSelectList().setFilter("1.1");

		expect(h.picker.render(80).join("\n")).not.toContain("1.3.0");
	});

	it("reports no row when a filter matches nothing, rather than a stale one", () => {
		// A stale selection here would install a version that is not on screen.
		const h = harness();
		h.picker.getSelectList().setFilter("9.9.9");

		expect(h.picker.selectedRow()).toBeNull();
	});
});
