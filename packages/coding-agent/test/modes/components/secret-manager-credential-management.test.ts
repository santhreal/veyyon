/**
 * The secret manager as a credential manager, rather than a table you can only walk.
 *
 * WHY THIS SUITE EXISTS. The card shipped able to show credentials and revoke, extend, rename and
 * copy them. Everything else an operator arrives wanting was missing, and each gap below was a
 * real dead end rather than a rough edge:
 *
 *  - You could not STORE a credential in the secret manager. You had to close it and type
 *    `/secret`, which is the surface the card exists to replace.
 *  - You could not SEARCH. A vault with forty entries was walked one arrow press at a time.
 *  - You could not SORT, so "which of these expires first" had no answer on screen.
 *  - `VaultEntry.createdAt` was recorded on every secret and displayed NOWHERE in the product, and
 *    the expansion log knew what each placeholder had been spent on but was never joined to the
 *    roster.
 *  - A credential stored in the wrong scope had to be revoked and retyped from its original
 *    source, because nothing offered to move it.
 *
 * These tests drive the real component against a real vault in a temp directory and assert
 * painted bytes and vault state. They are deliberately not unit tests of the shaping modules,
 * which own their own suites: what is proven here is that the card is WIRED to them, which is the
 * part that a green module suite says nothing about.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SECRET_MANAGER_HELP } from "@veyyon/coding-agent/modes/components/secret-help-overlay";
import { SecretManager } from "@veyyon/coding-agent/modes/components/secret-manager";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "@veyyon/coding-agent/secrets/audit";
import { resolveVaultLocations, SecretVault, type VaultLocations } from "@veyyon/coding-agent/secrets/vault";
import { stripAnsi } from "@veyyon/utils";

const WIDTH = 100;
const HEIGHT = 40;

/** Fixed so "3d ago" is a constant in the assertions rather than a function of the wall clock. */
const NOW = Date.parse("2026-07-31T12:00:00Z");
const DAY = 86_400_000;

let home: string;
let project: string;
let locations: VaultLocations;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(dark);
});

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-mgr-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-mgr-proj-"));
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

function vault(): SecretVault {
	return new SecretVault(locations, () => NOW);
}

function screen(manager: SecretManager): string[] {
	return manager.render(WIDTH).map(line => stripAnsi(line).trimEnd());
}

/**
 * The card's rows with the box border removed, so a scan can anchor to the start of a row.
 *
 * Every painted line arrives wrapped in `│ ... │` at a left margin. A regex anchored with `^`
 * against the raw line matches the margin rather than the row, which silently returns nothing
 * and makes an ordering assertion fail against a table that is perfectly correct.
 */
function body(manager: SecretManager): string[] {
	return screen(manager).map(line => line.replace(/^\s*│/, "").replace(/│\s*$/, ""));
}

/** The whole painted card as one string, for asserting that something is or is not on screen. */
function text(manager: SecretManager): string {
	return screen(manager).join("\n");
}

async function open(
	auditLog?: SecretAuditLog,
	readEnv?: (variable: string) => string | undefined,
): Promise<SecretManager> {
	const manager = new SecretManager({
		vault: vault(),
		terminalHeight: HEIGHT,
		now: () => NOW,
		auditLog,
		// Injected rather than written into `process.env`, which would leak the variable into every
		// test file that runs after this one.
		readEnv,
	});
	await manager.settled();
	manager.render(WIDTH);
	return manager;
}

/** Type a string into an open prompt one key at a time, the way a terminal delivers it. */
async function type(manager: SecretManager, value: string): Promise<void> {
	// Settled BEFORE typing as well as after: the key that opens a flow queues its first field,
	// so characters delivered immediately would reach the list underneath and press its actions.
	await manager.settled();
	for (const character of value) manager.handleInput(character);
	manager.handleInput("\r");
	// The add flow opens its next field inside the same queued chain, so settling covers the
	// whole step. No wall-clock wait is involved, and none should be added: a flow that needed
	// one would mean a step had escaped the queue and become unobservable to its caller.
	await manager.settled();
}

/**
 * The placeholders in the table, in paint order.
 *
 * Anchored to the row shape rather than to "the line contains a `#`". The footer carries a
 * `c copy #NAME#` chip, so a looser scan picks that up as a fifth credential and every ordering
 * assertion fails against a table that is in fact correct.
 */
function placeholderOrder(manager: SecretManager): string[] {
	const rows: string[] = [];
	for (const line of body(manager)) {
		const match = /^\s*[›❯]?\s+(#[A-Z0-9_]+#)\s+\S/.exec(line);
		if (match) rows.push(match[1]);
	}
	return rows;
}

/**
 * Four credentials whose names, scopes and expiries deliberately disagree.
 *
 * A sort only demonstrates anything when the orderings differ from each other: if name order and
 * expiry order coincide, a card that ignored the sort key entirely would pass.
 */
async function seed(): Promise<void> {
	const store = vault();
	await store.add({ name: "GITHUB_TOKEN", value: "ghp_alpha_value", scope: "profile", ttl: 7 * DAY });
	await store.add({ name: "STRIPE_KEY", value: "sk_beta_value", scope: "project", ttl: 1 * DAY });
	await store.add({ name: "DEPLOY_KEY", value: "dk_gamma_value", scope: "global", ttl: null });
	await store.add({ name: "AWS_SECRET", value: "aws_delta_value", scope: "profile", ttl: 30 * DAY });
}

describe("storing a credential from inside the card", () => {
	/**
	 * THE CARD CAN STORE A CREDENTIAL. Before this, `a` did nothing and the only way to add a
	 * secret was to close the manager and use the slash command, which made "secret manager" a
	 * name for a read-only roster. The assertion is on the VAULT, not on a notice, because a card
	 * that said "Stored" without writing anything would satisfy a screen-only check.
	 */
	it("stores the credential in the default scope as soon as the value is given", async () => {
		const manager = await open();

		manager.handleInput("a");
		await type(manager, "ghp_secret_value");

		const stored = await vault().load();
		expect(stored).toHaveLength(1);
		expect(stored[0].value).toBe("ghp_secret_value");
		expect(stored[0].scope).toBe("profile");
		expect(stored[0].name.length).toBeGreaterThan(0);
	});

	/**
	 * ONE FIELD, NOT THREE. Storing one credential used to cost a masked value prompt, then a name
	 * prompt, then a scope prompt. The middle one is also the defect that once stored the literal
	 * string `GITHUB_TOKEN` as a live credential: a masked field opened before any value had been
	 * given reads as a request for the name, so the operator typed the name into it.
	 *
	 * Counted from the SCREEN rather than from the flow object, because the flow can hold one step
	 * while the container opens two prompts, and the operator only ever sees the container.
	 */
	it("asks one question and returns to the roster", async () => {
		const manager = await open();

		manager.handleInput("a");
		await manager.settled();
		const asked = text(manager);
		await type(manager, "ghp_real_credential");
		const after = text(manager);

		expect(asked).toContain("New secret: paste the value");
		// No second question: the card is back on its own roster, showing what it stored.
		expect(after).not.toContain("New secret:");
		expect(after).toContain("Stored #");
		const stored = await vault().load();
		expect(stored).toHaveLength(1);
		expect(stored[0].value).toBe("ghp_real_credential");
	});

	/**
	 * The value field never paints what is typed into it. A credential echoed onto a full-screen
	 * card is readable by anyone behind the operator and lands in any terminal scrollback capture,
	 * which is the whole reason the vault exists rather than an environment variable.
	 */
	it("never echoes the credential while it is being typed", async () => {
		const manager = await open();

		manager.handleInput("a");
		for (const character of "ghp_visible_secret") manager.handleInput(character);

		expect(text(manager)).not.toContain("ghp_visible_secret");
		expect(text(manager)).not.toContain("ghp_");
	});

	/**
	 * The vault names the entry, and the confirmation NAMES THE PLACEHOLDER IT MINTED and the keys
	 * that change it. A generated name the operator is never told about is a credential they cannot
	 * spend: the placeholder is the only handle the model has on it.
	 */
	it("names the credential itself and says how to change that", async () => {
		const manager = await open();

		manager.handleInput("a");
		await type(manager, "some_value_here");

		const stored = await vault().load();
		expect(stored).toHaveLength(1);
		expect(stored[0].value).toBe("some_value_here");
		// ON ONE PAINTED ROW. A receipt that wraps pushes the table down and reads as an error, so
		// the row is located and asserted whole rather than matched against the flattened screen.
		const receipt = body(manager).filter(line => line.includes("Stored #"));
		expect(receipt).toHaveLength(1);
		expect(receipt[0]).toContain(`Stored #${stored[0].name}# in profile. n renames, m moves.`);
	});

	/**
	 * THE ROW IT STORED IS THE SELECTED ROW.
	 *
	 * The confirmation points at `n` and `m`, and both act on the selection. With four credentials
	 * already in the vault the cursor sits on the first of them, so a store that left the selection
	 * alone would tell the operator to press a key that renames somebody else's credential. Driven
	 * through the real `n` action rather than by reading a private field, because the mistake this
	 * closes is a rename landing on the wrong entry.
	 */
	it("selects the credential it just stored, so the keys it names act on it", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("a");
		await type(manager, "ghp_the_new_one");
		const created = (await vault().load()).find(entry => entry.value === "ghp_the_new_one");
		expect(created).toBeDefined();

		manager.handleInput("n");
		await manager.settled();
		// The rename field is prefilled with the SELECTED row's name, so the title alone says which
		// credential the key reached. Typed on the end of that prefill, which is what a terminal does.
		expect(text(manager)).toContain(`Rename #${created?.name}#`);
		await type(manager, "_RENAMED");

		const after = await vault().load();
		expect(after.find(entry => entry.name === `${created?.name}_RENAMED`)?.value).toBe("ghp_the_new_one");
		// And the credential that was selected before the store still carries its own name.
		expect(after.map(entry => entry.name)).toContain("AWS_SECRET");
	});

	/**
	 * A SEARCH DOES NOT HIDE WHAT WAS JUST STORED. The filter is cleared by the store, because a
	 * generated name almost never matches whatever the operator was searching for: the row would be
	 * absent from a table that had just reported storing it, and `n` would act on a hidden selection.
	 */
	it("clears an active filter so the new row is on screen", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "STRIPE");
		expect(placeholderOrder(manager)).toEqual(["#STRIPE_KEY#"]);

		manager.handleInput("a");
		await type(manager, "ghp_after_the_filter");

		const created = (await vault().load()).find(entry => entry.value === "ghp_after_the_filter");
		expect(created).toBeDefined();
		expect(placeholderOrder(manager)).toContain(`#${created?.name}#`);
		expect(placeholderOrder(manager)).toContain("#GITHUB_TOKEN#");
	});

	/**
	 * An empty value is refused rather than stored. An empty credential is never what was meant,
	 * and the vault would reject it anyway: refusing it at the field keeps the flow open so the
	 * operator can simply type the value, rather than dropping them back to the list.
	 */
	it("refuses an empty value and keeps the field open", async () => {
		const manager = await open();

		manager.handleInput("a");
		await type(manager, "");

		expect(text(manager).toLowerCase()).toContain("empty");
		expect(await vault().load()).toHaveLength(0);
	});

	/**
	 * `f`: THE CREDENTIAL IS NEVER TYPED AND NEVER DRAWN.
	 *
	 * `/secret --from-env VAR` has offered this on the command line since the feature shipped, and the
	 * card could not do it at all, so the manager was missing the one entry form where the value does
	 * not pass through the screen, the input buffer or the shell history. The assertion is on the
	 * VAULT: a card that said "Stored" without writing the variable's bytes would pass a screen check.
	 */
	it("stores a credential read out of an environment variable", async () => {
		const manager = await open(undefined, variable =>
			variable === "GITHUB_TOKEN" ? "ghp_from_the_environment" : undefined,
		);

		manager.handleInput("f");
		await type(manager, "GITHUB_TOKEN");

		const stored = await vault().load();
		expect(stored).toHaveLength(1);
		expect(stored[0].value).toBe("ghp_from_the_environment");
		expect(stored[0].scope).toBe("profile");
	});

	/**
	 * The confirmation SAYS WHICH VARIABLE was read. It is the only add whose value the operator never
	 * saw, so the moment it is stored is the only cheap moment to notice that the wrong variable was
	 * named; after that the credential is only ever spent as a placeholder.
	 */
	it("names the variable in the confirmation, and never the value", async () => {
		const manager = await open(undefined, () => "ghp_from_the_environment");

		manager.handleInput("f");
		await type(manager, "GITHUB_TOKEN");

		const stored = await vault().load();
		const receipt = body(manager).filter(line => line.includes("Stored #"));
		expect(receipt).toHaveLength(1);
		expect(receipt[0]).toContain(`Stored #${stored[0].name}# from $GITHUB_TOKEN in profile. n renames, m moves.`);
		expect(text(manager)).not.toContain("ghp_from_the_environment");
	});

	/**
	 * The variable's NAME is drawn while it is typed, unlike the value field. Masking it would make a
	 * typo indistinguishable from an unset variable, which are the two failures that step tells apart,
	 * and it would also imply the operator was being asked for the credential itself.
	 */
	it("shows the variable name as it is typed and asks for a name, not a value", async () => {
		const manager = await open(undefined, () => "ghp_from_the_environment");

		manager.handleInput("f");
		await manager.settled();
		const prompt = text(manager);
		for (const character of "GITHUB_TOKEN") manager.handleInput(character);

		expect(prompt).toContain("New secret: name the environment variable");
		expect(prompt.toLowerCase()).not.toContain("paste the value");
		expect(text(manager)).toContain("GITHUB_TOKEN");
	});

	/**
	 * A variable that is not set is refused AT THE FIELD, naming it, with the flow still open. The
	 * class this closes is a refusal arriving from `vault.add` after all three questions, which tears
	 * the flow down and costs the operator every answer they gave.
	 */
	it("refuses an unset variable by name and keeps the field open", async () => {
		const manager = await open(undefined, () => undefined);

		manager.handleInput("f");
		await type(manager, "GITHUB_TOEKN");

		const painted = text(manager);
		expect(painted).toContain("GITHUB_TOEKN");
		expect(painted).toContain("New secret: name the environment variable");
		expect(await vault().load()).toHaveLength(0);
	});

	/**
	 * `f` is reachable with the pointer as well as the key. A chip that draws and does nothing when
	 * clicked is the exact defect the footer was rebuilt to remove: it advertises an action the card
	 * refuses to perform, on the screen a new operator sees first.
	 */
	it("starts the same flow when the footer's from-env chip is clicked", async () => {
		const manager = await open(undefined, () => "ghp_from_the_environment");
		const footer = screen(manager).findIndex(line => line.includes("f from env"));
		expect(footer).toBeGreaterThan(-1);
		const column = screen(manager)[footer].indexOf("f from env") + 2;

		manager.handleInput(`\u001b[<0;${column + 1};${footer + 1}M`);
		manager.handleInput(`\u001b[<0;${column + 1};${footer + 1}m`);
		await manager.settled();

		expect(text(manager)).toContain("New secret: name the environment variable");
	});
});

describe("searching the roster", () => {
	/**
	 * THE FILTER NARROWS THE TABLE. Without it a vault of any size is walked one arrow at a time.
	 * Both the surviving row and the excluded ones are asserted, because a filter that returned
	 * everything and a filter that returned nothing each pass a one-sided check.
	 */
	it("shows only the credentials matching what you typed", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "stripe");

		const painted = text(manager);
		expect(painted).toContain("#STRIPE_KEY#");
		expect(painted).not.toContain("#GITHUB_TOKEN#");
		expect(painted).not.toContain("#DEPLOY_KEY#");
		expect(painted).not.toContain("#AWS_SECRET#");
	});

	/**
	 * A NARROWED LIST SAYS SO, AND SAYS OUT OF HOW MANY.
	 *
	 * A filtered table that looks identical to an unfiltered one is how an operator concludes a
	 * credential was never stored when it is three characters outside their search. The total is
	 * part of the sentence for the same reason: "showing 1" alone does not tell you anything is
	 * hidden.
	 */
	it("announces that the list is narrowed and how much it is hiding", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "key");

		expect(text(manager)).toContain("Showing 2 of 4");
	});

	/**
	 * Matching runs over the PLACEHOLDER, not the bare name, so the `#` an operator sees on every
	 * row is something they can type. Searching for the text on screen finding nothing would be a
	 * silent contradiction between what the card shows and what it accepts.
	 */
	it("matches the placeholder form shown on the row", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "#github");

		expect(text(manager)).toContain("#GITHUB_TOKEN#");
		expect(text(manager)).not.toContain("#STRIPE_KEY#");
	});

	/**
	 * ESCAPE CLEARS THE SEARCH, and there has to be some key that does.
	 *
	 * The field opens seeded with the current search so it can be amended, which means reopening
	 * it and pressing enter re-submits the SAME search: pressing `/` and confirming is not a way
	 * to clear it. Without escape clearing, backspacing the field to nothing would be the only
	 * route back to the full list, and an operator who pressed escape would be left looking at a
	 * filtered vault with no indication that a key had failed to do anything.
	 */
	it("restores the whole list when the search is cleared with escape", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "stripe");
		expect(text(manager)).not.toContain("#GITHUB_TOKEN#");

		manager.handleInput("/");
		await manager.settled();
		manager.handleInput("\x1b");
		await manager.settled();

		const painted = text(manager);
		expect(painted).toContain("#STRIPE_KEY#");
		expect(painted).toContain("#GITHUB_TOKEN#");
		expect(painted).toContain("#DEPLOY_KEY#");
		expect(painted).toContain("#AWS_SECRET#");
	});

	/**
	 * A SEARCH THAT MATCHED NOTHING IS NOT AN EMPTY VAULT.
	 *
	 * The onboarding text ("Nothing stored") shown to someone whose search simply missed tells
	 * them their credentials are gone, which is the single wrong conclusion this card exists to
	 * prevent. The two empty states must read differently.
	 */
	it("distinguishes a search that matched nothing from an empty vault", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "nothing_matches_this");

		const painted = text(manager);
		expect(painted).toContain("Nothing matches");
		expect(painted).not.toContain("Nothing stored");
	});

	/**
	 * Filtering does not touch the vault. A search is a view over what you own, and a card that
	 * pruned as it filtered would turn a typo into data loss.
	 */
	it("leaves every stored credential in the vault", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("/");
		await type(manager, "stripe");

		expect(await vault().load()).toHaveLength(4);
	});
});

describe("ordering the roster", () => {
	/**
	 * THE SORT KEY REACHES THE TABLE. The expiry ordering is asserted rather than the name
	 * ordering because name order is the default: a card that ignored the key entirely would pass
	 * an assertion about names and fail this one.
	 *
	 * `DEPLOY_KEY` never expires and must sort LAST under soonest-first, not first. Treating a
	 * null expiry as zero is the ordinary way to get this wrong, and it would put the one
	 * credential with no deadline at the top of a list sorted by deadline.
	 */
	it("reorders the table by expiry, with the never-expiring entry last", async () => {
		await seed();
		const manager = await open();

		// name -> scope -> expiry
		manager.handleInput("s");
		manager.handleInput("s");

		const order = placeholderOrder(manager);
		expect(order).toEqual(["#STRIPE_KEY#", "#GITHUB_TOKEN#", "#AWS_SECRET#", "#DEPLOY_KEY#"]);
	});

	/**
	 * The card says how it is ordered. A table that silently reordered under a keypress reads as
	 * rows appearing and disappearing, especially next to the filter whose key is adjacent.
	 */
	it("names the active sort on screen", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("s");
		manager.handleInput("s");

		expect(text(manager)).toContain("sorted by expiry");
	});

	/**
	 * The cursor stays on the CREDENTIAL across a reorder, not on the row number. Otherwise
	 * pressing sort and then revoke would revoke whatever happened to land under the old index,
	 * which is a destructive action aimed at the wrong secret.
	 */
	it("keeps the cursor on the same credential when the order changes", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("j");
		const before = body(manager).find(line => line.includes("›"));
		manager.handleInput("s");
		const after = body(manager).find(line => line.includes("›"));

		expect(before).toBeDefined();
		expect(after).toBeDefined();
		const name = (line: string) => line.slice(line.indexOf("#")).split(" ")[0];
		expect(name(after ?? "")).toBe(name(before ?? ""));
	});
});

describe("inspecting one credential", () => {
	/**
	 * `createdAt` IS RECORDED ON EVERY SECRET AND WAS DISPLAYED NOWHERE. The detail panel is the
	 * only surface in the product that answers "when did I store this", which matters when
	 * deciding whether a token predates a rotation.
	 */
	it("shows when the selected credential was stored", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("i");

		expect(text(manager)).toContain("added");
	});

	/**
	 * THE EXPANSION LOG IS JOINED TO THE ROSTER. The log already knew which tools received which
	 * placeholder, and the roster already knew what existed, and nothing put the two together, so
	 * "where has this credential been spent" could only be answered by reading a separate view and
	 * matching names by eye.
	 */
	it("reports how often the credential was used and which tools received it", async () => {
		await seed();
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({
			at: NOW - 3_600_000,
			tool: "bash",
			command: "curl #GITHUB_TOKEN#",
			secrets: ["#GITHUB_TOKEN#"],
		});
		auditLog.record({
			at: NOW - 7_200_000,
			tool: "fetch",
			command: "get #GITHUB_TOKEN#",
			secrets: ["#GITHUB_TOKEN#"],
		});
		await auditLog.flush();
		const manager = await open(auditLog);

		manager.handleInput("/");
		await type(manager, "github");
		manager.handleInput("i");

		const painted = text(manager);
		expect(painted).toContain("2");
		expect(painted).toContain("bash");
		expect(painted).toContain("fetch");
	});

	/**
	 * A credential that has never been spent says so in words. A `0` beside an empty tool list
	 * reads as a panel that failed to load its data rather than as a fact about the credential.
	 */
	it("says an unused credential has not been used, rather than showing a bare zero", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("i");

		expect(text(manager)).toContain("not used yet");
	});

	/**
	 * The panel never renders the credential itself. It is the densest surface in the card and the
	 * most tempting place for a value to appear beside its metadata, which is exactly why this is
	 * asserted rather than assumed.
	 */
	it("never renders the stored value", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("i");

		const painted = text(manager);
		expect(painted).not.toContain("ghp_alpha_value");
		expect(painted).not.toContain("sk_beta_value");
		expect(painted).not.toContain("dk_gamma_value");
	});

	/** The panel is a toggle: a second press closes it and gives the rows back to the table. */
	it("closes again on a second press", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("i");
		expect(text(manager)).toContain("added");
		manager.handleInput("i");
		expect(text(manager)).not.toContain("not used yet");
	});
});

describe("moving a credential between scopes", () => {
	/**
	 * A MOVE IS POSSIBLE AT ALL. Before this, a credential stored in the wrong scope had to be
	 * revoked and retyped from whatever system issued it, which for a rotated token means going
	 * back to the issuer.
	 */
	it("moves the credential to the next scope and leaves the source empty", async () => {
		const store = vault();
		await store.add({ name: "GITHUB_TOKEN", value: "ghp_alpha_value", scope: "project", ttl: null });
		const manager = await open();

		manager.handleInput("m");
		// Settled between the two: planning the move reads every scope, so the confirmation this
		// Enter is meant for has not been painted yet when the key press is delivered.
		await manager.settled();
		manager.handleInput("\r");
		await manager.settled();

		const entries = await vault().load();
		expect(entries).toHaveLength(1);
		expect(entries[0].name).toBe("GITHUB_TOKEN");
		expect(entries[0].value).toBe("ghp_alpha_value");
		expect(entries[0].scope).not.toBe("project");
	});

	/**
	 * THE MOVE DELETES THE SOURCE, NEVER THE COPY IT JUST WROTE.
	 *
	 * `vault.remove(name)` searches narrowest scope first. A move INTO the narrower scope with an
	 * unrestricted delete therefore finds the entry it has just written, deletes that, and leaves
	 * the original untouched: the card reports a successful move and nothing has moved. The fix is
	 * the scope argument on `remove`, and this test is what holds it in place.
	 */
	it("deletes the source copy when moving into a narrower scope", async () => {
		const store = vault();
		await store.add({ name: "DEPLOY_KEY", value: "dk_gamma_value", scope: "global", ttl: null });
		const manager = await open();

		manager.handleInput("m");
		// Settled between the two: planning the move reads every scope, so the confirmation this
		// Enter is meant for has not been painted yet when the key press is delivered.
		await manager.settled();
		manager.handleInput("\r");
		await manager.settled();

		const entries = await vault().load();
		expect(entries).toHaveLength(1);
		expect(entries[0].scope).toBe("profile");
		expect(entries[0].value).toBe("dk_gamma_value");
	});

	/**
	 * A move onto a name the destination already holds is REFUSED BEFORE ANYTHING RUNS.
	 *
	 * The move is an add followed by a remove. Running it into a collision overwrites a different
	 * live credential and then deletes the one being moved: two secrets lost, nothing gained. It
	 * has to be refused up front, because discovering it after the remove is discovering it too
	 * late.
	 */
	it("refuses a move onto a name the destination already holds, and keeps both credentials", async () => {
		const store = vault();
		// project is the SOURCE and global is where the cycle sends it, so the collision has to be
		// seeded in global. Seeded anywhere else the move is legal and this proves nothing.
		await store.add({ name: "SHARED", value: "project_value_x", scope: "project", ttl: null });
		await store.add({ name: "SHARED", value: "global_value_xx", scope: "global", ttl: null });
		const manager = await open();

		manager.handleInput("m");
		await manager.settled();

		// `loadEverywhere` rather than `load`: the collapsed read reports one entry for a name held
		// twice, so it cannot tell "both survived" from "one was destroyed".
		const values = (await vault().loadEverywhere()).map(entry => entry.value).sort();
		expect(values).toEqual(["global_value_xx", "project_value_x"]);
	});

	/** The refusal explains itself rather than doing nothing, so the key does not read as broken. */
	it("explains why a colliding move was refused", async () => {
		const store = vault();
		await store.add({ name: "SHARED", value: "project_value_x", scope: "project", ttl: null });
		await store.add({ name: "SHARED", value: "global_value_xx", scope: "global", ttl: null });
		const manager = await open();

		manager.handleInput("m");
		await manager.settled();

		expect(text(manager).toLowerCase()).toContain("already holds");
	});

	/**
	 * The remaining lifetime survives the move. `vault.add` takes a lifetime measured from now
	 * while the entry carries an absolute expiry, so passing the timestamp straight through would
	 * hand the moved copy a lifetime of decades and quietly defeat the expiry the operator chose.
	 */
	it("preserves the remaining lifetime rather than resetting or extending it", async () => {
		const store = vault();
		await store.add({ name: "GITHUB_TOKEN", value: "ghp_alpha_value", scope: "project", ttl: 2 * DAY });
		const manager = await open();

		manager.handleInput("m");
		// Settled between the two: planning the move reads every scope, so the confirmation this
		// Enter is meant for has not been painted yet when the key press is delivered.
		await manager.settled();
		manager.handleInput("\r");
		await manager.settled();

		const moved = (await vault().load())[0];
		expect(moved.expiresAt).not.toBeNull();
		expect(moved.expiresAt).toBe(NOW + 2 * DAY);
	});

	/** The confirmation never carries the value: the operator reads it, and so does anyone nearby. */
	it("never shows the value in the confirmation", async () => {
		const store = vault();
		await store.add({ name: "GITHUB_TOKEN", value: "ghp_alpha_value", scope: "project", ttl: null });
		const manager = await open();

		manager.handleInput("m");

		expect(text(manager)).not.toContain("ghp_alpha_value");
	});
});

describe("the key map", () => {
	/**
	 * EVERY ACTION IS DISCOVERABLE. The footer carries a handful of chips on one row and silently
	 * drops whatever overflows, so the actions added here would work while being invisible. A key
	 * that exists but is undocumented is a key nobody presses.
	 */
	it("lists the actions the footer has no room for", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("?");

		// Matched as a KEY COLUMN entry, not as a bare letter anywhere on screen. Single letters
		// occur in ordinary prose, so `toContain("a")` passes against a blank overlay.
		const bound = new Set<string>();
		for (const line of body(manager)) {
			// The key column can hold spaces (`up/down, j/k`), so the split is on the COLUMN GAP of two
			// or more spaces, not on the first space. Splitting on the first space matched `up/down,`
			// and made a row that renders correctly look absent.
			const match = /^\s+(\S.*?)\s{2,}[a-z]/.exec(line);
			if (match) bound.add(match[1]);
		}
		// DERIVED FROM THE MAP, not from the keys whoever wrote this remembered. A row added to
		// SECRET_MANAGER_HELP that the overlay cannot draw at this width fails here, and the hardcoded
		// list this replaced would have stayed green.
		for (const entry of SECRET_MANAGER_HELP) {
			if (entry.view === "log") continue;
			expect(bound).toContain(entry.keys);
		}
	});

	/**
	 * EVERY DOCUMENTED KEY DOES SOMETHING. The map is prose: a row can be added for a key the switch
	 * never handles, and the operator then presses a documented key and watches the card ignore it.
	 * `f` was the reverse of that defect for a week — the action existed on the command line and had
	 * no key at all — so the agreement is asserted in both directions and derived from the map, which
	 * means a new row fails this test until it is either bound or recorded below.
	 *
	 * WHAT IT DOES NOT CATCH: that the key does the RIGHT thing. Each action has its own test above;
	 * this one only refuses a documented key that is not wired to anything.
	 */
	it("acts on every single-letter key the map documents for the roster", async () => {
		/**
		 * Keys whose effect is deliberately invisible on a healthy vault, with the reason recorded.
		 *
		 * A key added to the map and to neither this table nor the switch fails the assertion below,
		 * which is the point: the decision has to be written down somewhere.
		 */
		const SILENT_ON_A_HEALTHY_ROSTER: Readonly<Record<string, string>> = {
			// `d` repairs a vault FILE that would not open. There is no such file here, so the card
			// correctly does nothing: the action belongs to a broken row, and `secret-manager-degenerate-states`
			// drives it against one.
			d: "only a broken vault row offers it",
			// `i` toggles the detail panel, and `u`, `s`, `/`, `c` all repaint. Nothing else is silent.
		};

		const silent: string[] = [];
		for (const entry of SECRET_MANAGER_HELP) {
			if (entry.view === "log" || entry.keys.length !== 1 || !/[a-z]/.test(entry.keys)) continue;
			await seed();
			const manager = await open();
			// `q` closes the card, which repaints nothing: the effect leaves through `onClose`. Watching
			// it here is what keeps `q` out of the recorded-silent table, where it would have sat as an
			// excuse covering a key that in fact works.
			let closed = false;
			manager.onClose = () => {
				closed = true;
			};
			const before = text(manager);

			manager.handleInput(entry.keys);
			await manager.settled();

			if (text(manager) === before && !closed) {
				silent.push(entry.keys);
				continue;
			}
			// Escape out so the next key is delivered to a roster rather than into an open dialog.
			manager.handleInput("\x1b");
			await manager.settled();
		}
		// COMPARED AS A SET, so the failure names the key rather than printing a frame. A key that went
		// silent appears here; a recorded key that started working also appears, which is the direction
		// that would otherwise leave a stale excuse in the table forever.
		expect(silent.toSorted()).toEqual(Object.keys(SILENT_ON_A_HEALTHY_ROSTER).toSorted());
	});

	/**
	 * The overlay swallows every other key. It is a reading surface laid over the list, and a
	 * stray `r` reaching the card underneath would open a revoke confirmation for a credential the
	 * operator cannot currently see.
	 */
	it("does not act on a credential while the key map is open", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("?");
		manager.handleInput("r");
		await manager.settled();

		// The overlay's own key map DOCUMENTS revoke, so the word is on screen either way. What
		// distinguishes the two states is the confirmation's accept chip, which only the real
		// revoke dialog paints.
		expect(text(manager).toLowerCase()).not.toContain("enter yes");
		expect(await vault().load()).toHaveLength(4);
	});

	/** Escape closes the overlay and returns to the list rather than closing the whole card. */
	it("returns to the list on escape", async () => {
		await seed();
		const manager = await open();

		manager.handleInput("?");
		manager.handleInput("\x1b");

		expect(text(manager)).toContain("#GITHUB_TOKEN#");
	});
});

/**
 * THE FOOTER'S CHIPS, ALL OF THEM, CLICKED.
 *
 * The defect this closes shipped twice. First the roster's band was derived from the selected row, so
 * `a add` never appeared on any screen while the body text told the operator to press it. Then the
 * chip was added and its mouse dispatch was not, so it drew, highlighted under the pointer, and did
 * nothing when clicked. Both are the same class: a chip is a promise, and the card is the only thing
 * that can keep it.
 *
 * DERIVED FROM THE PAINTED FOOTER, not from a list of chips written here. A chip added to
 * `secretShortcuts` with no `case` in the mouse dispatch fails this test the first time it is
 * painted, which is the only way this cannot rot: the ids live in a switch the compiler does not
 * check against the label list.
 *
 * WHAT IT DOES NOT CATCH: whether the chip does what its LABEL says. Each action is asserted by its
 * own test above; this one only refuses a chip that is decoration.
 */
describe("every chip the roster footer paints", () => {
	/**
	 * Chips that are hints rather than actions, with the reason recorded.
	 *
	 * A chip added to the band and to neither this table nor the mouse dispatch fails the assertion
	 * below. That is the point: the decision has to be written down rather than inferred from a chip
	 * that happens to do nothing.
	 */
	const HINTS_NOT_ACTIONS: Readonly<Record<string, string>> = {
		// Two keys, and no single point to click: the pointer switches views by clicking the tab strip,
		// which `secret-manager-log-table-and-pointer` drives.
		"left/right view": "names the arrow keys, and the tabs above are what a pointer clicks",
	};

	/** The footer rows: everything painted below the card's divider. */
	function footerRows(manager: SecretManager): { row: number; text: string }[] {
		const lines = screen(manager);
		const divider = lines.findIndex(line => line.includes("├"));
		return lines
			.slice(divider + 1, lines.length - 1)
			.map((text, index) => ({ row: divider + 1 + index, text }))
			.filter(entry => entry.text.includes("·"));
	}

	it("does something when it is clicked", async () => {
		await seed();
		const labels = footerRows(await open())
			.flatMap(entry => entry.text.split("·"))
			.map(chip => chip.replace(/[│\s]+$/u, "").replace(/^[│\s]+/u, ""))
			.filter(chip => chip.length > 0);
		// A footer that painted nothing would make every assertion below vacuous, and the roster's band
		// is the widest one the card has.
		expect(labels.length).toBeGreaterThan(8);

		const inert: string[] = [];
		for (const label of labels) {
			const manager = await open();
			let closed = false;
			manager.onClose = () => {
				closed = true;
			};
			const before = text(manager);
			const target = footerRows(manager).find(entry => entry.text.includes(label));
			expect(target).toBeDefined();
			if (target === undefined) continue;
			// The middle of the label, so a click cannot land on the separator beside it. SGR-1006 press
			// then release, one-based on the wire, which is what a terminal sends.
			const column = target.text.indexOf(label) + Math.floor(label.length / 2) + 1;
			manager.handleInput(`\u001b[<0;${column};${target.row + 1}M`);
			manager.handleInput(`\u001b[<0;${column};${target.row + 1}m`);
			await manager.settled();

			if (text(manager) === before && !closed) inert.push(label);
		}

		expect(inert.toSorted()).toEqual(Object.keys(HINTS_NOT_ACTIONS).toSorted());
	});
});
