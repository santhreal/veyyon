/**
 * A command line that makes a temporary directory and then deletes exactly that
 * directory destroys nothing it did not create, so it must not be critical.
 *
 * WHY THIS SUITE EXISTS. `TMP=$(mktemp -d) && … && rm -rf "$TMP"` is the most
 * common cleanup an agent writes, and the guard refused every one of them, in
 * yolo too, because `critical` is one of the two things yolo still stops for.
 * The refusal was sound on the evidence the guard had: `$(mktemp -d)` is an
 * opaque word, so `$TMP` was unresolvable, and an unresolvable word in a
 * recursive delete fails closed. It was still the wrong answer, because the
 * command text says where that value came from.
 *
 * The rule now reads that provenance. This suite is where the rule stays
 * narrow: the first half proves the shape passes, and the second half is the
 * load-bearing half, because every widening of this exemption is a way to
 * delete somebody's home directory. `rm -rf "$TMP"/*` in particular must stay
 * critical forever, since an empty `TMP` makes it `rm -rf /*`.
 *
 * NOTHING HERE EXECUTES ANYTHING. `findCriticalBashRisk` is a pure function
 * from command text to a verdict: it never spawns a shell, never touches the
 * filesystem, and never runs `rm`. This file imports that one function and
 * asserts verdicts on strings, so it is inert by construction and needs no
 * sandbox, no container, and no guard against running under a plain `bun test`.
 */

import { describe, expect, it } from "bun:test";
import { findCriticalBashRisk } from "../src/tools/bash-guard";

/** A stable home directory, so the rule is stated independently of the machine. */
const HOME = "/home/agent";

/**
 * The guard's verdict, judged against an EMPTY environment so the machine
 * running the suite cannot supply a `TMP` the reasoning did not account for.
 */
function isCritical(command: string): boolean {
	return findCriticalBashRisk(command, HOME, [], {}) !== undefined;
}

describe("a cleanup deleting the temp directory it just made", () => {
	it("passes the shape an agent actually writes", () => {
		const command =
			'TMP=$(mktemp -d) && espeak-ng -w "$TMP/t.wav" hello && dictate "$TMP/t.wav" --stdout && rm -rf "$TMP"';
		expect(isCritical(command)).toBe(false);
	});

	it("passes the minimal form", () => {
		expect(isCritical('TMP=$(mktemp -d) && rm -rf "$TMP"')).toBe(false);
	});

	it("passes the braced spelling of the same name", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion under test, not a JS template.
		expect(isCritical('TMP=$(mktemp -d) && rm -rf "${TMP}"')).toBe(false);
	});

	it("passes a backtick substitution", () => {
		expect(isCritical('TMP=`mktemp -d` && rm -rf "$TMP"')).toBe(false);
	});

	it("passes a temp FILE, which is still a path the command created", () => {
		expect(isCritical('F=$(mktemp) && rm -rf "$F"')).toBe(false);
	});

	it("passes wherever mktemp was told to put it, because it still made only that entry", () => {
		expect(isCritical('T=$(mktemp -d -p /etc) && rm -rf "$T"')).toBe(false);
	});

	it("passes the unquoted spelling", () => {
		expect(isCritical("TMP=$(mktemp -d) && rm -rf $TMP")).toBe(false);
	});
});

describe("the exemption stays narrow", () => {
	it("refuses a glob under the temp path, which is rm -rf /* when mktemp failed", () => {
		expect(isCritical('TMP=$(mktemp -d) && rm -rf "$TMP"/*')).toBe(true);
	});

	it("refuses a path suffix under the temp path, for the same empty-value reason", () => {
		expect(isCritical('TMP=$(mktemp -d) && rm -rf "$TMP"/sub')).toBe(true);
	});

	it("refuses the name once it has been reassigned to something else", () => {
		expect(isCritical('TMP=$(mktemp -d) && TMP=$HOME && rm -rf "$TMP"')).toBe(true);
	});

	it("refuses a prefix assignment on the delete itself, which the shell expands too late", () => {
		expect(isCritical('TMP=$(mktemp -d) rm -rf "$TMP"')).toBe(true);
	});

	it("refuses a name mktemp never created", () => {
		expect(isCritical('TMP=$(mktemp -d) && rm -rf "$OTHER"')).toBe(true);
	});

	it("refuses -u, which returns a name without creating it", () => {
		expect(isCritical('TMP=$(mktemp -u -d) && rm -rf "$TMP"')).toBe(true);
	});

	it("refuses a substitution that runs more than mktemp, whose output is anything at all", () => {
		expect(isCritical('TMP=$(mktemp -d; echo /) && rm -rf "$TMP"')).toBe(true);
	});

	it("refuses a shell-maintained name, because cd rewrites it with no assignment to see", () => {
		expect(isCritical('PWD=$(mktemp -d) && cd / && rm -rf "$PWD"')).toBe(true);
	});

	it("still refuses the home directory on a line that also made a temp directory", () => {
		expect(isCritical("TMP=$(mktemp -d) && rm -rf ~/")).toBe(true);
	});
});
/**
 * Condition 2 of the exemption is "the name is not reassigned between the
 * creation and the delete", and it was only ever checked against the leading
 * `NAME=value` run, which is the one place a BARE assignment can sit. Every
 * other way a shell writes a name puts it after the command word, so the check
 * never saw it and the exemption survived a rebinding to anything at all.
 *
 * The check is now an allowlist on how the name is SPELLED: reading it spells
 * `$T`, writing it spells `T` bare, so a construct nobody enumerated is still
 * covered. The last three cases here are the ones a list of builtins would
 * have missed, and they are the reason it is not a list of builtins.
 */
describe("a name rebound after the command word", () => {
	it("withdraws the exemption when export rebinds it", () => {
		expect(isCritical('T=$(mktemp -d) && export T=/ && rm -rf "$T"')).toBe(true);
	});

	it("withdraws it for declare, readonly and local, which bind the same way", () => {
		expect(isCritical('T=$(mktemp -d) && declare T=/ && rm -rf "$T"')).toBe(true);
		expect(isCritical('T=$(mktemp -d) && readonly T=/ && rm -rf "$T"')).toBe(true);
		expect(isCritical('T=$(mktemp -d) && local T=/ && rm -rf "$T"')).toBe(true);
	});

	/** `read` fills the name from stdin, so its value is whatever was piped in. */
	it("withdraws it when read fills the name from input", () => {
		expect(isCritical('T=$(mktemp -d) && read T && rm -rf "$T"')).toBe(true);
	});

	it("withdraws it for a loop that rebinds the same name", () => {
		expect(isCritical('T=$(mktemp -d) && for T in / ; do rm -rf "$T" ; done')).toBe(true);
	});

	/** `eval` and `source` can write any name, so nothing carried survives them. */
	it("withdraws everything across a construct it cannot read", () => {
		expect(isCritical('T=$(mktemp -d) && eval T=/ && rm -rf "$T"')).toBe(true);
		expect(isCritical('T=$(mktemp -d) && source ./setup.sh && rm -rf "$T"')).toBe(true);
	});

	/** No enumeration of builtins produced these, and the spelling rule does. */
	it("withdraws it for writers nobody enumerated", () => {
		expect(isCritical('T=$(mktemp -d) && printf -v T / && rm -rf "$T"')).toBe(true);
		expect(isCritical('T=$(mktemp -d) && getopts o T && rm -rf "$T"')).toBe(true);
		expect(isCritical('T=$(mktemp -d) && mapfile T < list && rm -rf "$T"')).toBe(true);
		expect(isCritical('T=$(mktemp -d) && T[0]=/ && rm -rf "$T"')).toBe(true);
	});

	/** A script this scan never reads can write any name without naming it here. */
	it("withdraws everything across a script it cannot read", () => {
		expect(isCritical('T=$(mktemp -d) && bash ./setup.sh && rm -rf "$T"')).toBe(true);
	});

	/**
	 * Withdrawal must not fire on a name merely MENTIONED. Logging the path is
	 * part of the shape this exemption exists for, and a guard that refuses the
	 * shape it was written to allow is the earlier defect again.
	 */
	it("leaves the exemption alone when the name is only read", () => {
		expect(isCritical('T=$(mktemp -d) && echo "made $T" && rm -rf "$T"')).toBe(false);
		expect(isCritical('T=$(mktemp -d) && cd "$T" && rm -rf "$T"')).toBe(false);
		expect(isCritical('T=$(mktemp -d) && if true ; then rm -rf "$T" ; fi')).toBe(false);
	});
});
