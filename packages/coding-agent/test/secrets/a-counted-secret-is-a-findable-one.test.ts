/**
 * Every value a session masks can be found from a command, and the two surfaces that report
 * protection report the same number.
 *
 * WHY THIS SUITE EXISTS. The composer footer read `10 masked` while `/secret list` answered "No
 * active secrets. Nothing is being substituted right now." Both halves came from the same session:
 * the footer counts what the obfuscator will substitute, the list read the vault, and the vault was
 * empty because every one of those ten values had been auto-detected in the environment.
 * `collectEnvSecrets` registered them with no name, so nothing on any surface could say what they
 * were. The operator could see that ten things were being masked and had no way to learn which.
 *
 * THE CLASS, not the incident: a surface that reports protection must read the same counter as
 * every other surface, and a counted value must be nameable by something. Two counters for one
 * fact is the defect; the ten environment variables were only how it showed up. The same shape had
 * already shipped once as `3 secrets` beside a one-row list, which is why `liveSecrets` splits
 * `named` out at all.
 *
 * WHAT IS PINNED HERE:
 *   1. The footer's count and the list's count come from ONE obfuscator built the way a session
 *      builds it, and every case asserts them against each other rather than against a literal.
 *   2. A masked value carries a label a person can search for -- the environment variable name, or
 *      the `secrets.yml` path -- and that label is never spendable as a placeholder.
 *   3. The empty-vault answer does not claim nothing is being substituted while something is.
 *   4. A credential that is BOTH stored under a name and present in the environment is reported
 *      once, by the list, and not a second time as unnameable.
 *
 * WHAT IT DOES NOT CATCH: whether the footer segment itself renders the number it is handed.
 * That is `secretsSegment`'s own contract, and it reads `liveSecrets()`, which is the counter this
 * suite pins the list against.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectEnvSecrets, loadSecrets } from "@veyyon/coding-agent/secrets";
import { buildEnvSecretPattern } from "@veyyon/coding-agent/secrets/env-keywords";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { renderSecretList, runSecretCommand } from "@veyyon/coding-agent/secrets/secret-command";
import { resolveVaultLocations, SecretVault } from "@veyyon/coding-agent/secrets/vault";

/** Credentials shaped like the real thing, so a leak of one or of its prefix is unmistakable. */
const TOKEN = "ghp_findable_credential_0001";
const OTHER = "sk-live-findable-credential-2";

const NOW = 1_700_000_000_000;

/** The keyword pattern the bundled list produces, so the detection here is the shipped detection. */
const PATTERN = buildEnvSecretPattern(["TOKEN", "SECRET"]);

/**
 * Build an obfuscator from an environment, the way `loadSecretRuntime` does.
 *
 * `collectEnvSecrets` reads `process.env`, so the variables are set for the length of the call and
 * removed again: no test may leave a credential in the process environment for the next file.
 */
function fromEnvironment(vars: Record<string, string>): SecretObfuscator {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(vars)) {
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	try {
		return new SecretObfuscator(collectEnvSecrets(PATTERN));
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("a value the session masks is reported by the same counter everywhere", () => {
	/**
	 * The reported defect, end to end: ten-ish masked values, an empty vault, and a list that has to
	 * agree with the footer instead of contradicting it.
	 */
	it("names every environment variable behind the masked count", () => {
		const obfuscator = fromEnvironment({ FINDABLE_API_TOKEN: TOKEN, FINDABLE_CLIENT_SECRET: OTHER });

		const chip = obfuscator.liveSecrets();
		const inventory = obfuscator.maskedInventory();

		// The footer's number and the list's number are the same number.
		expect(chip.count).toBe(2);
		expect(chip.named).toBe(0);
		expect(inventory.count).toBe(chip.count - chip.named);
		expect(inventory.sources).toEqual(["FINDABLE_API_TOKEN", "FINDABLE_CLIENT_SECRET"]);

		const rendered = renderSecretList([], { now: NOW, masked: inventory });

		expect(rendered).toContain("FINDABLE_API_TOKEN");
		expect(rendered).toContain("FINDABLE_CLIENT_SECRET");
		expect(rendered).toContain("2 values masked");
		// The falsehood that made the whole thing unreadable.
		expect(rendered).not.toContain("Nothing is being substituted right now");
		// And still a remedy, so the report is actionable rather than only true.
		expect(rendered).toContain("env-keywords.yml");
	});

	/**
	 * A SOURCE-LESS ENTRY, through the real obfuscator. An SDK caller hands secrets in directly and
	 * has no obligation to label them, so a masked value with nothing to name it is a legitimate
	 * state and the count of those values is the only thing that can report it. Asserted here rather
	 * than against a literal inventory, because the number is produced by the constructor.
	 */
	it("counts a masked value that arrived with no label at all", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: TOKEN, mode: "obfuscate", origin: "environment" },
		]);

		const inventory = obfuscator.maskedInventory();

		expect(inventory.count).toBe(1);
		expect(inventory.sources).toEqual([]);
		expect(inventory.unlabelled).toBe(1);
		// The list says so, rather than printing a count with an empty "From:" line beside it.
		expect(renderSecretList([], { now: NOW, masked: inventory })).toContain("1 value was declared without a source");
	});

	/** No value, and no prefix of one, may appear in any of it. */
	it("never prints the credential it is describing", () => {
		const obfuscator = fromEnvironment({ FINDABLE_API_TOKEN: TOKEN });

		const rendered = renderSecretList([], { now: NOW, masked: obfuscator.maskedInventory() });

		expect(rendered).not.toContain(TOKEN);
		expect(rendered).not.toContain(TOKEN.slice(0, 12));
	});

	/**
	 * A masked value stays unspendable. The label is a label.
	 *
	 * `source` grants nothing: the point of the split is that an auto-detected value is protected
	 * without becoming a credential the model can ask for by name.
	 */
	it("does not turn a label into a placeholder", () => {
		const obfuscator = fromEnvironment({ FINDABLE_API_TOKEN: TOKEN });

		expect(obfuscator.namedSecretNames()).toEqual([]);
		expect(obfuscator.knowsPlaceholder("#FINDABLE_API_TOKEN#")).toBe(false);
		expect(obfuscator.deobfuscate("#FINDABLE_API_TOKEN#")).toBe("#FINDABLE_API_TOKEN#");
		// Still masked on the way out, which is the half that must not regress.
		expect(obfuscator.obfuscate(`Authorization: ${TOKEN}`)).not.toContain(TOKEN);
	});

	/**
	 * Two variables holding ONE credential are one masked value.
	 *
	 * The footer counts by value and so does the inventory, so a duplicated export cannot make the
	 * two numbers disagree -- which is the failure mode a second counter would have reintroduced.
	 */
	it("counts one credential once however many variables hold it", () => {
		const obfuscator = fromEnvironment({ FINDABLE_API_TOKEN: TOKEN, FINDABLE_OTHER_TOKEN: TOKEN });

		const chip = obfuscator.liveSecrets();
		const inventory = obfuscator.maskedInventory();

		expect(chip.count).toBe(1);
		expect(inventory.count).toBe(1);
		expect(inventory.sources).toEqual(["FINDABLE_API_TOKEN"]);
	});

	/**
	 * One credential declared twice is ONE masked value, behind TWO placeholders.
	 *
	 * `collectEnvSecrets` collapses a value it has already seen, so an environment alone can never
	 * produce this: it takes a value that is both declared in `secrets.yml` and exported, which is
	 * ordinary (the file is how you make the detection deterministic, the export is how the tool that
	 * needs it reads it). Two entries register two placeholders for the same bytes, and this is the
	 * only shape in which counting placeholders and counting values give different answers -- so it
	 * is the only shape that can prove the inventory counts what the footer counts.
	 */
	it("counts one credential once behind two placeholders", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: TOKEN, mode: "obfuscate", origin: "config", source: "/tmp/secrets.yml" },
			{ type: "plain", content: TOKEN, mode: "obfuscate", origin: "environment", source: "FINDABLE_API_TOKEN" },
		]);

		const inventory = obfuscator.maskedInventory();

		expect(obfuscator.liveSecrets().count).toBe(1);
		expect(inventory.count).toBe(1);
		// Both labels, because the operator has two places to look and either one is a true answer to
		// "where is this coming from".
		expect(inventory.sources).toEqual(["/tmp/secrets.yml", "FINDABLE_API_TOKEN"]);
	});

	/**
	 * A credential in the vault AND in the environment is reported once, as a stored secret.
	 *
	 * The list names it, so naming it again as an unnameable masked value would tell the operator
	 * they have two things when they have one.
	 */
	it("does not report a stored credential as unnameable", () => {
		const previous = process.env.FINDABLE_API_TOKEN;
		process.env.FINDABLE_API_TOKEN = TOKEN;
		try {
			const obfuscator = new SecretObfuscator([
				{ type: "plain", content: TOKEN, mode: "obfuscate", origin: "vault", name: "FINDABLE" },
				...collectEnvSecrets(PATTERN),
			]);

			expect(obfuscator.liveSecrets()).toMatchObject({ count: 1, named: 1 });
			expect(obfuscator.maskedInventory()).toEqual({ count: 0, sources: [], unlabelled: 0 });
		} finally {
			if (previous === undefined) delete process.env.FINDABLE_API_TOKEN;
			else process.env.FINDABLE_API_TOKEN = previous;
		}
	});

	/** Nothing masked, nothing added: the answer an empty session gives is unchanged. */
	it("says nothing extra when nothing is masked", () => {
		const rendered = renderSecretList([], { now: NOW, masked: { count: 0, sources: [], unlabelled: 0 } });

		expect(rendered).toContain("No active secrets. Nothing is being substituted right now.");
		expect(rendered).not.toContain("masked in what is sent");
	});
});

describe("a declared secret is findable by the file that declared it", () => {
	/**
	 * `secrets.yml` has no name field, so a declared entry is as unnameable as an environment one and
	 * needs the same label. The file path is what an operator can act on.
	 */
	it("labels a secrets.yml entry with its path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-findable-"));
		try {
			const configDir = path.join(dir, ".veyyon");
			await fs.mkdir(configDir, { recursive: true });
			const declared = path.join(configDir, "secrets.yml");
			await fs.writeFile(declared, `- type: plain\n  content: ${TOKEN}\n`, "utf8");

			const obfuscator = new SecretObfuscator(await loadSecrets(dir, path.join(dir, "profile")));
			const inventory = obfuscator.maskedInventory();

			expect(inventory.count).toBe(1);
			expect(inventory.sources).toEqual([declared]);
			expect(renderSecretList([], { now: NOW, masked: inventory })).toContain("secrets.yml");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("the list command carries the inventory it is given", () => {
	/**
	 * Through the real runner, not the renderer alone: the surface reads the obfuscator and the
	 * runner has to pass it on, which is the wiring the reported defect was missing.
	 */
	it("reports masked values from a real vault read", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-findable-run-"));
		try {
			const vault = new SecretVault(
				resolveVaultLocations({
					globalConfigRoot: path.join(dir, "global"),
					agentDir: path.join(dir, "profile"),
					cwd: dir,
				}),
			);

			const result = await runSecretCommand(
				{ subcommand: "list" },
				{
					vault,
					readEnv: () => undefined,
					defaultTtl: null,
					now: NOW,
					masked: { count: 3, sources: ["ONE_TOKEN", "TWO_SECRET"], unlabelled: 1 },
				},
			);

			expect(result.message).toContain("3 values masked");
			expect(result.message).toContain("ONE_TOKEN, TWO_SECRET");
			// One value carries no label, and the report says which count that is rather than leaving
			// the operator to subtract two names from three values.
			expect(result.message).toContain("1 value was declared without a source");
			expect(result.changed).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	/**
	 * THE FALSE NEGATIVE THE COUNTS USED TO HIDE. The caveat was decided by `sources.length <
	 * count`, which is not a statement about labels: one credential declared in `secrets.yml` AND
	 * exported into the environment contributes two sources for one value, so two values with two
	 * labels between them read as fully accounted for while one of them had nothing to name it. The
	 * inventory now reports the nameless count itself.
	 */
	it("still says a value is nameless when another value carries two labels", () => {
		const rendered = renderSecretList([], {
			now: NOW,
			masked: { count: 2, sources: ["/home/dev/secrets.yml", "SHARED_TOKEN"], unlabelled: 1 },
		});

		expect(rendered).toContain("2 values masked");
		expect(rendered).toContain("1 value was declared without a source");
		// The remedy is printed whether or not every value could be named, because narrowing the
		// keywords is the answer in both cases.
		expect(rendered).toContain("env-keywords.yml");
	});
});
