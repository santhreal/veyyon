/**
 * A delete target holding an expansion this scan cannot settle is judged by the
 * concrete paths it can become, not by the fact that it holds one.
 *
 * WHY THIS SUITE EXISTS. `judgeDeleteTarget` refused every unsettled expansion
 * outright: "an expansion whose value is not knowable from the command text,
 * which is the shape that starts at the root when the variable is empty". That
 * reading is right about `rm -rf "$dir"` and `rm -rf "$dir"/*` and wrong about
 * `rm -rf "$DST/facet"`, whose worst reading is `/facet` — an ordinary top-level
 * path the identical literal spelling `rm -rf /facet` has always been allowed to
 * delete. A refusal here is `critical`, which is the one verdict `/yolo` cannot
 * lift and no standing grant can cover, so on a long headless run every
 * variable-shaped cleanup stopped the agent dead. A floor that fires on
 * `rm -rf "$DST/facet"` is a floor an operator switches off before it ever sees
 * a real `rm -rf /`.
 *
 * THE CLASS THIS CLOSES. Not "the reported command". The rule under test is an
 * invariant with one choke point: AN UNSETTLED TARGET IS JUDGED EXACTLY AS ITS
 * WORST LITERAL READING. So the sweeps below pair each unsettled word with the
 * literal path it becomes and require the two verdicts to agree, and they take
 * the dangerous readings from the module's own tables at run time —
 * `PROTECTED_ROOTS`, `SECRET_HOME_DIRECTORIES`, `PROTECTED_HOME_DIRECTORIES` —
 * so a member added to any of them is judged here the day it lands. A member
 * that stops being refused through an expansion turns this suite red even
 * though no line here names it.
 *
 * The literal half of that invariant was itself a hole, and closing it is part
 * of the same change: `rm -rf /*`, `rm -rf ~/*` and `rm -rf /var/*` were all
 * allowed, because the text `/var/*` equals no protected root, is not an
 * ancestor of the home directory, and sits under none of the protected
 * directories. A glob component is now judged as the directory it reads, which
 * is also what makes the July 2026 shape `rm -rf "$dir"/*` read as the root
 * instead of as the innocuous-looking path `/*`.
 *
 * WHAT IT DOES NOT CATCH, and both are deliberate:
 *
 *   1. A value that CLIMBS. `rm -rf /var/log/$X` with `X=../../..` is the root,
 *      and no finite set of readings finds it, because a variable can climb from
 *      any depth. Covering it means refusing every unknown suffix under every
 *      absolute prefix, `rm -rf ./dist/$TARGET` included, which is the blanket
 *      rule this replaced.
 *   2. A top-level directory nobody protected. `rm -rf "$D/media"` reads as
 *      `/media` and is allowed, for the same reason `rm -rf /media` is. That is
 *      a question about `PROTECTED_ROOTS`, not about expansions, and answering
 *      it here would put the two out of step.
 *
 * NOTHING HERE EXECUTES ANYTHING. `findCriticalBashRisk` is a pure function over
 * the command text, the home directory, the config additions and the child's
 * environment.
 */

import { describe, expect, it } from "bun:test";

import {
	findCriticalBashRisk,
	PROTECTED_HOME_DIRECTORIES,
	PROTECTED_ROOTS,
	SECRET_HOME_DIRECTORIES,
} from "../src/tools/bash-guard";

const HOME = "/home/operator";
/** A fixed environment and working directory, so no case depends on this machine. */
const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME };
const CWD = "/srv/work/proj/pkg";

function judge(command: string, extra: readonly string[] = []): string | undefined {
	return findCriticalBashRisk(command, HOME, extra, ENV, CWD)?.reason;
}

const refuses = (command: string): boolean => judge(command) !== undefined;

/** The word an unsettled name is spelled with; nothing in `ENV` sets it. */
const UNSET = "$D";

describe("the shape the blanket rule was blocking", () => {
	/**
	 * THE REPORTED COMMAND with no assignment anywhere on it, which is the case
	 * the value-carrying fix could not reach: a variable exported by the caller,
	 * set in a sourced profile, or written by a script this scan never sees.
	 */
	it("allows an ordinary suffix under a name the line never settles", () => {
		expect(judge('set -e; mkdir -p "$DST"; rm -rf "$DST/facet"; mv /tmp/facet "$DST/facet"')).toBeUndefined();
	});

	/** The same shape through every unsettleable spelling of a value. */
	it("allows it however the value became unknowable", () => {
		const spellings = [
			'rm -rf "$D/facet"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test
			'rm -rf "${D}/facet"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test
			'rm -rf "${D:-/srv}/facet"',
			"rm -rf $(cat target.txt)/facet",
			"rm -rf `cat target.txt`/facet",
			"rm -rf ~someoneelse/facet",
			"rm -rf $D/facet/build",
		];

		expect(spellings.filter(refuses)).toEqual([]);
	});
});

describe("an unsettled target is judged as its worst literal reading", () => {
	/**
	 * The invariant, swept over every dangerous suffix the module declares plus
	 * ordinary ones. An unsettled `$D` has two distinct readings for a suffixed
	 * word — empty, which makes `$D<suffix>` the absolute path `<suffix>`, and the
	 * home directory, which makes it `$HOME<suffix>` — and the root reading
	 * normalizes to the same path as the empty one. So the expected verdict is
	 * DERIVED here from the literal spellings of both readings rather than written
	 * down, and an implementation that drops either reading, or that judges an
	 * expansion by a different rule than the literal path, fails whichever
	 * direction it went.
	 */
	const SUFFIXES: string[] = [
		...PROTECTED_ROOTS.map(root => (root === "/" ? "/" : root)),
		...PROTECTED_ROOTS.filter(root => root !== "/").map(root => `${root}/lib`),
		...SECRET_HOME_DIRECTORIES.map(secret => `/${secret}`),
		...PROTECTED_HOME_DIRECTORIES.map(child => `/${child}`),
		"/facet",
		"/facet/build",
		"/tmp/scratch",
		"/media",
		"/*",
		"/facet/*",
	];

	/** Refused as a literal path under any value an unsettled name can hold. */
	const anyReadingRefuses = (suffix: string): boolean =>
		refuses(`rm -rf "${suffix}"`) || refuses(`rm -rf "${HOME}${suffix}"`);

	it.each(SUFFIXES)("agrees with the literal readings for %s", suffix => {
		const throughExpansion = refuses(`rm -rf "${UNSET}${suffix}"`);

		expect([suffix, throughExpansion]).toEqual([suffix, anyReadingRefuses(suffix)]);
	});

	/**
	 * And the pairing is not vacuous: the sweep has to contain both verdicts, or
	 * a rule that refuses everything and a rule that refuses nothing would both
	 * pass it. Both counts are asserted against the tables, so a suffix added
	 * above cannot quietly make one side empty.
	 */
	it("sweeps suffixes of both verdicts", () => {
		const refused = SUFFIXES.filter(anyReadingRefuses);

		expect(refused.length).toBeGreaterThan(PROTECTED_ROOTS.length);
		expect(SUFFIXES.length - refused.length).toBeGreaterThan(2);
	});
});

describe("the readings that keep the floor", () => {
	/**
	 * The BARE word is the shape with a catastrophic reading: an unsettled name
	 * can hold `/`, and `rm -rf /` is the command this module is named after.
	 * Every quoting of it, and a command substitution standing in the same
	 * place, must be refused.
	 */
	it("refuses a bare unsettled target in every spelling", () => {
		const bare = [
			"rm -rf $D",
			'rm -rf "$D"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test
			'rm -rf "${D}"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test
			'rm -rf "${D:-/}"',
			'rm -rf "$D/"',
			'rm -rf "$D//"',
			"rm -rf $(cat target.txt)",
			"rm -rf `cat target.txt`",
			"rm -rf ~someoneelse",
			"rm -rf $(dirname $(pwd))",
			"rm -rf $(cat missing",
		];

		expect(bare.filter(command => !refuses(command))).toEqual([]);
	});

	/** Every protected root, reached as the suffix of a name nothing settles. */
	it("refuses a suffix naming any protected root", () => {
		const escaped = PROTECTED_ROOTS.filter(root => !refuses(`rm -rf "${UNSET}${root === "/" ? "/" : root}"`));

		expect(escaped).toEqual([]);
	});

	/**
	 * A glob under an unsettled name is the July 2026 incident: an empty value
	 * makes it `rm -rf /*`, which `--preserve-root` does not stop, since the
	 * shell hands `rm` every top-level entry by name and never the root itself.
	 */
	it("refuses a glob under an unsettled name at any depth", () => {
		expect(refuses('rm -rf "$D"/*')).toBe(true);
		expect(refuses('rm -rf "$D"/*/build')).toBe(true);
		expect(refuses('rm -rf "$D"/?')).toBe(true);
		expect(refuses('rm -rf "$D"/[a-z]*')).toBe(true);
	});

	/**
	 * The home reading is what protects a credentials directory behind a name
	 * this scan cannot settle: `rm -rf "$D/.ssh"` is refused for the same reason
	 * `rm -rf ~/.ssh` is. Swept, so a directory added to either table is covered
	 * without anyone editing this file.
	 */
	it("refuses a suffix naming a protected home directory", () => {
		const escaped = [...SECRET_HOME_DIRECTORIES, ...PROTECTED_HOME_DIRECTORIES].filter(
			directory => !refuses(`rm -rf "${UNSET}/${directory}"`),
		);

		expect(escaped).toEqual([]);
	});

	/** A file INSIDE a credentials directory, which that table protects whole. */
	it("refuses a single credential file behind an unsettled prefix", () => {
		expect(refuses('rm -rf "$D/.aws/credentials"')).toBe(true);
	});

	/**
	 * The operator's own additions reach through an expansion too. A config that
	 * only protected literal paths would be a setting that stops working the
	 * moment a script uses a variable.
	 */
	it("refuses a suffix the operator protected", () => {
		expect(judge('rm -rf "$D/Documents"', ["~/Documents"])).toContain("tools.protectedPaths");
		expect(judge('rm -rf "$D/Documents"')).toBeUndefined();
	});

	/**
	 * A form with no name to substitute cannot be instantiated at all, so there
	 * is no reading of it to judge and it fails closed. `$$` is the process id,
	 * which this scan has no business predicting.
	 */
	it("refuses a word it cannot instantiate", () => {
		expect(judge('rm -rf "$D/$$"')).toContain("no reading this scan can even name");
	});

	/**
	 * A word an expansion collapsed to nothing is `rm -rf ''`, which deletes
	 * nothing at all. It has to be answered before the relative branch: resolved
	 * against the working directory it would name that directory, so a cleanup
	 * run from the home directory reported the home directory as the target.
	 */
	it("allows a word an expansion emptied, from a working directory that is protected", () => {
		expect(findCriticalBashRisk('rm -rf ""', HOME, [], ENV, HOME)).toBeUndefined();
		expect(findCriticalBashRisk('rm -rf "$EMPTY"', HOME, [], { ...ENV, EMPTY: "" }, HOME)).toBeUndefined();
	});
});

/**
 * On a host where this process cannot locate the home directory, the home
 * reading is gone and the ROOT reading is the only thing left that refuses a
 * bare unsettled word. Without this block the root reading is unobservable from
 * any command line, because the home reading refuses every bare word first, and
 * a rule nothing exercises is a rule nobody notices losing.
 */
describe("with no home directory to resolve", () => {
	const homeless = (command: string): string | undefined => findCriticalBashRisk(command, "", [], ENV, CWD)?.reason;

	it("still refuses a bare unsettled target", () => {
		expect(homeless('rm -rf "$D"')).toContain("a protected system directory (/)");
		expect(homeless("rm -rf $(cat target.txt)")).toContain("a protected system directory (/)");
		expect(homeless('rm -rf "$D"/*')).toContain("a protected system directory (/)");
	});

	it("still allows an ordinary suffix under it", () => {
		expect(homeless('rm -rf "$D/facet"')).toBeUndefined();
	});

	/**
	 * And says so about the tilde, which is the one word with no reading at all:
	 * it certainly names a directory and this process cannot say which.
	 */
	it("refuses a tilde it cannot place, for a different reason", () => {
		expect(homeless("rm -rf ~/scratch")).toContain("cannot locate");
	});
});

describe("the literal glob spellings the same rule closed", () => {
	/**
	 * These were allowed before a glob component was judged as the directory it
	 * reads, and each one is a total loss of the directory it names.
	 */
	it("refuses a glob directly under any protected root", () => {
		const escaped = PROTECTED_ROOTS.filter(root => !refuses(`rm -rf ${root === "/" ? "" : root}/*`));

		expect(escaped).toEqual([]);
	});

	/**
	 * `.config` reports the gcloud credentials inside it rather than the directory
	 * itself, because the most specific reason wins and a credentials directory is
	 * more specific than the settings tree containing it. `.kube` is the same
	 * table with nothing secret nested under it, so it reads as what it is.
	 */
	it("refuses a glob directly under the home directory and its protected children", () => {
		expect(judge(`rm -rf ${HOME}/*`)).toContain("the home directory itself");
		expect(judge(`rm -rf ${HOME}/.kube/*`)).toContain("a protected directory");
		expect(judge(`rm -rf ${HOME}/.config/*`)).toContain("a directory holding credentials");
		expect(judge(`rm -rf ${HOME}/.ssh/*`)).toContain("a directory holding credentials");
	});

	/**
	 * And it stays narrow: a glob inside an ordinary directory is the cleanup an
	 * agent writes all day, and refusing it would be the same crying-wolf
	 * failure in a new place.
	 */
	it("allows a glob inside an ordinary directory", () => {
		const allowed = [
			"rm -rf /tmp/build/*",
			"rm -rf /var/log/nginx/*",
			`rm -rf ${HOME}/.cache/veyyon/*`,
			"rm -rf ./dist/*",
		];

		expect(allowed.filter(refuses)).toEqual([]);
	});
});

describe("words that must not hang the scan", () => {
	/**
	 * The instantiator walks the word itself, so an unterminated construct has to
	 * end the walk rather than spin. Each of these is a real thing to type by
	 * accident, and the assertion is that the call RETURNS at all — a verdict is
	 * secondary, and a hang here would surface as a suite timeout rather than as
	 * a wrong answer.
	 */
	it("terminates on an unterminated expansion", () => {
		expect(refuses("rm -rf $(cat missing")).toBe(true);
		expect(refuses("rm -rf `cat missing")).toBe(true);
		expect(refuses('rm -rf "$D/${X"')).toBe(true);
		expect(typeof refuses("rm -rf $")).toBe("boolean");
	});

	/** And on a word carrying a great many expansions, which it walks linearly. */
	it("terminates on a word made of a thousand expansions", () => {
		const started = Date.now();
		const verdict = refuses(`rm -rf "${Array.from({ length: 1000 }, () => "$D").join("/")}/facet"`);

		expect(verdict).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
