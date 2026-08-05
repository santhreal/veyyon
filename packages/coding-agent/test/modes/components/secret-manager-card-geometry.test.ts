/**
 * How big the Secret Manager's card is, and where its blank rows are.
 *
 * WHY THIS SUITE EXISTS. Everything else about this card is tested through the text it paints, and
 * all of it passed while the card itself was the wrong shape. Three defects lived in the numbers
 * the card hands `renderModalShell`, and none of them can be seen by asserting that a row says
 * `#GITHUB_TOKEN#`:
 *
 * 1. The card borrowed the shared `MODAL_SIZING_LARGE`, whose `widthPct: 0.9` sizes a card to the
 *    TERMINAL rather than to what it holds. On a 120-column terminal that is a 108-column card
 *    with 102 columns of body, wrapped around a roster 40 columns wide: sixty-two empty columns
 *    beside every credential, on the one surface in the product whose whole body is a table.
 * 2. `vPad: 2` charged two blank rows above the tab strip and two below the table, so a card
 *    holding four rows of content spent four more saying nothing.
 * 3. `footerLines: 2` reserved two rows for the shortcut band whatever the chips did with them.
 *    The Secrets footer wraps to two rows and fills it; the Log footer is one row, so an empty row
 *    was painted between the chips and the bottom border on every Log state, on the key map, and
 *    on an empty vault.
 *
 * The width is measured off the content now — and off BOTH views at once, which is the part with
 * teeth. Sizing to the view in front of you is the shorter implementation and it makes the card
 * jump width under the cursor when the operator presses left/right, so the suite pins the
 * stability as hard as it pins the size.
 *
 * Every number below is a column count read off the painted frame. Nothing here inspects a private
 * field: a card's geometry is the most visible thing about it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SECRET_MANAGER_HELP } from "@veyyon/coding-agent/modes/components/secret-help-overlay";
import { SecretManager } from "@veyyon/coding-agent/modes/components/secret-manager";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "@veyyon/coding-agent/secrets/audit";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { stripAnsi } from "@veyyon/utils";

/**
 * A 120-column, 40-row terminal: the size the card was reported wrong at.
 *
 * 40 rows and not the 24 a piped process reports, because a 24-row card takes the COMPACT path,
 * which sheds the vertical padding half this suite is about and pays one column of horizontal
 * padding a side instead of two. A suite pinned to 24 rows would pass over defect 2 entirely.
 */
const WIDTH = 120;
const HEIGHT = 40;

/** Fixed, so `describeAgo` is a constant in the column arithmetic rather than a function of now. */
const NOW = Date.parse("2026-07-31T12:00:00Z");

let home: string;
let project: string;
let locations: VaultLocations;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
});

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-geom-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-geom-proj-"));
	locations = resolveVaultLocations({
		globalConfigRoot: home,
		agentDir: path.join(home, "profiles", "default"),
		cwd: project,
	});
	// An empty log's notice names the log's PATH, and that path is one of the terms the card's
	// width is measured from. Collapsing the home directory makes the term the same length on
	// every machine, so the widths asserted below are constants rather than a function of
	// whatever `os.tmpdir()` happens to be.
	spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(async () => {
	spyOn(os, "homedir").mockRestore();
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

/**
 * The card's own rows, cropped to the card's own columns.
 *
 * `renderModalShell` returns full-terminal lines with the card floated in the middle, so every
 * measurement here has to strip the surrounding pad first. A painted row is either entirely blank
 * (outside the card) or ends at the card's right border, which is what makes `trimEnd` the
 * right-hand crop and the shortest leading run of spaces the left-hand one.
 */
function cardRows(manager: SecretManager, width = WIDTH): string[] {
	const painted = manager.render(width).map(line => stripAnsi(line).trimEnd());
	const framed = painted.filter(line => line.length > 0);
	const left = Math.min(...framed.map(line => line.length - line.trimStart().length));
	return framed.map(line => line.slice(left));
}

/** Columns the card occupies, borders included. */
function cardWidth(manager: SecretManager, width = WIDTH): number {
	return cardRows(manager, width)[0]?.length ?? 0;
}

/**
 * Columns of body text a card of this width offers.
 *
 * `computeModalDims` derives it as `modalWidth - 2 - 2 * hPad`, and every card in this suite is
 * on the non-compact path at {@link HEIGHT} rows, where `hPad` is 2.
 */
function contentWidth(manager: SecretManager, width = WIDTH): number {
	return cardWidth(manager, width) - 6;
}

/** A card row with its borders and insets removed, so a blank body row reads as `""`. */
function body(row: string): string {
	return row.slice(1, -1).trim();
}

/**
 * Credentials that never expire, so the EXPIRES column is the constant `never expires`.
 *
 * A default TTL would put `4d left` there today and `3d left` tomorrow, and the column widths
 * below are the whole subject of this file.
 */
async function seedVault(entries: ReadonlyArray<{ name: string; scope: "global" | "profile" | "project" }>) {
	const vault = new SecretVault(locations);
	for (const entry of entries) {
		await vault.add({ name: entry.name, value: `val_${entry.name}_0123456789`, scope: entry.scope, ttl: null });
	}
}

/** The three credentials the operator had stored, one per scope. */
async function seedThreeSecrets(): Promise<void> {
	await seedVault([
		{ name: "GITHUB_TOKEN", scope: "profile" },
		{ name: "DEPLOY_KEY", scope: "project" },
		{ name: "STRIPE_KEY", scope: "global" },
	]);
}

/** A log file that exists and holds nothing, which is what a profile that has spent nothing has. */
async function emptyLog(): Promise<SecretAuditLog> {
	const auditLog = new SecretAuditLog(secretAuditPath(locations));
	await auditLog.flush();
	return auditLog;
}

/**
 * A log holding one use, written with a command far longer than any column can show.
 *
 * The command is the term that would let the log ask for the whole terminal, so a proof about the
 * WHERE column's budget needs one that overflows it rather than one that happens to fit.
 */
async function longCommandLog(): Promise<SecretAuditLog> {
	const auditLog = new SecretAuditLog(secretAuditPath(locations));
	auditLog.record({
		at: NOW - 3_600_000,
		tool: "bash",
		command: "curl -H 'Authorization: bearer #SPENT_TOKEN#' https://api.github.com/user/repos?per_page=100",
		secrets: ["#SPENT_TOKEN#"],
	});
	await auditLog.flush();
	return auditLog;
}

async function openManager(auditLog: SecretAuditLog | undefined): Promise<SecretManager> {
	const manager = new SecretManager({
		vault: new SecretVault(locations),
		terminalHeight: HEIGHT,
		now: () => NOW,
		auditLog,
	});
	await manager.settled();
	return manager;
}

describe("the card is as wide as its content, not as wide as the terminal", () => {
	/**
	 * REGRESSION: the card took `MODAL_SIZING_LARGE`, so its width was `0.9 * terminal` capped at
	 * 140. On the reported 120-column terminal that is a 108-column card with 102 columns of body
	 * around a roster 40 columns wide.
	 *
	 * IF THIS REGRESSES the card goes back to 108 columns and the roster floats in the middle of an
	 * empty slab. The numbers are exact rather than an upper bound because a card that merely "got
	 * smaller" is not the fix: it has to be the width its content asks for, which here is the
	 * empty log's notice at the prose measure of 72 columns.
	 */
	it("sizes a three-credential roster to 78 columns on a 120-column terminal", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());

		expect(cardWidth(manager)).toBe(78);
		expect(contentWidth(manager)).toBe(72);
		// Every row closes on the same column, so the card that shrank is still a card.
		expect(cardRows(manager).filter(row => row.length !== 78)).toEqual([]);
	});

	/**
	 * THE SAME FACT FROM THE ROSTER'S SIDE. `› #GITHUB_TOKEN#  profile  never expires` is 40
	 * columns, and it used to be painted with 62 empty ones after it. Asserting the widest table
	 * row and the slack beside it is what makes this a test about dead space rather than about a
	 * number that happens to be smaller.
	 */
	it("leaves the widest roster row 32 columns of slack instead of 62", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());

		const table = cardRows(manager)
			.map(body)
			.filter(text => text.includes("#GITHUB_TOKEN#") || text.includes("#STRIPE_KEY#"));
		expect(table).toEqual(["#GITHUB_TOKEN#  profile  never expires", "#STRIPE_KEY#    global   never expires"]);
		expect(Math.max(...table.map(text => text.length)) + 2).toBe(40);
		expect(contentWidth(manager) - 40).toBe(32);
	});

	/**
	 * REGRESSION GUARD FOR THE OBVIOUS WRONG FIX. Sizing the card to the view in front of you is
	 * one line shorter to write and makes the card resize under the cursor: the Log's table is
	 * wider than the roster, so left/right would widen and narrow the card on every switch.
	 *
	 * The control card is measured FIRST, over the same vault while the log file is still empty. It
	 * is what proves the 85 came from the log's records rather than from a constant — a card that
	 * ignored the log entirely would pass "both views agree" on its own.
	 */
	it("keeps one width across a Secrets/Log switch, and that width is the log's", async () => {
		await seedVault([
			{ name: "BACKUP_TOKEN", scope: "profile" },
			{ name: "SPENT_TOKEN", scope: "project" },
		]);
		const withoutLog = await openManager(await emptyLog());
		expect(cardWidth(withoutLog)).toBe(78);

		const manager = await openManager(await longCommandLog());
		const onSecrets = cardWidth(manager);
		manager.handleInput("\t");
		await manager.settled();
		const onLog = cardWidth(manager);
		manager.handleInput("\t");
		await manager.settled();
		const backOnSecrets = cardWidth(manager);

		expect(onSecrets).toBe(85);
		expect(onLog).toBe(85);
		expect(backOnSecrets).toBe(85);
	});

	/**
	 * REGRESSION: the WHERE column is why the Log view legitimately wants columns, and a card sized
	 * to the roster alone would have crushed it to nothing. It gets a fixed budget instead — 48
	 * columns, a command's recognisable head — because a command is unbounded, and a column sized
	 * to the longest one asks for the whole terminal on every state of the card including the
	 * roster.
	 *
	 * IF THIS REGRESSES either the log stops setting the width and WHERE collapses, or it sets the
	 * width without a cap and the card is back at 140 columns the moment a model writes a long
	 * `curl`.
	 */
	it("gives the log's WHERE column 48 columns and truncates the command into them", async () => {
		await seedVault([{ name: "SPENT_TOKEN", scope: "project" }]);
		const manager = await openManager(await longCommandLog());
		manager.handleInput("\t");
		await manager.settled();

		const rows = cardRows(manager);
		const header = rows.find(row => row.includes("WHERE"));
		expect(header).toBeDefined();
		// Body text starts one border column and one inset column in, so the WHERE heading's index
		// in the painted row is its content offset plus two.
		expect(contentWidth(manager) - (header?.indexOf("WHERE") ?? 0) + 2).toBe(48);

		// Forty-seven columns of command and the ellipsis that says the rest is on the detail line
		// under the table: exactly the 48 the header measurement above accounts for.
		const record = rows.map(body).find(text => text.includes("curl -H"));
		expect(record).toBe("› 1h ago  bash  #SPENT_TOKEN#  curl -H 'Authorization: bearer #SPENT_TOKEN#' h…");
	});

	/**
	 * THE FLOOR. Content-driven width has to stop somewhere: a vault with one short credential and
	 * a log of one short command asks for 46 columns, and at that width the footer's eight chips
	 * shred into four rows and the key map has nowhere to go. 60 columns is the floor the shared
	 * LARGE preset already used for a split pane, kept deliberately.
	 */
	it("never narrows past 60 columns, however little the card is holding", async () => {
		await seedVault([{ name: "TOKEN", scope: "project" }]);
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({ at: NOW - 3_600_000, tool: "bash", command: "ssh -i #TOKEN# prod", secrets: ["#TOKEN#"] });
		await auditLog.flush();
		const manager = await openManager(auditLog);

		expect(cardWidth(manager)).toBe(60);
	});

	/**
	 * THE NARROW TERMINALS. A content-driven width must never be a width the terminal cannot
	 * afford, and the two sizes the proof renderer keeps sections for are the ones that break
	 * first: a 60-column split pane and a 40-column phone-sized terminal.
	 */
	it("still fills a 60-column and a 40-column terminal with a closed card", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());

		for (const terminal of [60, 40] as const) {
			const rows = cardRows(manager, terminal);
			expect(rows.filter(row => row.length !== terminal)).toEqual([]);
			expect(rows[0]?.startsWith("┌")).toBe(true);
			expect(rows[0]?.endsWith("┐")).toBe(true);
			expect(rows[rows.length - 1]).toBe(`└${"─".repeat(terminal - 2)}┘`);
		}
	});
});

describe("the card's blank rows are the ones it needs", () => {
	/**
	 * REGRESSION: `vPad: 2` put two blank rows between the top border and the tab strip and two
	 * more between the table and the footer divider. On a card whose whole body is a tab strip and
	 * three credentials, that is four rows of nothing wrapped around four rows of content.
	 *
	 * IF THIS REGRESSES both counts go back to two and the roster floats again. One row each side
	 * is kept on purpose: a table resting directly on the footer divider reads as clipped.
	 */
	it("pads the body with one row above the tab strip and one below the table", async () => {
		await seedThreeSecrets();
		const rows = cardRows(await openManager(await emptyLog()));

		const tabStrip = rows.findIndex(row => body(row).includes("Secrets (3)"));
		const divider = rows.findIndex(row => row.startsWith("├"));
		const lastContent = rows.findLastIndex((row, index) => index < divider && body(row).length > 0);

		expect(tabStrip).toBe(2);
		expect(rows.slice(1, tabStrip).map(body)).toEqual([""]);
		expect(rows.slice(lastContent + 1, divider).map(body)).toEqual([""]);
		expect(body(rows[lastContent] ?? "")).toContain("#STRIPE_KEY#");
	});

	/**
	 * REGRESSION: `footerLines: 2` reserved two rows for the shortcut band unconditionally, so
	 * every state whose chips fit on one row painted an empty row between them and the bottom
	 * border. That is most of the states this card has — the whole Log view, the key map, and an
	 * empty vault.
	 *
	 * IF THIS REGRESSES a blank row reappears under the chips. Both halves matter: the Secrets
	 * footer genuinely wraps to two rows and must still be given two.
	 */
	it("reserves one footer row for the Log's one row of chips and two for the roster's", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());

		const rosterRows = cardRows(manager);
		const rosterDivider = rosterRows.findIndex(row => row.startsWith("├"));
		expect(rosterRows.length - rosterDivider - 2).toBe(2);
		expect(body(rosterRows[rosterRows.length - 2] ?? "")).toBe(
			"r revoke  ·  u uses  ·  left/right view  ·  esc back",
		);

		manager.handleInput("\t");
		await manager.settled();

		const logRows = cardRows(manager);
		const logDivider = logRows.findIndex(row => row.startsWith("├"));
		expect(logRows.length - logDivider - 2).toBe(1);
		expect(body(logRows[logRows.length - 2] ?? "")).toBe("? keys  ·  left/right view  ·  esc back");
	});

	/**
	 * REGRESSION: both footers said `esc close`, and escape has not closed the card from a narrowed
	 * view since the unwind was written. A roster narrowed by `/git` takes one escape to clear the
	 * filter and STAYS OPEN, so the chip promised something the key would not do — while the key
	 * map two keypresses away described the unwind correctly. Chip and key run the same
	 * `#dismiss`, so `back` is the word that is true of both, and it is what the key map's own
	 * footer already said.
	 *
	 * IF THIS REGRESSES the footer starts documenting behaviour the card does not have, which no
	 * other test catches: nothing else compares a chip's label against its handler.
	 */
	it("labels the escape chip back rather than close, in both views", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());

		const roster = cardRows(manager).map(body).join("\n");
		expect(roster).toContain("esc back");
		expect(roster).not.toContain("esc close");

		// The key still steps back rather than closing, which is the behaviour the label now
		// matches: one escape out of a search leaves the card open on the full roster.
		manager.handleInput("/");
		await manager.settled();
		for (const character of "GITHUB") manager.handleInput(character);
		manager.handleInput("\n");
		await manager.settled();
		expect(cardRows(manager).map(body).join("\n")).toContain("Showing 1 of 3");

		manager.handleInput("\x1b");
		await manager.settled();
		const reopened = cardRows(manager).map(body).join("\n");
		expect(reopened).toContain("#STRIPE_KEY#");
		expect(reopened).not.toContain("Showing 1 of 3");
		expect(reopened).toContain("esc back");
	});

	/**
	 * THE KEY MAP IS THE OTHER ONE-ROW FOOTER, and it is also the widest surface this card can be
	 * asked to draw. It is measured only while it is open, so a narrower resting card must not cost
	 * it a word: {@link SecretHelpOverlay} cuts a line that does not fit and appends no ellipsis,
	 * which would make the loss invisible.
	 *
	 * Read against `SECRET_MANAGER_HELP` rather than against pinned strings, so this stays a proof
	 * about truncation and not a copy of the key table that has to be edited alongside it.
	 */
	it("fits every key description once the key map is open, and puts its chip on the border", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());
		const resting = cardWidth(manager);
		manager.handleInput("?");

		const rows = cardRows(manager);
		const painted = rows.map(body).join("\n");
		for (const entry of SECRET_MANAGER_HELP) {
			if (entry.view === "log") continue;
			expect(painted).toContain(entry.description);
		}
		expect(cardWidth(manager)).toBeGreaterThan(resting);
		expect(body(rows[rows.length - 2] ?? "")).toBe("esc back");
	});

	/**
	 * REGRESSION: the key map's two groups were separated by a blank line that the card threw away.
	 * `SecretHelpOverlay.render` emits `""` between the view's own keys and the shared ones, and
	 * `Text` returns zero rows for a string that trims to nothing, so `Anywhere in the card` was
	 * painted directly under the last key of the group above it and the map read as one
	 * undifferentiated list with a heading buried in the middle of it.
	 *
	 * IF THIS REGRESSES — by going back to a plain `Text`, or by someone "simplifying" the
	 * conditional away — the separator disappears again and nothing else about the card changes,
	 * which is exactly why it survived this long. A space or a non-breaking space is not a fix
	 * either: `Text` trims before it measures.
	 *
	 * The separator is located RELATIVE TO THE HEADING rather than at a fixed row, because the key
	 * table above it grows whenever a key is documented.
	 */
	it("keeps the blank row that separates the key map's two groups", async () => {
		await seedThreeSecrets();
		const manager = await openManager(await emptyLog());
		manager.handleInput("?");

		const rows = cardRows(manager).map(body);
		const shared = rows.indexOf("Anywhere in the card");
		expect(shared).toBeGreaterThan(0);
		expect(rows[shared - 1]).toBe("");
		// Not a blank card: the group above the separator is a populated key table, and the row
		// before the blank is the last key in it rather than more padding.
		expect(rows[shared - 2]?.length).toBeGreaterThan(0);
		expect(rows.filter(row => row === "Anywhere in the card")).toHaveLength(1);
	});
});
