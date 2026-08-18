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
	SECRET_SUBCOMMAND_SHAPES,
	type SecretSubcommand,
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

describe("parsing the noninteractive command grammar", () => {
	/** No arguments is a request for help, not an error, on both surfaces. */
	it("treats an empty line as help", () => {
		expect(parseSecretCommand("", "noninteractive").subcommand).toBe("help");
		expect(parseSecretCommand("   ", "noninteractive").subcommand).toBe("help");
	});

	/** The commands, plus the second spellings people reach for. All of them run on both surfaces. */
	it("accepts every command and its synonyms", () => {
		expect(parseSecretCommand("from-env MY_VAR TOKEN_A", "noninteractive").subcommand).toBe("from-env");
		expect(parseSecretCommand("env MY_VAR TOKEN_A", "noninteractive").subcommand).toBe("from-env");
		expect(parseSecretCommand("list", "noninteractive").subcommand).toBe("list");
		expect(parseSecretCommand("rm TOKEN_A", "noninteractive").subcommand).toBe("rm");
		expect(parseSecretCommand("remove TOKEN_A", "noninteractive").subcommand).toBe("rm");
		expect(parseSecretCommand("delete TOKEN_A", "noninteractive").subcommand).toBe("rm");
		expect(parseSecretCommand("clear profile", "noninteractive").subcommand).toBe("clear");
		expect(parseSecretCommand("wipe profile", "noninteractive").subcommand).toBe("clear");
		expect(parseSecretCommand("extend TOKEN_A 7d", "noninteractive").subcommand).toBe("extend");
		expect(parseSecretCommand("renew TOKEN_A 7d", "noninteractive").subcommand).toBe("extend");
		expect(parseSecretCommand("rename TOKEN_A TOKEN_B", "noninteractive").subcommand).toBe("rename");
		expect(parseSecretCommand("name TOKEN_A TOKEN_B", "noninteractive").subcommand).toBe("rename");
		expect(parseSecretCommand("value TOKEN_A", "noninteractive").subcommand).toBe("value");
		expect(parseSecretCommand("replace TOKEN_A", "noninteractive").subcommand).toBe("value");
		expect(parseSecretCommand("scope TOKEN_A global", "noninteractive").subcommand).toBe("scope");
		expect(parseSecretCommand("move TOKEN_A global", "noninteractive").subcommand).toBe("scope");
		expect(parseSecretCommand("copy TOKEN_A", "noninteractive").subcommand).toBe("copy");
		expect(parseSecretCommand("log", "noninteractive").subcommand).toBe("log");
		expect(parseSecretCommand("audit", "noninteractive").subcommand).toBe("log");
		expect(parseSecretCommand("discard project", "noninteractive").subcommand).toBe("discard");
		expect(parseSecretCommand("help", "noninteractive").subcommand).toBe("help");
	});

	/**
	 * An unknown command refuses without echoing the candidate token. A misplaced credential is still
	 * secret data even when it occupies the first word.
	 */
	it("refuses an unknown command without echoing candidate bytes", () => {
		const candidate = "credential-fragment-that-must-not-print";
		let message = "";
		try {
			parseSecretCommand(candidate, "noninteractive");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Unknown /secret command.");
		expect(message).not.toContain(candidate);
	});

	/**
	 * A TRAILING WORD IS RECOGNISED BY ITS SHAPE, so the order it is written in does not matter.
	 *
	 * This is what replaced the options: an operator who writes the vault before the lifetime has not
	 * made a mistake, and there is no flag left to tell the two apart by. Both orders are asserted,
	 * because a parser that read them positionally would pass one row and fail the other.
	 */
	it("reads a lifetime and a vault in either order", () => {
		const a = parseSecretCommand("from-env MY_VAR TOKEN_A 7d project", "noninteractive");
		expect(a).toMatchObject({
			subcommand: "from-env",
			name: "TOKEN_A",
			fromEnv: "MY_VAR",
			ttl: 7 * DAY,
			scope: "project",
		});

		const b = parseSecretCommand("from-env OTHER TOKEN_B global never", "noninteractive");
		expect(b).toMatchObject({
			subcommand: "from-env",
			name: "TOKEN_B",
			fromEnv: "OTHER",
			ttl: null,
			scope: "global",
		});
	});

	/**
	 * A REQUIRED WORD TAKES WHATEVER ARRIVES, which is what lets a secret be called PROFILE.
	 *
	 * The shapes that identify a trailing word are exactly the shapes a name is allowed to have, so
	 * position has to win where a word is required. Otherwise the vault could hold no secret named
	 * after a scope, and the operator would be told their name is invalid rather than being asked for
	 * one.
	 */
	it("reads a required word by position, even when it looks like a vault", () => {
		expect(parseSecretCommand("rm PROFILE", "noninteractive")).toMatchObject({ subcommand: "rm", name: "PROFILE" });
		expect(parseSecretCommand("rm PROFILE global", "noninteractive")).toMatchObject({
			subcommand: "rm",
			name: "PROFILE",
			scope: "global",
		});
		expect(parseSecretCommand("extend NEVER never", "noninteractive")).toMatchObject({
			subcommand: "extend",
			name: "NEVER",
			ttl: null,
		});
	});

	/**
	 * Slash parsing owns only the whitespace that separates the command name from its arguments. Once
	 * the credential starts, repeated, leading and trailing whitespace are credential bytes.
	 *
	 * A terminal line, because that is the only surface with an inline value: a client refuses one, so
	 * there is nothing for it to transport.
	 */
	it("preserves unquoted credential bytes through slash transport", () => {
		const credential = "  alpha  beta\tgamma  ";
		const transported = parseSlashCommand(`/secret   add${credential}`)?.args;

		expect(transported).toBe(`add${credential}`);
		expect(parseSecretCommand(transported ?? "", "tui").value).toBe(credential.trim());
	});

	/**
	 * Quotes are credential data rather than shell syntax at this boundary. Keeping them exactly
	 * prevents the slash adapter from changing a quoted token before storage.
	 */
	it("preserves quoted credential bytes through slash transport", () => {
		const credential = '"alpha beta"';
		const transported = parseSlashCommand(`/secret add ${credential}`)?.args;

		expect(transported).toBe(`add ${credential}`);
		expect(parseSecretCommand(transported ?? "", "tui").value).toBe(credential);
	});

	/**
	 * NOTHING AFTER `add` IS SYNTAX, which is what removing the options bought.
	 *
	 * A credential containing a dash-shaped word used to be REFUSED as ambiguous, because the parser
	 * could not tell an option from the bytes of a passphrase. There are no options, so the ambiguity
	 * cannot arise and the value is stored exactly as typed -- dashes, spaces and all. The one
	 * exception is the bare `--` token, which is refused rather than stored, and has its own rows in
	 * the terminal suite below.
	 */
	it("stores a credential containing dash-shaped words verbatim", () => {
		for (const credential of ["alpha-secret --scope global", "alpha --scope omega", "--credential-fragment"]) {
			expect(parseSecretCommand(`add ${credential}`, "tui")).toEqual({ subcommand: "add", value: credential });
		}
	});

	/** `never` is a lifetime, so it reaches the request as an explicit null rather than as a default. */
	it("understands a never lifetime", () => {
		expect(parseSecretCommand("from-env MY_VAR TOKEN_A never", "noninteractive").ttl).toBeNull();
	});

	/** An absent lifetime is undefined, which means "use the configured default". */
	it("leaves an unspecified lifetime undefined", () => {
		expect(parseSecretCommand("from-env MY_VAR TOKEN_A", "noninteractive").ttl).toBeUndefined();
	});

	/**
	 * A malformed lifetime refuses at parse time, and is diagnosed as a lifetime rather than as an
	 * unreadable word.
	 *
	 * Refusing here rather than defaulting is the point: `7dd` silently becoming one day is how a
	 * credential outlives the window its owner chose. Naming it as a LIFETIME is the second half: any
	 * word beginning with a digit can only have been meant as one, since a vault is one of three
	 * literals and a secret name may not start with a digit, so the parser claims it and says what a
	 * lifetime looks like instead of listing every word it could not read.
	 */
	it("refuses a lifetime it cannot read", () => {
		expect(() => parseSecretCommand("from-env MY_VAR TOKEN_A 7dd", "noninteractive")).toThrow(/is not a lifetime/);
		expect(() => parseSecretCommand("from-env MY_VAR TOKEN_A 50", "noninteractive")).toThrow(/is not a lifetime/);
		expect(() => parseSecretCommand("extend TOKEN_A", "noninteractive")).toThrow(/still needs a lifetime/);
	});

	/**
	 * Zero and arithmetic-overflow lifetimes are boundaries, not alternate spellings of the default.
	 * Both must refuse before a request can reach storage.
	 */
	it("refuses TTL boundary values instead of falling back", () => {
		expect(() => parseSecretCommand("from-env V TOKEN_A 0m", "noninteractive")).toThrow(/expire immediately/);
		expect(() => parseSecretCommand("from-env V TOKEN_A 9007199254740991w", "noninteractive")).toThrow(/too large/);
		expect(() => parseSecretCommand("extend TOKEN_A 0m", "noninteractive")).toThrow(/expire immediately/);
		expect(() => parseSecretCommand("extend TOKEN_A 9007199254740991w", "noninteractive")).toThrow(/too large/);
	});

	/**
	 * The two commands that take a lifetime must diagnose the same bad one identically.
	 *
	 * They did not. The entry path rewrote every `parseTtl` failure into one generic "needs a valid
	 * lifetime", which existed only to stop `parseTtl` echoing the value back, and the cost was that it
	 * could not tell "0m expires immediately" from "9007199254740991w is too large" from "7dd is not a
	 * lifetime". Same mistake, same sentence, whichever command you typed. If this fails, someone
	 * reintroduced a per-command rewrite and one is now less specific than the other.
	 */
	it("diagnoses a bad lifetime identically for from-env and extend", () => {
		for (const [spec, expected] of [
			["7dd", /is not a lifetime/],
			["0m", /expire immediately/],
			["9007199254740991w", /too large/],
		] as const) {
			const fromEntry = messageOf(() => parseSecretCommand(`from-env V TOKEN_A ${spec}`, "noninteractive"));
			const fromExtend = messageOf(() => parseSecretCommand(`extend TOKEN_A ${spec}`, "noninteractive"));
			expect(fromEntry).toMatch(expected);
			expect(fromExtend).toMatch(expected);
			expect(fromEntry).toBe(fromExtend);
		}
	});

	/** A word in a vault's own position that is not a vault refuses, naming the three that exist. */
	it("refuses an unknown vault", () => {
		expect(() => parseSecretCommand("scope TOKEN_A everywhere", "noninteractive")).toThrow(
			/Write profile, project or global/,
		);
		expect(() => parseSecretCommand("clear everywhere", "noninteractive")).toThrow(
			/Write profile, project or global/,
		);
	});

	/**
	 * A word past the last slot refuses instead of being ignored, and says which shapes the command
	 * still reads.
	 */
	it("refuses a word no slot can hold", () => {
		const message = messageOf(() => parseSecretCommand("rm TOKEN_A global extra", "noninteractive"));

		expect(message).toContain("/secret rm cannot read");
		expect(message).not.toContain("extra");
	});

	/** Naming one slot twice is always a refusal; no last word silently wins. */
	it("refuses a repeated lifetime, vault or limit", () => {
		for (const args of ["from-env V TOKEN_A project global", "from-env V TOKEN_A 1h never", "log 1 99"]) {
			expect(() => parseSecretCommand(args, "noninteractive")).toThrow(/once, and this line names one twice/);
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
				parseSecretCommand("from-env MY_TOKEN github-token", "noninteractive"),
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
				parseSecretCommand("from-env MY_TOKEN github-token", "noninteractive"),
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
				parseSecretCommand("from-env MY_TOKEN github-token", "noninteractive"),
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
				// A terminal line: it is the only surface with an inline value, since a client cannot show
				// a warning about a screen it does not have.
				{ ...parseSecretCommand(`add ${VALUE}`, "tui"), name: "github-token" },
				context,
			);

			expect(result.changed).toBe(true);
			expect(result.message).toContain("in your scrollback");
			expect(result.message).toContain("/secret from-env");
		});
	});

	/**
	 * The vault must receive the exact bytes that crossed the slash boundary. A parser-only check
	 * would miss a later normalization before persistence, so this pins the stored value as well.
	 */
	it("stores transported inline credential bytes exactly", async () => {
		await withContext(async context => {
			const credential = `"${VALUE} alpha"`;
			const transported = parseSlashCommand(`/secret add  ${credential}  `)?.args;

			expect(transported).toBe(`add  ${credential}  `);
			const request = { ...parseSecretCommand(transported ?? "", "tui"), name: "byte-token" };
			expect(request.value).toBe(credential);
			const result = await runSecretCommand(request, context);

			expect((await context.vault.load())[0]?.value).toBe(credential);
			expect(result.message).not.toContain(credential);
			expect(result.agentNotice).not.toContain(credential);
		});
	});

	/**
	 * A credential followed by a valid-looking option used to be TRUNCATED and stored in another
	 * scope, and then, once that was caught, refused as ambiguous. Neither is right, and neither is
	 * reachable now: no word after `add` is syntax, so the whole line is the credential and the vault
	 * receives it byte for byte. Pinned through the store, because a parser-only check would miss a
	 * normalisation on the way to disk -- which is how the truncation happened in the first place.
	 */
	it("stores a credential that contains an option-shaped word", async () => {
		await withContext(async context => {
			const credential = `${VALUE} --scope global`;
			const transported = parseSlashCommand(`/secret add ${credential}`)?.args;

			expect(transported).toBe(`add ${credential}`);
			const request = { ...parseSecretCommand(transported ?? "", "tui"), name: "byte-token" };
			const result = await runSecretCommand(request, context);

			expect((await context.vault.load())[0]?.value).toBe(credential);
			expect(result.message).not.toContain(credential);
		});
	});

	/** A value read from the environment does not get the scrollback warning, since it was not typed. */
	it("omits the scrollback warning for a value read from the environment", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(
				parseSecretCommand("from-env MY_TOKEN t-token", "noninteractive"),
				context,
			);

			expect(result.message).not.toContain("scrollback");
		});
	});

	/** An unset environment variable refuses, explaining the likely cause. */
	it("refuses when the environment variable is not set", async () => {
		await withContext(async context => {
			await expect(
				runSecretCommand(parseSecretCommand("from-env NOPE t-token", "noninteractive"), context),
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
				parseSecretCommand("from-env EMPTY_TOKEN t-token", "noninteractive"),
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
				runSecretCommand(parseSecretCommand("from-env BLANK_TOKEN t-token", "noninteractive"), context),
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

			await runSecretCommand(parseSecretCommand("from-env PADDED_TOKEN t-token", "noninteractive"), context);

			const stored = await context.vault.load();
			expect(stored.find(entry => entry.name === "T_TOKEN")?.value).toBe(padded);
		});
	});

	/**
	 * Two sources at once is a mistake worth naming rather than silently preferring one.
	 *
	 * Hand-built, because no line produces it any more: `from-env` reads a variable, a name, a lifetime
	 * and a vault, so a credential appended to it is a word that fits no slot and the parser refuses it
	 * first. The runner guard stays asserted because `runSecretCommand` is exported, and because
	 * choosing one source silently is the failure it prevents: the operator would be told a credential
	 * was stored without being told which one.
	 */
	it("refuses both a value and an environment variable", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await expect(
				runSecretCommand({ subcommand: "from-env", fromEnv: "MY_TOKEN", name: "T_TOKEN", value: VALUE }, context),
			).rejects.toThrow(/either an environment variable or a value, not both/i);
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
	it("names only the environment form when given no value", async () => {
		await withContext(async context => {
			// Hand-built, because the grammar refuses this line before the runner sees it: `add` takes no
			// words on a client. The runner guard stays asserted anyway, since `runSecretCommand` is
			// exported and a caller that skips the parser must still be told which form this surface has.
			const failure = await runSecretCommand({ subcommand: "add", name: "T_TOKEN" }, context).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect((failure as Error).message).toContain("Name an environment variable to read it from");
			expect((failure as Error).message).toContain("/secret from-env MY_TOKEN T_TOKEN");
			expect((failure as Error).message).not.toContain("visible in your scrollback");
		});
	});

	/** The configured default lifetime is applied when the command does not say. */
	it("applies the configured default lifetime", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await runSecretCommand(parseSecretCommand("from-env MY_TOKEN t-token", "noninteractive"), context);

			expect((await context.vault.load())[0].expiresAt).toBe(context.now + DAY);
		});
	});

	/** An explicit lifetime beats the default. */
	it("prefers an explicit lifetime", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			await runSecretCommand(parseSecretCommand("from-env MY_TOKEN t-token never", "noninteractive"), context);

			expect((await context.vault.load())[0].expiresAt).toBeNull();
		});
	});

	/**
	 * An unnamed entry still works and reports the invented name.
	 *
	 * A TERMINAL LINE, because that is where a name can be absent: `/secret from-env <VAR>` takes the
	 * variable alone and the name is asked afterwards, so an operator who declines to name it gets one.
	 * A client must write the name on the line, so the invented name is unreachable there.
	 */
	it("invents a name when none is given", async () => {
		await withContext(async context => {
			context.env.set("MY_TOKEN", VALUE);

			const result = await runSecretCommand(parseSecretCommand("from-env MY_TOKEN", "tui"), context);

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
			expect(result.message).toContain("/secret from-env");
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
			await runSecretCommand(parseSecretCommand("from-env A token-a project", "noninteractive"), context);
			await runSecretCommand(parseSecretCommand("from-env B token-b never", "noninteractive"), context);

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
			await runSecretCommand(parseSecretCommand("from-env PROFILE shared-token profile", "noninteractive"), context);
			await runSecretCommand(parseSecretCommand("from-env PROJECT shared-token project", "noninteractive"), context);

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
			await runSecretCommand(parseSecretCommand("from-env A zebra-token", "noninteractive"), context);
			await runSecretCommand(parseSecretCommand("from-env A alpha-token", "noninteractive"), context);

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
			await runSecretCommand(parseSecretCommand("from-env A token-a global", "noninteractive"), context);

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

	/**
	 * `rm` with no name asks for one rather than removing anything, at both layers.
	 *
	 * The parser refuses first, which is where an operator meets it. The runner keeps its own guard
	 * because `runSecretCommand` is exported: a caller that builds a request by hand must not be able
	 * to reach a removal with no name and have it resolve to something.
	 */
	it("refuses rm with no name", async () => {
		await withContext(async context => {
			expect(() => parseSecretCommand("rm", "noninteractive")).toThrow(/still needs a secret name/);
			await expect(runSecretCommand({ subcommand: "rm" }, context)).rejects.toThrow(/Which secret/);
		});
	});

	/** Extending reports both the affected scope and the new lifetime, which matters when names overlap. */
	it("extends a secret", async () => {
		await withContext(async context => {
			context.env.set("A", VALUE);
			await runSecretCommand(parseSecretCommand("from-env A token-a 30m", "noninteractive"), context);

			const result = await runSecretCommand(parseSecretCommand("extend token-a 7d", "noninteractive"), context);

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
				parseSecretCommand("from-env PROFILE shared-token profile 30m", "noninteractive"),
				context,
			);
			await runSecretCommand(
				parseSecretCommand("from-env PROJECT shared-token project 30m", "noninteractive"),
				context,
			);

			const extended = await runSecretCommand(
				parseSecretCommand("extend shared-token 7d", "noninteractive"),
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
					"profile to remove that one too.",
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
				runSecretCommand(parseSecretCommand("extend token-a 7d", "noninteractive"), context),
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

		// DERIVED from the shape table, not listed. The list here was written out, so `clear` was added
		// to the grammar and to both help texts while this row went on asserting the nine verbs that
		// predated it -- green, and blind to the verb it should have been checking.
		const commands = (Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(
			command => command !== "add" && command !== "help",
		);
		expect(commands.length).toBeGreaterThan(9);
		for (const command of commands) {
			expect(noninteractive).toContain(`/secret ${command}`);
			expect(tui).toContain(`/secret ${command}`);
		}
		// `add` is the one asymmetry left, and both texts say so in their own terms: the terminal shows
		// the value form, and the client shows the word with the reason it does not work there. It is
		// named on the client rather than omitted because `add` is declared, so an ACP listing offers it,
		// and a listed command whose only documentation is the error it returns is a command that reads
		// as broken.
		expect(tui).toContain("/secret add <value>");
		expect(noninteractive).toContain("/secret add ");
		expect(noninteractive).toContain("use from-env");
		expect(noninteractive).not.toContain("/secret add <value>");
		// A NAME is never advertised beside `add`: an inline name is what writes a credential into
		// plaintext metadata when the two words are read the other way round.
		expect(tui).not.toContain("/secret add <name>");
	});

	/**
	 * The terminal help documents the ways in, and never a screen: there is not one to open.
	 *
	 * EVERY ENTRY FORM LEADS WITH THE VERB. The old list opened with `/secret <value>`, a form with no
	 * verb, and a help text that still showed it would be teaching a line the parser now refuses --
	 * with the operator's credential on screen, which is the one refusal worth never provoking.
	 */
	it("documents the entry forms in a terminal", () => {
		const tui = secretCommandUsage("tui");

		expect(tui).toContain("/secret add                           paste into a hidden field");
		expect(tui).toContain("/secret add <value>");
		expect(tui).toContain("/secret from-env <VAR>");
		expect(tui).not.toContain("manager");
		// The verbless forms are gone from the help because they are gone from the grammar. Asserted as
		// the exact line starts, so `/secret <value>` cannot come back as an entry form while
		// `/secret add <value>` keeps this row green by containing the same tail.
		expect(tui).not.toContain("  /secret <value>");
		expect(tui).not.toContain("  /secret --from-env");
		expect(tui).not.toContain("  /secret  ");
	});

	/**
	 * The word shapes and their defaults mean the same thing on both surfaces, so both spell them out.
	 *
	 * Every row is asserted dash-free as well, because a footer naming `--ttl` would be teaching a
	 * spelling the parser refuses -- the failure this whole grammar change exists to remove.
	 */
	it("states the word shapes and the scope precedence on both surfaces", () => {
		for (const usage of [secretCommandUsage("tui"), secretCommandUsage("noninteractive")]) {
			expect(usage).toContain("30m|12h|7d|2w|never");
			expect(usage).toContain("profile|project|global");
			expect(usage).toContain("a lifetime, on");
			expect(usage).toContain("a vault, on");
			expect(usage).toContain("project overrides profile");
			expect(usage).not.toMatch(/(^|\s)--/mu);
		}
	});
});

/**
 * The other branch of the same parser: in a terminal a VERB comes first, and what follows `add` is
 * the credential.
 *
 * WHY IT IS PINNED HERE TOO. `the-masked-prompt-cannot-be-read-as-a-name-prompt.test.ts` drives
 * this grammar through the real dialogs and the real vault, which is the right place to prove that
 * what an operator types is what gets stored. It cannot show the REQUEST, though, and the request
 * is where the two grammars actually part: whether a line came back as a value, as a verb, or as a
 * refusal is decided here, before any surface sees it. So these assert the returned object directly
 * and nothing downstream of it.
 */
describe("the terminal grammar", () => {
	/**
	 * A BARE LINE IS HELP, on this surface as on the other. It used to come back as a valueless `add`
	 * so that `/secret` alone opened the masked field, which was the verbless grammar's one good
	 * affordance and the reason a first word could not be required. With the verb required, the field
	 * is one word away and a bare line has nothing to do but say what the words are.
	 */
	it("returns help for a bare line", () => {
		for (const line of ["", "   ", "\t "]) {
			expect(parseSecretCommand(line, "tui")).toEqual({ subcommand: "help" });
		}
	});

	/**
	 * A FIRST WORD THAT IS NOT A VERB IS REFUSED, and `manager` is the case on purpose: it is the
	 * word a stale piece of advice or an old habit puts on this line. It used to be STORED — the
	 * parser read any unreserved first word as the credential — so a mistyped verb became a vault
	 * entry named `SECRET_1` and switched protection on, and the operator's answer to "what do I
	 * have" was the word they had mistyped.
	 *
	 * `value` is asserted absent on the thrown path by construction: nothing is returned at all.
	 */
	it("refuses a word that is not a verb, rather than storing it", () => {
		for (const line of ["manager", "  MANAGER  ", "ghp_pastedFromMuscleMemory", "lst"]) {
			expect(() => parseSecretCommand(line, "tui")).toThrow(/Unknown \/secret command/u);
		}
	});

	/**
	 * AND THE REFUSAL SAYS THE LINE IS EXPOSED, without repeating it.
	 *
	 * This is the cost of requiring the verb, and it is worth paying explicitly rather than silently.
	 * The operator who types `/secret ghp_…` is the one who learned the verbless gesture, and the
	 * refusal leaves them in a state neither outcome prepares them for: nothing was stored, AND the
	 * credential is in the scrollback of a session that will not obfuscate it, because the vault never
	 * saw it. A bare "unknown command" would let them believe a credential is protected while it sits
	 * on screen in plaintext, which is the failure mode of the entire feature.
	 *
	 * Both halves are asserted together, because the warning must not be bought by echoing the bytes.
	 */
	it("warns that a refused line is exposed, and never repeats it", () => {
		const message = messageOf(() => parseSecretCommand("ghp_pastedFromMuscleMemory", "tui"));

		expect(message).toContain("Nothing was stored.");
		expect(message).toContain("in your scrollback and was never protected");
		expect(message).toContain("rotate it");
		expect(message).toContain("/secret add");
		expect(message).not.toContain("ghp_pastedFromMuscleMemory");
	});

	/**
	 * A reserved word is a command however much follows it, so a malformed one is REFUSED rather
	 * than re-read as a credential. Refusing is what closes the silent-storage class: a grammar that
	 * fell back to storage when a verb did not fit its shape would turn `/secret log 50` into a
	 * credential and report it as a success.
	 *
	 * The refusal has to name the escape, because the operator whose credential really does start
	 * with a reserved word has to be told the one spelling that expresses it.
	 */
	it("refuses a malformed reserved line and names the value form", () => {
		// `log 50` is WELL FORMED now -- a bare number is the limit -- so the malformed line is one with
		// a word no slot can hold. Both rows still prove the same thing: a reserved first word is a
		// command however badly the rest is written, and the operator is told the one spelling that
		// stores such a line as a credential.
		expect(() => parseSecretCommand("log 50 20", "tui")).toThrow(/\/secret add <value>/u);
		expect(() => parseSecretCommand("list everything", "tui")).toThrow(/\/secret add <value>/u);
	});

	/** And the escape stores that same line verbatim, reserved first word and all. */
	it("stores an escaped line as the credential, byte for byte", () => {
		expect(parseSecretCommand("add log 50", "tui")).toEqual({
			subcommand: "add",
			value: "log 50",
		});
	});

	/**
	 * THE REMOVED `--` SPELLING FAILS CLOSED WHERE A VALUE IS READ, because the alternative is a
	 * corrupted credential. `--` is not a verb, so deleting its branch and nothing else would have
	 * sent `add -- sk-x` to the value reader, which slices from the first token to the last and would
	 * have stored the dashes as part of the credential. `#NAME#` then expands to `-- sk-x`, the
	 * request fails authentication somewhere else entirely, and nothing on screen connects that to a
	 * slash command. A credential is the one input whose corruption stays invisible until it is spent.
	 *
	 * Before `add`, `--` is simply not a command, so it is refused as one. Both refusals store
	 * nothing, and neither is allowed to become a value.
	 */
	it("refuses -- after add rather than storing the dashes", () => {
		for (const line of ["add -- sk-live-x", "add --"]) {
			expect(() => parseSecretCommand(line, "tui")).toThrow(/not part of \/secret/u);
			expect(() => parseSecretCommand(line, "tui")).toThrow(/\/secret add <value>/u);
		}
	});

	/** And as a first word it is refused for the ordinary reason: it is not a command. */
	it("refuses -- as a first word", () => {
		for (const line of ["-- log 50", "-- sk-live-x", "--"]) {
			expect(() => parseSecretCommand(line, "tui")).toThrow(/Unknown \/secret command/u);
		}
	});

	/**
	 * ONLY THE EXACT TOKEN. A credential that merely begins with dashes is stored byte for byte:
	 * widening the refusal to any `--` prefix would reject real values, which is the opposite failure
	 * and a louder one.
	 */
	it("still stores a value that only begins with dashes", () => {
		expect(parseSecretCommand("add --abc", "tui")).toEqual({ subcommand: "add", value: "--abc" });
		expect(parseSecretCommand("add ---", "tui")).toEqual({ subcommand: "add", value: "---" });
	});

	/**
	 * The value is the span from the first token to the last, not a trim and not a re-joined token
	 * list. A passphrase is allowed to contain runs of spaces and tabs; collapsing them would store
	 * a credential that fails to authenticate with nothing on screen to say why.
	 */
	it("keeps whitespace inside the credential and drops only what surrounds it", () => {
		expect(parseSecretCommand("add    correct horse  battery\tstaple   ", "tui")).toEqual({
			subcommand: "add",
			value: "correct horse  battery\tstaple",
		});
	});

	/**
	 * `add` in a terminal is NOT the noninteractive `add <name> <value>`. The distinction is the
	 * security property: a name parsed off this line would be a live credential written to the vault's
	 * plaintext metadata and echoed back on screen, which is how `/secret add ghp_realToken` used to
	 * store a token as a NAME.
	 *
	 * So the value is the rest of the line and `name` stays absent. A regression that restored
	 * positional-name parsing on this surface fails on the `name` assertion, not the value one.
	 */
	it("reads the line after add as the value, with no name", () => {
		const request = parseSecretCommand("add GITHUB_TOKEN", "tui");

		expect(request).toEqual({ subcommand: "add", value: "GITHUB_TOKEN" });
		expect(request.name).toBeUndefined();
	});

	/** `/secret add` alone is the masked field: a valueless add is what `needsValuePrompt` reads. */
	it("opens the masked field for a bare add", () => {
		expect(parseSecretCommand("add", "tui")).toEqual({ subcommand: "add" });
	});

	/**
	 * `--from-env` survives, in leading position after the verb only: it is the one entry form that
	 * never puts the credential on screen at all, so dropping it from the terminal would have left the
	 * safest path to ACP clients and not to the operator. A trailing extra word is refused rather than
	 * guessed at, because the flag reading and the credential reading of that line are mutually
	 * exclusive.
	 */
	it("reads from-env as a command of its own, with the name optional in a terminal", () => {
		expect(parseSecretCommand("from-env MY_VAR", "tui")).toEqual({ subcommand: "from-env", fromEnv: "MY_VAR" });
		expect(parseSecretCommand("env MY_VAR", "tui")).toEqual({ subcommand: "from-env", fromEnv: "MY_VAR" });
		// The name may be written, and then it is the same line the client writes. A terminal leaves it
		// out because a field asks for it; leaving it out is the option, not the spelling.
		expect(parseSecretCommand("from-env MY_VAR CHOSEN_NAME 7d", "tui")).toEqual({
			subcommand: "from-env",
			fromEnv: "MY_VAR",
			name: "CHOSEN_NAME",
			ttl: 7 * 24 * 60 * 60 * 1000,
		});
		// And one word past the name is refused, on the surface where the name is the last slot there is.
		expect(() => parseSecretCommand("from-env MY_VAR CHOSEN_NAME MORE", "tui")).toThrow(
			"/secret from-env cannot read the word in position 3",
		);
	});

	/**
	 * THE SAME REFUSAL ON THE OTHER SURFACE, minus the exposure warning. A client or a `-p`
	 * invocation never had the verbless form to unlearn, and the tail of its line is argv rather than
	 * something a person just typed on screen, so the scrollback sentence would be advice about a
	 * screen that may not exist. The refusal still carries the whole usage, because the caller cannot
	 * open a help screen and the list of what it CAN run is the actionable part.
	 *
	 * AND IT DOES NOT REPEAT THE WORD, on either surface: the unknown first token is very often the
	 * credential itself, so echoing it would write it into the refusal, the scrollback and the saved
	 * transcript.
	 */
	it("refuses an unknown word on the noninteractive surface without the scrollback warning", () => {
		const message = messageOf(() => parseSecretCommand("ghp_wordThisSurfaceCannotRead", "noninteractive"));

		expect(message).toContain("Unknown /secret command.");
		expect(message).toContain(secretCommandUsage("noninteractive"));
		expect(message).not.toContain("scrollback");
		expect(message).not.toContain("ghp_wordThisSurfaceCannotRead");
	});
});
