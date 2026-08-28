import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { applySessionWorkdir, applyStartupCwd } from "@veyyon/coding-agent/cli/startup-cwd";
import { directoryExists, getProjectDir, normalizePathForComparison, setProjectDir, TempDir } from "@veyyon/utils";

// WHY THIS SUITE EXISTS
// ---------------------
// Launching veyyon from EXACTLY $HOME (no --cwd, no --allow-home) relocates the
// session to a scratch dir (~/tmp -> /tmp -> /var/tmp) so a project-relative scan
// does not walk the whole home tree. The relocation itself is the contract this
// suite pins: it fires from home, never from a real project directory, and never
// when opted out, and session.workdir still outranks it.
//
// The defect this suite now locks out is the opposite of the one it was written
// for. The relocation used to print a three-line stderr notice on every launch
// from home. Those rows are scrolled into the terminal before the composer paints,
// so the composer starts life pushed down the screen and reflows once the frame
// lands — a visible cost on the interactive startup path, paid by every launch,
// to state something /cwd and the status line already show. Nothing on the startup
// cwd path writes bytes any more, on any branch.
//
// WHAT IT DOES NOT CATCH: another module writing to the streams during startup.
// The assertion is scoped to the two cwd functions.

/** Minimal Settings stand-in for applySessionWorkdir: only get()+reloadForCwd() are used. */
function workdirSettings(workdir: string | undefined) {
	return {
		get: (key: string) => (key === "session.workdir" ? workdir : undefined),
		reloadForCwd: async () => {},
	} as unknown as Parameters<typeof applySessionWorkdir>[0];
}

const originalProjectDir = getProjectDir();
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const tempDirs: TempDir[] = [];
let written: string[] = [];

function captureOutput(): void {
	written = [];
	const capture = ((chunk: string | Uint8Array): boolean => {
		written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	process.stderr.write = capture;
	process.stdout.write = capture;
}

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

beforeEach(captureOutput);

afterEach(async () => {
	process.stderr.write = originalStderrWrite;
	process.stdout.write = originalStdoutWrite;
	setProjectDir(originalProjectDir);
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("startup cwd resolution", () => {
	it("relocates away from $HOME, and writes nothing while doing it", async () => {
		const home = os.homedir();
		if (!home) return; // no home on this platform: the guard is a no-op, nothing to prove.
		setProjectDir(home);

		await applyStartupCwd(parseArgs(["hello"]));

		const landed = getProjectDir();
		expect(normalizePathForComparison(landed)).not.toBe(normalizePathForComparison(home));
		expect(await directoryExists(landed)).toBe(true);
		expect(written.join("")).toBe("");
	});

	it("writes nothing when the relocation is the session's final root", async () => {
		const home = os.homedir();
		if (!home) return;
		setProjectDir(home);

		// The full main.ts sequence: relocate, then let session.workdir have its say.
		// An unset workdir leaves the scratch directory as the root, which is the
		// state the removed notice used to describe.
		await applyStartupCwd(parseArgs(["hello"]));
		const workdirApplied = await applySessionWorkdir(workdirSettings(undefined), undefined);

		expect(workdirApplied).toBe(false);
		expect(normalizePathForComparison(getProjectDir())).not.toBe(normalizePathForComparison(home));
		expect(written.join("")).toBe("");
	});

	it("lets session.workdir re-root the session after the relocation", async () => {
		const home = os.homedir();
		if (!home) return;
		const workdir = makeTempDir("@pi-autochdir-workdir-");
		setProjectDir(home);

		await applyStartupCwd(parseArgs(["hello"]));
		const workdirApplied = await applySessionWorkdir(workdirSettings(workdir), undefined);

		expect(workdirApplied).toBe(true);
		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(workdir));
		expect(written.join("")).toBe("");
	});

	it("stays in $HOME when --allow-home is passed", async () => {
		const home = os.homedir();
		if (!home) return;
		setProjectDir(home);

		await applyStartupCwd(parseArgs(["--allow-home", "hello"]));

		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(home));
		expect(written.join("")).toBe("");
	});

	it("uses explicit --cwd and never auto-chdirs, even from home", async () => {
		const home = os.homedir();
		if (!home) return;
		const cliDir = makeTempDir("@pi-autochdir-cli-");
		setProjectDir(home);

		const parsed = parseArgs(["--cwd", cliDir, "hello"]);
		await applyStartupCwd(parsed);

		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(cliDir));
		expect(normalizePathForComparison(parsed.cwd ?? "")).toBe(normalizePathForComparison(cliDir));
		expect(written.join("")).toBe("");
	});

	it("does not trigger when launched from a real project directory", async () => {
		const projectDir = makeTempDir("@pi-autochdir-project-");
		setProjectDir(projectDir);

		await applyStartupCwd(parseArgs(["hello"]));

		expect(normalizePathForComparison(getProjectDir())).toBe(normalizePathForComparison(projectDir));
		expect(written.join("")).toBe("");
	});
});
