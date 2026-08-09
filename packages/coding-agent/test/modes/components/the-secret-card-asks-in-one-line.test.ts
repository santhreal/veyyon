/**
 * Every sentence the `/secret` card paints is ONE line.
 *
 * The class this closes: a hint, a refusal, a notice or an empty state written as a paragraph. The
 * card is at most 78 columns wide, so a paragraph wraps into a block of prose sitting between the
 * question and the field, in the one place an operator is mid-action and reading least. It arrived
 * three ways at once — a three-sentence hint on the environment field, a headline plus a blank plus
 * a guidance row for "nothing matched", and a two-paragraph explanation of a setting on the Log
 * view — so a test that pinned one of those sentences would have left the other two.
 *
 * WHAT THIS CATCHES. Every question the card can open, enumerated from the key map at run time
 * rather than listed here, so a new key with a paragraph hint fails on the day it is added. Every
 * refusal the add flow exports, enumerated from the module's own exports, so a new refusal is
 * caught whether or not anyone wires it to a field. The states that have no table and are therefore
 * all prose: an empty vault, a log that is not being recorded, a log narrowed to nothing.
 *
 * WHAT IT DOES NOT CATCH. It measures the budget, not the wording: a terse sentence that says the
 * wrong thing passes. It measures the sentence as authored, so a long interpolated value (a
 * forty-character variable name inside a refusal, a long search term) can still take a second row —
 * that is the wrapper doing its job on data, not an author writing a paragraph. The confirm bodies
 * are checked per line, so a body that grows a fourth line is not itself a failure.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as addFlow from "@veyyon/coding-agent/modes/components/secret-add-flow";
import { ADD_FLOW_SOURCES, SecretAddFlow } from "@veyyon/coding-agent/modes/components/secret-add-flow";
import { SECRET_MANAGER_HELP } from "@veyyon/coding-agent/modes/components/secret-help-overlay";
import { SecretManager } from "@veyyon/coding-agent/modes/components/secret-manager";
import { SECRET_CARD_PROSE_COLS } from "@veyyon/coding-agent/modes/components/secret-manager-types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "@veyyon/coding-agent/secrets/audit";
import {
	resolveVaultLocations,
	SecretVault,
	type VaultLocations,
	vaultPathFor,
} from "@veyyon/coding-agent/secrets/vault";
import { stripAnsi } from "@veyyon/utils";

const VALUE = "ghp_oneLineOfProseCredential7788";
/** Wide enough that the card renders at its own natural width rather than the terminal's. */
const WIDTH = 100;
const HEIGHT = 40;

let home: string;
let project: string;
let locations: VaultLocations;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
});

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-one-line-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-one-line-proj-"));
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

async function openManager(options?: { auditLog?: SecretAuditLog; empty?: boolean }): Promise<SecretManager> {
	const vault = new SecretVault(locations);
	if (options?.empty !== true) await vault.add({ name: "BACKUP_TOKEN", value: VALUE, scope: "profile" });
	const manager = new SecretManager({
		vault,
		terminalHeight: HEIGHT,
		refreshSecrets: async () => {},
		readEnv: () => undefined,
		auditLog: options?.auditLog,
	});
	await manager.settled();
	return manager;
}

/** The plain rows the card paints, with the frame and the blank margin stripped away. */
function body(manager: SecretManager): string[] {
	const rows = manager.render(WIDTH).map(line => stripAnsi(line).trimEnd());
	const top = rows.findIndex(row => row.includes("┌"));
	const bottom = rows.findIndex(row => row.includes("└"));
	if (top < 0 || bottom < 0) throw new Error("the card painted no frame");
	return rows.slice(top, bottom + 1).map(row => row.replace(/^\s*│ ?/, "").replace(/\s*│$/, ""));
}

/**
 * The rows of an open one-field prompt: everything between the title and the input line.
 *
 * `null` when the key did not open a field, which is how the enumeration below tells a question
 * apart from an action, a view switch or a confirmation without being told which is which.
 */
function questionRows(manager: SecretManager): string[] | null {
	const rows = body(manager);
	const input = rows.findIndex(row => /^>/.test(row.trim()));
	if (input < 0) return null;
	return rows.slice(1, input).filter(row => row.trim().length > 0);
}

/** Every single-character key the card's own map offers on the Secrets view. */
function secretViewKeys(): string[] {
	return SECRET_MANAGER_HELP.filter(entry => entry.keys.length === 1 && entry.view !== "log").map(entry => entry.keys);
}

describe("the refusals the add flow exports", () => {
	/**
	 * Enumerated from the module, so a refusal added tomorrow is measured without anyone
	 * remembering to list it here. The two builders take the variable name they echo.
	 */
	const refusals: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(addFlow)) {
		if (typeof value === "string" && name.endsWith("REFUSAL")) refusals.push([name, value]);
		if (typeof value === "function" && name.endsWith("Refusal")) {
			refusals.push([name, (value as (variable: string) => string)("GITHUB_TOKEN")]);
		}
	}

	it("finds every refusal the module exports", () => {
		// A guard on the enumeration itself: an `Object.entries` walk that matches nothing would
		// otherwise report a suite of zero passing measurements.
		expect(refusals.length).toBeGreaterThanOrEqual(5);
	});

	for (const [name, text] of refusals) {
		it(`${name} fits one line`, () => {
			expect(stripAnsi(text).length).toBeLessThanOrEqual(SECRET_CARD_PROSE_COLS);
		});
	}
});

describe("the questions the add flow asks", () => {
	/** Derived over the sources, so a third entry point cannot ship with a paragraph. */
	for (const source of ADD_FLOW_SOURCES) {
		it(`asks for a credential from ${source} in one line`, () => {
			const field = new SecretAddFlow({ source }).field;
			expect(field).not.toBeNull();
			expect(stripAnsi(field?.hint ?? "").length).toBeLessThanOrEqual(SECRET_CARD_PROSE_COLS);
		});
	}
});

describe("every question the card opens", () => {
	/**
	 * The whole key map is pressed and whatever opens a field is measured. This is the assertion
	 * that survives a new action: `v` was added to this card the week before this suite existed,
	 * and nothing about the test has to change for its hint to be held to the same line.
	 */
	it("asks in exactly one painted row", async () => {
		const measured: string[] = [];
		for (const key of secretViewKeys()) {
			const manager = await openManager();
			manager.handleInput(key);
			await manager.settled();
			const question = questionRows(manager);
			if (question === null) continue;
			measured.push(key);
			expect(question, `${key} asks its question in more than one row`).toHaveLength(1);
		}
		// The keys that open a field today. A drop to zero would make the loop above vacuous.
		expect(measured.length).toBeGreaterThanOrEqual(4);
	});
});

describe("the states that are nothing but prose", () => {
	/**
	 * An empty vault has no table, so its body IS its prose. Two rows of guidance were how the
	 * paragraph got in: the second sentence explained what the first one had already offered.
	 */
	it("tells an empty vault what to press in one row", async () => {
		const manager = await openManager({ empty: true });
		const prose = body(manager).filter(row => row.includes(" stores a credential"));

		expect(prose).toHaveLength(1);
		expect(prose[0]?.trim().length).toBeLessThanOrEqual(SECRET_CARD_PROSE_COLS);
		// Both sources and the placeholder survive the cut: this screen has nothing else to teach.
		expect(prose[0]).toContain("a stores a credential");
		expect(prose[0]).toContain("f reads one");
		expect(prose[0]).toContain("#NAME#");
	});

	/**
	 * Recording off is the state that carried two paragraphs to explain one setting. The name of
	 * the setting and its key are the only facts it holds; the empty table says the rest.
	 */
	it("names the recording setting in one row", async () => {
		const manager = await openManager();
		manager.handleInput("\t");
		await manager.settled();
		// EVERY row that talks about recording, not just the one naming the setting: the paragraph
		// this replaced said "not being recorded" first and named the setting three rows later, so a
		// filter on the setting's name alone would have found its one row and called that one line.
		const prose = body(manager).filter(row => /record/i.test(row) && !row.includes("Log (off)"));

		expect(prose).toHaveLength(1);
		expect(prose[0]?.trim().length).toBeLessThanOrEqual(SECRET_CARD_PROSE_COLS);
		expect(prose[0]).toContain("Record Secret Use");
		expect(prose[0]).toContain("secrets.auditLog");
	});

	/**
	 * A log narrowed to nothing: the finding and the way out. Three rows for "nothing matched" on a
	 * view whose table is already empty was the worst ratio of rows to facts on the card.
	 */
	it("reports a log narrowed to nothing in one row", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({
			at: Date.now(),
			secrets: ["#BACKUP_TOKEN#"],
			tool: "bash",
			command: "curl -H 'Authorization: bearer #BACKUP_TOKEN#' https://api.github.com/user",
		});
		await auditLog.flush();
		const manager = await openManager({ auditLog });
		manager.handleInput("\t");
		await manager.settled();
		manager.handleInput("/");
		await manager.settled();
		for (const char of "nothingmatchesthis") manager.handleInput(char);
		manager.handleInput("\n");
		await manager.settled();

		const prose = body(manager).filter(row => row.includes("matches"));
		expect(prose).toHaveLength(1);
		expect(prose[0]).toContain("Escape");
	});
});

describe("the warnings a confirmation carries", () => {
	/**
	 * A confirmation is the one place a card may legitimately paint several lines, and it is where
	 * the longest sentences on this card lived: revoke spent two sentences on "the value is gone",
	 * and discard spent three on "the file is moved". Each LINE of the body is measured, so the
	 * body may grow a line without failing but no line may become a paragraph.
	 */
	it("warns about a revoke in one row", async () => {
		const manager = await openManager();
		manager.handleInput("r");
		await manager.settled();
		const rows = body(manager).filter(row => row.includes("deleted"));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.trim().length).toBeLessThanOrEqual(SECRET_CARD_PROSE_COLS);
		expect(rows[0]).toContain("#BACKUP_TOKEN#");
	});

	/**
	 * The unreadable-vault path: its reason is painted straight into the confirm body, so the
	 * reason and the warning under it are both held to the line.
	 */
	it("warns about a discarded vault file in one row", async () => {
		await new SecretVault(locations).add({ name: "OTHER_TOKEN", value: VALUE, scope: "project" });
		await fs.writeFile(vaultPathFor(locations, "project"), "not-json-at-all", { mode: 0o600 });
		const manager = await openManager();
		const broken = body(manager).some(row => row.includes("unreadable") || row.includes("would not"));
		expect(broken).toBe(true);

		// Select the broken row, then ask to discard it.
		for (let i = 0; i < 4; i++) {
			manager.handleInput("j");
			await manager.settled();
			manager.handleInput("d");
			await manager.settled();
			const rows = body(manager).filter(row => row.includes("MOVED aside"));
			if (rows.length > 0) {
				expect(rows).toHaveLength(1);
				expect(rows[0]?.trim().length).toBeLessThanOrEqual(SECRET_CARD_PROSE_COLS);
				return;
			}
			manager.handleInput("\u001b");
			await manager.settled();
		}
		throw new Error("never reached the discard confirmation");
	});
});
