/**
 * The Secret Manager card in the states nobody seeds on purpose.
 *
 * WHY THIS SUITE EXISTS. The card's happy path is covered by its siblings and was proved frame by
 * frame from a recording. Its EDGES were not, and four of them were wrong in ways an operator
 * would read as a broken card rather than as an empty one:
 *
 * 1. The Log view had no empty state at all. Narrowing it to a credential that has never been
 *    spent painted a bare card carrying one sentence, `Showing 0 of 6 uses of #BACKUP_TOKEN#`,
 *    which asserts six uses of the credential the card had just found none of. That is the exact
 *    question `u` is pressed to answer, and the answer it gave was both empty and false.
 * 2. The Log footer was a constant, so a log holding nothing still offered `up/down select` and
 *    `/ search`: two chips over a table with no rows.
 * 3. The Log's file notices were painted with no wrapping, so the card cut them at its own inner
 *    width. An empty log's whole payload is the PATH of the file, and the path is what the cut
 *    removed; the recording-is-off explanation stopped mid-sentence.
 * 4. The Log table padded its cells with `String.padEnd`, which counts UTF-16 code units. An MCP
 *    server names its own tools, so a tool named in wide characters pushed every column to its
 *    right off the grid on exactly the rows that server contributed.
 *
 * Every test drives the real card over a real vault and a real log in a temp directory, and reads
 * the painted bytes back. Nothing here inspects a private field: each defect was visible and none
 * of them was structural.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretManager } from "@veyyon/coding-agent/modes/components/secret-manager";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "@veyyon/coding-agent/secrets/audit";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

const WIDTH = 100;
/**
 * 40 rows, not the 24 a piped process reports.
 *
 * A 24-row card is the COMPACT one: it sheds its horizontal padding and paints two columns wider
 * than the same card on an ordinary terminal. The wrapping defects below only appear at the width
 * an ordinary terminal gives, so a suite pinned to 24 rows would pass over all of them.
 */
const HEIGHT = 40;

/** Fixed, so "3d ago" is a constant in the assertions rather than a function of the wall clock. */
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
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-edge-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-edge-proj-"));
	locations = resolveVaultLocations({
		globalConfigRoot: home,
		agentDir: path.join(home, "profiles", "default"),
		cwd: project,
	});
});

afterEach(async () => {
	spyOn(os, "homedir").mockRestore();
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(project, { recursive: true, force: true });
});

/** The plain text the card paints, one entry per rendered row. */
function screen(manager: SecretManager): string[] {
	return manager.render(WIDTH).map(line => stripAnsi(line).trimEnd());
}

function screenText(manager: SecretManager): string {
	return screen(manager).join("\n");
}

/**
 * The card's body with the wrap undone, so a sentence the card broke over two rows reads as one.
 *
 * Assertions about a WRAPPED sentence cannot be written against the painted rows: where the break
 * falls is a function of the path length and the terminal width, and pinning it would make the
 * test a description of one temp directory. Rejoining is exact because the wrapper breaks at
 * spaces, so a joined pair of rows is the original string.
 */
function unwrapped(manager: SecretManager): string {
	return screen(manager)
		.map(line => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trim())
		.filter(line => line.length > 0)
		.join(" ")
		.replace(/ {2,}/g, " ");
}

/** Two credentials: one that has been spent and one that never has. */
async function seedVault(): Promise<void> {
	const vault = new SecretVault(locations);
	await vault.add({ name: "BACKUP_TOKEN", value: "bkp_edgeCaseCredential0001", scope: "profile" });
	await vault.add({ name: "SPENT_TOKEN", value: "spt_edgeCaseCredential0002", scope: "project" });
}

/** A log holding one use of `#SPENT_TOKEN#` and none of `#BACKUP_TOKEN#`. */
async function seedLog(): Promise<SecretAuditLog> {
	const auditLog = new SecretAuditLog(secretAuditPath(locations));
	auditLog.record({
		at: NOW - 3_600_000,
		tool: "bash",
		command: "curl -H 'Authorization: bearer #SPENT_TOKEN#' https://api.github.com/user/repos",
		secrets: ["#SPENT_TOKEN#"],
	});
	auditLog.record({
		at: NOW - 7_200_000,
		tool: "web_fetch",
		command: "GET https://example.invalid/health",
		secrets: [],
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

/** Open the card already on the Log view, with its read finished. */
async function openLogView(auditLog: SecretAuditLog | undefined): Promise<SecretManager> {
	const manager = await openManager(auditLog);
	manager.handleInput("\t");
	await manager.settled();
	return manager;
}

/** Type a query into the Log's search field and submit it. */
async function searchLog(manager: SecretManager, query: string): Promise<void> {
	manager.handleInput("/");
	await manager.settled();
	for (const character of query) manager.handleInput(character);
	manager.handleInput("\n");
	await manager.settled();
}

describe("the log view explains a narrowing that matched nothing", () => {
	/**
	 * REGRESSION: `u` on a credential that has never been spent painted an empty card whose only
	 * line was `Showing 0 of 2 uses of #BACKUP_TOKEN#.`, and that counting sentence measures the
	 * log against what survived, so it names a number of uses of the credential that do not exist.
	 * `u` is pressed to decide whether revoking something is safe, and this is the state where the
	 * answer is "yes, nothing has ever spent it". It has to say that rather than count.
	 */
	it("says a credential has never been spent instead of counting the whole log against it", async () => {
		await seedVault();
		const manager = await openManager(await seedLog());
		// Rendered first: the cursor rests on BACKUP_TOKEN, which sorts before SPENT_TOKEN.
		manager.render(WIDTH);
		manager.handleInput("u");
		await manager.settled();

		const text = screenText(manager);
		expect(text).toContain("#BACKUP_TOKEN# has not been used yet.");
		expect(text).toContain("Press escape to show every recorded use.");
		expect(text).not.toContain("Showing 0 of");
		// The tab strip still reports the log's true size, so the empty body is legibly a
		// narrowing of two records rather than a log that holds none.
		expect(text).toContain("Log (2)");
	});

	/**
	 * REGRESSION: `u` on a fresh profile stacked THREE lines that contradicted each other —
	 * `#BACKUP_TOKEN# has not been used yet.`, `Press escape to show every recorded use.`, and the
	 * file's own `No secret has been used yet. The log is …`. The first two describe a narrowing
	 * of records that exist; against a log holding none they invent them, and the middle line
	 * offered to widen into a view with nothing in it either. Three sentences, one fact.
	 *
	 * IF THIS REGRESSES the per-credential empty state fires again on an empty file and the card
	 * says "nothing has ever been recorded" and "escape will show you what was recorded" in the
	 * same breath. The file notice is the survivor because it is the only one carrying a fact the
	 * operator can act on: the path.
	 */
	it("says only that the file is empty when a narrowing lands on a log holding nothing", async () => {
		await seedVault();
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		await auditLog.flush();
		const manager = await openManager(auditLog);
		manager.render(WIDTH);
		manager.handleInput("u");
		await manager.settled();

		const text = unwrapped(manager);
		expect(text).toContain(`No secret has been used yet. The log is ${secretAuditPath(locations)}.`);
		expect(text).not.toContain("#BACKUP_TOKEN# has not been used yet.");
		expect(text).not.toContain("Press escape to show every recorded use.");
		expect(text).not.toContain("Showing 0 of");
		// The narrowing did happen — the card is on the Log, restricted to a credential — so this
		// is the empty state being coherent rather than the keypress being ignored.
		expect(text).toContain("Log (0)");
	});

	/**
	 * REGRESSION: a Log search that matched nothing left the operator with one counting line and
	 * no way out named. The roster has explained this state since it was written, in exactly these
	 * words, and the two views sit one keypress apart.
	 */
	it("names the query and the key that clears it when a log search matches nothing", async () => {
		await seedVault();
		const manager = await openLogView(await seedLog());
		await searchLog(manager, "kubectl");

		const text = screenText(manager);
		expect(text).toContain('No recorded use matches "kubectl".');
		expect(text).toContain("Press / to change the search, then escape to clear it.");
		expect(text).not.toContain("Showing 0 of");
	});

	/**
	 * REGRESSION: the two narrowings COMPOSE, so the empty state has to name both or the operator
	 * cannot tell which one hid the rows. Naming only the search would send them to escape, which
	 * clears the search and still shows nothing.
	 */
	it("names both the credential and the query when a search inside a narrowing matches nothing", async () => {
		await seedVault();
		const manager = await openManager(await seedLog());
		manager.render(WIDTH);
		manager.handleInput("j");
		manager.handleInput("u");
		await manager.settled();
		await searchLog(manager, "kubectl");

		expect(screenText(manager)).toContain('No use of #SPENT_TOKEN# matches "kubectl".');
	});

	/**
	 * THE NEGATIVE CONTROL for the three above. The counting line is replaced only when the
	 * narrowing left NO rows; a narrowing that still has rows must keep it, because that line is
	 * the only thing separating a filtered table from a complete one.
	 */
	it("keeps the counting line when the narrowing still has rows", async () => {
		await seedVault();
		const manager = await openManager(await seedLog());
		manager.render(WIDTH);
		manager.handleInput("j");
		manager.handleInput("u");
		await manager.settled();

		const text = screenText(manager);
		expect(text).toContain("Showing 1 of 2 uses of #SPENT_TOKEN#.");
		expect(text).not.toContain("has not been used yet");
	});
});

describe("the log view's footer offers only chips that can act", () => {
	/**
	 * REGRESSION: the Log's footer was a constant, so a fresh profile whose log holds nothing was
	 * still offered `up/down select` and `/ search`. Neither can do anything to a table with no
	 * rows, and the Secrets view has always pruned its own row actions the same way.
	 */
	it("drops select and search when the log holds no records", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		await auditLog.flush();
		const manager = await openLogView(auditLog);

		const text = screenText(manager);
		expect(text).not.toContain("up/down select");
		expect(text).not.toContain("/ search");
		expect(text).toContain("? keys");
		expect(text).toContain("left/right view");
		expect(text).toContain("esc back");
	});

	/**
	 * SEARCH SURVIVES A SEARCH THAT MATCHED NOTHING. That is the one state where the key matters
	 * most: amending the query is how the rows come back. Only the selection chip goes, because
	 * there is nothing to select.
	 */
	it("keeps the search chip when a search hid every row", async () => {
		await seedVault();
		const manager = await openLogView(await seedLog());
		await searchLog(manager, "kubectl");

		const text = screenText(manager);
		expect(text).toContain("/ search");
		expect(text).not.toContain("up/down select");
	});

	/** The ordinary case, so the pruning above is a narrowing of a footer that is otherwise full. */
	it("offers both chips when the log has rows", async () => {
		await seedVault();
		const manager = await openLogView(await seedLog());

		const text = screenText(manager);
		expect(text).toContain("up/down select");
		expect(text).toContain("/ search");
	});
});

/**
 * WHY THIS SUITE EXISTS.
 *
 * The roster's footer was built entirely from the SELECTED ROW, so `a` — which belongs to the card
 * and needs no row — appeared on no screen at all. The state that made it indefensible is the
 * empty vault, the first screen a new operator ever sees: the body said "Press a to store a
 * credential, and it lands here" while the footer under it read `left/right view · esc back`, so
 * the only key that can populate the card was promised by the prose and denied by the footer.
 *
 * The same derivation dropped `? keys` from this view, which is where `m` move, `i` detail, `s`
 * sort and `/` search are documented. Those keys worked; nothing on the screen said so.
 *
 * WHAT THIS DOES NOT CATCH: whether the add flow itself is any good once it opens. That is
 * `secret-add-flow.test.ts`. This suite only proves the card offers the action, in every state,
 * and that the chip is wired to the same handler as the key.
 */
describe("the roster's footer offers the card's own actions, not only the row's", () => {
	/**
	 * Every resting state of the roster, so this closes the class rather than the one screen the
	 * defect was reported on. A state added here with no add chip turns this RED, which is the
	 * point: the row-derived footer passed on the populated screen and failed on the empty one.
	 */
	const ROSTER_STATES: readonly { name: string; open: () => Promise<SecretManager> }[] = [
		{
			name: "an empty vault, where add is the only thing left to do",
			open: async () => openManager(await seedLog()),
		},
		{
			name: "a populated roster with a row selected",
			open: async () => {
				await seedVault();
				return openManager(await seedLog());
			},
		},
		{
			name: "a roster narrowed by a search that matched nothing",
			open: async () => {
				await seedVault();
				const manager = await openManager(await seedLog());
				manager.render(WIDTH);
				manager.handleInput("/");
				await manager.settled();
				for (const character of "zzzz") manager.handleInput(character);
				manager.handleInput("\n");
				await manager.settled();
				return manager;
			},
		},
	];

	for (const state of ROSTER_STATES) {
		it(`offers add and the key map on ${state.name}`, async () => {
			const manager = await state.open();

			const text = screenText(manager);
			expect(text).toContain("a add");
			expect(text).toContain("? keys");
		});
	}

	/**
	 * The empty state's PROSE and its FOOTER have to agree, which is the exact contradiction that
	 * shipped. Asserted together in one test because either half alone is satisfiable by deleting
	 * the other, and deleting the instruction would be the wrong repair.
	 */
	it("says press a in the body and lists a add in the footer on the same screen", async () => {
		const manager = await openManager(await seedLog());

		const text = unwrapped(manager);
		expect(text).toContain("Press a to store a credential");
		expect(text).toContain("a add");
	});

	/**
	 * A CHIP THAT CANNOT ACT IS WORSE THAN NO CHIP, so the label is not the contract: the chip is
	 * clicked here, through the real SGR mouse path, and the add flow has to open. A chip whose id
	 * the dispatch switch does not handle paints identically and does nothing.
	 */
	it("opens the add flow when the add chip is clicked, not only when a is pressed", async () => {
		const manager = await openManager(await seedLog());

		const rows = screen(manager);
		const row = rows.findIndex(line => line.includes("a add"));
		expect(row).toBeGreaterThanOrEqual(0);
		const col = (rows[row] ?? "").indexOf("a add");
		manager.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
		await manager.settled();

		// The card's own first field, not the composer's masked prompt: the manager runs the add
		// flow in place, so its title is what proves the chip reached `#startAdd`.
		expect(screenText(manager)).toContain("New secret: paste the value");
	});
});

describe("the log view's file notices survive the card's width", () => {
	/**
	 * REGRESSION: an empty log's entire payload is the PATH of the file it is empty at, and the
	 * card painted that sentence unwrapped and let its own width cut it, so the path arrived as
	 * `/home/u/.veyyon/prof…`. A sentence whose meaning is in its tail cannot be ellipsised.
	 */
	it("wraps the empty-log notice instead of cutting the path off", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		await auditLog.flush();
		const manager = await openLogView(auditLog);

		expect(unwrapped(manager)).toContain(`No secret has been used yet. The log is ${secretAuditPath(locations)}.`);
		// Nothing on this card is long enough to need truncating once the notice wraps, so a
		// single ellipsis anywhere is the truncation coming back.
		expect(screenText(manager)).not.toContain("…");
	});

	/**
	 * THE PATH IS SHORTENED, not printed absolute. This card is a full-screen surface people
	 * screenshot, and the absolute form spends thirty-odd columns restating the home directory
	 * before it reaches the part that identifies the file.
	 */
	it("collapses the home directory in the empty-log notice", async () => {
		spyOn(os, "homedir").mockReturnValue(home);
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		await auditLog.flush();
		const manager = await openLogView(auditLog);

		expect(unwrapped(manager)).toContain(
			"No secret has been used yet. The log is ~/profiles/default/secret-audit.jsonl.",
		);
		expect(screenText(manager)).not.toContain(home);
	});

	/**
	 * REGRESSION: the recording-is-off explanation was hand-wrapped at a width the card only has
	 * on a short terminal, so on an ordinary one its first line lost its last word to a hard `…`
	 * and the instruction stopped mid-sentence. It is the only useful thing this state can say.
	 */
	it("paints the recording-is-off instruction to its last word", async () => {
		const manager = await openLogView(undefined);

		expect(unwrapped(manager)).toContain(
			'Turn on "Record Secret Use" in /settings (secrets.auditLog) to start recording which ' +
				"credential was spent, in which tool, and what the model wrote around it.",
		);
		expect(screenText(manager)).not.toContain("…");
	});
});

describe("the log table measures its columns in terminal cells", () => {
	/**
	 * REGRESSION: the table padded with `String.padEnd`, which counts UTF-16 code units. An MCP
	 * server names its own tools and nothing bounds those to ASCII, so a tool named `mcp__文書__検索`
	 * (11 code units, 15 columns) was padded four columns too far and pushed the SECRETS and WHERE
	 * cells of that row off the grid. Every row an MCP server contributed stopped being a row of
	 * the table it sat in.
	 */
	it("starts the SECRETS column at the same terminal column on an ASCII row and a wide one", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({
			at: NOW - 3_600_000,
			tool: "bash",
			command: "curl --header #SPENT_TOKEN#",
			secrets: ["#SPENT_TOKEN#"],
		});
		auditLog.record({
			at: NOW - 7_200_000,
			tool: "mcp__文書__検索",
			command: "search --index prod",
			secrets: ["#SPENT_TOKEN#"],
		});
		await auditLog.flush();
		const manager = await openLogView(auditLog);

		// The detail pane under the table repeats the selected command, so the placeholder alone
		// does not identify a table row. The relative timestamp is the row's first cell.
		const rows = screen(manager).filter(line => /\dh ago/.test(line));
		const header = screen(manager).find(line => line.includes("SECRETS"));
		if (header === undefined) throw new Error("the log table painted no header");
		expect(rows).toHaveLength(2);

		const columnOf = (line: string, cell: string) => visibleWidth(line.slice(0, line.indexOf(cell)));
		const secretsColumn = rows.map(line => columnOf(line, "#SPENT_TOKEN#"));
		// The card is centred, so the absolute column includes the shell's left pad. What matters
		// is that all three agree: two rows and the heading they sit under.
		expect(secretsColumn[0]).toBe(secretsColumn[1]);
		expect(columnOf(header, "SECRETS")).toBe(secretsColumn[0]);
	});

	/**
	 * The WIDTH of the TOOL column is what the padding is measured against, so the check above
	 * would also pass if both rows were mis-measured identically. This pins the gap: `bash` is
	 * four columns inside a column sized for `mcp__文書__検索`, which is fifteen, so the ASCII cell
	 * carries eleven columns of padding plus the table's two-column gap.
	 */
	it("sizes the TOOL column to the widest cell in terminal columns, not code units", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({ at: NOW - 3_600_000, tool: "bash", command: "curl #SPENT_TOKEN#", secrets: ["#SPENT_TOKEN#"] });
		auditLog.record({
			at: NOW - 7_200_000,
			tool: "mcp__文書__検索",
			command: "search --index prod",
			secrets: ["#SPENT_TOKEN#"],
		});
		await auditLog.flush();
		const manager = await openLogView(auditLog);

		const rows = screen(manager).filter(line => /\dh ago/.test(line));
		const asciiRow = rows.find(line => line.includes("bash"));
		const wideRow = rows.find(line => line.includes("mcp__"));
		if (asciiRow === undefined || wideRow === undefined) throw new Error("the log table painted no rows");

		const gapAfter = (line: string, cell: string) => {
			const start = line.indexOf(cell) + cell.length;
			return line.slice(start).length - line.slice(start).trimStart().length;
		};
		expect(visibleWidth("mcp__文書__検索")).toBe(15);
		expect(gapAfter(asciiRow, "bash")).toBe(15 - visibleWidth("bash") + 2);
		expect(gapAfter(wideRow, "mcp__文書__検索")).toBe(2);
	});
});
