import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";

/**
 * `setTransports({ file: false, console: false })` turns logging off: an emit writes no file line,
 * nothing to stdout or stderr, and throws nothing. The logger is a process-wide singleton, so a
 * test file that disabled transports and left a warning or a stray line behind poisoned every later
 * file's output. Re-enabling a transport resumes writing.
 */

let tempDir: string;
let prevAgentDir: string | undefined;

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-logger-no-transports-"));
	prevAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
	process.env.VEYYON_CODING_AGENT_DIR = tempDir;
});

afterAll(() => {
	if (prevAgentDir === undefined) {
		delete process.env.VEYYON_CODING_AGENT_DIR;
	} else {
		process.env.VEYYON_CODING_AGENT_DIR = prevAgentDir;
	}
	// Detach the file transport before deleting tempDir so no live handle points
	// at a removed dir. With the silent fix this is a harmless no-op, not a leak.
	logger.setTransports({ file: false, console: false });
	fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("logger with no transports", () => {
	it("writes nowhere when every transport is disabled", () => {
		// Ensure the sinks exist, then drop all of them at runtime.
		logger.setTransports({ file: tempDir, console: false });
		logger.info("no-transports-warmup");
		logger.setTransports({ file: false, console: false });

		const stdoutSpy = spyOn(process.stdout, "write");
		const stderrSpy = spyOn(process.stderr, "write");
		const errorSpy = spyOn(console, "error");
		let calls: unknown[][] = [];
		try {
			logger.warn("no-transports-disabled-fixture", {
				provider: "unit-oauth-select",
				index: 1,
				error: "Error: invalid_grant",
				isDefinitiveFailure: true,
			});
		} finally {
			calls = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls, ...errorSpy.mock.calls];
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
			errorSpy.mockRestore();
		}

		expect(calls).toEqual([]);
		const written = fs
			.readdirSync(tempDir)
			.filter(n => n.startsWith("veyyon.") && n.endsWith(".log"))
			.map(f => fs.readFileSync(path.join(tempDir, f), "utf8"))
			.join("");
		expect(written).toContain("no-transports-warmup");
		expect(written).not.toContain("no-transports-disabled-fixture");
	});

	it("resumes writing once a transport is re-enabled", () => {
		logger.setTransports({ file: false, console: false });
		logger.setTransports({ file: tempDir, console: false });
		logger.warn("no-transports-resume-fixture");
		// The file sink writes each line synchronously, so the line is on disk when the call returns.
		const written = fs
			.readdirSync(tempDir)
			.filter(n => n.startsWith("veyyon.") && n.endsWith(".log"))
			.map(f => fs.readFileSync(path.join(tempDir, f), "utf8"))
			.join("");
		expect(written).toContain("no-transports-resume-fixture");
	});
});
