/**
 * The whole class of commands that hand shell text to a shell, closed.
 *
 * WHY THIS SUITE IS SHAPED LIKE THIS. The defect this file guards was fixed
 * once already, for the members somebody had in mind at the time. The reason it
 * came back is that the members were a branch in the middle of a function: you
 * could add a shell, or a delete verb, and nothing anywhere would notice that
 * no decision had been recorded about it. A suite that pins `bash`, `sh` and
 * `eval` is a suite that is green the day `zsh` starts being read differently.
 *
 * So nothing below hardcodes the member list. The variant space is read at run
 * time out of `INTERPRETED_SCRIPT_COMMANDS` and `DESTRUCTIVE_VERBS`, the two
 * registries the implementation itself reads, and every member is required to
 * carry a recorded decision here. Add a member to either registry and this file
 * goes RED until somebody writes down what that member should do. That is the
 * property being defended, more than any individual verdict.
 *
 * Two invariants are stated at the choke point rather than per reproduction:
 *
 *   READ  every member's script argument is judged as shell text, so a delete
 *         written inside it is found wherever the member keeps it.
 *   BOUND every member terminates, and refuses rather than descends once the
 *         nesting passes `MAX_INTERPRETED_SHELL_DEPTH`.
 */

import { describe, expect, it } from "bun:test";
import {
	DESTRUCTIVE_VERBS,
	findCriticalBashRisk,
	INTERPRETED_SCRIPT_COMMANDS,
	MAX_INTERPRETED_SHELL_DEPTH,
	SCRIPT_FLAG,
	type ScriptArgumentShape,
} from "../src/tools/bash-guard";

const HOME = "/home/agent";

/** A fixed environment, so no variable below resolves by accident on this host. */
const ENV: NodeJS.ProcessEnv = { HOME, PATH: "/usr/bin" };

const reason = (command: string): string => findCriticalBashRisk(command, HOME, [], ENV, "/w")?.reason ?? "(allowed)";

const refuses = (command: string): boolean => findCriticalBashRisk(command, HOME, [], ENV, "/w") !== undefined;

/**
 * How to write a command line for one member of the interpreter class.
 *
 * A member is asked for three spellings rather than one, because the three are
 * where the class has historically split: a script it can read, a script it
 * cannot read that is harmless, and a script it cannot read that deletes.
 */
interface MemberDecision {
	/** The member's own spelling of "run this readable script". */
	readonly readable: (script: string) => string;
	/** The member running a script whose text is one unresolvable expansion. */
	readonly opaque: string;
}

/**
 * The recorded decision for every member of the interpreter class.
 *
 * FAIL BY DEFAULT. The keys are checked against the live registry below, so a
 * shell added to `INTERPRETED_SCRIPT_COMMANDS` with no row here fails that
 * check rather than silently going untested.
 */
const MEMBERS: Record<string, MemberDecision> = {
	eval: { readable: script => `eval "${script}"`, opaque: 'eval "$SETUP"' },
	trap: { readable: script => `trap "${script}" EXIT`, opaque: 'trap "$CLEANUP" EXIT' },
	bash: { readable: script => `bash -c "${script}"`, opaque: 'bash -c "$SCRIPT"' },
	sh: { readable: script => `sh -c "${script}"`, opaque: 'sh -c "$SCRIPT"' },
	zsh: { readable: script => `zsh -c "${script}"`, opaque: 'zsh -c "$SCRIPT"' },
	dash: { readable: script => `dash -c "${script}"`, opaque: 'dash -c "$SCRIPT"' },
	ksh: { readable: script => `ksh -c "${script}"`, opaque: 'ksh -c "$SCRIPT"' },
	ash: { readable: script => `ash -c "${script}"`, opaque: 'ash -c "$SCRIPT"' },
};

describe("the class of commands that hand shell text to a shell", () => {
	/**
	 * The gate that makes the rest of this file worth having. Every member of
	 * the live registry must carry a decision, and no decision may name a member
	 * that no longer exists.
	 */
	it("has a recorded decision for every member of the registry", () => {
		expect(Object.keys(MEMBERS).sort()).toEqual([...INTERPRETED_SCRIPT_COMMANDS.keys()].sort());
	});

	/** Every shape in the union is exercised, not just the one in the bug report. */
	it("exercises every argument shape the union declares", () => {
		const declared = new Set<ScriptArgumentShape>(INTERPRETED_SCRIPT_COMMANDS.values());
		expect([...declared].sort()).toEqual(["afterScriptFlag", "nextWord"]);
	});

	for (const [member, decision] of Object.entries(MEMBERS)) {
		describe(member, () => {
			/** READ: the script is judged as shell text, wherever this member keeps it. */
			it("finds a delete written inside the script", () => {
				expect(reason(decision.readable("rm -rf ~/"))).toContain("recursively remove");
			});

			/** READ: an unresolvable target inside the script is still refused. */
			it("refuses a delete whose target it cannot name", () => {
				expect(reason(decision.readable("rm -rf $D"))).toContain("recursively remove");
			});

			/** The fix: unreadability alone is not a refusal, for any member. */
			it("runs an opaque script rather than failing the call", () => {
				expect(refuses(decision.opaque)).toBe(false);
			});

			/** Ordinary work must keep working, for every member. */
			it("runs ordinary readable work", () => {
				expect(refuses(decision.readable("npm run build"))).toBe(false);
				expect(refuses(decision.readable("rm -rf ./dist"))).toBe(false);
			});

			/** The quotes never change the verdict relative to the bare command. */
			it("agrees with the identical bare command", () => {
				for (const bare of ["rm -f $LOCK", "rm $F", "rm -rf $D", "chmod -R 777 $P", "rm -rf ./dist"]) {
					expect([bare, refuses(decision.readable(bare))]).toEqual([bare, refuses(bare)]);
				}
			});
		});
	}
});

describe("the class of verbs an unreadable script may not hide", () => {
	/**
	 * Same gate, for the second registry. A verb added to
	 * `RECURSIVE_DELETE_COMMANDS` or `RECURSIVE_REWRITE_COMMANDS` joins
	 * `DESTRUCTIVE_VERBS` automatically, and would otherwise arrive untested.
	 */
	const VERBS: Record<string, string> = {
		rm: "rm -rf /",
		rmdir: "rmdir /",
		shred: "shred /",
		srm: "srm /",
		chmod: "chmod -R 777 /",
		chown: "chown -R root /",
		chgrp: "chgrp -R root /",
		find: "find / -delete",
	};

	it("has a recorded invocation for every destructive verb", () => {
		expect(Object.keys(VERBS).sort()).toEqual([...DESTRUCTIVE_VERBS].sort());
	});

	for (const [verb, invocation] of Object.entries(VERBS)) {
		/**
		 * Buried in a command substitution, which is the one position the word
		 * scan cannot reach: the whole `$(…)` is a single word to the splitter, so
		 * `$(rm` never reads as `rm`. Every verb must be caught there, not just
		 * the one somebody reported.
		 */
		it(`refuses ${verb} buried in a command substitution`, () => {
			expect(reason(`eval "$(${invocation})"`)).toContain("cannot read");
			expect(reason(`bash -c "\`${invocation}\`"`)).toContain("cannot read");
		});
	}
});

/**
 * TERMINATION AND BOUNDS.
 *
 * The scan re-enters itself, so "did it answer" is a separate question from
 * "did it answer correctly", and only the bound makes the first one true. These
 * cases are stated against the exported constant rather than the number 3, so
 * moving the bound moves the test with it instead of leaving a stale literal.
 */
describe("the recursion terminates and is bounded", () => {
	/**
	 * `sh -c "…"` wrapped `depth` times around a payload, escaped the way a
	 * shell requires at each level. Naive single quotes do NOT nest (`'a'b'` is
	 * three tokens, not one), so a builder that used them would produce a
	 * command the guard reads as one level deep and an assertion about the bound
	 * that never reaches it.
	 */
	const nest = (depth: number, payload: string): string => {
		let command = payload;
		for (let level = 0; level < depth; level += 1) {
			const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			command = `sh -c "${escaped}"`;
		}
		return command;
	};

	/**
	 * The bound is honoured exactly. One level under it the guard is still
	 * reading and answers about the payload; one level over it the guard has
	 * stopped reading and says so.
	 */
	it("reads up to the bound and refuses past it", () => {
		expect(reason(nest(MAX_INTERPRETED_SHELL_DEPTH, "rm -rf ~/"))).toContain("recursively remove");
		expect(reason(nest(MAX_INTERPRETED_SHELL_DEPTH + 1, "echo hi"))).toContain("nested deeper");
	});

	/**
	 * Termination, not a value. A nesting well past the bound must come back at
	 * all; a scan that descended per level instead of refusing at one would run
	 * until the runner's own timeout killed the file, and no assertion about a
	 * verdict can see that. Ten levels rather than a thousand because each level
	 * doubles the escaping, so the input grows exponentially in the depth and
	 * the interesting property is reached immediately past the bound anyway.
	 */
	it("answers a nesting well past the bound instead of descending", () => {
		const deep = MAX_INTERPRETED_SHELL_DEPTH + 7;
		expect(reason(nest(deep, "echo hi"))).toContain("nested deeper");
		expect(reason(nest(deep, "rm -rf ~/"))).toContain("nested deeper");
	});

	/**
	 * The refusal past the bound is a REFUSAL, not a verdict about the text. A
	 * harmless payload and a destructive one are refused identically, because at
	 * that point the guard has read neither.
	 */
	it("refuses past the bound without claiming to have read the text", () => {
		expect(reason(nest(MAX_INTERPRETED_SHELL_DEPTH + 1, "echo hi"))).toBe(
			reason(nest(MAX_INTERPRETED_SHELL_DEPTH + 1, "rm -rf ~/")),
		);
	});
});

/**
 * The `-c` spellings an agent writes. The pattern is exported, so the accepted
 * and rejected spellings are stated against it and against the guard's verdict
 * together: a pattern that drifts from the routing is the failure this catches.
 */
describe("the script-flag spellings", () => {
	const ACCEPTED = ["-c", "-lc", "-ec", "-euc", "-xc", "-eufc"];
	const REJECTED = ["-e", "-l", "--command", "-C", "-cx"];

	it("routes the script for every accepted spelling", () => {
		for (const flag of ACCEPTED) {
			expect([flag, SCRIPT_FLAG.test(flag)]).toEqual([flag, true]);
			expect([flag, reason(`bash ${flag} "rm -rf ~/"`)]).toEqual([
				flag,
				"rm would recursively remove the home directory itself",
			]);
		}
	});

	it("does not treat a non-script flag as one", () => {
		for (const flag of REJECTED) {
			expect([flag, SCRIPT_FLAG.test(flag)]).toEqual([flag, false]);
		}
	});
});
