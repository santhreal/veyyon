import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import CommitCommand from "@veyyon/coding-agent/commands/commit";
import * as commitModule from "@veyyon/coding-agent/commit";
import * as themeModule from "@veyyon/coding-agent/modes/theme/theme";
import { getProjectDir, postmortem, setProjectDir } from "@veyyon/utils";

describe("veyyon commit command lifecycle (issue #1041)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forces process exit after the commit pipeline resolves", async () => {
		const initThemeSpy = vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		const runCommitSpy = vi.spyOn(commitModule, "runCommitCommand").mockResolvedValue(undefined);
		// Stub postmortem.quit so it records the exit code without actually
		// terminating the test runner. Resolves immediately — the production
		// implementation never returns, but the contract under test is that
		// the call happens at all.
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "veyyon",
			version: "0.0.0-test",
			commands: new Map(),
		});

		await command.run();

		expect(initThemeSpy).toHaveBeenCalledTimes(1);
		expect(runCommitSpy).toHaveBeenCalledTimes(1);
		// Quit must come after the pipeline so we cannot regress the order.
		expect(runCommitSpy.mock.invocationCallOrder[0]).toBeLessThan(quitSpy.mock.invocationCallOrder[0]);
		expect(quitSpy).toHaveBeenCalledWith(0);
	});

	it("passes a failure exitCode set by the pipeline through to quit", async () => {
		vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		const originalExitCode = process.exitCode;
		vi.spyOn(commitModule, "runCommitCommand").mockImplementation(async () => {
			// e.g. the "not inside a git repository" fail-fast guard.
			process.exitCode = 1;
		});
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "veyyon",
			version: "0.0.0-test",
			commands: new Map(),
		});

		try {
			await command.run();
			expect(quitSpy).toHaveBeenCalledWith(1);
		} finally {
			process.exitCode = originalExitCode;
		}
	});

	it("does not convert commit pipeline failures into exit 0", async () => {
		const initThemeSpy = vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		const runCommitSpy = vi
			.spyOn(commitModule, "runCommitCommand")
			.mockRejectedValue(new Error("commit was not created"));
		const quitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const command = new CommitCommand([], {
			bin: "veyyon",
			version: "0.0.0-test",
			commands: new Map(),
		});

		await expect(command.run()).rejects.toThrow("commit was not created");

		expect(initThemeSpy).toHaveBeenCalledTimes(1);
		expect(runCommitSpy).toHaveBeenCalledTimes(1);
		expect(quitSpy).not.toHaveBeenCalled();
	});
});

describe("veyyon commit outside a git repository", () => {
	it("fails fast with a clean error and exit code 1, not a raw GitCommandError", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-commit-no-repo-"));
		const originalProjectDir = getProjectDir();
		const originalExitCode = process.exitCode;
		const stderrChunks: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderrChunks.push(String(chunk));
			return true;
		});
		try {
			setProjectDir(tempDir);
			await commitModule.runCommitCommand({ push: false, dryRun: true, noChangelog: true });
			const stderr = stderrChunks.join("");
			expect(stderr).toContain("is not inside a git repository");
			expect(stderr).not.toContain("GitCommandError");
			expect(process.exitCode).toBe(1);
		} finally {
			stderrSpy.mockRestore();
			setProjectDir(originalProjectDir);
			process.exitCode = originalExitCode;
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
