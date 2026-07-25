import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getAgentDir } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

// Piped/redirected stdout must degrade to plain text: the theme renderer
// emits truecolor SGR escapes unconditionally, so commands that print themed
// components (`gallery`, `search`) strip ANSI when chalk detects a non-color
// stdout (pipe, NO_COLOR). `veyyon gallery | grep …` used to be escape soup.

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-plain-pipe-test-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-plain-pipe-proj-"));
const hermetic = hermeticSpawnEnv({ VEYYON_NO_TITLE: "1", VEYYON_CODING_AGENT_DIR: agentDir });
// The gallery test proves a PIPE alone strips color — NO_COLOR must stay unset there.
const envWithoutNoColor = { ...hermetic.env };
delete envWithoutNoColor.NO_COLOR;

afterAll(() => {
	hermetic.cleanup();
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("themed command output on a pipe (e2e)", () => {
	it("`veyyon gallery` piped emits zero ANSI escapes but keeps the section content", async () => {
		const proc = Bun.spawn([process.execPath, cliEntry, "gallery", "--tool", "apply_patch"], {
			cwd: projectDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: envWithoutNoColor,
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("apply_patch");
		expect(stdout).not.toContain("\u001b[");
	}, 60_000);
});

describe("`veyyon search` without a query (e2e)", () => {
	it("exits 1 with usage naming the command", async () => {
		const proc = Bun.spawn([process.execPath, cliEntry, "search"], {
			cwd: projectDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: hermetic.env,
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr as ReadableStream).text(), proc.exited]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Query is required");
		expect(stderr).toContain("veyyon search <query>");
	}, 60_000);
});

describe("`veyyon search` output on a pipe (unit)", () => {
	// Unlike the e2e cases above, this one runs the command IN THIS PROCESS, so
	// the hermetic env handed to a spawned child does nothing for it.
	// `runSearchCommand` loads Settings, which opens the agent storage database
	// under the CONFIG root, and without moving that root the test wrote into the
	// developer's real `~/.veyyon`. That is what the real-data tripwire caught
	// when this case started failing on main; before the tripwire it passed while
	// mutating real data. VEYYON_CONFIG_DIR resolves relative to os.homedir(),
	// which Bun fixes at process start, so assigning HOME here would do nothing.
	let configRoot = "";
	let originalConfigDirEnv: string | undefined;

	beforeAll(() => {
		configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-plain-pipe-config-"));
		originalConfigDirEnv = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), configRoot);
		__resetDirsFromEnvForTests();
	});

	afterAll(() => {
		if (originalConfigDirEnv === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = originalConfigDirEnv;
		__resetDirsFromEnvForTests();
		fs.rmSync(configRoot, { recursive: true, force: true });
	});

	/** Isolation is asserted, not assumed: it only proves the path it names. */
	it("resolves the agent directory inside the temp config root, not the real one", () => {
		expect(getAgentDir().startsWith(configRoot)).toBe(true);
		expect(getAgentDir()).not.toContain(path.join(os.homedir(), ".veyyon"));
	});

	it("strips theme escapes from the rendered panel when chalk detects no color support", async () => {
		const searchIndex = await import("@veyyon/coding-agent/web/search/index");
		const { runSearchCommand } = await import("@veyyon/coding-agent/cli/web-search-cli");
		const { spyOn } = await import("bun:test");
		const chalk = (await import("chalk")).default;
		// Piped stdio normally leaves chalk.level at 0, but a full-suite run can
		// inherit level 3 from an earlier test that forced color — pin it so the
		// strip branch (which keys off this) is exercised regardless of ordering.
		const previousLevel = chalk.level;
		chalk.level = 0;
		spyOn(searchIndex, "runSearchQuery").mockResolvedValue({
			content: [{ type: "text", text: "plain search answer body" }],
		} as never);
		const writes: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(String(chunk));
			return true;
		});
		try {
			await runSearchCommand({ query: "anything", expanded: true });
		} finally {
			stdoutSpy.mockRestore();
			chalk.level = previousLevel;
		}
		const out = writes.join("");
		expect(out).toContain("plain search answer body");
		expect(out).not.toContain("\u001b[");
	});
});
