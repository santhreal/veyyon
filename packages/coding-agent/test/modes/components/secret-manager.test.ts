/**
 * The `/secret manager` card, driven against a real vault in a temp directory.
 *
 * Every assertion below reads the vault BACK from disk after the action. A manager that only
 * updates its own row list looks identical on screen to one that wrote, and the whole point of
 * this surface is that it is the thing operators use to change what is stored.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretManager } from "@veyyon/coding-agent/modes/components/secret-manager";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { SecretAuditLog, secretAuditPath } from "@veyyon/coding-agent/secrets/audit";
import { expiryWarnings } from "@veyyon/coding-agent/secrets/secret-command";
import {
	resolveVaultLocations,
	SecretVault,
	type VaultLocations,
	vaultPathFor,
} from "@veyyon/coding-agent/secrets/vault";
import { stripAnsi } from "@veyyon/utils";

/** The credential under test. Long enough to be obfuscatable, distinctive enough to grep for. */
const VALUE = "ghp_secretManagerCardCredential77";
/** A second one, so "the list shows every secret" is a claim about more than one row. */
const OTHER_VALUE = "sk-live-secretManagerSecondCred55";

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
	home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-manager-home-"));
	project = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-manager-proj-"));
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

/** The plain text the card paints, one entry per rendered row. */
function screen(manager: SecretManager): string[] {
	return manager.render(WIDTH).map(line => stripAnsi(line).trimEnd());
}

/** Everything the card paints, as one string, for absence assertions. */
function screenText(manager: SecretManager): string {
	return screen(manager).join("\n");
}

/** Type a value into the card's open one-field prompt, then submit it. */
function type(manager: SecretManager, text: string): void {
	for (const char of text) manager.handleInput(char);
	manager.handleInput("\n");
}

async function openManager(options?: {
	refreshSecrets?: () => Promise<void>;
	copy?: (text: string) => Promise<void>;
	now?: () => number;
	auditLog?: SecretAuditLog;
}): Promise<SecretManager> {
	const manager = new SecretManager({
		vault: new SecretVault(locations),
		terminalHeight: HEIGHT,
		refreshSecrets: options?.refreshSecrets,
		copy: options?.copy,
		now: options?.now,
		auditLog: options?.auditLog,
	});
	await manager.settled();
	return manager;
}

/** Switch to the Log view and let its read finish. */
async function openLogView(manager: SecretManager): Promise<SecretManager> {
	manager.handleInput("\t");
	await manager.settled();
	return manager;
}

describe("the secret manager list", () => {
	/**
	 * Every stored secret is reachable from the card. A manager that lists a subset makes the
	 * secrets it omits unmanageable, since this GUI is the only surface with revoke/extend/rename.
	 */
	it("lists every stored secret by placeholder", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		await vault.add({ name: "STRIPE_KEY", value: OTHER_VALUE, scope: "project" });

		const manager = await openManager();
		const text = screenText(manager);

		expect(text).toContain("#GITHUB_TOKEN#");
		expect(text).toContain("#STRIPE_KEY#");
		expect(text).toContain("profile");
		expect(text).toContain("project");
		expect(manager.rowCount).toBe(2);
	});

	/**
	 * THE PRODUCT'S CENTRAL PROMISE: a value put into the vault is never shown again. A management
	 * card is the likeliest place to break it, because "prove the entry is really there" reads as a
	 * reason to print what is stored, and this screen is the one people share.
	 */
	it("renders no secret value anywhere", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		await vault.add({ name: "STRIPE_KEY", value: OTHER_VALUE, scope: "project" });

		const manager = await openManager();
		const rendered = manager.render(WIDTH).join("\n");

		expect(rendered).not.toContain(VALUE);
		expect(rendered).not.toContain(OTHER_VALUE);
		// Not even a prefix long enough to be worth guessing from.
		expect(rendered).not.toContain(VALUE.slice(0, 12));
		expect(rendered).not.toContain(OTHER_VALUE.slice(0, 12));
	});

	/**
	 * `c` copies the PLACEHOLDER, which is what the operator pastes into a prompt. Copying the
	 * value would be the same disclosure the card exists to prevent, just routed through the
	 * system clipboard where nothing can take it back.
	 */
	it("copies the placeholder and never the value", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		const copied: string[] = [];
		const manager = await openManager({ copy: async text => void copied.push(text) });

		manager.handleInput("c");
		await manager.settled();

		expect(copied).toEqual(["#GITHUB_TOKEN#"]);
	});
});

describe("revoking from the manager", () => {
	/**
	 * `r` then Enter must actually delete the stored value, not just drop the row. A card that
	 * removed the row without writing would leave a live credential in the vault that the operator
	 * has been told is gone, and every later session would load it again.
	 */
	it("removes the entry from the vault and the row from the list", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		await vault.add({ name: "STRIPE_KEY", value: OTHER_VALUE, scope: "profile" });

		const manager = await openManager();
		manager.handleInput("r");
		manager.handleInput("\n");
		await manager.settled();

		const remaining = await new SecretVault(locations).load();
		expect(remaining.map(entry => entry.name)).toEqual(["STRIPE_KEY"]);
		expect(manager.rowCount).toBe(1);
		expect(screenText(manager)).toContain("#STRIPE_KEY#");
		// The only place the revoked name may still appear is the confirmation of what just
		// happened. A surviving TABLE row would say the credential is still stored.
		const mentions = screen(manager).filter(line => line.includes("#GITHUB_TOKEN#"));
		expect(mentions).toHaveLength(1);
		expect(mentions[0]).toContain("Revoked");
	});

	/**
	 * The confirm is a real gate. Dismissing it leaves the credential exactly where it was, which
	 * is the only reason to show a confirm at all.
	 */
	it("keeps the entry when the confirm is dismissed", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });

		const manager = await openManager();
		manager.handleInput("r");
		manager.handleInput("\x1b");
		await manager.settled();

		const remaining = await new SecretVault(locations).load();
		expect(remaining.map(entry => entry.name)).toEqual(["GITHUB_TOKEN"]);
	});

	/**
	 * A mutation that did not refresh the live obfuscator leaves the running session spending the
	 * state it captured at startup: the revoked value stays substitutable for the rest of the run.
	 */
	it("refreshes the live secret runtime after the write", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		let refreshes = 0;
		const manager = await openManager({
			refreshSecrets: async () => {
				refreshes++;
			},
		});

		manager.handleInput("r");
		manager.handleInput("\n");
		await manager.settled();

		expect(refreshes).toBe(1);
	});

	/**
	 * A refresh that throws is surfaced, not swallowed. The vault write is already durable at that
	 * point, so the session is out of step with disk and only the operator can decide what to do.
	 *
	 * The card is content-sized, so this sentence is longer than the card is wide and is wrapped
	 * across rows. The assertion reflows the body back into one line before matching, which is
	 * what makes it a proof about the WORDS reaching the operator rather than about where the
	 * wrap happened to fall — and it can assert the whole sentence instead of a fragment of it.
	 */
	it("reports a failed refresh on the card", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		const manager = await openManager({
			refreshSecrets: async () => {
				throw new Error("runtime coordinator is wedged");
			},
		});

		manager.handleInput("r");
		manager.handleInput("\n");
		await manager.settled();

		const reflowed = screen(manager)
			.map(row => row.replaceAll("│", " "))
			.join(" ")
			.replace(/\s+/g, " ");
		expect(reflowed).toContain(
			"The vault was updated, but the running session could not refresh secret protection: runtime coordinator is wedged",
		);
		expect(await new SecretVault(locations).load()).toEqual([]);
	});
});

describe("extending from the manager", () => {
	/**
	 * A valid TTL must move the stored deadline. A card that only redrew "7d left" would tell the
	 * operator their credential survives the week while the vault expires it tonight.
	 */
	it("moves expiresAt for a valid lifetime", async () => {
		const vault = new SecretVault(locations);
		const added = await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile", ttl: 60 * 60 * 1000 });

		const manager = await openManager();
		manager.handleInput("e");
		type(manager, "7d");
		await manager.settled();

		const [stored] = await new SecretVault(locations).load();
		expect(stored.name).toBe("GITHUB_TOKEN");
		expect(stored.value).toBe(VALUE);
		expect(stored.expiresAt).not.toBeNull();
		expect(stored.expiresAt as number).toBeGreaterThan(added.expiresAt as number);
		expect((stored.expiresAt as number) - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
	});

	/**
	 * An unparseable lifetime leaves the entry untouched and says so on the card. Falling back to a
	 * default here is how `7dd` silently becomes one day and a credential outlives its window;
	 * closing the card on the error is how the operator loses the reason.
	 */
	it("refuses an unparseable lifetime without touching the entry", async () => {
		const vault = new SecretVault(locations);
		const added = await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile", ttl: 60 * 60 * 1000 });

		const manager = await openManager();
		manager.handleInput("e");
		type(manager, "7dd");
		await manager.settled();

		const [stored] = await new SecretVault(locations).load();
		expect(stored.expiresAt).toBe(added.expiresAt);
		expect(screenText(manager)).toContain("That is not a lifetime");
	});
});

/**
 * `v`: correcting a credential in place.
 *
 * WHY IT IS ITS OWN GROUP. Every other write on this card changes a label, a lifetime or a location.
 * This one changes the SECRET, which makes it the only action whose failure is silent: a card that
 * reported success while the session kept spending the old bytes looks identical to one that worked.
 * That is why the refresh is asserted here and not left to the revoke group.
 */
describe("correcting a value from the manager", () => {
	/**
	 * The value changes and nothing else does. A correction that re-dated the entry would be `add`
	 * wearing another key, and an operator who corrected a typo would silently get a fresh lifetime.
	 */
	it("replaces the value and keeps the name, the scope and the expiry", async () => {
		const added = await new SecretVault(locations).add({
			name: "GITHUB_TOKEN",
			value: VALUE,
			scope: "profile",
			ttl: 60 * 60 * 1000,
		});

		const manager = await openManager();
		manager.handleInput("v");
		type(manager, OTHER_VALUE);
		await manager.settled();

		const [stored] = await new SecretVault(locations).load();
		expect(stored.name).toBe("GITHUB_TOKEN");
		expect(stored.value).toBe(OTHER_VALUE);
		expect(stored.scope).toBe("profile");
		expect(stored.expiresAt).toBe(added.expiresAt);
		expect(stored.createdAt).toBe(added.createdAt);
	});

	/**
	 * THE RUNNING SESSION HAS TO BE TOLD. The obfuscator captured the old value at startup; without a
	 * refresh the model keeps writing `#GITHUB_TOKEN#` and the session keeps substituting the bytes
	 * the operator just corrected, which is the one failure mode of this action that nothing on screen
	 * would reveal.
	 */
	it("refreshes the live secret runtime after the edit", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		let refreshes = 0;
		const manager = await openManager({
			refreshSecrets: async () => {
				refreshes++;
			},
		});

		manager.handleInput("v");
		type(manager, OTHER_VALUE);
		await manager.settled();

		expect(refreshes).toBe(1);
	});

	/** The new value is never painted, for the same reason the add field hides what is typed. */
	it("never echoes the corrected value", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });

		const manager = await openManager();
		manager.handleInput("v");
		for (const character of OTHER_VALUE) manager.handleInput(character);

		expect(screenText(manager)).not.toContain(OTHER_VALUE);
		type(manager, "");
		await manager.settled();
		expect(screenText(manager)).not.toContain(OTHER_VALUE);
	});

	/**
	 * A refused correction keeps the credential AND the field. Closing on the refusal would leave an
	 * operator staring at the roster with a half-corrected credential and no field to finish it in,
	 * and accepting the short value would store something the obfuscator cannot protect.
	 */
	it("keeps the credential and the field when the value is refused", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });

		const manager = await openManager();
		manager.handleInput("v");
		type(manager, "pin1234");
		await manager.settled();

		const [stored] = await new SecretVault(locations).load();
		expect(stored.value).toBe(VALUE);
		const painted = screenText(manager);
		expect(painted).toContain("New value for #GITHUB_TOKEN#");
		expect(painted).toContain("under the 8-character");
	});
});

describe("renaming from the manager", () => {
	/**
	 * A rename must carry the value across. Losing it would silently destroy the credential while
	 * leaving a row on screen that looks like it still works.
	 */
	it("changes the name and keeps the value", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });

		const manager = await openManager();
		manager.handleInput("n");
		// The field is prefilled with the current name, so a rename starts by clearing it.
		for (let i = 0; i < "GITHUB_TOKEN".length; i++) manager.handleInput("\x7f");
		type(manager, "GH_PAT");
		await manager.settled();

		const stored = await new SecretVault(locations).load();
		expect(stored.map(entry => entry.name)).toEqual(["GH_PAT"]);
		expect(stored[0].value).toBe(VALUE);
		expect(screenText(manager)).toContain("#GH_PAT#");
	});

	/**
	 * Renaming onto a live credential would destroy it in exchange for nothing, so the vault
	 * refuses and the card shows why with the field still open rather than closing on the failure.
	 */
	it("surfaces a name collision inline and changes nothing", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		await vault.add({ name: "STRIPE_KEY", value: OTHER_VALUE, scope: "profile" });

		const manager = await openManager();
		manager.handleInput("n");
		for (let i = 0; i < "GITHUB_TOKEN".length; i++) manager.handleInput("\x7f");
		type(manager, "STRIPE_KEY");
		await manager.settled();

		const stored = await new SecretVault(locations).load();
		expect(stored.map(entry => entry.name).sort()).toEqual(["GITHUB_TOKEN", "STRIPE_KEY"]);
		expect(stored.find(entry => entry.name === "STRIPE_KEY")?.value).toBe(OTHER_VALUE);
		expect(screenText(manager)).toContain("already has a secret named STRIPE_KEY");
	});
});

describe("an unreadable vault", () => {
	/**
	 * `load()` REFUSES a vault file it cannot read, and that refusal is correct. This card is the
	 * primary repair surface, so it has to absorb the refusal: a manager that propagates it leaves
	 * the operator unable to start and unable to fix, which is the exact dead end
	 * `discardUnreadableScope` exists to break.
	 */
	it("renders the repair state instead of throwing", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		const vaultPath = vaultPathFor(locations, "profile");
		await fs.writeFile(vaultPath, "not-json-at-all", { mode: 0o600 });

		const manager = await openManager();
		const text = screenText(manager);

		expect(text).toContain("Your vault could not be read");
		expect(text).toContain("profile vault unreadable");
		expect(manager.rowCount).toBe(1);
	});

	/**
	 * The tab counts CREDENTIALS, not rows. An unreadable scope occupies a row too, so counting
	 * rows rendered `Secrets (3)` directly above a body stating that nothing stored was available
	 * to the session: the tab was reporting three repair rows as three spendable secrets. That
	 * contradiction appears in exactly the state where the operator most needs to trust the card,
	 * and only a rendered image caught it, so it is pinned here.
	 */
	it("counts no secrets in the tab while the vault is unreadable", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		await fs.writeFile(vaultPathFor(locations, "profile"), "not-json-at-all", { mode: 0o600 });

		const text = screenText(await openManager());

		expect(text).toContain("Secrets (0)");
		expect(text).not.toContain("Secrets (1)");
	});

	/**
	 * The healthy counterpart, so the assertion above cannot pass by the counter being broken in
	 * the other direction. Two stored credentials must read as two.
	 */
	it("counts every stored secret in the tab when the vault reads", async () => {
		const vault = new SecretVault(locations);
		await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		await vault.add({ name: "STRIPE_KEY", value: OTHER_VALUE, scope: "profile" });

		expect(screenText(await openManager())).toContain("Secrets (2)");
	});

	/**
	 * `d` MOVES the broken file aside rather than deleting it: it still holds real credentials
	 * sealed with a key that is still on disk, so a truncated tail may have recoverable entries
	 * behind it. Destroying it to make the product usable again is not a trade the operator agreed
	 * to.
	 */
	it("discards the broken file by moving it aside", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		const vaultPath = vaultPathFor(locations, "profile");
		await fs.writeFile(vaultPath, "not-json-at-all", { mode: 0o600 });

		const manager = await openManager();
		manager.handleInput("d");
		manager.handleInput("\n");
		await manager.settled();

		await expect(fs.access(vaultPath)).rejects.toThrow();
		const siblings = await fs.readdir(path.dirname(vaultPath));
		const movedAside = siblings.filter(name => name.startsWith("vault.json.unreadable-"));
		expect(movedAside).toHaveLength(1);
		expect(await fs.readFile(path.join(path.dirname(vaultPath), movedAside[0]), "utf8")).toBe("not-json-at-all");
		expect(await new SecretVault(locations).load()).toEqual([]);
	});
});

describe("the log view", () => {
	/**
	 * `/secret log` no longer parses in a terminal — the line after `/secret` is read as the
	 * credential — so this card is the ONLY route to the expansion record. A log view that
	 * dropped records would retire the evidence trail as a side effect of that parser change.
	 */
	it("lists every recorded expansion by secret name and where it was spent", async () => {
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({
			at: Date.now() - 120_000,
			secrets: ["#GITHUB_TOKEN#"],
			tool: "bash",
			command: "curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user",
		});
		auditLog.record({
			at: Date.now() - 60_000,
			secrets: ["#STRIPE_KEY#"],
			tool: "web_fetch",
			command: "POST https://api.stripe.com/v1/charges with #STRIPE_KEY#",
		});
		await auditLog.flush();

		const manager = await openLogView(await openManager({ auditLog }));
		const text = screenText(manager);

		expect(manager.logRecordCount).toBe(2);
		expect(text).toContain("#GITHUB_TOKEN#");
		expect(text).toContain("bash");
		expect(text).toContain("api.github.com/user");
		expect(text).toContain("#STRIPE_KEY#");
		expect(text).toContain("web_fetch");
		expect(text).toContain("api.stripe.com/v1/charges");
	});

	/**
	 * "Nothing was recorded" and "nothing is being recorded" support opposite conclusions about
	 * whether credentials were spent, and as an empty table they are the same picture. The view
	 * names the setting instead, because that is the only thing it can usefully offer here.
	 */
	it("explains that recording is off instead of rendering an empty table", async () => {
		const manager = await openLogView(await openManager());
		const text = screenText(manager);

		expect(text).toContain("secrets.auditLog");
		expect(text).toContain("Record Secret Use");
		// The tab strip must not claim a count, which would read as "zero uses".
		expect(text).toContain("Log (off)");
		expect(text).not.toContain("No secret has been used yet");
	});

	/**
	 * The log is evidence of what was SPENT, so it is the surface most tempting to enrich with
	 * the value that was substituted. It never carries one, and the placeholder in the recorded
	 * command must survive to the screen unexpanded.
	 */
	it("renders no secret value in the log", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		const auditLog = new SecretAuditLog(secretAuditPath(locations));
		auditLog.record({
			at: Date.now(),
			secrets: ["#GITHUB_TOKEN#"],
			tool: "bash",
			command: "curl -H 'Authorization: bearer #GITHUB_TOKEN#' https://api.github.com/user",
		});
		await auditLog.flush();

		const manager = await openLogView(await openManager({ auditLog }));

		expect(manager.render(WIDTH).join("\n")).not.toContain(VALUE);
		expect(screenText(manager)).toContain("bearer #GITHUB_TOKEN#");
	});
});

/**
 * The advice an operator is given and the keys this card binds are two halves of one promise, and
 * nothing above makes them agree.
 *
 * WHY THIS MATTERS. The notices raised by the vault loader and the obfuscator now send people
 * here: an expiring secret says to press a key "in /secret manager", and a scope whose file cannot
 * be read paints its own row saying which key moves it aside. Those sentences are the ONLY
 * instruction most operators will ever get, because the card lists no key legend for a row it is
 * not sitting on. The tests above prove `e` extends and `d` discards, and the advice suite proves
 * the sentences name a terminal route, but both would still pass if the advice named `x` and the
 * card bound `e`. The operator would then be told, correctly and uselessly, to press a key that
 * does nothing, about a credential that is expiring while they read it.
 *
 * So these press the key PARSED OUT OF THE REAL ADVICE rather than a key typed into the test.
 * Renaming a binding without moving the sentence, or rewording the sentence without checking the
 * binding, fails here.
 */
describe("the keys the advice tells you to press", () => {
	/** The single-quoted key in "Extend it with 'e' in /secret manager". */
	function keyNamedForManager(advice: string): string {
		const named = /'(.)' in \/secret manager/.exec(advice);
		if (named === null) throw new Error(`Advice names no manager key: ${advice}`);
		return named[1];
	}

	/**
	 * The expiry warning arrives unprompted about a credential still in use, so it is the piece of
	 * advice most likely to be acted on immediately and the worst one to have pointing at a dead key.
	 */
	it("extends the selected secret with the key the expiry warning names", async () => {
		const vault = new SecretVault(locations);
		const added = await vault.add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile", ttl: 60 * 60 * 1000 });
		const warning =
			expiryWarnings(
				[
					{
						name: "GITHUB_TOKEN",
						value: VALUE,
						scope: "profile",
						createdAt: added.createdAt,
						expiresAt: added.expiresAt,
					},
				],
				Date.now() + 55 * 60 * 1000,
			)[0] ?? "";

		expect(warning).not.toBe("");
		const manager = await openManager();
		manager.handleInput(keyNamedForManager(warning));
		type(manager, "7d");
		await manager.settled();

		const [stored] = await new SecretVault(locations).load();
		expect(stored.expiresAt as number).toBeGreaterThan(added.expiresAt as number);
	});

	/**
	 * The repair row is its own advice: the loader's notice says to open the manager, and the row
	 * here is what tells you the key. A row promising a key it does not bind strands the operator
	 * on the one screen they were sent to, with their whole vault unreadable.
	 */
	it("moves the broken file aside with the key its own row names", async () => {
		await new SecretVault(locations).add({ name: "GITHUB_TOKEN", value: VALUE, scope: "profile" });
		const vaultPath = vaultPathFor(locations, "profile");
		await fs.writeFile(vaultPath, "not-json-at-all", { mode: 0o600 });

		const manager = await openManager();
		const promised = /press (.) to move it aside/.exec(screenText(manager));
		expect(promised).not.toBeNull();

		manager.handleInput((promised as RegExpExecArray)[1]);
		manager.handleInput("\n");
		await manager.settled();

		await expect(fs.access(vaultPath)).rejects.toThrow();
	});
});
