import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { applyStartupCwd } from "@veyyon/coding-agent/cli/startup-cwd";
import { directoryExists, getProjectDir, normalizePathForComparison, setProjectDir, TempDir } from "@veyyon/utils";

// WHY THIS SUITE EXISTS
// ---------------------
// Launching veyyon from EXACTLY $HOME (no --cwd, no --allow-home) relocates the
// session to a scratch dir (~/tmp -> /tmp -> /var/tmp) so a project-relative scan
// does not walk the whole home tree. The bug this suite locks out (BACKLOG GRAN-10)
// is that the relocation used to be SILENT: a user who launched "in their project"
// (home) landed in /tmp with no explanation, which made --cwd / /cwd / session.workdir
// all feel broken ("nothing I set changes where I am"). Proven at runtime 2026-07-21:
// `veyyon -p` from $HOME with session.workdir unset ran bash in /tmp. The contract now
// is Law 10 compliant: the relocation is LOUD (announced on stderr, naming the target
// and the overrides) and observable (applyStartupCwd returns the relocation target),
// and it only fires from home, never from a real project dir or when opted out.

const originalProjectDir = getProjectDir();
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const tempDirs: TempDir[] = [];
let stderrChunks: string[] = [];

function captureStderr(): void {
	stderrChunks = [];
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
}

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

beforeEach(captureStderr);

afterEach(async () => {
	process.stderr.write = originalStderrWrite;
	setProjectDir(originalProjectDir);
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("applyStartupCwd home-directory auto-chdir is loud, not silent (GRAN-10)", () => {
	it("relocates away from $HOME and announces the real target plus the overrides", async () => {
		const home = os.homedir();
		if (!home) return; // no home on this platform: the guard is a no-op, nothing to prove.
		setProjectDir(home);

		const parsed = parseArgs(["hello"]);
		const relocated = await applyStartupCwd(parsed);

		// It moved somewhere real, and that somewhere is NOT home.
		expect(relocated).toBeDefined();
		if (!relocated) throw new Error("expected a relocation target");
		expect(normalizePathForComparison(relocated)).not.toBe(normalizePathForComparison(home));
		expect(await directoryExists(relocated)).toBe(true);
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(relocated));

		// The move is surfaced to the operator: one notice that names the real
		// target directory and every way to opt out or choose a directory. A
		// silent relocation would leave stderr empty (the regression this guards).
		const notice = stderrChunks.join("");
		expect(notice.length).toBeGreaterThan(0);
		expect(notice).toContain(relocated);
		expect(notice).toContain("--cwd");
		expect(notice).toContain("--allow-home");
		expect(notice).toContain("session.workdir");
	});

	it("stays in $HOME and says nothing when --allow-home is passed", async () => {
		const home = os.homedir();
		if (!home) return;
		setProjectDir(home);

		const parsed = parseArgs(["--allow-home", "hello"]);
		const relocated = await applyStartupCwd(parsed);

		expect(relocated).toBeUndefined();
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(home));
		expect(stderrChunks.join("")).toBe("");
	});

	it("uses explicit --cwd and never auto-chdirs (no relocation, no notice) even from home", async () => {
		const home = os.homedir();
		if (!home) return;
		const cliDir = makeTempDir("@pi-autochdir-cli-");
		setProjectDir(home);

		const parsed = parseArgs(["--cwd", cliDir, "hello"]);
		const relocated = await applyStartupCwd(parsed);

		expect(relocated).toBeUndefined();
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(cliDir));
		expect(stderrChunks.join("")).toBe("");
	});

	it("does not trigger when launched from a real project directory (not home)", async () => {
		const projectDir = makeTempDir("@pi-autochdir-project-");
		setProjectDir(projectDir);

		const parsed = parseArgs(["hello"]);
		const relocated = await applyStartupCwd(parsed);

		expect(relocated).toBeUndefined();
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(projectDir));
		expect(stderrChunks.join("")).toBe("");
	});
});
