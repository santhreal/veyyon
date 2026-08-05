/**
 * The Secrets card's detail panel.
 *
 * WHY THIS SUITE EXISTS. This pane is the only surface in the product that shows `createdAt`, and
 * the only one that joins the expansion log back to the roster, so every field it prints is a
 * field no other test can catch a regression in. It is also a panel that holds a `ScopedVaultEntry`
 * (value and all) and must never print the value, which is a property that has to be asserted
 * rather than assumed.
 *
 * Each test below names one defect and locks it out. They assert exact painted strings against a
 * frozen clock, because every defect this pane can have is visible: a wrong label column, a `0`
 * where a sentence belongs, an expired secret that looks live, or a panel that grows past its
 * width are all things you can only see by reading the bytes that reach the terminal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SecretDetailPane } from "@veyyon/coding-agent/modes/components/secret-detail-pane";
import type { ManagerRow, SecretUsageStats } from "@veyyon/coding-agent/modes/components/secret-manager-types";
import { getThemeByName, setThemeInstance, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ScopedVaultEntry } from "@veyyon/coding-agent/secrets/vault";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

const WIDTH = 60;

/** Frozen so "3d ago" and "5d left" are constants in the assertions, not functions of the wall clock. */
const NOW = Date.parse("2026-07-31T12:00:00Z");

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The value this pane must never print. Distinctive so a substring search cannot match by luck. */
const SECRET_VALUE = "ghp_zzq7ThisIsTheRawCredentialAndMustNeverBeShown";

const now = () => NOW;

/**
 * Colour is forced on for this file. The default policy under `bun test` is `plain`, which makes
 * `theme.fg` the identity function and would turn the expired-versus-live colour assertion into a
 * comparison of two identical strings that passes no matter what the pane paints.
 */
let priorPolicy: AnsiPolicy;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
	priorPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(priorPolicy);
});

function entryOf(overrides: Partial<ScopedVaultEntry> = {}): ScopedVaultEntry {
	return {
		name: "GITHUB_TOKEN",
		value: SECRET_VALUE,
		scope: "project",
		createdAt: NOW - 3 * DAY,
		expiresAt: NOW + 5 * DAY,
		...overrides,
	};
}

function secretRow(overrides: Partial<ScopedVaultEntry> = {}): ManagerRow {
	return { kind: "secret", entry: entryOf(overrides) };
}

function usageOf(overrides: Partial<SecretUsageStats> = {}): SecretUsageStats {
	return { useCount: 4, lastUsedAt: NOW - 2 * HOUR, tools: ["bash", "fetch"], ...overrides };
}

/** Rendered rows with colour removed, so a test can name the text a row is supposed to hold. */
function plain(row: ManagerRow, usage: SecretUsageStats = usageOf(), width = WIDTH): string[] {
	return new SecretDetailPane(row, usage, now).render(width).map(line => stripAnsi(line).trimEnd());
}

describe("SecretDetailPane fields", () => {
	/**
	 * Locks out a panel that drops or misspells a field.
	 *
	 * Every one of these seven rows exists because the table above has no room for it, and
	 * `createdAt` in particular appears nowhere else in the product. Asserting the whole panel as
	 * one exact list means a silently removed row, a relabelled row, or a reordered panel fails
	 * here rather than being noticed by an operator months later.
	 */
	it("renders every known field with its exact label and text", () => {
		expect(plain(secretRow())).toEqual([
			"  placeholder  #GITHUB_TOKEN#",
			"  scope        project",
			"  added        3d ago",
			"  expires      5d left",
			"  used         4 times",
			"  last used    2h ago",
			"  tools        bash, fetch",
		]);
	});

	/**
	 * Locks out a label column that is measured from the rows currently showing.
	 *
	 * If the width were derived from the visible labels, the broken-row panel (whose longest label
	 * is "status") would indent its values differently from the secret panel, and moving the
	 * selection between the two kinds would shake the values sideways. The column is pinned to the
	 * longest label in the whole set, so every value starts in the same cell in both branches.
	 */
	it("starts every value in the same column for both row kinds", () => {
		const secret = plain(secretRow());
		const broken = plain({ kind: "broken", scope: "global", reason: "This vault file would not parse." });
		const columnOf = (line: string) => line.indexOf(line.trim().split(/\s{2,}/)[1] ?? "");
		expect(secret.map(columnOf)).toEqual([15, 15, 15, 15, 15, 15, 15]);
		expect(columnOf(broken[0])).toBe(15);
		expect(columnOf(broken[1])).toBe(15);
	});

	/**
	 * Locks out a singular count printed as "1 times".
	 *
	 * The count is the field an operator reads to decide whether a credential is still in use, and
	 * a panel that cannot count to one reads as a panel that computed the number wrong.
	 */
	it("says '1 time' rather than '1 times' for a single use", () => {
		const lines = plain(secretRow(), usageOf({ useCount: 1, tools: ["bash"] }));
		expect(lines[4]).toBe("  used         1 time");
	});
});

describe("SecretDetailPane never-used wording", () => {
	/**
	 * Locks out `used 0` beside an empty tools row.
	 *
	 * A zero next to a blank list reads as a panel that failed to load the expansion log, not as
	 * the fact that the secret has never been spent. The three rows collapse to one sentence, so
	 * there is no blank left to misread.
	 */
	it("collapses an unused secret to a single 'not used yet' row", () => {
		const lines = plain(secretRow(), { useCount: 0, lastUsedAt: null, tools: [] });
		expect(lines).toEqual([
			"  placeholder  #GITHUB_TOKEN#",
			"  scope        project",
			"  added        3d ago",
			"  expires      5d left",
			"  used         not used yet",
		]);
		expect(lines.join("\n")).not.toContain("last used");
		expect(lines.join("\n")).not.toContain("tools");
	});

	/**
	 * Locks out a negative use count sneaking past a `=== 0` test.
	 *
	 * The count is joined from a log file the card does not own. A miscount that produced a
	 * negative would otherwise print "-2 times", which is worse than saying nothing.
	 */
	it("treats a negative use count as never used", () => {
		const lines = plain(secretRow(), { useCount: -2, lastUsedAt: null, tools: [] });
		expect(lines[4]).toBe("  used         not used yet");
		expect(lines).toHaveLength(5);
	});

	/**
	 * Locks out "just now" being printed for a timestamp that does not exist.
	 *
	 * A truncated or hand-edited log can count uses while losing the newest instant. Passing a
	 * `null` last-use through `describeAgo` would render `now - null`, which is `now`, and print
	 * the confident lie "just now" about an unknown time.
	 */
	it("names an unknown last use rather than dating it from zero", () => {
		const lines = plain(secretRow(), { useCount: 3, lastUsedAt: null, tools: ["bash"] });
		expect(lines[5]).toBe("  last used    unknown");
	});

	/**
	 * Locks out a blank tools row when the log counted uses but kept no tool names.
	 *
	 * A row with a label and nothing after it looks like a rendering fault; "none recorded" says
	 * the log is the thing that is missing information.
	 */
	it("names an empty tool list when uses were counted", () => {
		const lines = plain(secretRow(), { useCount: 2, lastUsedAt: NOW - HOUR, tools: [] });
		expect(lines[6]).toBe("  tools        none recorded");
	});
});

describe("SecretDetailPane expiry", () => {
	/**
	 * Locks out an expired secret that looks exactly like a live one.
	 *
	 * Finding out why a placeholder stopped expanding is the most common reason to open this
	 * panel, so the answer has to be visible before the words are read. The live row is dim and
	 * the expired row is the error colour; asserting the coloured substrings proves the two rows
	 * do not paint the same bytes.
	 */
	it("paints an expired entry in the error colour and a live one dim", () => {
		const live = new SecretDetailPane(secretRow(), usageOf(), now).render(WIDTH);
		const dead = new SecretDetailPane(secretRow({ expiresAt: NOW - DAY }), usageOf(), now).render(WIDTH);
		expect(live[3]).toContain(theme.fg("dim", "5d left"));
		expect(dead[3]).toContain(theme.fg("error", "expired"));
		expect(dead[3]).not.toContain(theme.fg("dim", "expired"));
		expect(stripAnsi(dead[3]).trimEnd()).toBe("  expires      expired");
	});

	/**
	 * Locks out a `null` expiry rendered as a date, a dash, or the string "null".
	 *
	 * `expiresAt: null` means the secret never expires, and the phrasing has to come from
	 * `describeTimeLeft` so this panel and the `/secret` command cannot disagree about it.
	 */
	it("says 'never expires' for an entry with no expiry", () => {
		const lines = plain(secretRow({ expiresAt: null }));
		expect(lines[3]).toBe("  expires      never expires");
	});

	/**
	 * Locks out an expiry exactly on the clock reading as time remaining.
	 *
	 * A secret whose expiry equals `now` is spent. Rounding it up to "0m left" would tell the
	 * operator to keep waiting for something that has already stopped working.
	 */
	it("treats an expiry landing exactly on now as expired", () => {
		const lines = plain(secretRow({ expiresAt: NOW }));
		expect(lines[3]).toBe("  expires      expired");
	});

	/**
	 * Locks out a clock read once at construction.
	 *
	 * `now` is a function so the panel ages with the card. If the constructor captured the value,
	 * a card left open would keep insisting a long-dead credential has days left.
	 */
	it("reads the clock on every render rather than at construction", () => {
		let clock = NOW;
		const pane = new SecretDetailPane(secretRow(), usageOf(), () => clock);
		expect(stripAnsi(pane.render(WIDTH)[3]).trimEnd()).toBe("  expires      5d left");
		clock = NOW + 10 * DAY;
		expect(stripAnsi(pane.render(WIDTH)[3]).trimEnd()).toBe("  expires      expired");
	});
});

describe("SecretDetailPane broken rows", () => {
	/**
	 * Locks out a broken vault file rendered as an empty secret.
	 *
	 * A skeleton of placeholder and expiry rows with nothing in them would suggest the entry
	 * exists and is blank. What the operator needs instead is the reason and the repair, so the
	 * branch replaces the field list rather than padding it.
	 */
	it("renders the repair explanation instead of empty secret fields", () => {
		const lines = plain({
			kind: "broken",
			scope: "profile",
			reason: "This vault file would not parse.",
		});
		expect(lines).toEqual([
			"  scope        profile",
			"  status       vault unreadable",
			"  repair       This vault file would not parse.",
		]);
	});

	/**
	 * Locks out a repair sentence clipped at the panel edge.
	 *
	 * The reason is prose the operator has to act on, so cutting it in half destroys the only
	 * thing the branch exists to deliver. It wraps under the value column instead, and the
	 * continuation rows line up with the first so the sentence reads as one block.
	 */
	it("wraps a long repair sentence under the value column", () => {
		const reason =
			"This vault file decrypted but its contents would not parse, so the secrets it holds are unavailable.";
		const lines = plain({ kind: "broken", scope: "global", reason });
		expect(lines).toEqual([
			"  scope        global",
			"  status       vault unreadable",
			"  repair       This vault file decrypted but its contents",
			"               would not parse, so the secrets it holds are",
			"               unavailable.",
		]);
		// The wrapped rows must reconstitute the sentence exactly, so a wrap that ate a word or a
		// space fails here even though the row list above would still look plausible.
		expect(
			lines
				.slice(2)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim()
				.replace(/^repair /, ""),
		).toBe(reason);
	});

	/**
	 * Locks out a throw or a stray row when the reason is empty.
	 *
	 * Nothing guarantees the container has a sentence to hand over. An empty reason must still
	 * produce exactly one labelled row, because the wrap of an empty string is an empty list.
	 */
	it("renders one empty repair row for a reason with no text", () => {
		const lines = plain({ kind: "broken", scope: "project", reason: "" });
		expect(lines).toEqual(["  scope        project", "  status       vault unreadable", "  repair"]);
	});
});

describe("SecretDetailPane width handling", () => {
	/**
	 * Locks out a panel that grows wider than the card it sits in.
	 *
	 * A long tool list is the field most likely to overflow, and one row wider than `width` shears
	 * every row below it on a real terminal. Truncation with an ellipsis keeps the row inside the
	 * panel and still says the list continues.
	 */
	it("truncates a long tool list to the given width", () => {
		const tools = ["bash", "fetch", "write", "browser", "launch", "eval", "glob"];
		const lines = new SecretDetailPane(secretRow(), usageOf({ tools }), now).render(34);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		expect(stripAnsi(lines[6])).toBe("  tools        bash, fetch, write…");
	});

	/**
	 * Locks out a long placeholder pushing the panel open.
	 *
	 * Names run to sixty-four characters, which is wider than a narrow card. The placeholder row
	 * is truncated on the same rule as every other value.
	 */
	it("truncates a maximum-length placeholder to the given width", () => {
		const name = "A".repeat(64);
		const lines = new SecretDetailPane(secretRow({ name }), usageOf(), now).render(30);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(stripAnsi(lines[0])).toBe("  placeholder  #AAAAAAAAAAAAA…");
	});

	/**
	 * Locks out negative padding arithmetic at a width narrower than the label column.
	 *
	 * `width - VALUE_OFFSET` goes negative long before the width reaches zero. Handing a negative
	 * to a padding or wrap helper is how a pane throws during a live resize, which takes the whole
	 * card down rather than just clipping a row.
	 */
	it("clips every row to a single cell at width 1 rather than throwing", () => {
		const secret = new SecretDetailPane(secretRow(), usageOf(), now).render(1);
		expect(secret.map(stripAnsi)).toEqual(["…", "…", "…", "…", "…", "…", "…"]);
		const broken = new SecretDetailPane(
			{ kind: "broken", scope: "global", reason: "This vault file would not parse." },
			usageOf(),
			now,
		).render(1);
		expect(broken.map(stripAnsi)).toEqual(["…", "…", "…"]);
	});

	/**
	 * Locks out a throw at width 0, which a card reaches mid-resize before the layout settles.
	 *
	 * The row count is asserted too: a pane that collapsed to zero rows at zero width would make
	 * the card jump in height on every resize tick.
	 */
	it("emits one empty row per field at width 0", () => {
		const lines = new SecretDetailPane(secretRow(), usageOf(), now).render(0);
		expect(lines.map(stripAnsi)).toEqual(["", "", "", "", "", "", ""]);
		for (const line of lines) expect(visibleWidth(line)).toBe(0);
	});
});

describe("SecretDetailPane value secrecy", () => {
	/**
	 * Locks out the one defect this component could ship that actually leaks a credential.
	 *
	 * The pane holds a whole `ScopedVaultEntry`, so `value` is one property access away from every
	 * row it draws. A future field added by copying an existing row is exactly how it would reach
	 * the screen, so the assertion covers the entire rendered panel rather than any one row, and
	 * checks the raw output so a value hidden inside an escape sequence still fails.
	 */
	it("never renders the entry value anywhere in the panel", () => {
		const raw = new SecretDetailPane(secretRow(), usageOf(), now).render(WIDTH).join("\n");
		expect(raw).not.toContain(SECRET_VALUE);
		expect(raw).not.toContain("ghp_");
		expect(stripAnsi(raw)).not.toContain(SECRET_VALUE);
	});

	/**
	 * Locks out a value that leaks through a field it happens to resemble.
	 *
	 * If the value were ever substituted for the name, the placeholder row would carry it while
	 * still looking like a placeholder. Giving the entry a value that is also a legal-looking name
	 * proves the row is built from `name`, not from whatever field was nearest.
	 */
	it("builds the placeholder from the name even when the value looks like one", () => {
		const row = secretRow({ name: "API_KEY", value: "OTHER_SECRET_VALUE" });
		const lines = plain(row);
		expect(lines[0]).toBe("  placeholder  #API_KEY#");
		expect(lines.join("\n")).not.toContain("OTHER_SECRET_VALUE");
	});
});
