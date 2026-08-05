/**
 * `/secret log`, and the masked-entry path that changes what the confirmation says.
 *
 * WHY THIS SUITE EXISTS. Two things here are easy to get wrong in ways nothing else would catch:
 *
 *   1. `/secret log` with recording turned off must say SO, not print an empty list. An empty list
 *      reads as "no credential has been used", which is a false statement about a session that
 *      used ten.
 *   2. `needsValuePrompt` decides whether a surface opens a masked field. Getting it wrong in
 *      either direction is a real defect: too eager and `--from-env` stops working, too shy and
 *      the credential goes through the composer. It is asked in the pure layer precisely so both
 *      surfaces cannot disagree, so it is pinned here rather than in a TUI test.
 *
 * THE SURFACE IS NONINTERACTIVE, everywhere a command line appears. `log`, `audit`, `--limit` and
 * `add <name> <value>` are verb grammar, and a terminal has none: it reads its whole argument line
 * as a credential. So every `parseSecretCommand` below names that surface explicitly, and the
 * usage assertion reads the noninteractive help, which is the only variant that still lists a
 * verb. `needsValuePrompt` itself is surface-blind — it reads a parsed request, not a surface —
 * which is why the requests it is fed here are the shapes only that grammar can produce.
 */
import { describe, expect, it } from "bun:test";
import { SecretAuditLog } from "@veyyon/coding-agent/secrets/audit";
import {
	DEFAULT_LOG_LIMIT,
	NONINTERACTIVE_SECRET_COMMAND_USAGE,
	needsValuePrompt,
	parseSecretCommand,
	renderLog,
	runSecretCommand,
} from "@veyyon/coding-agent/secrets/secret-command";
import { normaliseSecretName, type SecretVault } from "@veyyon/coding-agent/secrets/vault";

/** A vault stub: `log` never touches one, so this proves the command does not either. */
const unusedVault = {} as SecretVault;

describe("parsing /secret log", () => {
	/** The verb, and the alias people reach for. */
	it("accepts log and audit", () => {
		expect(parseSecretCommand("log", "noninteractive").subcommand).toBe("log");
		expect(parseSecretCommand("audit", "noninteractive").subcommand).toBe("log");
	});

	/** A limit is read as a number. */
	it("reads --limit", () => {
		expect(parseSecretCommand("log --limit 50", "noninteractive").limit).toBe(50);
	});

	/** No limit means the default, chosen in one place. */
	it("leaves the limit unset when not given", () => {
		expect(parseSecretCommand("log", "noninteractive").limit).toBeUndefined();
		expect(DEFAULT_LOG_LIMIT).toBe(20);
	});

	/**
	 * A nonsense limit is refused rather than silently treated as the default.
	 *
	 * `--limit abc` quietly becoming 20 would show the operator a truncated log while they believed
	 * they had asked for all of it.
	 */
	it("refuses a limit that is not a positive whole number", () => {
		expect(() => parseSecretCommand("log --limit abc", "noninteractive")).toThrow(/positive whole number/);
		expect(() => parseSecretCommand("log --limit 0", "noninteractive")).toThrow(/positive whole number/);
		expect(() => parseSecretCommand("log --limit -3", "noninteractive")).toThrow(/positive whole number/);
		expect(() => parseSecretCommand("log --limit 2.5", "noninteractive")).toThrow(/positive whole number/);
		expect(() => parseSecretCommand("log --limit", "noninteractive")).toThrow(/positive whole number/);
	});

	/** The noninteractive usage text documents the subcommand, so a bare `/secret` there teaches it. */
	it("is documented in the usage text", () => {
		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).toContain("/secret log");
		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).toContain("--limit");
	});
});

describe("running /secret log", () => {
	/**
	 * THE ONE THAT MATTERS. With recording off, the command says recording is off.
	 *
	 * Printing "no secret has been used yet" would be a lie in the exact situation somebody runs
	 * this command to check.
	 */
	it("says recording is off rather than showing an empty log", async () => {
		const result = await runSecretCommand(parseSecretCommand("log", "noninteractive"), {
			vault: unusedVault,
			readEnv: () => undefined,
			defaultTtl: null,
			now: 0,
			auditLog: undefined,
		});

		expect(result.message).toContain("not being recorded");
		expect(result.message).toContain("secrets.auditLog");
		expect(result.message).not.toContain("No secret has been used yet");
		expect(result.changed).toBe(false);
	});

	/** Reading the log never counts as a change, so nothing is reconciled or re-saved. */
	it("reports no change", async () => {
		const log = new SecretAuditLog("/nonexistent/veyyon-test/secret-audit.jsonl");
		const result = await runSecretCommand(parseSecretCommand("log", "noninteractive"), {
			vault: unusedVault,
			readEnv: () => undefined,
			defaultTtl: null,
			now: 0,
			auditLog: log,
		});

		expect(result.changed).toBe(false);
		expect(result.agentNotice).toBeUndefined();
	});
});

describe("rendering the log", () => {
	/** An empty log names the file, so the operator can go and look. */
	it("names the file when nothing has been recorded", () => {
		const text = renderLog([], { malformed: 0, path: "/home/u/.veyyon/secret-audit.jsonl", now: 0 });

		expect(text).toBe("No secret has been used yet. The log is /home/u/.veyyon/secret-audit.jsonl.");
	});

	/** Exact layout: the age, the tool, the placeholders, then the command underneath. */
	it("renders a row as age, tool, placeholders and command", () => {
		const now = 10_000_000;
		const text = renderLog(
			[
				{
					at: now - 120_000,
					secrets: ["#GITHUB_TOKEN#"],
					tool: "bash",
					command: '{"command":"curl -H \'Authorization: Bearer #GITHUB_TOKEN#\'"}',
				},
			],
			{ malformed: 0, path: "/log", now },
		);

		expect(text).toBe(
			[
				"1 most recent use(s), oldest first:",
				"  2m ago  bash  #GITHUB_TOKEN#",
				'    {"command":"curl -H \'Authorization: Bearer #GITHUB_TOKEN#\'"}',
			].join("\n"),
		);
	});

	/** Several placeholders in one command are listed together on the row. */
	it("lists every placeholder used in one command", () => {
		const text = renderLog([{ at: 0, secrets: ["#TOKEN_A#", "#TOKEN_B#"], tool: "bash", command: "x" }], {
			malformed: 0,
			path: "/log",
			now: 0,
		});

		expect(text).toContain("#TOKEN_A# #TOKEN_B#");
	});

	/** A capped evidence list says how many additional placeholders were withheld. */
	it("reports omitted placeholders on a truncated record", () => {
		const text = renderLog(
			[
				{
					at: 0,
					secrets: ["#TOKEN_A#"],
					omittedSecrets: 3,
					truncated: true,
					tool: "bash",
					command: "x",
				},
			],
			{ malformed: 0, path: "/log", now: 0 },
		);

		expect(text).toContain("#TOKEN_A# +3 omitted");
	});

	/** Coarse ages, so a row reads at a glance. Exact values, so the arithmetic is pinned. */
	it("describes ages coarsely", () => {
		const rowFor = (elapsed: number): string =>
			renderLog([{ at: 1_000_000_000 - elapsed, secrets: ["#T_TOKEN#"], tool: "bash", command: "x" }], {
				malformed: 0,
				path: "/log",
				now: 1_000_000_000,
			}).split("\n")[1];

		expect(rowFor(5_000)).toContain("just now");
		expect(rowFor(120_000)).toContain("2m ago");
		expect(rowFor(3_600_000)).toContain("1h ago");
		expect(rowFor(7_200_000)).toContain("2h ago");
		expect(rowFor(4 * 86_400_000)).toContain("4d ago");
	});

	/**
	 * Lines that could not be read are reported, not swallowed.
	 *
	 * A log that quietly drops what it cannot parse is not evidence of anything, which defeats the
	 * only reason to keep one.
	 */
	it("says how many lines could not be read", () => {
		const text = renderLog([], { malformed: 3, path: "/home/u/log.jsonl", now: 0 });

		expect(text).toContain("3 line(s) in /home/u/log.jsonl could not be read");
	});
});

describe("a log shared by several sessions", () => {
	/**
	 * Says so, because the log belongs to a PROFILE and not to a session.
	 *
	 * Several veyyon processes in one profile append to one file, so the rows an operator reads can
	 * be interleaved from two windows. Without the note they read as one session's history and the
	 * operator counts uses another window made, which is the wrong conclusion to draw from an audit
	 * log. The `session` field was being recorded and surfaced nowhere at all, which is the same as
	 * not recording it.
	 */
	it("notes how many sessions the records came from", () => {
		const text = renderLog(
			[
				{ at: 0, secrets: ["#A_TOKEN#"], tool: "bash", session: "sess-1", command: "one" },
				{ at: 0, secrets: ["#B_TOKEN#"], tool: "bash", session: "sess-2", command: "two" },
			],
			{ malformed: 0, path: "/log", now: 0 },
		);

		expect(text).toContain("These records come from 2 sessions sharing this profile's log.");
	});

	/** One session is the ordinary case and says nothing, or the note becomes noise on every run. */
	it("stays quiet when every record is from one session", () => {
		const text = renderLog(
			[
				{ at: 0, secrets: ["#A_TOKEN#"], tool: "bash", session: "sess-1", command: "one" },
				{ at: 0, secrets: ["#B_TOKEN#"], tool: "bash", session: "sess-1", command: "two" },
			],
			{ malformed: 0, path: "/log", now: 0 },
		);

		expect(text).not.toContain("sessions sharing");
	});

	/** Records with no session label at all are not counted as a session of their own. */
	it("ignores records that carry no session", () => {
		const text = renderLog(
			[
				{ at: 0, secrets: ["#A_TOKEN#"], tool: "bash", command: "one" },
				{ at: 0, secrets: ["#B_TOKEN#"], tool: "bash", session: "sess-1", command: "two" },
			],
			{ malformed: 0, path: "/log", now: 0 },
		);

		expect(text).not.toContain("sessions sharing");
	});

	/** Three sessions counts three, so the number is the count and not a boolean in disguise. */
	it("counts the distinct sessions", () => {
		const text = renderLog(
			["a", "b", "c", "a"].map((session, index) => ({
				at: 0,
				secrets: [`#T${index}_TOKEN#`],
				tool: "bash",
				session,
				command: `run ${index}`,
			})),
			{ malformed: 0, path: "/log", now: 0 },
		);

		expect(text).toContain("come from 3 sessions");
	});
});

describe("deciding whether to prompt for a value", () => {
	/** An add with a name and nothing else is the case a masked field exists for. */
	it("prompts for an add with no value and no source", () => {
		expect(needsValuePrompt(parseSecretCommand("add github-token", "noninteractive"))).toBe(true);
	});

	/** A name is not required: an unnamed add still needs a value. */
	it("prompts for an add with no name at all", () => {
		expect(needsValuePrompt(parseSecretCommand("add", "noninteractive"))).toBe(true);
	});

	/** `--from-env` already has the value, so prompting would be a pointless extra step. */
	it("does not prompt when the value comes from the environment", () => {
		expect(needsValuePrompt(parseSecretCommand("add github-token --from-env GH_TOKEN", "noninteractive"))).toBe(
			false,
		);
	});

	/** An inline value is already supplied, however unwise that was. */
	it("does not prompt when a value was given inline", () => {
		expect(needsValuePrompt(parseSecretCommand("add github-token ghp_inlinevalue", "noninteractive"))).toBe(false);
	});

	/** Only `add` ever prompts. Every other subcommand needs no credential. */
	it("does not prompt for any other subcommand", () => {
		for (const line of ["list", "rm github-token", "extend github-token --ttl 7d", "log", "help"]) {
			expect(needsValuePrompt(parseSecretCommand(line, "noninteractive"))).toBe(false);
		}
	});

	/** Options do not change the answer: `--ttl` and `--scope` are not a value. */
	it("still prompts when only options were given", () => {
		expect(needsValuePrompt(parseSecretCommand("add github-token --ttl 7d --scope project", "noninteractive"))).toBe(
			true,
		);
	});
});

describe("the confirmation after a masked entry", () => {
	/**
	 * A masked entry does NOT warn about the scrollback, because it was never on screen.
	 *
	 * Warning anyway would be the more cautious-looking choice and the worse one: a warning that
	 * fires when it does not apply is one an operator learns to skip, including on the inline path
	 * where it is true.
	 */
	it("does not claim the value was on screen", async () => {
		const stored: Array<{ name?: string; value: string }> = [];
		const vault = {
			add: async (options: { name?: string; value: string }) => {
				stored.push(options);
				return {
					// Through the real normaliser, so the stub cannot disagree with the vault about what
					// `github-token` becomes. Spelling it `GITHUB-TOKEN` here would have made the test
					// pass against a name the vault would never produce.
					name: options.name === undefined ? "SECRET_1" : normaliseSecretName(options.name),
					value: options.value,
					createdAt: 0,
					expiresAt: null,
					scope: "profile" as const,
				};
			},
		} as unknown as SecretVault;

		const request = parseSecretCommand("add github-token", "noninteractive");
		request.value = "ghp_typedIntoAMaskedField";
		request.maskedEntry = true;

		const result = await runSecretCommand(request, {
			vault,
			readEnv: () => undefined,
			defaultTtl: null,
			now: 0,
		});

		expect(result.message).not.toContain("scrollback");
		expect(result.message).not.toContain("typed on screen");
		expect(result.message).toContain("#GITHUB_TOKEN#");
		// The value itself is never echoed back, masked entry or not.
		expect(result.message).not.toContain("ghp_typedIntoAMaskedField");
		expect(stored[0].value).toBe("ghp_typedIntoAMaskedField");
	});

	/** The inline path still warns, so the two cases stay distinguishable. */
	it("still warns when the value came from the command line", async () => {
		const vault = {
			add: async (options: { name?: string; value: string }) => ({
				name: "GITHUB_TOKEN",
				value: options.value,
				createdAt: 0,
				expiresAt: null,
				scope: "profile" as const,
			}),
		} as unknown as SecretVault;

		const result = await runSecretCommand(
			parseSecretCommand("add github-token ghp_inlineValue123", "noninteractive"),
			{
				vault,
				readEnv: () => undefined,
				defaultTtl: null,
				now: 0,
			},
		);

		expect(result.message).toContain("scrollback");
	});
});

describe("a client that cannot prompt", () => {
	/**
	 * Is told so, and told what to use instead.
	 *
	 * ACP and print mode have no terminal to mask. The refusal names `--from-env` rather than
	 * reading an unmasked value, because a prompt that echoes is the exposure this whole path
	 * exists to remove.
	 */
	it("refuses an add with no value and points at --from-env", async () => {
		await expect(
			runSecretCommand(parseSecretCommand("add github-token", "noninteractive"), {
				vault: unusedVault,
				readEnv: () => undefined,
				defaultTtl: null,
				now: 0,
			}),
		).rejects.toThrow(/cannot prompt for one without showing it/);
	});
});
