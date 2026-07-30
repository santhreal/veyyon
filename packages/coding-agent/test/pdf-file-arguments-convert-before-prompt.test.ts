import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils/temp";

interface ChildResult {
	images: unknown[];
	text: string;
}

/**
 * PDF arguments must reach the prompt as extracted text, never as binary bytes
 * or a degraded conversion error. The conversion runs in a source-runtime child
 * because Bun 1.3.14 cannot initialize MuPDF's top-level-await module inside
 * `bun test`; the shipped CLI runtime can and does.
 */
test("converts PDF file arguments before adding them to the prompt", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-pdf-file-args-"));
	const env: Record<string, string | undefined> = { ...Bun.env, HOME: home };
	delete env.VEYYON_CONFIG_DIR;
	delete env.XDG_CONFIG_HOME;
	try {
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "support/pdf-file-arguments-convert-child.ts")],
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
		expect(stderr).toBe("");
		const result = JSON.parse(stdout) as ChildResult;
		expect(result.images).toEqual([]);
		expect(result.text).toContain("Hello PDF from issue 1401");
		expect(result.text).not.toContain("%PDF-1.4");
		expect(result.text).not.toContain("stream");
	} finally {
		removeSyncWithRetries(home);
	}
});
