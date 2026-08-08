/**
 * What `/secret` shows an operator: the `list` table, the empty-vault help, and the two usage
 * variants.
 *
 * WHY THIS SUITE EXISTS. `/secret list` used to print `  #NAME#  scope  time-left` per row: three
 * fields joined by two spaces, with no header. That reads fine in a fixture where every name is
 * the same length and falls apart the moment they are not, because the scope and lifetime columns
 * start wherever the previous name happened to end. The operator then has to read every row from
 * its first character to find the one field they came for, and there is no header telling them
 * what the fields even are. Nothing in the row said a secret was about to lapse either, although
 * `WARN_AT_FRACTIONS` and `expiryWarnings` had known how to decide that the whole time.
 *
 * So the assertions here are deliberately byte-exact and deliberately use names of DIFFERENT
 * lengths. A same-length fixture passes against the broken renderer, which is precisely why the
 * bug survived the tests that already existed.
 *
 * THREE THINGS THIS SUITE REFUSES TO LET REGRESS:
 *   1. ALIGNMENT, measured in terminal columns. A secret name is arbitrary text as far as the
 *      renderer is concerned, and one wide (CJK) grapheme is two columns but one unit of
 *      `.length`. Padding by `.length` produces a table that is aligned only in ASCII.
 *   2. THE NEAR-EXPIRY MARKER, and that it comes from the same threshold owner as the sentences
 *      `expiryWarnings` writes. Two owners of "nearly expired" is the exact bug that once made
 *      the halfway warning unreachable.
 *   3. THE SURFACE SPLIT, which is now about verbs as well as entry forms. A client with no way to
 *      hide what is typed must never be told to type a credential, in the usage text or in the
 *      empty-vault help; and a terminal, whose whole argument line is the credential, must never
 *      be shown a verb it would store rather than run. The TABLE itself is surface independent,
 *      so every row that renders one names no surface at all.
 *
 * No value may appear anywhere, so every fixture carries a real-looking credential and every
 * rendering is searched for it and for a prefix of it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	expiryWarnings,
	NONINTERACTIVE_SECRET_COMMAND_USAGE,
	parseSecretCommand,
	renderSecretList,
	runSecretCommand,
	SECRET_COMMAND_USAGE,
	secretCommandUsage,
} from "@veyyon/coding-agent/secrets/secret-command";
import { type ScopedVaultEntry, SecretVault, type VaultScope } from "@veyyon/coding-agent/secrets/vault";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A credential shaped like the real thing, so a leak of it or of its prefix is unmistakable. */
const VALUE = "sk-live-0123456789abcdef";

/**
 * One entry, positioned in its lifetime by how long ago it was created and how long it has left.
 * Everything is relative to a fixed `NOW`, so no test reads the wall clock.
 */
function entry(
	name: string,
	scope: VaultScope,
	createdAgo: number,
	expiresIn: number | null,
	value = VALUE,
): ScopedVaultEntry {
	return {
		name,
		value,
		scope,
		createdAt: NOW - createdAgo,
		expiresAt: expiresIn === null ? null : NOW + expiresIn,
	};
}

/** Healthy: one seventh through its lifetime, so nothing may mark it. */
const API_KEY = entry("API_KEY", "profile", DAY, 6 * DAY);
/** Never expires, and much longer than the header, so it sets the placeholder column width. */
const DEPLOY_ACCOUNT = entry("DEPLOYMENT_SERVICE_ACCOUNT", "project", DAY, null);
/** Exactly past the 0.5 threshold: four days into a seven-day life. */
const HALFWAY_TOKEN = entry("HALFWAY_TOKEN", "global", 4 * DAY, 3 * DAY);
/** Exactly on the 0.9 threshold: nine days into a ten-day life. */
const LAPSING_TOKEN = entry("LAPSING_TOKEN", "project", 9 * DAY, DAY);

describe("the /secret list table", () => {
	/**
	 * THE ALIGNMENT ASSERTION, and the reason it uses two names 19 characters apart.
	 *
	 * Every byte of the rendering is pinned. The old space-joined renderer produced
	 * `  #API_KEY#  profile  6d left` here, which no amount of `toContain` would have caught as
	 * wrong, because each individual field was present. What was missing was the header and the
	 * common left edge of the SCOPE and EXPIRES columns.
	 */
	it("renders a header and columns that line up across names of different lengths", () => {
		expect(renderSecretList([DEPLOY_ACCOUNT, API_KEY], { now: NOW })).toBe(
			[
				"2 active secrets. The agent spends one by writing its placeholder; the value is never shown.",
				"  PLACEHOLDER                   SCOPE    EXPIRES",
				"  #API_KEY#                     profile  6d left",
				"  #DEPLOYMENT_SERVICE_ACCOUNT#  project  never expires",
			].join("\n"),
		);
	});

	/**
	 * The header is a real header: it sits above the rows, is padded by the same rule, and is
	 * therefore what a reader can scan down from. A header appended after the rows, or padded
	 * independently, would satisfy a `toContain("PLACEHOLDER")` and be useless.
	 */
	it("puts the header directly above the rows and pads it by the same rule", () => {
		const lines = renderSecretList([DEPLOY_ACCOUNT, API_KEY], { now: NOW }).split("\n");

		expect(lines[1]).toBe("  PLACEHOLDER                   SCOPE    EXPIRES");
		expect(lines[2].indexOf("profile")).toBe(lines[1].indexOf("SCOPE"));
		expect(lines[3].indexOf("project")).toBe(lines[1].indexOf("SCOPE"));
		expect(lines[3].indexOf("never expires")).toBe(lines[1].indexOf("EXPIRES"));
	});

	/**
	 * A single secret still gets the header, and the count is singular.
	 *
	 * The boundary the old `${n} active secret(s):` line papered over with a parenthesis.
	 */
	it("keeps the header and says 'secret' for exactly one", () => {
		expect(renderSecretList([API_KEY], { now: NOW })).toBe(
			[
				"1 active secret. The agent spends one by writing its placeholder; the value is never shown.",
				"  PLACEHOLDER  SCOPE    EXPIRES",
				"  #API_KEY#    profile  6d left",
			].join("\n"),
		);
	});

	/** Sorted by name, so the table is byte-stable across calls and diffable between them. */
	it("sorts rows by name regardless of the order the vault returned them", () => {
		const ascending = renderSecretList([API_KEY, DEPLOY_ACCOUNT], { now: NOW });
		const descending = renderSecretList([DEPLOY_ACCOUNT, API_KEY], { now: NOW });

		expect(ascending).toBe(descending);
		expect(ascending.indexOf("#API_KEY#")).toBeLessThan(ascending.indexOf("#DEPLOYMENT_SERVICE_ACCOUNT#"));
	});

	/** No row may end in blanks: the table is something an operator copies out of a terminal. */
	it("never leaves trailing whitespace on a row", () => {
		for (const line of renderSecretList([DEPLOY_ACCOUNT, API_KEY, LAPSING_TOKEN], { now: NOW }).split("\n")) {
			expect(line).toBe(line.trimEnd());
		}
	});
});

describe("column width is measured in terminal columns", () => {
	/**
	 * THE WIDE-CHARACTER REGRESSION. `#東京_KEY#` occupies TEN terminal columns and EIGHT units of
	 * `.length`, so a renderer padding by `.length` gives it two spaces too many and the SCOPE
	 * column steps right by two on that row alone.
	 *
	 * Both halves of that are asserted: the rendered bytes are exact, and the two rows are shown
	 * to differ in character index while agreeing in display width. If they agreed in character
	 * index too, the fixture would not be exercising the difference at all.
	 */
	it("aligns a wide-character name by display width, not by .length", () => {
		const wide = entry("東京_KEY", "profile", DAY, 6 * DAY);
		const narrow = entry("US_KEY", "global", DAY, 2 * DAY);

		const rendered = renderSecretList([wide, narrow], { now: NOW });

		expect(rendered).toBe(
			[
				"2 active secrets. The agent spends one by writing its placeholder; the value is never shown.",
				"  PLACEHOLDER  SCOPE    EXPIRES",
				"  #US_KEY#     global   2d left",
				"  #東京_KEY#   profile  6d left",
			].join("\n"),
		);

		const [, header, narrowRow, wideRow] = rendered.split("\n");
		// The scope column starts at the same terminal column on every line...
		const scopeColumn = Bun.stringWidth(header.slice(0, header.indexOf("SCOPE")));
		expect(scopeColumn).toBe(15);
		expect(Bun.stringWidth(narrowRow.slice(0, narrowRow.indexOf("global")))).toBe(scopeColumn);
		expect(Bun.stringWidth(wideRow.slice(0, wideRow.indexOf("profile")))).toBe(scopeColumn);
		// ...while sitting at DIFFERENT character offsets, which is what `.length` would have got wrong.
		expect(narrowRow.indexOf("global")).toBe(15);
		expect(wideRow.indexOf("profile")).toBe(13);
	});

	/** An all-wide name is the extreme of the same case: 2 + 2 x 4 + 2 = twelve columns. */
	it("counts every wide grapheme as two columns", () => {
		const rendered = renderSecretList(
			[entry("東京鍵前", "profile", DAY, 6 * DAY), entry("AB_CD", "global", DAY, 2 * DAY)],
			{ now: NOW },
		);
		const [, header, , wideRow] = rendered.split("\n");

		expect(Bun.stringWidth(wideRow.slice(0, wideRow.indexOf("profile")))).toBe(
			Bun.stringWidth(header.slice(0, header.indexOf("SCOPE"))),
		);
		expect(wideRow.startsWith("  #東京鍵前#")).toBe(true);
	});
});

describe("a near-expiry row is marked", () => {
	/**
	 * THE MISSING SIGNAL. A row minutes from deletion looked exactly like one with a month left,
	 * so the only way to find it was to read and compare every lifetime by hand.
	 *
	 * The distinguishing bytes are asserted exactly, and the healthy row in the SAME table is
	 * asserted NOT to carry them — a marker on every row marks nothing.
	 */
	it("distinguishes a lapsing row from a healthy one in the same table", () => {
		const rendered = renderSecretList([API_KEY, HALFWAY_TOKEN, LAPSING_TOKEN], { now: NOW });

		expect(rendered).toBe(
			[
				"3 active secrets. The agent spends one by writing its placeholder; the value is never shown.",
				"  PLACEHOLDER      SCOPE    EXPIRES  STATUS",
				"  #API_KEY#        profile  6d left",
				"  #HALFWAY_TOKEN#  global   3d left  past halfway",
				"  #LAPSING_TOKEN#  project  1d left  expires soon",
				"Extend one before it lapses: /secret extend <name> --ttl 7d.",
			].join("\n"),
		);

		const healthyRow = rendered.split("\n")[2];
		expect(healthyRow).toBe("  #API_KEY#        profile  6d left");
		expect(healthyRow).not.toContain("expires soon");
		expect(healthyRow).not.toContain("past halfway");
	});

	/**
	 * The STATUS column and its footer appear only when a row fills them. A column of blanks on
	 * every healthy table trains the eye to skip the one place the warning will ever appear.
	 */
	it("omits the status column entirely when nothing is near expiry", () => {
		const rendered = renderSecretList([API_KEY, DEPLOY_ACCOUNT], { now: NOW });

		expect(rendered).not.toContain("STATUS");
		expect(rendered).not.toContain("Extend one before it lapses");
	});

	/** An entry that never expires is never near expiry, however old it is. */
	it("never marks an entry that has no expiry", () => {
		const ancient = entry("FOREVER_TOKEN", "global", 4000 * DAY, null);

		expect(renderSecretList([ancient], { now: NOW })).toBe(
			[
				"1 active secret. The agent spends one by writing its placeholder; the value is never shown.",
				"  PLACEHOLDER      SCOPE   EXPIRES",
				"  #FOREVER_TOKEN#  global  never expires",
			].join("\n"),
		);
	});

	/**
	 * THE THRESHOLD BOUNDARY, at both fractions and just below the lower one.
	 *
	 * A seven-day life sampled at 0.49, 0.5 and 0.9 of the way through. The 0.49 sample is the
	 * one that catches a marker widened to "anything with an expiry".
	 */
	it("marks at each threshold and stays silent just below the first", () => {
		const life = 7 * DAY;
		const at = (fraction: number) => entry("BOUNDARY_TOKEN", "profile", life * fraction, life * (1 - fraction));

		expect(renderSecretList([at(0.49)], { now: NOW })).not.toContain("STATUS");
		expect(renderSecretList([at(0.5)], { now: NOW })).toContain("past halfway");
		expect(renderSecretList([at(0.5)], { now: NOW })).not.toContain("expires soon");
		expect(renderSecretList([at(0.9)], { now: NOW })).toContain("expires soon");
		expect(renderSecretList([at(0.9)], { now: NOW })).not.toContain("past halfway");
	});

	/**
	 * ONE OWNER OF "NEARLY EXPIRED", pinned by agreement rather than by reading the source.
	 *
	 * `expiryWarnings` writes the turn-boundary sentences and the table writes a two-word cell.
	 * They are the same judgement rendered twice, and the bug this guards against is the one the
	 * subsystem has already had once: an inline fraction in one place drifting from
	 * `WARN_AT_FRACTIONS` in the other, so a secret is urgent in one report and fine in the other.
	 */
	it("agrees with expiryWarnings about which entries are near expiry, and how urgently", () => {
		const life = 10 * DAY;
		for (const fraction of [0, 0.25, 0.49, 0.5, 0.75, 0.89, 0.9, 0.99]) {
			const sample = entry("AGREEMENT_TOKEN", "profile", life * fraction, life * (1 - fraction));
			const row = renderSecretList([sample], { now: NOW }).split("\n")[2];
			const warnings = expiryWarnings([sample], NOW);

			expect(row.includes("expires soon") || row.includes("past halfway")).toBe(warnings.length === 1);
			expect(row.includes("expires soon")).toBe(warnings[0]?.includes("expires soon") ?? false);
			expect(row.includes("past halfway")).toBe(
				warnings[0]?.includes("is over halfway through its lifetime") ?? false,
			);
		}
	});
});

describe("the table never shows a value", () => {
	/**
	 * THE ASSERTION THAT MATTERS MOST. A prefix of a credential is still a disclosure, and a
	 * table is the output most likely to end up in a screenshot or a bug report.
	 *
	 * Searched for in a table that also carries a status column and a footer, so every line the
	 * renderer can emit is covered by one search.
	 */
	it("shows neither a value nor a prefix of one, on any line", () => {
		const rendered = renderSecretList([API_KEY, LAPSING_TOKEN, DEPLOY_ACCOUNT], { now: NOW });

		expect(rendered).not.toContain(VALUE);
		expect(rendered).not.toContain(VALUE.slice(0, 8));
		expect(rendered).not.toContain("0123456789");
	});

	/** Padding is computed from the placeholder, never from the value, so a long value moves nothing. */
	it("does not let the length of a value change the layout", () => {
		const short = entry("API_KEY", "profile", DAY, 6 * DAY, "abcdefghij");
		const long = entry("API_KEY", "profile", DAY, 6 * DAY, "x".repeat(4096));

		expect(renderSecretList([long], { now: NOW })).toBe(renderSecretList([short], { now: NOW }));
	});
});

describe("a cell is sanitised before it is drawn", () => {
	/**
	 * A name reaches the renderer from a file, so it is operator-supplied text. A newline in it
	 * would split one row into two and every column below would be measured against the wrong
	 * thing; a tab would move the row by an amount the width calculation cannot see.
	 */
	it("keeps a name containing a tab or a newline on one row", () => {
		const rendered = renderSecretList(
			[entry("LINE\nBREAK\tNAME", "profile", DAY, 6 * DAY), entry("PLAIN", "global", DAY, 2 * DAY)],
			{ now: NOW },
		);

		expect(rendered).toBe(
			[
				"2 active secrets. The agent spends one by writing its placeholder; the value is never shown.",
				"  PLACEHOLDER        SCOPE    EXPIRES",
				"  #LINE BREAK NAME#  profile  6d left",
				"  #PLAIN#            global   2d left",
			].join("\n"),
		);
		expect(rendered.split("\n")).toHaveLength(4);
	});

	/**
	 * An over-long name is truncated rather than allowed to push SCOPE and EXPIRES off the right
	 * of the terminal, which is the unreadable output this table exists to replace.
	 */
	it("truncates a name too wide to draw and keeps the later columns visible", () => {
		const rendered = renderSecretList(
			[entry("Z".repeat(80), "profile", DAY, 6 * DAY), entry("PLAIN", "global", DAY, 2 * DAY)],
			{ now: NOW },
		);
		const [, header, , longRow] = rendered.split("\n");

		expect(longRow).toContain("…");
		expect(longRow.endsWith("profile  6d left")).toBe(true);
		expect(Bun.stringWidth(longRow.slice(0, longRow.indexOf("profile")))).toBe(
			Bun.stringWidth(header.slice(0, header.indexOf("SCOPE"))),
		);
		// 2 indent + 66 (`#` + a maximum-length name + `#`) + 2 gutter.
		expect(Bun.stringWidth(header.slice(0, header.indexOf("SCOPE")))).toBe(70);
	});
});

describe("the empty vault", () => {
	/**
	 * THE FIRST THING A NEW USER SEES, on the TUI surface, whose three entry forms are the verbless
	 * grammar: the argument line is the credential, a bare `/secret` opens the hidden field, and
	 * `--from-env` reads it out of the environment. This surface owns the copy because it is the
	 * only one that HAS a field to offer; the one below owns the same text minus what it cannot do.
	 */
	it("offers every entry form the terminal has, and explains what a secret is", () => {
		expect(renderSecretList([], { now: NOW })).toBe(
			[
				"No active secrets. Nothing is being substituted right now.",
				"",
				"Store one and the agent can spend it by writing #NAME#, never seeing the value itself:",
				"  /secret <value>                       store it now, then name it (optional)",
				"  /secret                               paste into a hidden field instead",
				"  /secret --from-env <VAR>              store the value of an environment variable",
			].join("\n"),
		);
	});

	/**
	 * A surface that cannot hide what is typed must not suggest typing a credential. Telling an
	 * ACP client to run `/secret add <name>` would park the value in its request history.
	 */
	it("offers only the environment form on a surface that cannot mask input", () => {
		expect(renderSecretList([], { now: NOW, surface: "noninteractive" })).toBe(
			[
				"No active secrets. Nothing is being substituted right now.",
				"",
				"Store one and the agent can spend it by writing #NAME#, never seeing the value itself:",
				"  /secret add <name> --from-env <VAR>   store the value of an environment variable",
			].join("\n"),
		);
	});

	/** Empty means empty: no header, no count line, nothing that reads as a failed render. */
	it("shows no table furniture when there is nothing to put in it", () => {
		const rendered = renderSecretList([], { now: NOW });

		expect(rendered).not.toContain("PLACEHOLDER");
		expect(rendered).not.toContain("active secret.");
		expect(rendered).not.toContain("STATUS");
	});
});

describe("the two usage variants", () => {
	/** `secretCommandUsage` is the only selector, so neither surface can be handed the other's help. */
	it("hands each surface its own text", () => {
		expect(secretCommandUsage("tui")).toBe(SECRET_COMMAND_USAGE);
		expect(secretCommandUsage("noninteractive")).toBe(NONINTERACTIVE_SECRET_COMMAND_USAGE);
	});

	/**
	 * THE STRUCTURAL FRAME IS SHARED, AND ONLY THE SURFACE-SPECIFIC LINES DIVERGE.
	 *
	 * The two variants no longer differ by two removable lines: a terminal has no verbs at all, so
	 * its entry group describes the verbless grammar and its management group is the single line
	 * that opens the manager. What must still hold, and is what stops the two lists drifting, is
	 * that the frame around those lines is byte-identical: both headings, the blank line between
	 * the groups, and the blank line before the footer. A reworded heading applied to one variant
	 * and forgotten on the other fails here.
	 *
	 * THE FOOTER IS DELIBERATELY NOT COMPARED, and that is the one exemption. It names the verbs
	 * that read each option, and only the noninteractive surface has verbs, so a shared footer put
	 * "on add, rm and discard" in front of an operator who cannot type `discard`. Each footer is
	 * pinned as an exact list by its own test below, which is a stricter check than equality with
	 * the other surface: neither can drift silently just because this comparison stopped covering
	 * it. The one footer line that IS a shared fact is asserted on both, so the exemption cannot
	 * quietly widen into "the footers are unrelated".
	 */
	it("agree on the structural frame around the lines that differ", () => {
		const structure = (usage: string) => usage.split("\n").filter(line => line === "" || line.endsWith(":"));

		expect(structure(NONINTERACTIVE_SECRET_COMMAND_USAGE)).toEqual(structure(SECRET_COMMAND_USAGE));
		expect(structure(SECRET_COMMAND_USAGE)).toEqual([
			"Store a credential the agent can use without ever seeing it:",
			"",
			"Manage what is already stored:",
			"",
		]);
		for (const usage of [SECRET_COMMAND_USAGE, NONINTERACTIVE_SECRET_COMMAND_USAGE]) {
			expect(usage).toContain(
				"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.",
			);
		}
		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).not.toBe(SECRET_COMMAND_USAGE);
	});

	/** The TUI can hide what is typed, so it is the only variant that may advertise doing so. */
	it("offer masked and inline entry only in the TUI", () => {
		expect(SECRET_COMMAND_USAGE).toContain(
			"/secret <value>                       store it now, then name it (optional)",
		);
		expect(SECRET_COMMAND_USAGE).toContain("/secret                               paste into a hidden field instead");

		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).not.toContain("<value>");
		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).not.toContain("hidden field");
		expect(NONINTERACTIVE_SECRET_COMMAND_USAGE).not.toContain("store it now");
	});

	/**
	 * THE SET OF COMMANDS EACH SURFACE NAMES. Both parse every verb, so both name every verb, and
	 * the terminal additionally names the manager, which is the one command that needs a screen.
	 *
	 * The state this replaced had the terminal listing exactly one word, on the reasoning that a
	 * verb in that list is a word the terminal would store as a credential. That was true of the
	 * parser at the time, and the two together meant the help was consistent and the commands were
	 * unreachable: `/secret list` stored `list`. The verbs work here now, so a verb MISSING from
	 * either list is a working command nobody discovers.
	 */
	it("list every verb on both surfaces, and the manager only where there is a screen", () => {
		const commandWords = (usage: string) =>
			[...new Set([...usage.matchAll(/^ {2}\/secret (\w+)/gmu)].map(match => match[1]))].sort();

		expect(commandWords(SECRET_COMMAND_USAGE)).toEqual(["discard", "extend", "list", "log", "manager", "rm"]);
		expect(commandWords(NONINTERACTIVE_SECRET_COMMAND_USAGE)).toEqual([
			"add",
			"discard",
			"extend",
			"list",
			"log",
			"rm",
		]);
	});

	/**
	 * THE GROUPING. A flat list of seven gave `rm`, `extend` and `log` the same weight as `add`,
	 * so the one line a new operator needs was the fourth of seven with nothing separating them.
	 *
	 * Asserted structurally: two headings, every command line indented under one of them, and a
	 * blank line between the groups. Not by counting lines, which any reflow would break. The
	 * management BODY is then asserted per surface, since that is exactly where the two diverge.
	 */
	it("separate the everyday path from management, on both surfaces", () => {
		for (const usage of [SECRET_COMMAND_USAGE, NONINTERACTIVE_SECRET_COMMAND_USAGE]) {
			const lines = usage.split("\n");
			const store = lines.indexOf("Store a credential the agent can use without ever seeing it:");
			const manage = lines.indexOf("Manage what is already stored:");

			expect(store).toBe(0);
			expect(manage).toBeGreaterThan(store);
			expect(lines[manage - 1]).toBe("");
			expect(lines.slice(store + 1, manage - 1).every(line => line.startsWith("  /secret "))).toBe(true);

			// The management body itself, exactly, because the two texts still diverge there: a terminal
			// leads with the manager screen, which is the better way to do four of the five, and a
			// client with no screen has only the verbs. Bounded by the heading above and the blank line
			// below rather than by fixed offsets, so the claim survives any reflow of the group in
			// front of it.
			const management = [
				"  /secret list                          show active secrets, never their values",
				"  /secret rm <name> [--scope global]    remove a secret",
				"  /secret extend <name> --ttl 7d        give a secret a fresh lifetime",
				"  /secret log [--limit 50]              show which secrets were used, and where",
				"  /secret discard --scope project       move a broken vault file aside",
			];
			expect(lines.slice(manage + 1, lines.indexOf("", manage + 1))).toEqual(
				usage === SECRET_COMMAND_USAGE
					? [
							"  /secret manager                       open the manager: rename, extend, revoke, copy",
							...management,
						]
					: management,
			);
		}
	});

	/**
	 * The options block sits below both groups, and names which subcommands read each option.
	 *
	 * It used to open with a bare "Options:" heading, which read as "every subcommand takes these".
	 * That was false: `list` takes neither, `rm` took `--scope` only after it was added, and
	 * `extend` takes only `--ttl`. Advertising a flag the parser refuses costs more than omitting
	 * it, because the refusal looks like the operator's mistake rather than a limit.
	 */
	it("keep the options below both groups, naming which subcommands read each one", () => {
		const lines = NONINTERACTIVE_SECRET_COMMAND_USAGE.split("\n");

		expect(lines.slice(-4)).toEqual([
			"--ttl 30m|12h|7d|2w|never            on add and extend",
			"--scope profile|project|global       on add, rm and discard",
			"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.",
			"Removal without --scope takes the narrowest match, which is the one currently in effect.",
		]);
		expect(lines[lines.length - 5]).toBe("");
	});

	/**
	 * Terminal help states the option values without the annotation column beside them.
	 *
	 * The column says WHICH VERB reads each option, and it is noise on a surface whose first line is
	 * `/secret <value>`: the everyday path there takes no options at all, and the verbs that do take
	 * them spell the option in their own usage line two rows up. Pinned as an exact list so a future
	 * footer line has to be placed on the surface it is true for.
	 */
	it("state the option values in the terminal without the per-verb column", () => {
		const lines = SECRET_COMMAND_USAGE.split("\n");

		expect(lines.slice(-3)).toEqual([
			"--ttl 30m|12h|7d|2w|never",
			"--scope profile|project|global",
			"Lifetimes default to the secrets.defaultTtl setting. Scope defaults to profile; project overrides profile, which overrides global.",
		]);
		expect(lines[lines.length - 4]).toBe("");
		expect(SECRET_COMMAND_USAGE).not.toContain("on add, rm and discard");
	});
});

describe("/secret list end to end", () => {
	/**
	 * The command routes its surface into the renderer.
	 *
	 * `renderSecretList` is the seam every test above uses, so this is the one that proves the
	 * seam is actually wired: run the real command over a real vault and check the noninteractive
	 * invocation does not come back advertising an entry form it cannot offer.
	 *
	 * NONINTERACTIVE THROUGHOUT, because `list` and `add <name> --from-env <VAR>` are verbs and a
	 * terminal has none: `list` typed there is a credential to store. The table itself is surface
	 * independent, which is why every row above renders it without naming one.
	 */
	it("renders the table through runSecretCommand and honours the surface when empty", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-list-"));
		try {
			const now = NOW;
			const vault = new SecretVault(
				{
					globalConfigRoot: path.join(root, "config"),
					profileDir: path.join(root, "config", "profiles", "work", "agent"),
					projectDir: path.join(root, "project", ".veyyon"),
				},
				() => now,
			);
			const context = {
				vault,
				readEnv: (name: string) => (name === "SOURCE" ? VALUE : undefined),
				defaultTtl: 7 * DAY,
				now,
			};

			const empty = await runSecretCommand(parseSecretCommand("list", "noninteractive"), {
				...context,
				surface: "noninteractive" as const,
			});
			expect(empty.message).not.toContain("hidden field");
			expect(empty.message).not.toContain("/secret <value>");
			expect(empty.message).toContain("  /secret add <name> --from-env <VAR>");

			await runSecretCommand(parseSecretCommand("add api-key --from-env SOURCE", "noninteractive"), context);
			await runSecretCommand(
				parseSecretCommand("add deployment-service-account --from-env SOURCE --ttl never", "noninteractive"),
				context,
			);

			const listed = await runSecretCommand(parseSecretCommand("list", "noninteractive"), context);
			expect(listed.message).toBe(
				[
					"2 active secrets. The agent spends one by writing its placeholder; the value is never shown.",
					"  PLACEHOLDER                   SCOPE    EXPIRES",
					"  #API_KEY#                     profile  7d left",
					"  #DEPLOYMENT_SERVICE_ACCOUNT#  profile  never expires",
				].join("\n"),
			);
			expect(listed.message).not.toContain(VALUE);
			expect(listed.changed).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
