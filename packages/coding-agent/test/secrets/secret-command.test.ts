/**
 * `/secret` argument parsing and behaviour, including everything it must refuse.
 *
 * WHY THIS SUITE EXISTS. The command is the surface where a user hands over a credential, so
 * its mistakes are credential mistakes. Three classes of them are pinned here:
 *
 *   1. AMBIGUOUS PARSING. The original sketch was `/secret <value> <name> <ttl>`, which has no
 *      unique reading once the value can contain spaces. Options are flags, the name is first,
 *      and a value containing spaces still survives, which is asserted directly.
 *   2. SILENT DEFAULTS. A lifetime that does not parse must refuse rather than fall back, or a
 *      typo grants a credential a different lifetime than the operator wrote and nothing says
 *      so. Same for the `secrets.defaultTtl` setting.
 *   3. LEAKING WHAT IT PRINTS. `list` must never show a value, not even a prefix, and no
 *      message may echo the credential. Asserted by searching output for the literal.
 *
 * The vault is real (a temporary directory) rather than mocked, so these tests exercise the
 * seal, the scope files, and expiry along with the parsing.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseSecretCommand,
	resolveDefaultTtl,
	runSecretCommand,
	SECRET_COMMAND_USAGE,
} from "@veyyon/coding-agent/secrets/secret-command";
import { parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";
import { PROVIDERS_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/providers";
import { DEFAULT_TTL_MS, SecretVault } from "@veyyon/coding-agent/secrets/vault";

const VALUE = "ghp_a_real_looking_credential";
const DAY = 24 * 60 * 60 * 1000;

/** A command context over a throwaway vault, with a fixed clock and a fake environment. */
async function withContext(
	body: (context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		defaultTtl: number | null;
		now: number;
		env: Map<string, string>;
	}) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-cmd-"));
	try {
		const env = new Map<string, string>();
		const now = 1_800_000_000_000;
		await body({
			vault: new SecretVault(
				{
					globalConfigRoot: path.join(root, "config"),
					profileDir: path.join(root, "config", "profiles", "work", "agent"),
					projectDir: path.join(root, "project", ".veyyon"),
				},
				() => now,
			),
			readEnv: name => env.get(name),
			defaultTtl: DAY,
			now,
			env,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("parsing", () => {
	/** No arguments is a request for help, not an error. */
	it("treats an empty line as help", () => {
		expect(parseSecretCommand("").subcommand).toBe("help");
		expect(parseSecretCommand("   ").subcommand).toBe("help");
	});

	/** The subcommands, plus the synonyms people reach for. */
	it("accepts every subcommand and its synonyms", () => {
		expect(parseSecretCommand("add TOKEN_A x").subcommand).toBe("add");
		expect(parseSecretCommand("list").subcommand).toBe("list");
		expect(parseSecretCommand("rm TOKEN_A").subcommand).toBe("rm");
		expect(parseSecretCommand("remove TOKEN_A").subcommand).toBe("rm");
		expect(parseSecretCommand("delete TOKEN_A").subcommand).toBe("rm");
		expect(parseSecretCommand("extend TOKEN_A").subcommand).toBe("extend");
		expect(parseSecretCommand("renew TOKEN_A").subcommand).toBe("extend");
	});

	/** An unknown subcommand refuses and shows the usage rather than doing something else. */
	it("refuses an unknown subcommand", () => {
		expect(() => parseSecretCommand("frobnicate")).toThrow(/Unknown \/secret subcommand "frobnicate"/);
	});

	/** Flags can surround the name until inline credential data starts, so safe forms stay flexible. */
	it("reads flags on either side of the name before a credential", () => {
		const a = parseSecretCommand("add TOKEN_A --from-env MY_VAR --ttl 7d --scope project");
		expect(a).toMatchObject({
			subcommand: "add",
			name: "TOKEN_A",
			fromEnv: "MY_VAR",
			ttl: 7 * DAY,
			scope: "project",
		});

		const b = parseSecretCommand("add --ttl never --scope global TOKEN_B --from-env OTHER");
		expect(b).toMatchObject({ subcommand: "add", name: "TOKEN_B", fromEnv: "OTHER", ttl: null, scope: "global" });
	});

	/**
	 * A value containing spaces survives, which is the parsing bug this shape avoids.
	 *
	 * With the value as an optional positional BEFORE the name, `abc def` was indistinguishable
	 * from a value of `abc` followed by a name of `def`. Name first makes the rest unambiguous.
	 */
	it("keeps a value that contains spaces", () => {
		expect(parseSecretCommand("add TOKEN_A correct horse battery staple")).toMatchObject({
			name: "TOKEN_A",
			value: "correct horse battery staple",
		});
	});

	/**
	 * Slash parsing owns only the whitespace that separates the command name from its arguments.
	 * Once the credential starts, repeated, leading and trailing whitespace are credential bytes.
	 */
	it("preserves unquoted credential bytes through slash transport", () => {
		const credential = "  alpha  beta\tgamma  ";
		const transported = parseSlashCommand(`/secret   add TOKEN_A ${credential}`)?.args;

		expect(transported).toBe(`add TOKEN_A ${credential}`);
		expect(parseSecretCommand(transported ?? "").value).toBe(credential);
	});

	/**
	 * Quotes are credential data rather than shell syntax at this boundary. Keeping them and the
	 * trailing tab exactly prevents the slash adapter from changing a quoted token before storage.
	 */
	it("preserves quoted credential bytes through slash transport", () => {
		const credential = '"alpha beta"\t ';
		const transported = parseSlashCommand(`/secret add TOKEN_A ${credential}`)?.args;

		expect(transported).toBe(`add TOKEN_A ${credential}`);
		expect(parseSecretCommand(transported ?? "").value).toBe(credential);
	});

	/**
	 * An option-looking word after an inline credential has two possible readings. Refuse even a
	 * well-formed option instead of truncating the value, and never put candidate bytes in the error.
	 */
	it("refuses ambiguous option-shaped credentials without echoing fragments", () => {
		const candidates = [
			"alpha-secret --scope global",
			"alpha --scope credential-fragment-should-stay-private omega",
			"--credential-fragment-should-stay-private",
		];
		for (const credential of candidates) {
			let message = "";
			try {
				parseSecretCommand(`add TOKEN_A ${credential}`);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).toBe(
				"An inline credential containing an option-shaped word is ambiguous and was not read. " +
					"Put every option before the secret name, or use --from-env.",
			);
			expect(message).not.toContain(credential);
		}
	});

	/** `never` parses to null before an inline credential starts, so its meaning is unambiguous. */
	it("understands a never lifetime", () => {
		expect(parseSecretCommand("add --ttl never TOKEN_A x").ttl).toBeNull();
	});

	/** An absent lifetime is undefined, which means "use the configured default". */
	it("leaves an unspecified lifetime undefined", () => {
		expect(parseSecretCommand("add TOKEN_A x").ttl).toBeUndefined();
	});

	/**
	 * A malformed lifetime refuses at parse time.
	 *
	 * Refusing here rather than defaulting is the point: `--ttl 7dd` silently becoming one day
	 * is how a credential outlives the window its owner chose.
	 */
	it("refuses a lifetime it cannot read", () => {
		expect(() => parseSecretCommand("add --ttl 7dd TOKEN_A x")).toThrow(/needs a valid lifetime/);
		expect(() => parseSecretCommand("add TOKEN_A --ttl")).toThrow(/needs a lifetime/);
	});

	/** An unknown scope refuses, naming the three that exist. */
	it("refuses an unknown scope", () => {
		expect(() => parseSecretCommand("add --scope everywhere TOKEN_A x")).toThrow(
			/must be profile, project or global/,
		);
	});

	/** A misspelled flag refuses instead of being swallowed as a value. */
	it("refuses an unknown option", () => {
		expect(() => parseSecretCommand("add --from-environment MY_VAR TOKEN_A")).toThrow(/Unknown option/);
	});

	/** A flag missing its argument refuses rather than reading the next token as the value. */
	it("refuses a flag with no argument", () => {
		expect(() => parseSecretCommand("add TOKEN_A --from-env")).toThrow(/needs the name of an environment variable/);
	});

	/** Repeating a security option is always a refusal; no last value silently wins. */
	it("refuses duplicate source, scope, lifetime and limit options", () => {
		for (const args of [
			"add TOKEN_A --from-env FIRST --from-env SECOND",
			"add TOKEN_A --scope project --scope global",
			"add TOKEN_A --ttl 1h --ttl never",
			"log --limit 1 --limit 99",
		]) {
			expect(() => parseSecretCommand(args)).toThrow(/may be supplied only once/);
		}
	});
});

describe("add", () => {
	/**
	 * The recommended form: the credential comes from the environment and is never typed.
	 *
	 * Nothing enters the input buffer or the scrollback, which is the only way to store a
	 * secret without it appearing on screen at all.
	 */
	it("stores a value read from the environment", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(parseSecretCommand("add github-token --from-env MY_TOKEN"), context);

			expect(result.changed).toBe(true);
			expect(result.message).toContain("Stored GITHUB_TOKEN");
			expect(result.message).toContain("profile vault");
			expect((await context.vault.load())[0]).toMatchObject({ name: "GITHUB_TOKEN", value: VALUE });
		});
	});

	/**
	 * NOTHING PRINTED CONTAINS THE CREDENTIAL.
	 *
	 * The command's output goes to the terminal and, in some clients, into a log. A confirmation
	 * that helpfully echoed the value would undo the entire feature.
	 */
	it("never prints the credential", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(parseSecretCommand("add github-token --from-env MY_TOKEN"), context);

			expect(result.message).not.toContain(VALUE);
			expect(result.agentNotice).not.toContain(VALUE);
		});
	});

	/**
	 * The agent is told a secret exists and how to reference it.
	 *
	 * Without this the model has a placeholder nobody introduced it to: the system prompt's note
	 * about placeholder tokens is folded in at startup, so a session that began with no secrets
	 * would never have learned what `#NAME#` means.
	 */
	it("produces a notice naming the placeholder", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(parseSecretCommand("add github-token --from-env MY_TOKEN"), context);

			expect(result.agentNotice).toContain("#GITHUB_TOKEN#");
			expect(result.agentNotice).toContain("must not");
			expect(result.agentNotice).toContain("never see the value");
		});
	});

	/**
	 * An inline value is accepted and the exposure is stated rather than implied.
	 *
	 * Refusing inline values would mean you cannot store a credential that is not already in
	 * your environment. Accepting one silently would let the user believe nothing was exposed.
	 */
	it("accepts an inline value and says it was on screen", async () => {
		await withContext(async context => {
			const result = await runSecretCommand(parseSecretCommand(`add github-token ${VALUE}`), context);

			expect(result.changed).toBe(true);
			expect(result.message).toContain("in your scrollback");
			expect(result.message).toContain("--from-env");
		});
	});

	/**
	 * The vault must receive the exact bytes that crossed the slash boundary. A parser-only check
	 * would miss a later normalization before persistence, so this pins the stored value as well.
	 */
	it("stores transported inline credential bytes exactly", async () => {
		await withContext(async context => {
			const credential = `  "${VALUE} alpha"\t  `;
			const transported = parseSlashCommand(`/secret add byte-token ${credential}`)?.args;

			expect(transported).toBe(`add byte-token ${credential}`);
			const request = parseSecretCommand(transported ?? "");
			expect(request.value).toBe(credential);
			const result = await runSecretCommand(request, context);

			expect((await context.vault.load())[0]?.value).toBe(credential);
			expect(result.message).not.toContain(credential);
			expect(result.agentNotice).not.toContain(credential);
		});
	});

	/**
	 * A credential followed by a valid-looking option used to be truncated and stored in another
	 * scope. Refusal must happen before any vault write, and its error must disclose none of it.
	 */
	it("stores nothing for an ambiguous option-looking credential", async () => {
		await withContext(async context => {
			const credential = `${VALUE} --scope global`;
			const transported = parseSlashCommand(`/secret add byte-token ${credential}`)?.args;
			let message = "";

			try {
				await runSecretCommand(parseSecretCommand(transported ?? ""), context);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(transported).toBe(`add byte-token ${credential}`);
			expect(message).toBe(
				"An inline credential containing an option-shaped word is ambiguous and was not read. " +
					"Put every option before the secret name, or use --from-env.",
			);
			expect(message).not.toContain(credential);
			expect(await context.vault.load()).toEqual([]);
		});
	});

	/** A value read from the environment does not get the scrollback warning, since it was not typed. */
	it("omits the scrollback warning for --from-env", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(parseSecretCommand("add t-token --from-env MY_TOKEN"), context);

			expect(result.message).not.toContain("scrollback");
		});
	});

	/** An unset environment variable refuses, explaining the likely cause. */
	it("refuses when the environment variable is not set", async () => {
		await withContext(async context => {
			await expect(runSecretCommand(parseSecretCommand("add t-token --from-env NOPE"), context)).rejects.toThrow(
				/NOPE is not set in this process/,
			);
		});
	});

	/** Two sources at once is a mistake worth naming rather than silently preferring one. */
	it("refuses both a value and --from-env", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await expect(
				runSecretCommand(parseSecretCommand(`add --from-env MY_TOKEN t-token ${VALUE}`), context),
			).rejects.toThrow(/either --from-env or a value, not both/i);
		});
	});

	/** No value at all explains both ways to supply one. */
	it("explains both sources when given no value", async () => {
		await withContext(async context => {
			const failure = await runSecretCommand(parseSecretCommand("add t-token"), context).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect((failure as Error).message).toContain("--from-env");
			expect((failure as Error).message).toContain("visible in your scrollback");
		});
	});

	/** The configured default lifetime is applied when the command does not say. */
	it("applies the configured default lifetime", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await runSecretCommand(parseSecretCommand("add t-token --from-env MY_TOKEN"), context);

			expect((await context.vault.load())[0].expiresAt).toBe(context.now + DAY);
		});
	});

	/** An explicit lifetime beats the default. */
	it("prefers an explicit lifetime", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await runSecretCommand(parseSecretCommand("add t-token --from-env MY_TOKEN --ttl never"), context);

			expect((await context.vault.load())[0].expiresAt).toBeNull();
		});
	});

	/** An unnamed add still works and reports the invented name. */
	it("invents a name when none is given", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(parseSecretCommand("add --from-env MY_TOKEN"), context);

			expect(result.message).toContain("SECRET_1");
			expect(result.agentNotice).toContain("#SECRET_1#");
		});
	});
});

describe("list", () => {
	/** An empty vault says how to fill it rather than printing nothing. */
	it("explains how to add one when empty", async () => {
		await withContext(async context => {
			const result = await runSecretCommand(parseSecretCommand("list"), context);

			expect(result.message).toContain("No secrets stored");
			expect(result.message).toContain("--from-env");
			expect(result.changed).toBe(false);
		});
	});

	/**
	 * NO VALUE APPEARS, not even a prefix.
	 *
	 * The most important assertion about `list`. A prefix of a credential is still a
	 * disclosure, and showing one invites a screenshot that leaks it.
	 */
	it("shows names, scopes and lifetimes but never values", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			context.env.set("B", `${VALUE}_two`);
			await runSecretCommand(parseSecretCommand("add token-a --from-env A --scope project"), context);
			await runSecretCommand(parseSecretCommand("add token-b --from-env B --ttl never"), context);

			const result = await runSecretCommand(parseSecretCommand("list"), context);

			expect(result.message).toContain("#TOKEN_A#");
			expect(result.message).toContain("project");
			expect(result.message).toContain("#TOKEN_B#");
			expect(result.message).toContain("never expires");
			expect(result.message).not.toContain(VALUE);
			// Not even the first few characters.
			expect(result.message).not.toContain(VALUE.slice(0, 8));
		});
	});

	/** Sorted by name, so repeated calls read the same way. */
	it("sorts entries by name", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(parseSecretCommand("add zebra-token --from-env A"), context);
			await runSecretCommand(parseSecretCommand("add alpha-token --from-env A"), context);

			const result = await runSecretCommand(parseSecretCommand("list"), context);

			expect(result.message.indexOf("ALPHA_TOKEN")).toBeLessThan(result.message.indexOf("ZEBRA_TOKEN"));
		});
	});
});

describe("rm and extend", () => {
	/** Removing reports the scope, since the same name can exist in more than one. */
	it("removes a secret and names the scope", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(parseSecretCommand("add token-a --from-env A --scope global"), context);

			const result = await runSecretCommand(parseSecretCommand("rm token-a"), context);

			expect(result.message).toBe("Removed TOKEN_A from the global vault.");
			expect(result.changed).toBe(true);
			expect(await context.vault.load()).toEqual([]);
		});
	});

	/** Removing something absent says so instead of claiming success. */
	it("reports when there is nothing to remove", async () => {
		await withContext(async context => {
			const result = await runSecretCommand(parseSecretCommand("rm token-a"), context);

			expect(result.message).toContain("No secret named TOKEN_A");
			expect(result.changed).toBe(false);
		});
	});

	/** `rm` with no name asks for one rather than removing anything. */
	it("refuses rm with no name", async () => {
		await withContext(async context => {
			await expect(runSecretCommand(parseSecretCommand("rm"), context)).rejects.toThrow(/Which secret/);
		});
	});

	/** Extending reports the new lifetime in the units it will be listed in. */
	it("extends a secret", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(parseSecretCommand("add token-a --from-env A --ttl 30m"), context);

			const result = await runSecretCommand(parseSecretCommand("extend token-a --ttl 7d"), context);

			expect(result.message).toContain("7d from now");
			expect((await context.vault.load())[0].expiresAt).toBe(context.now + 7 * DAY);
		});
	});

	/** Extending something absent says so rather than creating it. */
	it("reports when there is nothing to extend", async () => {
		await withContext(async context => {
			const result = await runSecretCommand(parseSecretCommand("extend token-a --ttl 7d"), context);

			expect(result.message).toContain("No secret named TOKEN_A");
			expect(result.changed).toBe(false);
		});
	});
});

describe("the configured default lifetime", () => {
	/** The settings notation is the same one the command takes, so there is one thing to learn. */
	it("reads the same notation as the command", () => {
		expect(resolveDefaultTtl("1d")).toBe(DAY);
		expect(resolveDefaultTtl("12h")).toBe(12 * 60 * 60 * 1000);
		expect(resolveDefaultTtl("never")).toBeNull();
	});

	/**
	 * A setting that does not parse refuses, and the message says where to fix it.
	 *
	 * Falling back to the built-in default would mean every secret quietly got a lifetime the
	 * operator did not write, with the misconfiguration never surfacing.
	 */
	it("refuses a setting it cannot read", () => {
		expect(() => resolveDefaultTtl("1 day")).toThrow(/secrets.defaultTtl setting is "1 day"/);
		expect(() => resolveDefaultTtl("7dd")).toThrow(/Fix it in \/settings/);
	});

	/**
	 * An ABSENT setting is not a misconfiguration, so it falls back rather than throwing.
	 *
	 * The distinction this file keeps making: nothing written means nothing to honour, and the
	 * built-in default applies. Something written that cannot be read is a mistake worth
	 * surfacing. Only the second one refuses.
	 */
	it("uses the built-in default when nothing is configured", () => {
		expect(resolveDefaultTtl(undefined)).toBe(DAY);
		expect(resolveDefaultTtl("")).toBe(DAY);
		expect(resolveDefaultTtl("   ")).toBe(DAY);
	});

	/**
	 * The declared setting default and the built-in default are the same lifetime.
	 *
	 * They are defined in two places on purpose: the settings schema wants a literal string a
	 * user can read, and the vault wants milliseconds. Two definitions of one value drift, so
	 * this pins them together instead of coupling the modules to each other.
	 */
	it("agrees with the settings schema default", () => {
		const declared = PROVIDERS_SETTINGS["secrets.defaultTtl"];

		expect(declared.default).toBe("1d");
		expect(resolveDefaultTtl(declared.default as string)).toBe(DEFAULT_TTL_MS);
	});
});

describe("usage text", () => {
	/**
	 * The usage names every subcommand, so it cannot drift from what the parser accepts.
	 *
	 * A user who mistypes gets this text, and a subcommand missing from it is a subcommand
	 * nobody discovers.
	 */
	it("documents every subcommand", () => {
		for (const verb of ["add", "list", "rm", "extend"]) {
			expect(SECRET_COMMAND_USAGE).toContain(`/secret ${verb}`);
		}
		expect(SECRET_COMMAND_USAGE).toContain("--from-env");
		expect(SECRET_COMMAND_USAGE).toContain("--ttl");
		expect(SECRET_COMMAND_USAGE).toContain("--scope");
		expect(SECRET_COMMAND_USAGE).toContain("never");
	});
});
