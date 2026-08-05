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

async function open(auditLog?: SecretAuditLog): Promise<SecretManager> {
	const manager = new SecretManager({
		vault: vault(),
		terminalHeight: HEIGHT,
		now: () => NOW,
		auditLog,
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
	it("stores a named credential in the chosen scope", async () => {
		const manager = await open();

		manager.handleInput("a");
		await type(manager, "ghp_secret_value");
		await type(manager, "GITHUB_TOKEN");
		await type(manager, "project");

		const stored = await vault().load();
		expect(stored).toHaveLength(1);
		expect(stored[0].name).toBe("GITHUB_TOKEN");
		expect(stored[0].value).toBe("ghp_secret_value");
		expect(stored[0].scope).toBe("project");
	});

	/**
	 * THE VALUE IS ASKED FOR FIRST AND THE NAME SECOND.
	 *
	 * This is the exact defect that once stored the literal string `GITHUB_TOKEN` as a live
	 * credential: a masked field opened before any value had been given reads as a request for the
	 * name, so the operator typed the name into it. If the order ever flips back, the value below
	 * lands in the name and this fails on both fields at once.
	 */
	it("asks for the value before the name, so the name is never stored as the value", async () => {
		const manager = await open();

		manager.handleInput("a");
		const firstPrompt = text(manager);
		await type(manager, "ghp_real_credential");
		const secondPrompt = text(manager);
		await type(manager, "GITHUB_TOKEN");
		await type(manager, "profile");

		expect(firstPrompt.toLowerCase()).toContain("value");
		expect(secondPrompt.toLowerCase()).toContain("name");
		const stored = await vault().load();
		expect(stored[0].value).toBe("ghp_real_credential");
		expect(stored[0].value).not.toBe("GITHUB_TOKEN");
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
	 * An empty name means "generate one", which is the documented behaviour of `vault.add`. It is
	 * asserted here because the card could plausibly have refused the blank field instead, which
	 * would force a name on an operator who deliberately wanted the generated one.
	 */
	it("accepts a blank name and lets the vault generate one", async () => {
		const manager = await open();

		manager.handleInput("a");
		await type(manager, "some_value_here");
		await type(manager, "");
		await type(manager, "profile");

		const stored = await vault().load();
		expect(stored).toHaveLength(1);
		expect(stored[0].name.length).toBeGreaterThan(0);
		expect(stored[0].value).toBe("some_value_here");
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
			const match = /^\s+(\S+)\s{2,}[a-z]/.exec(line);
			if (match) bound.add(match[1]);
		}
		for (const key of ["a", "m", "i", "s", "/"]) expect(bound).toContain(key);
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
