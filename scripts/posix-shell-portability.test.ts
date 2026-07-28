import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The shell scripts veyyon ships have to parse under macOS `/bin/sh`, which is
 * bash 3.2.
 *
 * One incompatibility has already cost a red gate on both macOS runners the day
 * they were added, and it is invisible on every Linux shell: inside a command
 * substitution, bash 3.2 reads the `)` that ends a `case` pattern as the `)`
 * that ends the substitution. The file dies at RUN time, not at parse time, with
 * `syntax error near unexpected token 'newline'` naming a line of perfectly
 * valid POSIX sh. `sh -n` on Linux says nothing, `dash` says nothing, and the
 * failure only appears once a macOS runner executes the branch.
 *
 * The fix is POSIX-optional syntax that every shell accepts: a leading `(` on
 * the pattern, `case "$x" in (foo) ...`. This is the gate that keeps it, because
 * the parens read like noise and the next person to tidy them away would get a
 * green Linux CI and a red macOS one.
 *
 * A lint rather than an execution test on purpose: reproducing it needs bash 3.2,
 * which is not installable on the Linux runners, so the choice is this or nothing.
 */

const repoRoot = path.resolve(import.meta.dir, "..");

/** Every shell script the product or its gates run. */
const SHELL_SCRIPTS = [
	"scripts/install.sh",
	"scripts/install-tests/functions.test.sh",
	"scripts/install-tests/run-ci.sh",
	"scripts/install-tests/stress.sh",
];

/**
 * Patterns of a one-line `case` that sits inside a command substitution and are
 * NOT parenthesized, as `<line number>: <pattern>`.
 *
 * Scoped to one-line `case ... esac` because that is the shape the hazard takes:
 * a multi-line `case` inside `$( )` puts its `)` on its own line, where bash 3.2
 * parses it correctly.
 */
export function unparenthesizedCasePatterns(source: string): string[] {
	const found: string[] = [];
	source.split("\n").forEach((line, index) => {
		const substitution = line.indexOf("$(");
		if (substitution === -1) return;
		const caseAt = line.indexOf("case ", substitution);
		if (caseAt === -1 || !line.includes("esac", caseAt)) return;
		const body = line.slice(caseAt);
		for (const match of body.matchAll(/(?:\bin |;; )([^(;\s][^)]*)\)/g)) {
			const pattern = match[1] as string;
			if (pattern.startsWith("esac")) continue;
			found.push(`${index + 1}: ${pattern}`);
		}
	});
	return found;
}

describe("shell scripts parse under macOS /bin/sh (bash 3.2)", () => {
	/**
	 * The control. Every assertion below reports "nothing found", which is also
	 * what a detector that matches nothing at all reports, and a regex that
	 * quietly stopped matching would leave this gate green forever.
	 */
	it("detects the hazard in a line that has it", () => {
		const bad = `check "x" "$( ( case "$v" in *good*) echo yes ;; *) echo no ;; esac ) )" "yes"`;
		expect(unparenthesizedCasePatterns(bad)).toEqual(["1: *good*", "1: *"]);
	});

	it("accepts the same line once the patterns are parenthesized", () => {
		const good = `check "x" "$( ( case "$v" in (*good*) echo yes ;; (*) echo no ;; esac ) )" "yes"`;
		expect(unparenthesizedCasePatterns(good)).toEqual([]);
	});

	it("ignores a case that is not inside a command substitution", () => {
		// Outside `$( )` the pattern's `)` has nothing to be confused with, so
		// requiring the paren there would be a style rule, not a portability one.
		expect(unparenthesizedCasePatterns(`has() { case "$1" in bash) return 0 ;; *) return 1 ;; esac; }`)).toEqual([]);
	});

	it.each(SHELL_SCRIPTS)("%s parenthesizes every case pattern inside a command substitution", relative => {
		const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
		expect(unparenthesizedCasePatterns(source)).toEqual([]);
	});

	it.each(SHELL_SCRIPTS)("%s exists and is not empty", relative => {
		// Guards the list above: a renamed script would otherwise make its own
		// check vacuous rather than failing.
		expect(fs.readFileSync(path.join(repoRoot, relative), "utf8").length).toBeGreaterThan(500);
	});
});
