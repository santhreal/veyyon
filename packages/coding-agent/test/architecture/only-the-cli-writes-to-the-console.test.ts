/**
 * Writing to the console is a CLI privilege, and nothing else in the package has it.
 *
 * `console.log` and `console.error` write straight to the process's stdout and
 * stderr. In a command that OWNS the terminal, `veyyon config get`, `veyyon
 * profile list`, that is exactly right: the output is the product. Inside a
 * module the TUI loads, it is a defect, because the TUI owns the screen and an
 * unscheduled write lands in the middle of a frame and corrupts it. Nothing
 * fails, nothing is logged, and the user sees a garbled render.
 *
 * The sweep that produced this rule found 278 console calls across 17 files.
 * Sixteen of them were CLI entry points under `src/cli/` and `src/commands/`.
 * The seventeenth was `config/model-resolver.ts`, a module the session loads,
 * and its five calls sat inside two functions that turned out to have no caller
 * at all: a whole second initial-model precedence chain, complete with a
 * `process.exit(1)` in a library module, that `main.ts` had long since replaced.
 * Both are deleted, and this test is what stops the next one arriving.
 *
 * The rule is on the DIRECTORY rather than on a file list, so a new CLI command
 * needs no edit here and a new console call anywhere else fails immediately.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(import.meta.dir, "../../src");

/**
 * Where the console is the product rather than a stray write.
 *
 * `cli/` holds the argument parsers and their output writers; `commands/` holds
 * the oclif command classes that wrap them. Both run as the whole process, with
 * no TUI on screen to corrupt. This list may SHRINK. It may not grow without a
 * reason written here, because every entry is a directory where a mistake stops
 * being visible.
 */
const CONSOLE_OWNERS = ["cli", "commands"];

/** Source lines with string literals and comments removed, so a mention is not a call. */
function codeOf(source: string): string[] {
	return source.split("\n").map(line => {
		const withoutComment = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
		return withoutComment
			.replace(/"(?:[^"\\]|\\.)*"/g, '""')
			.replace(/'(?:[^'\\]|\\.)*'/g, "''")
			.replace(/`(?:[^`\\]|\\.)*`/g, "``");
	});
}

const CONSOLE_CALL = /\bconsole\.\w+\s*\(/;

interface Hit {
	file: string;
	line: number;
	text: string;
}

function consoleCalls(predicate: (relative: string) => boolean): Hit[] {
	const hits: Hit[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "__tests__") walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			const relative = path.relative(SRC, full);
			if (!predicate(relative)) continue;
			codeOf(fs.readFileSync(full, "utf8")).forEach((text, index) => {
				if (CONSOLE_CALL.test(text)) hits.push({ file: relative, line: index + 1, text: text.trim() });
			});
		}
	};
	walk(SRC);
	return hits;
}

/** True when `relative` lives under one of the directories allowed to write. */
function isConsoleOwner(relative: string): boolean {
	const [top] = relative.split(path.sep);
	return CONSOLE_OWNERS.includes(top ?? "");
}

describe("only the CLI writes to the console", () => {
	/**
	 * The scan reads the real tree. A walk that found nothing would pass the rule
	 * below while checking nothing at all, which is the failure mode every
	 * source-scanning test has.
	 */
	it("reads the package source", () => {
		const everything = consoleCalls(() => true);

		expect(everything.length).toBeGreaterThan(100);
		expect(everything.some(hit => hit.file.startsWith(`cli${path.sep}`))).toBe(true);
	});

	/**
	 * The rule itself.
	 *
	 * A failure here names the file and line, because the fix depends on what the
	 * module is: a library module reports through the logger or returns the
	 * message to a surface that can show it, and a genuinely new CLI surface
	 * belongs in the list above with its reason.
	 */
	it("no module outside the CLI directories calls the console", () => {
		const offenders = consoleCalls(relative => !isConsoleOwner(relative)).map(
			hit => `${hit.file}:${hit.line} ${hit.text}`,
		);

		expect(offenders).toEqual([]);
	});

	/**
	 * And the allowlisted directories really are where the console lives.
	 *
	 * If the CLI moved and this stopped being true, the rule above would still
	 * pass while guarding an empty exception, so the exception is asserted rather
	 * than assumed.
	 */
	it("the allowlisted directories are the ones that write", () => {
		const owningDirectories = CONSOLE_OWNERS.filter(
			owner => consoleCalls(relative => relative.startsWith(`${owner}${path.sep}`)).length > 0,
		);

		expect(owningDirectories).toEqual(CONSOLE_OWNERS);
	});
});

describe("the scanner tells a call from a mention", () => {
	/**
	 * The two `tools/ast-*.ts` files carry `console.log($$$)` inside their tool
	 * documentation, as the example pattern an ast-grep query looks for. A
	 * scanner that counted those would report two permanent offenders and the
	 * rule would be turned off within the week.
	 */
	it("ignores a console call written inside a string", () => {
		expect(codeOf('const example = "console.log($$$)";').some(line => CONSOLE_CALL.test(line))).toBe(false);
		expect(codeOf("const example = `console.log($$$)`;").some(line => CONSOLE_CALL.test(line))).toBe(false);
		expect(codeOf("// call console.log(x) here").some(line => CONSOLE_CALL.test(line))).toBe(false);
		expect(codeOf(" * never call console.error(x)").some(line => CONSOLE_CALL.test(line))).toBe(false);
	});

	/**
	 * The non-vacuity twin: it still sees a real call, including one that is not
	 * `log` and one with a space before the parenthesis.
	 */
	it("still sees a real call", () => {
		expect(codeOf("\tconsole.log(message);").some(line => CONSOLE_CALL.test(line))).toBe(true);
		expect(codeOf("\tconsole.error (message);").some(line => CONSOLE_CALL.test(line))).toBe(true);
		expect(codeOf("\tconsole.table(rows);").some(line => CONSOLE_CALL.test(line))).toBe(true);
	});

	/**
	 * And the owner check reads the top directory, not a substring of the path.
	 */
	it("recognises the owner directories by their place in the path", () => {
		expect(isConsoleOwner(path.join("cli", "config-cli.ts"))).toBe(true);
		expect(isConsoleOwner(path.join("commands", "session.ts"))).toBe(true);
		expect(isConsoleOwner(path.join("config", "model-resolver.ts"))).toBe(false);
		// A nested directory that merely CONTAINS the word is not an owner.
		expect(isConsoleOwner(path.join("modes", "cli", "thing.ts"))).toBe(false);
	});
});
