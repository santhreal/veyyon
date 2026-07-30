import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils/temp";

interface ChildPayload {
	result: { ok: boolean; content: string };
	capturedConsoleErrors: unknown[][];
}

/**
 * Recoverable MuPDF warnings must flow through the centralized logger instead
 * of writing raw stderr that corrupts the TUI. The conversion runs in a
 * source-runtime child because Bun 1.3.14 cannot initialize MuPDF's
 * top-level-await module inside `bun test`.
 */
test("routes recoverable PDF warnings to the configured logger", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-markit-mupdf-"));
	const env: Record<string, string | undefined> = { ...Bun.env, HOME: home };
	delete env.VEYYON_CONFIG_DIR;
	delete env.XDG_CONFIG_HOME;
	try {
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../support/markit-mupdf-warnings-child.ts")],
			{
				env,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		const resultLine = stdout.split("\n").find(line => line.startsWith("__VEYYON_RESULT__"));
		expect(resultLine).toBeDefined();
		const payload = JSON.parse(resultLine?.slice("__VEYYON_RESULT__".length) ?? "") as ChildPayload;
		expect(payload.result.ok).toBe(true);
		expect(payload.result.content).toContain("Tagged PDF repro text");
		expect(payload.capturedConsoleErrors).toEqual([]);
		const logEntries = stdout
			.split("\n")
			.filter(line => line.startsWith("{"))
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(
			logEntries.some(
				entry =>
					entry.level === "debug" &&
					entry.stream === "stderr" &&
					String(entry.message).includes("mupdf wasm output") &&
					String(entry.message).includes("Screen annotations"),
			),
		).toBe(true);
		expect(stderr).toBe("");
	} finally {
		removeSyncWithRetries(home);
	}
});
