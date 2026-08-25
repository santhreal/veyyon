/**
 * A bash command carrying a leading `cd <path> &&` or a relative `cwd` is judged
 * by approval against that effective target directory, not the ambient session cwd.
 *
 * WHY THIS SUITE EXISTS. `execute` extracted a leading `cd <path> &&` out of the
 * command into `cwd` when no explicit `cwd` parameter was supplied and executed
 * the remainder in that directory. However, `bashApprovalDecision` performed no
 * extraction and judged the unmodified command against the session cwd.
 *
 * For a command like `cd /protected && rm -rf *`, approval evaluated `rm -rf *`
 * against the safe session directory and allowed it, while execution ran
 * `rm -rf *` inside `/protected`.
 *
 * Additionally, approval previously only accepted an explicit `cwd` argument if
 * it started with `/`, falling back to `sessionCwd` for relative paths, while
 * execution resolved relative `cwd` arguments against `sessionCwd`.
 *
 * This suite closes the class of approval-versus-execution directory divergence
 * by asserting that both leading `cd` extractions and relative `cwd` arguments
 * resolve to the exact same effective working directory for approval decisions.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Shell-internal directory changes that occur
 * later in a pipeline or script (e.g. `echo foo && cd /bar && rm -rf *` or
 * inside subshells `(cd /bar && rm -rf *)`) are not extracted into the tool's
 * `cwd` parameter by execution, so they remain judged as shell script text.
 */

import { describe, expect, it } from "bun:test";
import { bashApprovalDecision, extractEffectiveBashCommand } from "../src/tools/bash";

describe("a command carrying a leading cd is judged against that directory", () => {
	// A four-level deep working directory inside a safe project tree.
	const SESSION_CWD = "/srv/work/proj/pkg";
	const PROTECTED_DIR = "/protected/data";

	const decide = (
		command: string,
		cwd?: string,
		extraProtectedPaths: readonly string[] = [PROTECTED_DIR],
	): { critical: boolean; tier: string; reason?: string } => {
		const decision = bashApprovalDecision(
			cwd !== undefined ? { command, cwd } : { command },
			extraProtectedPaths,
			SESSION_CWD,
		);
		if (typeof decision === "string") {
			return { critical: false, tier: decision };
		}
		return {
			critical: decision.critical === true,
			tier: decision.tier,
			reason: decision.reason,
		};
	};

	it("refuses a destructive delete when leading cd points to a protected path", () => {
		const result = decide(`cd ${PROTECTED_DIR} && rm -rf *`);
		expect(result.critical).toBe(true);
		expect(result.reason).toContain(PROTECTED_DIR);
	});

	it("refuses a destructive delete when leading cd points to system root", () => {
		const result = decide("cd /etc && rm -rf *");
		expect(result.critical).toBe(true);
		expect(result.reason).toContain("/etc");
	});

	it("refuses when leading cd uses single quotes around target directory", () => {
		const result = decide(`cd '${PROTECTED_DIR}' && rm -rf *`);
		expect(result.critical).toBe(true);
		expect(result.reason).toContain(PROTECTED_DIR);
	});

	it("refuses when leading cd uses double quotes around target directory", () => {
		const result = decide(`cd "${PROTECTED_DIR}" && rm -rf *`);
		expect(result.critical).toBe(true);
		expect(result.reason).toContain(PROTECTED_DIR);
	});

	it("refuses when leading cd contains irregular whitespace and tabs", () => {
		const result = decide(`cd \t  ${PROTECTED_DIR} \t && \t rm -rf *`);
		expect(result.critical).toBe(true);
		expect(result.reason).toContain(PROTECTED_DIR);
	});

	it("refuses when leading cd climbs out of the session directory to system root", () => {
		// SESSION_CWD is /srv/work/proj/pkg (4 levels deep), 4 climbs reach /
		const result = decide("cd ../../../.. && rm -rf *");
		expect(result.critical).toBe(true);
		expect(result.reason).toContain("a protected system directory (/)");
	});

	it("refuses when cwd is supplied as an explicit relative path climbing to system root", () => {
		const result = decide("rm -rf *", "../../../..");
		expect(result.critical).toBe(true);
		expect(result.reason).toContain("a protected system directory (/)");
	});

	it("refuses when cwd is supplied as an explicit relative path reaching a protected path", () => {
		// Session cwd is /srv/work/proj/pkg. Climbing 3 levels reaches /srv, then into /srv/protected
		const result = decide("rm -rf *", "../../../protected", ["/srv/protected"]);
		expect(result.critical).toBe(true);
		expect(result.reason).toContain("/srv/protected");
	});

	it("allows ordinary relative commands inside the safe session directory", () => {
		const result = decide("cd src && rm -rf build");
		expect(result.critical).toBe(false);
		expect(result.tier).toBe("exec");
	});

	it("leaves explicit cwd untouched when leading cd is present", () => {
		// Explicit cwd points to a safe subdirectory, but command has leading cd to safe dir
		const result = decide("cd src && rm -rf build", "/srv/work/proj/pkg/subdir");
		expect(result.critical).toBe(false);
		expect(result.tier).toBe("exec");
	});

	it("does not extract leading cd when the path contains shell variables ($VAR)", () => {
		const extracted = extractEffectiveBashCommand("cd $TARGET && rm -rf *");
		expect(extracted.cwd).toBeUndefined();
		expect(extracted.command).toBe("cd $TARGET && rm -rf *");
	});

	it("does not extract leading cd when the path contains command substitutions $(...)", () => {
		const extracted = extractEffectiveBashCommand("cd $(dirname foo) && rm -rf *");
		expect(extracted.cwd).toBeUndefined();
		expect(extracted.command).toBe("cd $(dirname foo) && rm -rf *");
	});

	it("does not extract leading cd when the path contains backticks", () => {
		const extracted = extractEffectiveBashCommand("cd `pwd` && rm -rf *");
		expect(extracted.cwd).toBeUndefined();
		expect(extracted.command).toBe("cd `pwd` && rm -rf *");
	});

	it("does not extract cd across multiple lines when && is on a subsequent line", () => {
		const multiline = "cd /tmp\necho start && rm -rf *";
		const extracted = extractEffectiveBashCommand(multiline);
		expect(extracted.cwd).toBeUndefined();
		expect(extracted.command).toBe(multiline);
	});
	it("preserves identical approval tier and critical floor for commands with no leading cd and no cwd", () => {
		// Safe ordinary commands stay allowed
		expect(decide("ls -la").tier).toBe("exec");
		expect(decide("ls -la").critical).toBe(false);
		expect(decide("bun test").tier).toBe("exec");
		expect(decide("bun test").critical).toBe(false);
		expect(decide("rm -rf build").tier).toBe("exec");
		expect(decide("rm -rf build").critical).toBe(false);

		// Dangerous / destructive commands still trigger critical floor with identical reasons
		const rootDelete = decide("rm -rf /");
		expect(rootDelete.critical).toBe(true);
		expect(rootDelete.reason).toBe("rm would recursively remove a protected system directory (/)");
	});
});
