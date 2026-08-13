/**
 * A variable this command line assigns is knowable from the command text.
 *
 * WHY THIS SUITE EXISTS. `findCriticalBashRisk` applied a segment's inline
 * assignments over a COPY of the environment that died with the segment, so the
 * most ordinary shape an agent writes,
 *
 *     DST=/srv/app; mkdir -p "$DST"; rm -rf "$DST/build"
 *
 * reached the delete with `$DST` unresolved, and an unresolved expansion in a
 * recursive delete is `critical`. `critical` is the floor `/yolo` cannot lift
 * and a standing grant cannot apply to, so a mode whose whole promise is that
 * it does not prompt stopped and asked — and on a headless run, which has no
 * answer to give, the call fails outright. The guard's own words for that
 * verdict are "an expansion whose value is NOT KNOWABLE FROM THE COMMAND TEXT",
 * and the command text said what it was one word earlier.
 *
 * THE CLASS THIS CLOSES. Not "the `;` case": every route by which this line
 * settles a name (bare assignment, a declaration builtin, a wrapper word in
 * front of it, a later reassignment) resolves it, and every route by which the
 * line does NOT settle it keeps the floor. The fail-closed half is the half
 * that matters, and it is swept from the module's own tables at run time —
 * `SHELL_MAINTAINED_VARIABLES`, `PROTECTED_ROOTS`, `DECLARATION_BUILTINS` — so
 * a member added to any of them is judged here the day it lands rather than the
 * day someone remembers this file.
 *
 * WHAT IT DOES NOT CATCH. Control flow. The scan reads every segment of a line
 * unconditionally, so it cannot know that `[ -z "$D" ] && D=/srv` did not run;
 * that case is answered by refusing to believe an assignment whose name already
 * has a different ambient value, which is a blunt instrument and is asserted
 * below as such. It says nothing about a name written inside a script file, a
 * function, or a subshell whose text this scan never sees — those are covered
 * by `bash-guard-unreadable-script.test.ts`, and they keep the floor.
 *
 * Two branches of the fix are also unobservable from any command, because the
 * expander refuses the same values a second time: carrying refuses a
 * shell-maintained name, and carrying refuses a value that is itself an
 * unresolvable expansion. Deleting either one leaves this suite green. Both are
 * documented at `carriedValue` as redundant defence, and what a test CAN watch
 * — the expander's own copy of each rule — is asserted below.
 */

import { describe, expect, it } from "bun:test";

import {
	DECLARATION_BUILTINS,
	findCriticalBashRisk,
	PROTECTED_ROOTS,
	SHELL_MAINTAINED_VARIABLES,
} from "../src/tools/bash-guard";

const HOME = "/home/operator";
/** A fixed environment, so no case can pass or fail because of this machine. */
const ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME };

function judge(command: string, env: NodeJS.ProcessEnv = ENV): string | undefined {
	return findCriticalBashRisk(command, HOME, [], env)?.reason;
}

describe("a value the line assigns", () => {
	/**
	 * THE REPORTED COMMAND, verbatim apart from the paths. Every word of it is
	 * ordinary: make a directory, replace what is in it, move something in.
	 */
	it("resolves through the rest of the line, so an ordinary staging command does not prompt", () => {
		const command =
			'set -e; DST=/srv/app/libs; mkdir -p "$DST"; rm -rf "$DST/facet"; mv /tmp/facet "$DST/facet"; cd "$DST/facet"; pwd';

		expect(judge(command)).toBeUndefined();
	});

	/**
	 * Every spelling that puts an assignment on the line, swept from the module's
	 * own table plus the bare and wrapper forms. A declaration builtin added to
	 * `DECLARATION_BUILTINS` and never thought about lands here automatically.
	 *
	 * The table's membership is pinned by exact equality as well as swept,
	 * because a sweep alone is circular: emptying the table would empty the cases
	 * derived from it and leave this green while `export DST=…` stopped
	 * resolving. Adding a member is meant to fail here until someone writes it
	 * down and watches the behaviour case pass.
	 */
	it("resolves through every spelling of an assignment the scan steps over", () => {
		expect([...DECLARATION_BUILTINS].sort()).toEqual(["declare", "export", "local", "readonly", "typeset"]);

		const prefixes = ["", "env ", "sudo ", "sudo -E ", ...[...DECLARATION_BUILTINS].map(word => `${word} `)];
		const unresolved = prefixes.filter(prefix => judge(`${prefix}DST=/srv/app; rm -rf "$DST/build"`) !== undefined);

		expect(unresolved).toEqual([]);
	});

	/** The last assignment wins, exactly as the shell reads it. */
	it("takes the value from the LAST assignment before the delete", () => {
		expect(judge('DST=/srv/app; DST=/; rm -rf "$DST"')).toContain("protected system directory");
		expect(judge('DST=/; DST=/srv/app; rm -rf "$DST"')).toBeUndefined();
	});

	/**
	 * Resolving a name must not resolve it INTO the floor. A line that names a
	 * protected root through a variable is the same command as naming it
	 * directly, and every root the module protects is swept rather than sampled.
	 */
	it("keeps the floor when the resolved value IS a protected root", () => {
		const escaped = PROTECTED_ROOTS.filter(root => judge(`DST=${root}; rm -rf "$DST"`) === undefined);

		expect(escaped).toEqual([]);
	});

	it("keeps the floor when the resolved value is the home directory", () => {
		expect(judge(`DST=${HOME}; rm -rf "$DST"`)).toContain("home directory");
		expect(judge('DST=$HOME; rm -rf "$DST"')).toContain("home directory");
	});
});

describe("a value the line does NOT settle", () => {
	/**
	 * Each row is a shape whose value the command text does not fix, and each one
	 * was a way to smuggle a delete past a scan that believes assignments. They
	 * are listed with the reading that makes them dangerous, because a reader
	 * deleting one of these rows needs to know what it is for.
	 */
	const UNSETTLED: readonly (readonly [string, string])[] = [
		// The value cannot be had without running the substitution.
		["command substitution", 'DST=$(cat target.txt); rm -rf "$DST"'],
		// Pasting it would word-split into two targets, one of them the root.
		["a value that word-splits", 'DST="/ /tmp/x"; rm -rf $DST'],
		// Pasting it would glob to every top-level entry.
		["a value that globs", 'DST="/*"; rm -rf $DST'],
		// A second round of expansion this module does not model.
		["a value naming another variable", 'DST=$OTHER; rm -rf "$DST"'],
		// An operator form the expander refuses outright. The `${...}` is shell
		// parameter expansion inside a command fixture, not a missed JS template.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax under test
		["a defaulting expansion", 'DST=/srv; rm -rf "${DST:-/}"'],
		// Something wrote the name and this scan cannot say what it wrote.
		["a name rebound by read", 'DST=/srv/app; read DST; rm -rf "$DST"'],
		["a name rebound by a loop", 'DST=/srv/app; for DST in a b; do :; done; rm -rf "$DST"'],
		["a name rebound inside an unreadable script", 'DST=/srv/app; bash ./deploy.sh; rm -rf "$DST"'],
		// No assignment at all: the ambient value is the shell's business.
		["no assignment on the line", 'rm -rf "$DST/build"'],
	];

	it.each(UNSETTLED)("keeps the floor for %s", (_label, command) => {
		expect(judge(command)).toBeDefined();
	});

	/**
	 * A name the SHELL maintains is never resolved, because its value at the
	 * moment the command runs is not the one any earlier word set: `cd` rewrites
	 * `PWD` inside the very line being judged. Swept from the module's set, so a
	 * variable added to it cannot arrive uncovered.
	 *
	 * The ambient value is SUPPLIED on purpose. Without it the case passes for
	 * the wrong reason — an unset name is unknown however the rule is spelled —
	 * and the assertion could not tell a working guard from a deleted one.
	 *
	 * The rule is enforced twice, in the expander and again where a value is
	 * carried forward, and only the expander's copy is observable from here: the
	 * carried-value copy is redundant defence and no command can distinguish it.
	 */
	it("never resolves a shell-maintained name, whatever the line assigns it", () => {
		const resolved = [...SHELL_MAINTAINED_VARIABLES].filter(
			name => judge(`${name}=/srv/app; cd /; rm -rf "$${name}"`, { ...ENV, [name]: "/srv/app" }) === undefined,
		);

		expect(resolved).toEqual([]);
	});

	/**
	 * The blunt instrument named in the header. The scan reads a conditional
	 * assignment as if it always ran, so when the ambient environment already
	 * holds a DIFFERENT value the line is ambiguous and the guard refuses to
	 * pick: believing the assignment would judge a path the command may never
	 * touch and wave past the one it will.
	 */
	it("refuses to believe an assignment the ambient environment contradicts", () => {
		const conditional = '[ -z "$DST" ] && DST=/srv/app; rm -rf "$DST"';

		expect(judge(conditional, { ...ENV, DST: "/" })).toBeDefined();
		expect(judge(conditional, { ...ENV, DST: "/srv/app" })).toBeUndefined();
		expect(judge(conditional)).toBeUndefined();
	});

	/**
	 * A PREFIX assignment does not settle a name for its OWN command. The shell
	 * expands a command's words before its prefix assignments take effect, so
	 * `A=1 B=$A cmd` gives `B` the old `A`, and reading the value the same
	 * segment is in the middle of writing would resolve a path the shell will
	 * not use. Only a LATER segment may read it.
	 */
	it("does not let a segment's own assignment settle a value in that same segment", () => {
		// Observed one segment LATER, because within the segment the raw text is
		// what binds and `$DST` is refused as a value on its own account. The next
		// segment is where a wrongly-resolved `TARGET` would become a path.
		expect(judge('DST=/srv/app TARGET=$DST true; rm -rf "$TARGET"')).toBeDefined();
		expect(judge('DST=/srv/app; TARGET=$DST; rm -rf "$TARGET"')).toBeUndefined();
	});

	/**
	 * The exemption for a directory the line created with `mktemp` is keyed on a
	 * name, and carrying values must not have given that name a second life:
	 * `T=$(mktemp -d)` is still an unresolvable value, so the glob form stays
	 * critical while the bare form stays exempt.
	 */
	it("leaves the mktemp exemption exactly where it was", () => {
		expect(judge('T=$(mktemp -d); rm -rf "$T"')).toBeUndefined();
		expect(judge('T=$(mktemp -d); rm -rf "$T"/*')).toBeDefined();
		expect(judge('T=$(mktemp -d); read T; rm -rf "$T"')).toBeDefined();
	});

	/**
	 * Rule 6: the scan has to END. A line whose assignments reference each other
	 * is the shape that turns a resolver into a loop, and a guard that hangs is
	 * worse than one that prompts.
	 */
	it("terminates on assignments that reference each other", () => {
		const start = Date.now();

		expect(judge('A=$B; B=$A; A=$B; rm -rf "$A"')).toBeDefined();
		expect(Date.now() - start).toBeLessThan(1_000);
	});
});
