/**
 * What the guard does with a shell script it cannot fully read.
 *
 * WHY THIS SUITE EXISTS. Reaching into `bash -c` and `eval` closed a real hole:
 * a delete written inside a script argument used to be invisible to the
 * classifier. The first version of that reach also refused any script word
 * carrying an expansion it could not resolve, and `critical` is not a prompt in
 * every run. It is a floor `/yolo` cannot lift and a standing grant cannot
 * apply to, so a session with no interactive surface (headless, CI, `-p` with
 * no terminal, and every subagent under such a root, which inherits the root's
 * surface through `resolveRootUIContext`) has nobody to ask and the tool call
 * fails outright.
 *
 * That turned fifteen ordinary shapes into hard failures, including the lines a
 * shell profile is made of. Both halves are pinned below: the benign shapes run,
 * and a delete the guard cannot account for still stops.
 */

import { describe, expect, it } from "bun:test";
import { bashApprovalDecision } from "../src/tools/bash";
import { findCriticalBashRisk } from "../src/tools/bash-guard";

const HOME = "/home/agent";

/** A fixed environment, so no variable below resolves by accident on this host. */
const ENV: NodeJS.ProcessEnv = { HOME, PATH: "/usr/bin" };

const refuses = (command: string): boolean => findCriticalBashRisk(command, HOME, [], ENV, "/w") !== undefined;

/** The reason an operator would read, or a marker when the command is allowed. */
const reason = (command: string): string => findCriticalBashRisk(command, HOME, [], ENV, "/w")?.reason ?? "(allowed)";

describe("a script argument the guard cannot fully resolve", () => {
	/**
	 * The whole script is one unresolvable expansion. There is nothing to read,
	 * and nothing to read is exactly the position `sh ./setup.sh`, `make` and a
	 * bare `$SCRIPT` are already in, all of which run.
	 */
	it("runs an opaque script the same way every other opaque command runs", () => {
		expect(refuses('sh -c "$SCRIPT"')).toBe(false);
		expect(refuses('bash -lc "$CMD"')).toBe(false);
		expect(refuses('eval "$SETUP"')).toBe(false);
		expect(refuses('bash -c "$(cat run.sh)"')).toBe(false);
		expect(refuses('bash -c "$RUNNER test"')).toBe(false);
		// The same opacity spelled without an interpreter, which was always fine.
		expect(refuses("sh ./setup.sh")).toBe(false);
		expect(refuses("$SCRIPT")).toBe(false);
	});

	/** The lines a shell profile is made of, none of which the guard can resolve. */
	it("runs the shell-init idioms", () => {
		expect(refuses('eval "$(direnv hook bash)"')).toBe(false);
		expect(refuses('eval "$(ssh-agent -s)"')).toBe(false);
		expect(refuses('eval "$(rbenv init -)"')).toBe(false);
		expect(refuses('eval "$(pyenv init -)"')).toBe(false);
	});

	/** Ordinary build and VCS work whose script names one variable. */
	it("runs a readable script that merely mentions a variable", () => {
		expect(refuses('sh -c "cd $DIR && make"')).toBe(false);
		expect(refuses('bash -lc "npm run build --prefix $PKG"')).toBe(false);
		expect(refuses('sh -c "git -C $REPO status"')).toBe(false);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell brace expansion, the bytes under test
		expect(refuses('bash -c "echo ${GREETING}"')).toBe(false);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell default-value operator, the bytes under test
		expect(refuses('sh -c "printf %s ${MSG:-hi}"')).toBe(false);
		expect(refuses('trap "echo done > $LOG" EXIT')).toBe(false);
	});

	/**
	 * The quotes around a command do not make it more dangerous. A non-recursive
	 * `rm` with an unresolvable argument is allowed at the top level, so allowing
	 * it inside `-c` is the same rule rather than a second one. Stated as an
	 * equality so the two verdicts cannot drift apart.
	 */
	it("judges a script by the same rule as the identical bare command", () => {
		for (const bare of ["rm -f $LOCK", "rm $F", "rm -rf $D", "chmod -R 777 $P", "rm -rf ./dist"]) {
			expect([bare, refuses(`sh -c "${bare}"`)]).toEqual([bare, refuses(bare)]);
		}
	});

	/**
	 * The reading is what makes the fix safe: an unresolved part stays a literal
	 * `$NAME` in the inner scan, so a delete whose target the guard cannot name
	 * is still refused for that target rather than for the quotes around it.
	 */
	it("still refuses a delete inside the script whose target it cannot name", () => {
		expect(reason('bash -c "rm -rf $D"')).toContain("recursively remove");
		expect(reason("sh -lc 'rm -rf \"$dir\"/*'")).toContain("recursively remove");
		expect(reason('sh -c "chmod -R 777 $P"')).toContain("recursively remove");
		expect(reason('eval "cd /tmp && rm -rf $OUT"')).toContain("recursively remove");
	});

	/**
	 * A delete inside a command substitution is the one shape the reading cannot
	 * reach: `$(rm -rf /)` is a single word to the splitter and `$(rm` is not
	 * `rm`, so the inner scan walks past it. Refused on the raw text instead.
	 */
	it("refuses a delete buried where the word scan cannot see it", () => {
		expect(reason('eval "$(rm -rf /)"')).toContain("cannot read");
		expect(reason('bash -c "$(rm -rf ~/.ssh)"')).toContain("cannot read");
		expect(reason('sh -c "`rm -rf ~`"')).toContain("cannot read");
		expect(reason('trap "$(shred ~/.ssh/id_rsa)" EXIT')).toContain("cannot read");
	});

	/** Past the nesting bound the guard stops reading, and says so rather than
	 * calling the text fine. This reason is distinct from the one above because
	 * the two refusals are different facts about the command. */
	it("refuses a script nested deeper than it reads", () => {
		expect(reason('bash -c "sh -c \'bash -c \\"sh -c $X\\"\'"')).toContain("nested deeper");
	});

	/** The shapes the previous commit closed stay closed at every depth. */
	it("keeps reading a script it can read", () => {
		expect(refuses('bash -c "rm -rf ~/"')).toBe(true);
		expect(refuses('eval "for i in 1 ; do rm -rf ~ ; done"')).toBe(true);
		expect(refuses("bash -c \"sh -c 'rm -rf ~/'\"")).toBe(true);
		expect(refuses('bash -c "npm run build"')).toBe(false);
	});
});

/**
 * The same cases through `bashApprovalDecision`, the entry point the tool calls.
 * `critical` is the field that becomes a hard failure in a run with no UI, so a
 * suite that only called the classifier would not be measuring the defect.
 */
describe("the approval decision a run with no interactive surface receives", () => {
	const isCritical = (command: string): boolean => {
		const decision = bashApprovalDecision({ command, env: { HOME } });
		return typeof decision !== "string" && decision.critical === true;
	};

	it("does not mark an unresolvable benign script critical", () => {
		expect(isCritical('eval "$(direnv hook bash)"')).toBe(false);
		expect(isCritical('sh -c "$SCRIPT"')).toBe(false);
		expect(isCritical('bash -lc "npm run build --prefix $PKG"')).toBe(false);
	});

	it("still marks a delete it cannot account for critical", () => {
		expect(isCritical('bash -c "rm -rf $D"')).toBe(true);
		expect(isCritical('eval "$(rm -rf /)"')).toBe(true);
	});
});
