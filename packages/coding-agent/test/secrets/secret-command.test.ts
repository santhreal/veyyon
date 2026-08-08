/**
 * `/secret` argument parsing and behaviour, including everything it must refuse.
 *
 * WHICH GRAMMAR THIS SUITE IS ABOUT. `parseSecretCommand` branches on its `surface` argument, and
 * the verbs (`add`, `list`, `rm`, `extend`, `log`, `discard`) survive on ONE of the two branches:
 * the noninteractive one, used by `-p` and by ACP clients, which has no masked field and no GUI to
 * replace them with. Everything below that names a verb therefore passes `"noninteractive"` at the
 * call rather than relying on the parameter's default, so each test says which grammar it pins. The
 * terminal branch, where the argument line simply IS the credential, is pinned at the bottom of the
 * file in "the terminal grammar"; the dialogs it drives are covered by
 * `the-masked-prompt-cannot-be-read-as-a-name-prompt.test.ts`.
 *
 * WHY THIS SUITE EXISTS. The command is the surface where a user hands over a credential, so
 * its mistakes are credential mistakes. Three classes of them are pinned here:
 *
 *   1. AMBIGUOUS PARSING. The verb grammar's sketch was `/secret <value> <name> <ttl>`, which has
 *      no unique reading once the value can contain spaces. Options are flags, the name is first,
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
import { PROVIDERS_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/providers";
import {
	parseSecretCommand,
	resolveDefaultTtl,
	runSecretCommand,
	secretCommandUsage,
} from "@veyyon/coding-agent/secrets/secret-command";
import { DEFAULT_TTL_MS, SecretVault } from "@veyyon/coding-agent/secrets/vault";
import { parseSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";

const VALUE = "ghp_a_real_looking_credential";
const DAY = 24 * 60 * 60 * 1000;

/** The message a refusal carries, so two verbs' wording can be compared rather than only matched. */
function messageOf(body: () => unknown): string {
	try {
		body();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected a refusal, but the call returned.");
}

/**
 * A command context over a throwaway vault, with a fixed clock and a fake environment.
 *
 * The surface is fixed to `"noninteractive"` to match the grammar every `runSecretCommand` test in
 * this file parses with. It is not decoration: `runSecretCommand` picks its help text and its
 * "no value given" advice from it, and the adapter never pairs a request parsed on one surface with
 * copy written for the other, so a context left on the default would test a combination that
 * cannot occur.
 */
async function withContext(
	body: (context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		defaultTtl: number | null;
		now: number;
		surface: "noninteractive";
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
			surface: "noninteractive",
			env,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("parsing the noninteractive verb grammar", () => {
	/** No arguments is a request for help, not an error. A terminal treats it as an empty value instead. */
	it("treats an empty line as help", () => {
		expect(parseSecretCommand("", "noninteractive").subcommand).toBe("help");
		expect(parseSecretCommand("   ", "noninteractive").subcommand).toBe("help");
	});

	/** The subcommands, plus the synonyms people reach for. None of them is a verb in a terminal. */
	it("accepts every subcommand and its synonyms", () => {
		expect(parseSecretCommand("add TOKEN_A x", "noninteractive").subcommand).toBe("add");
		expect(parseSecretCommand("list", "noninteractive").subcommand).toBe("list");
		expect(parseSecretCommand("rm TOKEN_A", "noninteractive").subcommand).toBe("rm");
		expect(parseSecretCommand("remove TOKEN_A", "noninteractive").subcommand).toBe("rm");
		expect(parseSecretCommand("delete TOKEN_A", "noninteractive").subcommand).toBe("rm");
		expect(parseSecretCommand("extend TOKEN_A", "noninteractive").subcommand).toBe("extend");
		expect(parseSecretCommand("renew TOKEN_A", "noninteractive").subcommand).toBe("extend");
	});

	/**
	 * An unknown subcommand refuses without echoing the candidate token. A misplaced credential
	 * is still secret data even when it occupies the verb slot.
	 *
	 * ONLY THIS SURFACE REFUSES. The same line typed in a terminal is a credential to store, which
	 * is why the refusal is asserted here and its absence is asserted in the terminal suite below.
	 */
	it("refuses an unknown subcommand without echoing candidate bytes", () => {
		const candidate = "credential-fragment-that-must-not-print";
		let message = "";
		try {
			parseSecretCommand(candidate, "noninteractive");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Unknown /secret subcommand.");
		expect(message).not.toContain(candidate);
	});

	/** Flags can surround the name until inline credential data starts, so safe forms stay flexible. */
	it("reads flags on either side of the name before a credential", () => {
		const a = parseSecretCommand("add TOKEN_A --from-env MY_VAR --ttl 7d --scope project", "noninteractive");
		expect(a).toMatchObject({
			subcommand: "add",
			name: "TOKEN_A",
			fromEnv: "MY_VAR",
			ttl: 7 * DAY,
			scope: "project",
		});

		const b = parseSecretCommand("add --ttl never --scope global TOKEN_B --from-env OTHER", "noninteractive");
		expect(b).toMatchObject({ subcommand: "add", name: "TOKEN_B", fromEnv: "OTHER", ttl: null, scope: "global" });
	});

	/**
	 * A value containing spaces survives, which is the parsing bug this shape avoids.
	 *
	 * With the value as an optional positional BEFORE the name, `abc def` was indistinguishable
	 * from a value of `abc` followed by a name of `def`. Name first makes the rest unambiguous.
	 */
	it("keeps a value that contains spaces", () => {
		expect(parseSecretCommand("add TOKEN_A correct horse battery staple", "noninteractive")).toMatchObject({
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
		expect(parseSecretCommand(transported ?? "", "noninteractive").value).toBe(credential);
	});

	/**
	 * Quotes are credential data rather than shell syntax at this boundary. Keeping them and the
	 * trailing tab exactly prevents the slash adapter from changing a quoted token before storage.
	 */
	it("preserves quoted credential bytes through slash transport", () => {
		const credential = '"alpha beta"\t ';
		const transported = parseSlashCommand(`/secret add TOKEN_A ${credential}`)?.args;

		expect(transported).toBe(`add TOKEN_A ${credential}`);
		expect(parseSecretCommand(transported ?? "", "noninteractive").value).toBe(credential);
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
				parseSecretCommand(`add TOKEN_A ${credential}`, "noninteractive");
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
		expect(parseSecretCommand("add --ttl never TOKEN_A x", "noninteractive").ttl).toBeNull();
	});

	/** An absent lifetime is undefined, which means "use the configured default". */
	it("leaves an unspecified lifetime undefined", () => {
		expect(parseSecretCommand("add TOKEN_A x", "noninteractive").ttl).toBeUndefined();
	});

	/**
	 * A malformed lifetime refuses at parse time.
	 *
	 * Refusing here rather than defaulting is the point: `--ttl 7dd` silently becoming one day
	 * is how a credential outlives the window its owner chose.
	 */
	it("refuses a lifetime it cannot read", () => {
		expect(() => parseSecretCommand("add --ttl 7dd TOKEN_A x", "noninteractive")).toThrow(/is not a lifetime/);
		expect(() => parseSecretCommand("add TOKEN_A --ttl", "noninteractive")).toThrow(/needs a lifetime/);
	});

	/**
	 * Zero and arithmetic-overflow lifetimes are boundaries, not alternate spellings of the
	 * default. Both must refuse before a request can reach storage.
	 */
	it("refuses TTL boundary values instead of falling back", () => {
		expect(() => parseSecretCommand("add --ttl 0m TOKEN_A x", "noninteractive")).toThrow(/expire immediately/);
		expect(() => parseSecretCommand("add --ttl 9007199254740991w TOKEN_A x", "noninteractive")).toThrow(/too large/);
		expect(() => parseSecretCommand("extend TOKEN_A --ttl 0m", "noninteractive")).toThrow(/expire immediately/);
		expect(() => parseSecretCommand("extend TOKEN_A --ttl 9007199254740991w", "noninteractive")).toThrow(/too large/);
	});

	/**
	 * `add` and `extend` must diagnose the same bad lifetime identically.
	 *
	 * They did not. `add` rewrote every `parseTtl` failure into one generic "needs a valid lifetime",
	 * which existed only to stop `parseTtl` echoing the value back, and the cost was that `add` could
	 * not tell "0m expires immediately" from "9007199254740991w is too large" from "7dd is not a
	 * lifetime". Same mistake, same sentence, whichever verb you typed. If this fails, someone
	 * reintroduced a per-verb rewrite and one verb is now less specific than the other.
	 */
	it("diagnoses a bad lifetime identically for add and extend", () => {
		for (const [spec, expected] of [
			["7dd", /is not a lifetime/],
			["0m", /expire immediately/],
			["9007199254740991w", /too large/],
		] as const) {
			const fromAdd = messageOf(() => parseSecretCommand(`add --ttl ${spec} TOKEN_A x`, "noninteractive"));
			const fromExtend = messageOf(() => parseSecretCommand(`extend TOKEN_A --ttl ${spec}`, "noninteractive"));
			expect(fromAdd).toMatch(expected);
			expect(fromExtend).toMatch(expected);
			expect(fromAdd).toBe(fromExtend);
		}
	});

	/** An unknown scope refuses, naming the three that exist. */
	it("refuses an unknown scope", () => {
		expect(() => parseSecretCommand("add --scope everywhere TOKEN_A x", "noninteractive")).toThrow(
			/must be profile, project or global/,
		);
	});

	/** A misspelled flag refuses instead of being swallowed as a value. */
	it("refuses an unknown option", () => {
		expect(() => parseSecretCommand("add --from-environment MY_VAR TOKEN_A", "noninteractive")).toThrow(
			/Unknown option/,
		);
	});

	/** A flag missing its argument refuses rather than reading the next token as the value. */
	it("refuses a flag with no argument", () => {
		expect(() => parseSecretCommand("add TOKEN_A --from-env", "noninteractive")).toThrow(
			/needs the name of an environment variable/,
		);
	});

	/** Repeating a security option is always a refusal; no last value silently wins. */
	it("refuses duplicate source, scope, lifetime and limit options", () => {
		for (const args of [
			"add TOKEN_A --from-env FIRST --from-env SECOND",
			"add TOKEN_A --scope project --scope global",
			"add TOKEN_A --ttl 1h --ttl never",
			"log --limit 1 --limit 99",
		]) {
			expect(() => parseSecretCommand(args, "noninteractive")).toThrow(/may be supplied only once/);
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

			const result = await runSecretCommand(
				parseSecretCommand("add github-token --from-env MY_TOKEN", "noninteractive"),
				context,
			);

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

			const result = await runSecretCommand(
				parseSecretCommand("add github-token --from-env MY_TOKEN", "noninteractive"),
				context,
			);

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

			const result = await runSecretCommand(
				parseSecretCommand("add github-token --from-env MY_TOKEN", "noninteractive"),
				context,
			);

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
			const result = await runSecretCommand(
				parseSecretCommand(`add github-token ${VALUE}`, "noninteractive"),
				context,
			);

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
			const request = parseSecretCommand(transported ?? "", "noninteractive");
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
				await runSecretCommand(parseSecretCommand(transported ?? "", "noninteractive"), context);
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

			const result = await runSecretCommand(
				parseSecretCommand("add t-token --from-env MY_TOKEN", "noninteractive"),
				context,
			);

			expect(result.message).not.toContain("scrollback");
		});
	});

	/** An unset environment variable refuses, explaining the likely cause. */
	it("refuses when the environment variable is not set", async () => {
		await withContext(async context => {
			await expect(
				runSecretCommand(parseSecretCommand("add t-token --from-env NOPE", "noninteractive"), context),
			).rejects.toThrow(/NOPE is not set in this process/);
		});
	});

	/**
	 * Set-but-empty is a DIFFERENT cause from unset and must not borrow its message. Both used to
	 * say "is not set in this process", which is false for a variable that is exported and empty:
	 * driving the real CLI produced that line for `V_EMPTY=""` and sent the reader off to re-check
	 * an export that was already correct, while the real cause was an assignment that set it to
	 * nothing. The wrong diagnosis is the whole bug here, so the message is pinned, not just the
	 * refusal.
	 */
	it("distinguishes a variable that is set but empty from one that is unset", async () => {
		await withContext(async context => {
			context.env.set("EMPTY_TOKEN", "");

			const failure = await runSecretCommand(
				parseSecretCommand("add t-token --from-env EMPTY_TOKEN", "noninteractive"),
				context,
			).then(
				() => undefined,
				(error: unknown) => (error as Error).message,
			);

			expect(failure).toContain("EMPTY_TOKEN is set but empty");
			expect(failure).toContain("EMPTY_TOKEN= sets it to nothing");
			expect(failure).not.toContain("is not set in this process");
		});
	});

	/**
	 * Whitespace-only is refused rather than stored, because a placeholder that expands to blank
	 * text would spend nothing into a command while looking like a working credential. It is
	 * refused rather than trimmed for the same reason: trimming would invent a value the operator
	 * never exported.
	 */
	it.each([
		["spaces and a tab", "   \t "],
		["a newline", "\n"],
	])("refuses a variable holding only %s", async (_case, blank) => {
		await withContext(async context => {
			context.env.set("BLANK_TOKEN", blank);

			await expect(
				runSecretCommand(parseSecretCommand("add t-token --from-env BLANK_TOKEN", "noninteractive"), context),
			).rejects.toThrow(/BLANK_TOKEN contains only whitespace/);
		});
	});

	/**
	 * A credential that merely CONTAINS surrounding whitespace is stored byte for byte. Real tokens
	 * are allowed to carry padding, and trimming one would corrupt it silently: the placeholder
	 * would spend bytes the operator never stored, and the failure would surface far away as an
	 * authentication error with no trace back to here.
	 */
	it("stores a padded credential without trimming it", async () => {
		await withContext(async context => {
			const padded = ` ${VALUE} `;
			context.env.set("PADDED_TOKEN", padded);

			await runSecretCommand(parseSecretCommand("add t-token --from-env PADDED_TOKEN", "noninteractive"), context);

			const stored = await context.vault.load();
			expect(stored.find(entry => entry.name === "T_TOKEN")?.value).toBe(padded);
		});
	});

	/** Two sources at once is a mistake worth naming rather than silently preferring one. */
	it("refuses both a value and --from-env", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await expect(
				runSecretCommand(parseSecretCommand(`add --from-env MY_TOKEN t-token ${VALUE}`, "noninteractive"), context),
			).rejects.toThrow(/either --from-env or a value, not both/i);
		});
	});

	/**
	 * No value at all names the ONE source this surface has, and does not offer the other.
	 *
	 * SUBJECT CHANGED WITH THE GRAMMAR. This used to assert that both sources were explained,
	 * because the request and the copy were read on a single surface. A client with no way to hide
	 * what is typed refuses an inline credential outright, so recommending one here would send the
	 * caller into a second refusal, and the message says only `--from-env` and shows the exact line
	 * to type. The scrollback sentence is asserted absent rather than left unmentioned, since that
	 * is the half that would come back if the two surfaces' copy were ever collapsed again.
	 */
	it("names only --from-env when given no value", async () => {
		await withContext(async context => {
			const failure = await runSecretCommand(parseSecretCommand("add t-token", "noninteractive"), context).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect((failure as Error).message).toContain("--from-env");
			expect((failure as Error).message).toContain("/secret add t-token --from-env MY_TOKEN");
			expect((failure as Error).message).not.toContain("visible in your scrollback");
		});
	});

	/** The configured default lifetime is applied when the command does not say. */
	it("applies the configured default lifetime", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await runSecretCommand(parseSecretCommand("add t-token --from-env MY_TOKEN", "noninteractive"), context);

			expect((await context.vault.load())[0].expiresAt).toBe(context.now + DAY);
		});
	});

	/** An explicit lifetime beats the default. */
	it("prefers an explicit lifetime", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await runSecretCommand(
				parseSecretCommand("add t-token --from-env MY_TOKEN --ttl never", "noninteractive"),
				context,
			);

			expect((await context.vault.load())[0].expiresAt).toBeNull();
		});
	});

	/** An unnamed add still works and reports the invented name. */
	it("invents a name when none is given", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(
				parseSecretCommand("add --from-env MY_TOKEN", "noninteractive"),
				context,
			);

			expect(result.message).toContain("SECRET_1");
			expect(result.agentNotice).toContain("#SECRET_1#");
		});
	});
});

describe("list", () => {
	/** An empty vault says how to fill it rather than printing nothing. */
	it("explains how to add one when empty", async () => {
		await withContext(async context => {
			const result = await runSecretCommand(parseSecretCommand("list", "noninteractive"), context);

			expect(result.message).toContain("No active secrets");
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
			await runSecretCommand(
				parseSecretCommand("add token-a --from-env A --scope project", "noninteractive"),
				context,
			);
			await runSecretCommand(parseSecretCommand("add token-b --from-env B --ttl never", "noninteractive"), context);

			const result = await runSecretCommand(parseSecretCommand("list", "noninteractive"), context);

			expect(result.message).toContain("#TOKEN_A#");
			expect(result.message).toContain("project");
			expect(result.message).toContain("#TOKEN_B#");
			expect(result.message).toContain("never expires");
			expect(result.message).not.toContain(VALUE);
			// Not even the first few characters.
			expect(result.message).not.toContain(VALUE.slice(0, 8));
		});
	});

	/**
	 * Wider-scope duplicates remain stored but are shadowed. List must call its rows active rather
	 * than claim it enumerates every stored copy, and it must show only the effective project row.
	 *
	 * The row count is measured as ROWS, not as occurrences of the placeholder anywhere in the
	 * output. It used to count occurrences, which conflated two different promises: "one row per
	 * name" and "the hidden copy is never mentioned". Only the first is a contract. The list now
	 * names the shadowed copy in a sentence below the table on purpose, because a stored credential
	 * the list declines to mention is the one thing it must not omit, so a test that forbade the
	 * second mention would have been defending the absence of a disclosure.
	 */
	it("labels and shows only the active entry for a duplicate name", async () => {
		await withContext(async context => {
			context.env.set("PROFILE", `${VALUE}_profile`);
			context.env.set("PROJECT", `${VALUE}_project`);
			await runSecretCommand(
				parseSecretCommand("add shared-token --from-env PROFILE --scope profile", "noninteractive"),
				context,
			);
			await runSecretCommand(
				parseSecretCommand("add shared-token --from-env PROJECT --scope project", "noninteractive"),
				context,
			);

			const result = await runSecretCommand(parseSecretCommand("list", "noninteractive"), context);
			expect(result.message).toContain("1 active secret. ");
			// A row is the placeholder followed by an actual SCOPE cell. Matching any word here also
			// matched the note's own first line ("#SHARED_TOKEN# is also stored in ..."), which is the
			// trap in measuring a table row with a loose pattern over the whole message.
			const rows = result.message
				.split("\n")
				.filter(line => /^\s+#SHARED_TOKEN#\s+(profile|project|global)\s+\S/.test(line));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain("#SHARED_TOKEN#  project");
			expect(result.message).not.toContain("#SHARED_TOKEN#  profile");
			// And the copy that is NOT in the table is disclosed rather than dropped.
			expect(result.message).toContain("is also stored in the profile vault, shadowed by the project one.");
		});
	});

	/** Sorted by name, so repeated calls read the same way. */
	it("sorts entries by name", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(parseSecretCommand("add zebra-token --from-env A", "noninteractive"), context);
			await runSecretCommand(parseSecretCommand("add alpha-token --from-env A", "noninteractive"), context);

			const result = await runSecretCommand(parseSecretCommand("list", "noninteractive"), context);

			expect(result.message.indexOf("ALPHA_TOKEN")).toBeLessThan(result.message.indexOf("ZEBRA_TOKEN"));
		});
	});
});

describe("rm and extend", () => {
	/** Removing reports the scope, since the same name can exist in more than one. */
	it("removes a secret and names the scope", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(
				parseSecretCommand("add token-a --from-env A --scope global", "noninteractive"),
				context,
			);

			const result = await runSecretCommand(parseSecretCommand("rm token-a", "noninteractive"), context);

			expect(result.message).toBe("Removed TOKEN_A from the global vault.");
			expect(result.changed).toBe(true);
			expect(await context.vault.load()).toEqual([]);
		});
	});

	/** Removing something absent is a failed state change, not a successful no-op. */
	it("fails when there is nothing to remove", async () => {
		await withContext(async context => {
			await expect(runSecretCommand(parseSecretCommand("rm token-a", "noninteractive"), context)).rejects.toThrow(
				"No secret named TOKEN_A is stored. Run /secret list to see what is.",
			);
		});
	});

	/** `rm` with no name asks for one rather than removing anything. */
	it("refuses rm with no name", async () => {
		await withContext(async context => {
			await expect(runSecretCommand(parseSecretCommand("rm", "noninteractive"), context)).rejects.toThrow(
				/Which secret/,
			);
		});
	});

	/** Extending reports both the affected scope and the new lifetime, which matters when names overlap. */
	it("extends a secret", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(parseSecretCommand("add token-a --from-env A --ttl 30m", "noninteractive"), context);

			const result = await runSecretCommand(
				parseSecretCommand("extend token-a --ttl 7d", "noninteractive"),
				context,
			);

			expect(result.message).toContain("7d from now");
			expect(result.message).toContain("in the profile vault");
			expect((await context.vault.load())[0].expiresAt).toBe(context.now + 7 * DAY);
		});
	});

	/**
	 * Duplicate names resolve project before profile before global. Mutating by name must report
	 * the effective scope it actually changed rather than implying every stored copy changed.
	 */
	it("extends and removes the effective duplicate name by scope precedence", async () => {
		await withContext(async context => {
			context.env.set("PROFILE", `${VALUE}_profile`);
			context.env.set("PROJECT", `${VALUE}_project`);
			await runSecretCommand(
				parseSecretCommand("add shared-token --from-env PROFILE --scope profile --ttl 30m", "noninteractive"),
				context,
			);
			await runSecretCommand(
				parseSecretCommand("add shared-token --from-env PROJECT --scope project --ttl 30m", "noninteractive"),
				context,
			);

			const extended = await runSecretCommand(
				parseSecretCommand("extend shared-token --ttl 7d", "noninteractive"),
				context,
			);
			expect(extended.message).toContain("in the project vault");
			expect((await context.vault.load())[0]).toMatchObject({
				scope: "project",
				value: `${VALUE}_project`,
				expiresAt: context.now + 7 * DAY,
			});

			// The removal takes the project copy and UNCOVERS the profile one, so the placeholder keeps
			// working and now spends a different credential. This assertion used to stop at the first
			// sentence, which was true and incomplete: an operator who read it had no way to know a
			// second copy had just become live under the same name.
			const removed = await runSecretCommand(parseSecretCommand("rm shared-token", "noninteractive"), context);
			expect(removed.message).toBe(
				"Removed SHARED_TOKEN from the project vault. A profile secret of the same name was underneath " +
					"it, so #SHARED_TOKEN# still spends a credential, now that one. Run /secret rm SHARED_TOKEN " +
					"--scope profile to remove that one too.",
			);
			// Not a revocation: the name still resolves, so telling the model to stop using it would be
			// false and would make it send the literal text instead.
			expect(removed.agentNoticeIsRevocation).toBeUndefined();
			expect((await context.vault.load())[0]).toMatchObject({
				scope: "profile",
				value: `${VALUE}_profile`,
			});
		});
	});

	/** Extending something absent is a failed state change, not a successful no-op. */
	it("fails when there is nothing to extend", async () => {
		await withContext(async context => {
			await expect(
				runSecretCommand(parseSecretCommand("extend token-a --ttl 7d", "noninteractive"), context),
			).rejects.toThrow("No secret named TOKEN_A is stored. Run /secret list to see what is.");
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
	 * Both surfaces parse every verb, so both name every verb. The terminal ALSO names the value
	 * forms, which is the half of the grammar the other surface cannot offer safely.
	 *
	 * A user who mistypes gets this text. What this replaced was accurate and useless: the verbs were
	 * in noninteractive help and deliberately absent from terminal help, because the terminal parsed
	 * no verbs at all, so an operator who found `list` in the docs and typed it stored the word
	 * `list` as a credential. Now the verbs work on both surfaces, and help that omitted them on
	 * either one would hide working commands.
	 */
	it("documents every verb on both surfaces", () => {
		const noninteractive = secretCommandUsage("noninteractive");
		const tui = secretCommandUsage("tui");

		for (const verb of ["list", "rm", "extend", "log", "discard"]) {
			expect(noninteractive).toContain(`/secret ${verb}`);
			expect(tui).toContain(`/secret ${verb}`);
		}
		// `add` is spelled per surface, which is the one asymmetry left: a name and a variable where a
		// value cannot be typed at all, the bare value form where it can.
		expect(noninteractive).toContain("/secret add <name>");
		expect(tui).toContain("/secret <value>");
		expect(tui).not.toContain("/secret add");
	});

	/** The terminal help documents the three ways in and the one reserved word, and nothing else. */
	it("documents the verbless entry forms and the manager in a terminal", () => {
		const tui = secretCommandUsage("tui");

		expect(tui).toContain("/secret <value>");
		expect(tui).toContain("/secret --from-env <VAR>");
		expect(tui).toContain("paste into a hidden field");
		expect(tui).toContain("/secret manager");
		expect(secretCommandUsage("noninteractive")).not.toContain("/secret manager");
	});

	/** Options and their defaults mean the same thing on both surfaces, so both spell them out. */
	it("states the options and the scope precedence on both surfaces", () => {
		for (const usage of [secretCommandUsage("tui"), secretCommandUsage("noninteractive")]) {
			expect(usage).toContain("--from-env");
			expect(usage).toContain("--ttl");
			expect(usage).toContain("--scope");
			expect(usage).toContain("never");
			expect(usage).toContain("project overrides profile");
		}
	});
});

/**
 * The other branch of the same parser: in a terminal the FIRST WORD decides.
 *
 * WHY IT IS PINNED HERE TOO. `the-masked-prompt-cannot-be-read-as-a-name-prompt.test.ts` drives
 * this grammar through the real dialogs and the real vault, which is the right place to prove that
 * what an operator types is what gets stored. It cannot show the REQUEST, though, and the request
 * is where the two grammars actually part: whether a line came back as a value, as a verb, or as an
 * escaped value is decided here, before any surface sees it. So these assert the returned object
 * directly and nothing downstream of it.
 */
describe("the terminal grammar", () => {
	/**
	 * An `add` with no value and no source is the signal that opens the masked field: it is exactly
	 * what `needsValuePrompt` looks for. A bare line must not come back as `help`, or the one
	 * gesture that puts a credential nowhere near the scrollback would print usage instead.
	 */
	it("returns a valueless add for a bare line", () => {
		for (const line of ["", "   ", "\t "]) {
			const request = parseSecretCommand(line, "tui");

			expect(request).toEqual({ subcommand: "add" });
			expect(request.value).toBeUndefined();
			expect(request.fromEnv).toBeUndefined();
		}
	});

	/** The single reserved word, which the adapter turns into "open the GUI" rather than a vault call. */
	it("returns the manager subcommand for the bare reserved word", () => {
		expect(parseSecretCommand("manager", "tui")).toEqual({ subcommand: "manager" });
		expect(parseSecretCommand("  MANAGER  ", "tui")).toEqual({ subcommand: "manager" });
	});

	/**
	 * A reserved word is a command however much follows it, so a malformed one is REFUSED rather
	 * than re-read as a credential. Refusing is what closes the silent-storage class: the older
	 * grammar reserved `manager` for exactly one word and treated every longer line as a value, so
	 * `/secret rm TOKEN` and `/secret log 50` both quietly became credentials.
	 *
	 * The refusal has to carry the escape, because the operator whose credential really does start
	 * with a reserved word has exactly one way to say so and no reason to guess it.
	 */
	it("refuses a malformed reserved line and names the escape", () => {
		expect(() => parseSecretCommand("manager key 8891", "tui")).toThrow(/\/secret -- <value>/u);
	});

	/** And the escape stores that same line verbatim, reserved first word and all. */
	it("stores an escaped line as the credential, byte for byte", () => {
		expect(parseSecretCommand("-- manager key 8891", "tui")).toEqual({
			subcommand: "add",
			value: "manager key 8891",
		});
	});

	/**
	 * The value is the span from the first token to the last, not a trim and not a re-joined token
	 * list. A passphrase is allowed to contain runs of spaces and tabs; collapsing them would store
	 * a credential that fails to authenticate with nothing on screen to say why.
	 */
	it("keeps whitespace inside the credential and drops only what surrounds it", () => {
		expect(parseSecretCommand("   correct horse  battery\tstaple   ", "tui")).toEqual({
			subcommand: "add",
			value: "correct horse  battery\tstaple",
		});
	});

	/**
	 * `add` IS a verb again in a terminal, and it is a synonym for the bare form rather than the
	 * noninteractive `add <name> <value>`. The distinction is the security property: a name parsed
	 * off this line would be a live credential written to the vault's plaintext metadata and echoed
	 * back on screen, which is how `/secret add ghp_realToken` used to store a token as a NAME.
	 *
	 * So the value is the rest of the line and `name` stays absent. A regression that restored
	 * positional-name parsing on this surface fails on the `name` assertion, not the value one.
	 */
	it("reads add as a synonym for the bare value form, with no name", () => {
		const request = parseSecretCommand("add GITHUB_TOKEN", "tui");

		expect(request).toEqual({ subcommand: "add", value: "GITHUB_TOKEN" });
		expect(request.name).toBeUndefined();
	});

	/** `/secret add` alone is the masked field, exactly as a bare line is. */
	it("opens the masked field for a bare add", () => {
		expect(parseSecretCommand("add", "tui")).toEqual({ subcommand: "add" });
		expect(parseSecretCommand("add --from-env MY_VAR", "tui")).toEqual({ subcommand: "add", fromEnv: "MY_VAR" });
	});

	/**
	 * `--from-env` survives, in leading position only: it is the one entry form that never puts the
	 * credential on screen at all, so dropping it from the terminal would have left the safest path
	 * to ACP clients and not to the operator. A trailing extra word is refused rather than guessed
	 * at, because the flag reading and the credential reading of that line are mutually exclusive.
	 */
	it("reads a leading --from-env and refuses one carrying an extra word", () => {
		expect(parseSecretCommand("--from-env MY_VAR", "tui")).toEqual({ subcommand: "add", fromEnv: "MY_VAR" });
		expect(() => parseSecretCommand("--from-env MY_VAR extra", "tui")).toThrow(
			"--from-env needs the name of an environment variable, and nothing else.",
		);
	});

	/**
	 * The reserved word on a client with no screen to open is named for what it is, not filed under
	 * "unknown". Calling a real command unknown sends an ACP or `-p` caller hunting for a typo
	 * instead of reading the text verbs the same refusal prints underneath.
	 */
	it("refuses the manager on a client that has no screen, without calling it unknown", () => {
		const message = messageOf(() => parseSecretCommand("manager", "noninteractive"));

		expect(message).toContain("The secret manager is a terminal screen, and this client has none.");
		expect(message).not.toContain("Unknown /secret subcommand");
		expect(message).toContain(secretCommandUsage("noninteractive"));
	});
});
