import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_CODE_NOTICE_RE, formatExitCodeNotice } from "@veyyon/coding-agent/exec/exit-notice";

/**
 * The "how this command ended" notice has exactly one wording and one matcher.
 *
 * WHY THIS SUITE EXISTS. The notice is a WRITE/READ PAIR spread across the
 * codebase: five surfaces append it to a failed command's output (the bash
 * tool, `eval`, `ssh`, the `!` transcript messages, the legacy extension shim)
 * and the task renderer strips it back off the recent-output pane by matching
 * it. The two sides have to agree on the exact bytes. Before this module they
 * did not share anything: each producer wrote its own template literal and the
 * renderer carried a regex copied from one of them.
 *
 * That is the classic drift shape, and adding the signal wording is exactly the
 * change that triggers it: a producer that says `Command was killed by SIGKILL`
 * against a renderer that only knows `Command exited with code N` leaves the
 * notice visible in the pane, which reads as a rendering bug.
 *
 * So this suite pins three things: the wording, the matcher agreeing with the
 * wording for every shape the wording can take, and a source lock that fails if
 * a sixth copy of the string appears somewhere else.
 */

describe("formatExitCodeNotice", () => {
	/**
	 * The plain form, unchanged from before the signal existed. Pinned as exact
	 * bytes because sessions recorded earlier contain this text and the renderer
	 * still has to strip it out of them.
	 */
	it("states the code for an ordinary non-zero exit", () => {
		expect(formatExitCodeNotice(1)).toBe("Command exited with code 1");
		expect(formatExitCodeNotice(127)).toBe("Command exited with code 127");
	});

	/**
	 * An exit code that happens to fall in the 128+N range is still an ordinary
	 * exit when no signal is given. This is the case the whole feature is about,
	 * asserted from the side that must NOT change.
	 */
	it("does not mention a signal for a literal exit in the signal range", () => {
		expect(formatExitCodeNotice(137)).toBe("Command exited with code 137");
		expect(formatExitCodeNotice(143)).toBe("Command exited with code 143");
	});

	/**
	 * The signal form names the signal and keeps the numeric code. Both halves
	 * matter: the name is what tells a reader it was killed, and the number is
	 * what a script author comparing `$?` is looking for.
	 */
	it("names the signal and keeps the code for a signalled death", () => {
		expect(formatExitCodeNotice(137, os.constants.signals.SIGKILL)).toBe(
			`Command was killed by SIGKILL (${os.constants.signals.SIGKILL}); the shell reports this as exit code 137`,
		);
		expect(formatExitCodeNotice(143, os.constants.signals.SIGTERM)).toBe(
			`Command was killed by SIGTERM (${os.constants.signals.SIGTERM}); the shell reports this as exit code 143`,
		);
	});

	/**
	 * A signal number with no name on this platform still produces a usable
	 * notice rather than "undefined". Real-time signals (SIGRTMIN+n) have no
	 * entry in the platform table, and a process killed by one must still be
	 * reported as killed.
	 */
	it("falls back to the bare number for a signal with no name", () => {
		expect(formatExitCodeNotice(192, 64)).toBe(
			"Command was killed by signal 64; the shell reports this as exit code 192",
		);
	});

	/**
	 * A negative exit code is reachable on Windows, where a process can exit with
	 * a value that the shell surfaces signed. The notice must render it rather
	 * than dropping the sign.
	 */
	it("renders a negative exit code", () => {
		expect(formatExitCodeNotice(-1)).toBe("Command exited with code -1");
	});
});

describe("EXIT_CODE_NOTICE_RE", () => {
	/**
	 * The matcher must accept everything the formatter produces. Generated FROM
	 * the formatter rather than from hand-written strings, so the two cannot
	 * drift apart without this failing: a reworded notice that the regex no
	 * longer matches turns this red immediately.
	 */
	it("matches every notice the formatter produces", () => {
		const notices = [
			formatExitCodeNotice(1),
			formatExitCodeNotice(-1),
			formatExitCodeNotice(137),
			formatExitCodeNotice(137, os.constants.signals.SIGKILL),
			formatExitCodeNotice(143, os.constants.signals.SIGTERM),
			formatExitCodeNotice(130, os.constants.signals.SIGINT),
			formatExitCodeNotice(192, 64),
		];

		for (const notice of notices) {
			expect(EXIT_CODE_NOTICE_RE.test(notice)).toBe(true);
		}
	});

	/**
	 * And it must reject ordinary output, or the renderer would eat a real line
	 * of a command's result. The near-misses are the dangerous ones: a command
	 * that PRINTS something like the notice must not be treated as the notice.
	 */
	it("rejects lines that merely resemble a notice", () => {
		const notMatching = [
			"Command exited with code",
			"Command exited with code abc",
			"  Command exited with code 1",
			"Command exited with code 1 ",
			"echo Command exited with code 1",
			"Command was killed",
			"Command was killed by SIGKILL",
			"Wall time: 1.2 seconds",
			"",
		];

		for (const line of notMatching) {
			expect(EXIT_CODE_NOTICE_RE.test(line)).toBe(false);
		}
	});

	/**
	 * Anchored to a whole line, not to a substring. The renderer applies it to
	 * the last line of the output; an unanchored match would strip a line that
	 * merely ended with the notice text.
	 */
	it("is anchored so a notice embedded in a longer line does not match", () => {
		expect(EXIT_CODE_NOTICE_RE.test("build failed: Command exited with code 1")).toBe(false);
	});
});

describe("the notice wording has one owner", () => {
	/**
	 * The source lock. Six call sites shared this string by copy before, which is
	 * how the renderer's regex ended up describing a wording it did not own. This
	 * fails if a seventh copy appears, which is the only way to keep the
	 * unification from quietly coming undone.
	 *
	 * Scoped to `src`, since tests legitimately assert the literal text.
	 */
	it("spells the notice text in exit-notice.ts and nowhere else in src", () => {
		const root = path.resolve(import.meta.dir, "../../src");
		const offenders: string[] = [];

		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
				if (full.endsWith(path.join("exec", "exit-notice.ts"))) continue;
				const text = fs.readFileSync(full, "utf8");
				if (text.includes("Command exited with code") || text.includes("Command was killed by")) {
					offenders.push(path.relative(root, full));
				}
			}
		};
		walk(root);

		expect(offenders).toEqual([]);
	});
});
