/**
 * The secret manager's Log table and its pointer targets.
 *
 * WHY THIS SUITE EXISTS. The Log view used to render `renderLog()` split on newline: the exact
 * transcript the non-interactive `/secret log` prints, dropped into a card. That is text output in
 * a GUI, and it showed: nothing lined up, every record cost two rows, and the header sentence
 * counted records the body below it then repeated. The body also had no pointer targets at all,
 * so the tabs above it and the rows inside it were the only things on a mouse-tracking full-screen
 * card that a mouse could not touch.
 *
 * Each test below locks one of those defects out by name. They assert painted bytes and vault
 * state rather than internal fields, because the defect was always visible and never structural:
 * the old code was internally consistent and still wrong on screen.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretManager } from "@veyyon/coding-agent/modes/components/secret-manager";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "@veyyon/coding-agent/secrets/audit";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { stripAnsi } from "@veyyon/utils";

const WIDTH = 100;
const HEIGHT = 40;

/** Fixed so "45h ago" is a constant in the assertions rather than a function of the wall clock. */
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
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-log-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-log-proj-"));
	locations = resolveVaultLocations({
		globalConfigRoot: home,
		agentDir: path.join(home, "profiles", "default"),
		cwd: project,
	});
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

function screen(manager: SecretManager): string[] {
	return manager.render(WIDTH).map(line => stripAnsi(line).trimEnd());
}

/**
 * The card's body with the wrap undone, so a sentence the card broke over two rows reads as one.
 *
 * Where the break falls is a function of the temp path's length and the terminal width, so an
 * assertion against the painted rows would be a description of one temp directory. Rejoining is
 * exact because the wrapper breaks at spaces.
 */
function unwrapped(manager: SecretManager): string {
	return screen(manager)
		.map(line => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trim())
		.filter(line => line.length > 0)
		.join(" ")
		.replace(/ {2,}/g, " ");
}

/**
 * Three records whose cells deliberately disagree about width.
 *
 * A table only demonstrates alignment when its columns are ragged: equal-width cells line up even
 * under the broken renderer this suite exists to keep out.
 */
async function seedLog(): Promise<SecretAuditLog> {
	const auditLog = new SecretAuditLog(secretAuditPath(locations));
	auditLog.record({
		at: NOW - 3_600_000,
		tool: "bash",
		command: "curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user/repos",
		secrets: ["#GITHUB_TOKEN#"],
	});
	auditLog.record({
		at: NOW - 7_200_000,
		tool: "fetch",
		command: "ssh -i #DEPLOY_KEY# deploy@prod",
		secrets: ["#DEPLOY_KEY#", "#STRIPE_KEY#"],
	});
	await auditLog.flush();
	return auditLog;
}

async function openLog(auditLog: SecretAuditLog | undefined): Promise<SecretManager> {
	const manager = new SecretManager({
		vault: new SecretVault(locations),
		terminalHeight: HEIGHT,
		now: () => NOW,
		auditLog,
	});
	await manager.settled();
	manager.handleInput("\t");
	await manager.settled();
	// Rendered before any pointer event: the card records its own geometry as it paints, so a
	// click delivered to a card that has never rendered has nothing to hit.
	manager.render(WIDTH);
	return manager;
}

/** The rows of the Log table, in paint order, without the chrome around them. */
function tableRows(manager: SecretManager): string[] {
	return screen(manager)
		.map(line => line.replace(/^\s*│/, "").replace(/│\s*$/, ""))
		.filter(line => /\d+h ago/.test(line));
}

function sgr(row: number, col: number, kind: "press" | "motion"): string {
	// SGR-1006 is 1-based on the wire and the parser converts; the button code for motion with no
	// button held is 35, and 0 is a plain left press.
	return kind === "press" ? `\x1b[<0;${col + 1};${row + 1}M` : `\x1b[<35;${col + 1};${row + 1}M`;
}

/** The screen row a painted line sits on, so a click targets what a human would be pointing at. */
function rowOf(manager: SecretManager, match: string): number {
	const index = screen(manager).findIndex(line => line.includes(match));
	if (index === -1) throw new Error(`no painted row contains ${match}`);
	return index;
}

function colOf(manager: SecretManager, match: string): number {
	const row = rowOf(manager, match);
	return screen(manager)[row].indexOf(match);
}

describe("the log renders as a table, not as the CLI transcript", () => {
	/**
	 * ONE RECORD IS ONE ROW, and that row carries the whole record. The old view split each record
	 * across two lines, the second an indented command, which is what made a page of log read as a
	 * wall of text and made the tab's record count disagree with the body it labelled.
	 *
	 * The command is asserted to be ON the same line as the timestamp precisely because a count of
	 * timestamp-bearing lines alone is two under both renderers: it is the co-location that tells
	 * the two apart.
	 */
	it("gives each record exactly one row carrying all of its fields", async () => {
		const manager = await openLog(await seedLog());
		const rows = tableRows(manager);

		expect(rows).toHaveLength(2);
		expect(manager.logRecordCount).toBe(2);
		expect(rows[0]).toContain("bash");
		expect(rows[0]).toContain("#GITHUB_TOKEN#");
		expect(rows[0]).toContain("curl -H");
		expect(rows[1]).toContain("fetch");
		expect(rows[1]).toContain("ssh -i");
	});

	/**
	 * THE COLUMNS LINE UP. This is the whole defect in one assertion: every cell in a column starts
	 * at the same screen column, measured across every record rather than per row. The old renderer
	 * joined cells with two literal spaces, so `fetch` pushed everything after it one column right
	 * of where `bash` did.
	 *
	 * Each index is asserted to have been FOUND before the columns are compared. A cell that is not
	 * on the line reports -1, and a pair of -1s is a set of size one: without this the test would
	 * have passed against the old renderer, where the command was not on the row at all.
	 */
	it("starts every cell of a column at the same screen column", async () => {
		const manager = await openLog(await seedLog());
		const rows = tableRows(manager);

		const columnOf = (row: string, cell: string) => {
			const index = row.indexOf(cell);
			expect(index).toBeGreaterThan(0);
			return index;
		};

		expect(columnOf(rows[0], "bash")).toBe(columnOf(rows[1], "fetch"));
		expect(columnOf(rows[0], "#GITHUB_TOKEN#")).toBe(columnOf(rows[1], "#DEPLOY_KEY#"));
		expect(columnOf(rows[0], "curl")).toBe(columnOf(rows[1], "ssh"));
	});

	/**
	 * A HEADING ROW NAMES THE COLUMNS. Without it the table is four unlabelled fields and the
	 * reader has to infer that the third one is the placeholders and not, say, the session.
	 */
	it("labels the columns", async () => {
		const manager = await openLog(await seedLog());
		const text = screen(manager).join("\n");

		expect(text).toContain("WHEN");
		expect(text).toContain("TOOL");
		expect(text).toContain("SECRETS");
		expect(text).toContain("WHERE");
	});

	/**
	 * THE HEADER SENTENCE IS GONE. "3 most recent use(s), oldest first:" is transcript phrasing for
	 * output that scrolls past. In a card the body is right there being counted, so the sentence
	 * was both redundant and a second place for the count to be wrong.
	 */
	it("does not repeat the CLI's counting sentence", async () => {
		const manager = await openLog(await seedLog());

		expect(screen(manager).join("\n")).not.toContain("most recent use(s)");
	});

	/**
	 * THE COMMAND SURVIVES TRUNCATION. WHERE takes the leftover width and gets cut, which is only
	 * acceptable because the selected record's command is shown in full underneath. Drop the detail
	 * strip and the view silently loses the evidence it exists to preserve.
	 */
	it("shows the selected record's command in full below the table", async () => {
		const manager = await openLog(await seedLog());
		const text = screen(manager).join("\n");

		expect(text).toContain("curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user/repos");
	});

	/**
	 * THE DETAIL FOLLOWS THE SELECTION. A strip that always showed the first record would be
	 * decoration; it is the reason the table may truncate, so it has to track what is selected.
	 */
	it("moves the detail strip when the selection moves", async () => {
		const manager = await openLog(await seedLog());
		expect(screen(manager).join("\n")).toContain("https://api.github.com/user/repos");

		manager.handleInput("j");
		const text = screen(manager).join("\n");

		expect(text).toContain("ssh -i #DEPLOY_KEY# deploy@prod");
		expect(text).not.toContain("https://api.github.com/user/repos");
	});

	/**
	 * AN EMPTY LOG STILL EXPLAINS ITSELF, and names the file, so it reads as "nothing has happened"
	 * rather than "the card failed to load something".
	 *
	 * The WHOLE path, to its last segment. This assertion used to accept the leading 30 characters
	 * because the card painted the notice unwrapped and cut it at its own inner width, which threw
	 * away the only part of the sentence that identifies anything: an empty log's entire payload is
	 * WHERE it is empty, and `/home/you/.veyyon/prof…` answers nothing.
	 */
	it("names the file when nothing has been recorded", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		const manager = await openLog(auditLog);

		expect(unwrapped(manager)).toContain(`No secret has been used yet. The log is ${secretAuditPath(locations)}.`);
		expect(screen(manager).join("\n")).not.toContain("…");
	});

	/**
	 * RECORDING OFF IS NOT AN EMPTY LOG. Painting `0` uses where nothing is being recorded asserts
	 * that no secret was spent, which is the one conclusion that state cannot support.
	 */
	it("distinguishes recording being off from an empty log", async () => {
		const manager = await openLog(undefined);

		const text = screen(manager).join("\n");
		expect(text).toContain("Log (off)");
		expect(text).toContain("secrets.auditLog");
	});
});

describe("the log and secrets tables answer the pointer", () => {
	/**
	 * CLICKING A TAB SWITCHES TO IT. The card is mounted full-screen with mouse tracking on, so a
	 * tab strip that only answers the keyboard is a control that looks clickable and is not.
	 */
	it("switches view when a tab is clicked", async () => {
		const manager = await openLog(await seedLog());
		expect(screen(manager).join("\n")).toContain("[Log (2)]");

		const row = rowOf(manager, "Secrets (0)");
		manager.handleInput(sgr(row, colOf(manager, "Secrets (0)"), "press"));

		expect(screen(manager).join("\n")).toContain("[Secrets (0)]");
	});

	/**
	 * CLICKING A LOG ROW SELECTS IT, which is what makes the detail strip reachable by pointer. The
	 * body previously routed nothing, so a click here landed on the chrome hit test and did nothing
	 * at all.
	 */
	it("selects the log record that was clicked", async () => {
		const manager = await openLog(await seedLog());
		const row = rowOf(manager, "ssh -i");

		manager.handleInput(sgr(row, 20, "press"));

		expect(screen(manager).join("\n")).toContain("ssh -i #DEPLOY_KEY# deploy@prod");
	});

	/**
	 * A CLICK BELOW THE LAST ROW SELECTS NOTHING. Row arithmetic that is not bounded by the records
	 * actually on screen turns empty space into a control, and on the secrets table that empty
	 * space sits directly above a revoke.
	 */
	it("ignores a click past the last row", async () => {
		const manager = await openLog(await seedLog());
		const before = screen(manager).join("\n");
		const lastRow = rowOf(manager, "ssh -i");

		manager.handleInput(sgr(lastRow + 1, 20, "press"));

		expect(screen(manager).join("\n")).toBe(before);
	});

	/**
	 * HOVER REVEALS THE ROW'S ACTION on the secrets table, matching the Agent Control Center so the
	 * two cards teach one gesture. It is drawn on hover rather than always, because a destructive
	 * control on every row is noise until a pointer is actually near it.
	 */
	it("reveals the revoke action under the pointer and hides it again", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: "ghp_pointerProofCredential001", scope: "profile" });
		const manager = new SecretManager({ vault: new SecretVault(locations), terminalHeight: HEIGHT, now: () => NOW });
		await manager.settled();
		manager.render(WIDTH);
		// Read off the SECRET'S OWN ROW, never the whole frame: the card's title bar carries its
		// own `[x]` close glyph, so a frame-wide search would pass whether or not a row ever
		// revealed anything.
		const rowText = () => screen(manager)[rowOf(manager, "#GITHUB_TOKEN#")];
		expect(rowText()).not.toContain("[x]");

		const row = rowOf(manager, "#GITHUB_TOKEN#");
		manager.handleInput(sgr(row, 20, "motion"));
		expect(rowText()).toContain("[x]");

		// Off the rows entirely: the highlight has to go with the pointer, or it claims a click
		// would land somewhere it no longer would.
		manager.handleInput(sgr(row + 6, 20, "motion"));
		expect(rowText()).not.toContain("[x]");
	});

	/**
	 * CLICKING THE REVEALED ACTION ASKS FIRST. The pointer must reach revoke, and revoke must still
	 * be the same guarded action the `r` key runs: a one-click destroy on a hover target is exactly
	 * the accident a confirm exists to prevent.
	 */
	it("routes a click on the revealed action into the revoke confirmation", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: "ghp_pointerProofCredential002", scope: "profile" });
		const manager = new SecretManager({ vault: new SecretVault(locations), terminalHeight: HEIGHT, now: () => NOW });
		await manager.settled();
		manager.render(WIDTH);

		const row = rowOf(manager, "#GITHUB_TOKEN#");
		manager.handleInput(sgr(row, 20, "motion"));
		const actionCol = screen(manager)[row].indexOf("[x]");
		expect(actionCol).toBeGreaterThan(0);
		manager.handleInput(sgr(row, actionCol, "press"));

		expect(screen(manager).join("\n")).toContain("Revoke");
		// Still stored: the click opened the question, it did not answer it.
		expect(await new SecretVault(locations).load()).toHaveLength(1);
	});
});

describe("searching the log", () => {
	/**
	 * `/` NARROWS THE LOG. Without this the Log view had a key the Secrets view answered and it did
	 * not, so `/` in the log either did nothing or, worse, typed into the roster's search and
	 * narrowed a table the operator could not see. The log is the view where a search matters most:
	 * it is the one that grows without bound, and "which tool spent this credential" is the
	 * question it exists to answer.
	 */
	it("narrows the table to the records matching the tool", async () => {
		const manager = await openLog(await seedLog());
		expect(tableRows(manager)).toHaveLength(2);

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("fetch");
		manager.handleInput("\r");
		await manager.settled();

		const rows = tableRows(manager);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("fetch");
		expect(rows.join("\n")).not.toContain("bash");
	});

	/**
	 * The command text is searchable too, not just the tool. An operator hunting a specific use
	 * remembers what was run far more often than which tool ran it.
	 */
	it("matches against the command as well as the tool", async () => {
		const manager = await openLog(await seedLog());
		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("api.github.com");
		manager.handleInput("\r");
		await manager.settled();

		const rows = tableRows(manager);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("bash");
	});

	/**
	 * A SEARCH THAT HID EVERYTHING MUST SAY SO. With no rows left there is no table to infer from,
	 * and an empty Log view is indistinguishable from a log that recorded nothing, which would
	 * read as "the audit log is broken" rather than "your search matched nothing".
	 *
	 * It says it in a SENTENCE now. This used to accept `0 of 2`, a counting line that measures the
	 * whole log against what survived and names no way back; the roster has explained the same
	 * state in words since it was written, and the two views sit one keypress apart.
	 */
	it("says the search hid the records rather than showing an empty log", async () => {
		const manager = await openLog(await seedLog());
		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("nothing-matches-this");
		manager.handleInput("\r");
		await manager.settled();

		expect(tableRows(manager)).toHaveLength(0);
		const text = screen(manager).join("\n");
		expect(text).toContain('No recorded use matches "nothing-matches-this". Escape clears the search.');
		expect(text).not.toContain("0 of 2");
	});

	/**
	 * Escape restores the full log. A filter with no way back strands the operator in a narrowed
	 * view whose only exit is closing the card.
	 */
	it("restores every record when the search is cancelled", async () => {
		const manager = await openLog(await seedLog());
		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("fetch");
		manager.handleInput("\r");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(1);

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("\x1b");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(2);
	});

	/**
	 * THE TWO SEARCHES ARE SEPARATE STATE. One shared query would mean narrowing the log and then
	 * tabbing to Secrets to find the roster mysteriously filtered by a tool name, hiding
	 * credentials that are certainly still there.
	 */
	it("does not carry the log search across to the secrets roster", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: "ghp_ExampleTokenValue_9f3a", scope: "profile" });
		const manager = await openLog(await seedLog());

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("fetch");
		manager.handleInput("\r");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(1);

		// Back to the roster: the credential is listed, not filtered away by the word "fetch".
		manager.handleInput("\t");
		await manager.settled();
		expect(screen(manager).join("\n")).toContain("GITHUB_TOKEN");
	});

	/**
	 * USAGE COUNTS READ THE WHOLE LOG, NOT THE FILTERED VIEW. Joining the detail pane against the
	 * narrowed list would report a credential as used once because that is how many of its uses
	 * matched the search, which is a lie about a security-relevant number.
	 */
	it("counts uses from every record even while the log is narrowed", async () => {
		const auditLog = await seedLog();
		auditLog.record({
			at: NOW - 10_800_000,
			tool: "bash",
			command: "git push #GITHUB_TOKEN#",
			secrets: ["#GITHUB_TOKEN#"],
		});
		await auditLog.flush();

		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: "ghp_ExampleTokenValue_9f3a", scope: "profile" });
		const manager = await openLog(auditLog);

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("api.github.com");
		manager.handleInput("\r");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(1);

		// The roster's detail pane still sees both uses of the token.
		manager.handleInput("\t");
		await manager.settled();
		manager.handleInput("i");
		await manager.settled();
		expect(screen(manager).join("\n")).toMatch(/2 times/);
	});
});

describe("tracing one credential's uses", () => {
	/**
	 * Seeds a roster credential plus a log where it was spent twice and another tool ran without it.
	 * The third record is what makes the narrowing observable: without a non-matching record, an
	 * unwired `u` looks identical to a working one.
	 */
	async function seedTraceable(): Promise<SecretManager> {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({
			at: NOW - 3_600_000,
			tool: "bash",
			command: "git push #GITHUB_TOKEN#",
			secrets: ["#GITHUB_TOKEN#"],
		});
		auditLog.record({
			at: NOW - 7_200_000,
			tool: "fetch",
			command: "curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user",
			secrets: ["#GITHUB_TOKEN#"],
		});
		auditLog.record({
			at: NOW - 10_800_000,
			tool: "bash",
			command: "ssh -i #DEPLOY_KEY# deploy@prod",
			secrets: ["#DEPLOY_KEY#"],
		});
		await auditLog.flush();

		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: "ghp_ExampleTokenValue_9f3a", scope: "profile" });
		await vault.add({ name: "DEPLOY_KEY", value: "deploy_ExampleKeyValue_7c1b", scope: "profile" });

		const manager = new SecretManager({
			vault: new SecretVault(locations),
			terminalHeight: HEIGHT,
			now: () => NOW,
			auditLog,
		});
		await manager.settled();
		manager.render(WIDTH);
		return manager;
	}
	/**
	 * Put the selection on a named credential, deterministically.
	 *
	 * Done with the roster's own search rather than by counting `j` presses, because the roster's
	 * order depends on the sort key and on last-used times drawn from the seeded log. A test that
	 * navigated by position would silently start testing a different credential the moment the
	 * default sort changed, and still pass.
	 */
	async function selectRow(manager: SecretManager, name: string): Promise<void> {
		manager.handleInput("/");
		await manager.settled();
		manager.handleInput(name);
		manager.handleInput("\r");
		await manager.settled();
		const selected = screen(manager).find(line => line.includes("›"));
		if (selected?.includes(name) !== true) throw new Error(`selection did not land on ${name}: ${selected}`);
	}

	/**
	 * `u` ANSWERS "WHAT BREAKS IF I REVOKE THIS". Before this key the only way to find a
	 * credential's uses was to read the whole log and match `#NAME#` by eye, which is precisely
	 * the check that gets skipped right before a revoke. If it regresses, revoking becomes a guess.
	 */
	it("jumps to the log showing only that credential's uses", async () => {
		const manager = await seedTraceable();
		await selectRow(manager, "GITHUB_TOKEN");
		manager.handleInput("u");
		await manager.settled();

		const rows = tableRows(manager);
		expect(rows).toHaveLength(2);
		expect(rows.join("\n")).not.toContain("deploy@prod");
	});

	/**
	 * The narrowing must be VISIBLE. A log showing two of three records with nothing saying why is
	 * a log the operator will read as complete, and conclude the credential was never used
	 * elsewhere when in fact the view was filtered.
	 */
	it("names the credential it narrowed to", async () => {
		const manager = await seedTraceable();
		await selectRow(manager, "GITHUB_TOKEN");
		manager.handleInput("u");
		await manager.settled();

		const text = screen(manager).join("\n");
		expect(text).toContain("#GITHUB_TOKEN#");
		expect(text).toMatch(/2 of 3/);
	});

	/**
	 * The credential restriction and the text search COMPOSE, and clearing the search must not
	 * silently widen the view back to every credential. That would show uses of a different secret
	 * under a heading the operator still reads as "this one's uses".
	 */
	it("keeps the credential restriction when the text search is cleared", async () => {
		const manager = await seedTraceable();
		await selectRow(manager, "GITHUB_TOKEN");
		manager.handleInput("u");
		await manager.settled();

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("git push");
		manager.handleInput("\r");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(1);

		// Clear only the text. Escape inside the search field is the clear: reopening the field and
		// pressing enter would resubmit the text it was seeded with, which is not a clear at all.
		// The credential restriction survives it, so the deploy key stays hidden.
		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("\x1b");
		await manager.settled();
		const rows = tableRows(manager);
		expect(rows).toHaveLength(2);
		expect(rows.join("\n")).not.toContain("deploy@prod");
	});

	/**
	 * `u` TRACES THE ROW THE TABLE PAINTED, not the row at the same index in the unsorted vault
	 * list. This shipped broken once: the cursor indexes the SHAPED list, which is sorted and may
	 * be filtered, so reading `rows[selectedIndex]` traced whichever credential happened to sit at
	 * that position in load order. The narrowed log then looked entirely correct, named a real
	 * credential in its notice, and answered a question nobody asked. Nothing on screen revealed
	 * the mismatch, which is what makes it worth a test of its own: it was caught by rendering an
	 * image, not by any assertion.
	 *
	 * The test navigates with `j` rather than the search helper on purpose. Searching collapses the
	 * roster to one row, which makes the shaped and unshaped indices agree and hides the defect.
	 */
	it("traces the credential the cursor is on once the roster is sorted", async () => {
		const manager = await seedTraceable();
		// Second row of the painted roster, whatever the vault's own load order happens to be.
		manager.handleInput("j");
		manager.render(WIDTH);
		const selected = screen(manager).find(line => line.includes("›"));
		const traced = /#([A-Z_]+)#/.exec(selected ?? "")?.[1];
		expect(traced).toBeDefined();

		manager.handleInput("u");
		await manager.settled();

		// The notice names the credential the cursor was on, and every row shown spent it.
		const text = screen(manager).join("\n");
		expect(text).toContain(`of #${traced}#`);
		for (const row of tableRows(manager)) expect(row).toContain(`#${traced}#`);
	});

	/**
	 * Escape unwinds the narrowing before it closes the card. Closing straight out would leave the
	 * next open showing the whole log with no trace of the question that was asked.
	 */
	it("widens back to the whole log on escape rather than closing", async () => {
		const manager = await seedTraceable();
		let closed = false;
		manager.onClose = () => {
			closed = true;
		};
		await selectRow(manager, "GITHUB_TOKEN");
		manager.handleInput("u");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(2);

		manager.handleInput("\x1b");
		await manager.settled();
		expect(closed).toBe(false);
		expect(tableRows(manager)).toHaveLength(3);

		// A second escape, with nothing left to unwind, does close it.
		manager.handleInput("\x1b");
		await manager.settled();
		expect(closed).toBe(true);
	});

	/**
	 * ESCAPE PEELS ONE LAYER PER PRESS when the Log is narrowed twice over.
	 *
	 * `u` restricts the Log to one credential's uses, and `/` then searches within that
	 * restriction, so the operator has asked two separate questions in a known order. Escape once
	 * dropped both at the same time. The restriction the operator never cancelled vanished, and
	 * because the view was then fully widened the NEXT escape closed the card, which is how the
	 * demo tape lost its final scene: the help overlay never opened and `?` fell through to the
	 * chat prompt.
	 *
	 * Each of the three presses is asserted, because the bug is entirely about how many layers one
	 * press removes. A test that only checked the end state would pass on the broken behaviour.
	 */
	it("clears the log search before the credential restriction, one per escape", async () => {
		const manager = await seedTraceable();
		let closed = false;
		manager.onClose = () => {
			closed = true;
		};
		await selectRow(manager, "GITHUB_TOKEN");
		manager.handleInput("u");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(2);

		// Search within the restriction: one of the two uses mentions curl.
		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("curl");
		manager.handleInput("\r");
		await manager.settled();
		expect(tableRows(manager)).toHaveLength(1);

		// First escape drops the text search only. The restriction survives, so the whole log's
		// third record (DEPLOY_KEY) must still be absent.
		manager.handleInput("\x1b");
		await manager.settled();
		expect(closed).toBe(false);
		expect(tableRows(manager)).toHaveLength(2);
		expect(screen(manager).join("\n")).toContain("of #GITHUB_TOKEN#");

		// Second escape drops the restriction and shows every recorded use.
		manager.handleInput("\x1b");
		await manager.settled();
		expect(closed).toBe(false);
		expect(tableRows(manager)).toHaveLength(3);

		// Only the third closes.
		manager.handleInput("\x1b");
		await manager.settled();
		expect(closed).toBe(true);
	});
});

describe("escaping a narrowed roster", () => {
	/**
	 * ESCAPE WIDENS THE ROSTER BEFORE IT CLOSES THE CARD, the same way it already widened a
	 * narrowed Log.
	 *
	 * This shipped broken: the unwind was gated on the Log view alone, so a search in the Secrets
	 * view made escape close the whole card in one press. That is worse than merely surprising.
	 * The roster's own status line offers escape as the way to clear the search,
	 * so the card was instructing the operator to press a key that did the opposite of what the
	 * line promised, and the search was lost with the card. It was caught by recording the demo
	 * tape, where the card vanished mid-take and every later keystroke fell through to the chat
	 * prompt and was submitted to a model.
	 *
	 * The second escape is asserted too. Widening must not cost the operator the ability to leave:
	 * a fix that swallowed every escape would satisfy the first half of this test and trap them.
	 */
	it("clears the search on the first escape and closes on the second", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: "ghp_ExampleTokenValue_9f3a", scope: "profile" });
		await vault.add({ name: "DEPLOY_KEY", value: "deploy_ExampleKeyValue_7c1b", scope: "profile" });

		const manager = new SecretManager({
			vault: new SecretVault(locations),
			terminalHeight: HEIGHT,
			now: () => NOW,
		});
		await manager.settled();
		let closed = false;
		manager.onClose = () => {
			closed = true;
		};

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("GITHUB");
		manager.handleInput("\r");
		await manager.settled();
		expect(screen(manager).join("\n")).toContain('Showing 1 of 2 matching "GITHUB"');

		manager.handleInput("\x1b");
		await manager.settled();
		const widened = screen(manager).join("\n");
		expect(closed).toBe(false);
		expect(widened).not.toContain("matching");
		expect(widened).toContain("#DEPLOY_KEY#");
		expect(widened).toContain("#GITHUB_TOKEN#");

		manager.handleInput("\x1b");
		await manager.settled();
		expect(closed).toBe(true);
	});
});
