/**
 * The write tool reports the filename the filesystem actually stores.
 *
 * WHY THIS SUITE EXISTS. On a case-insensitive filesystem, which is the default
 * on macOS and Windows, writing to `Foo.ts` when the directory entry is
 * `foo.ts` updates `foo.ts` and leaves its spelling alone: the write does not
 * rename the entry. The tool used to echo the requested spelling back, so the
 * operator was told `Successfully wrote N bytes to Foo.ts` for a filename that
 * does not exist, and a follow-up grep or read for `Foo.ts` found nothing. The
 * write was correct; only the report lied, which is the harder kind of bug to
 * chase because everything on disk is fine.
 *
 * The rule is narrow on purpose: the stored spelling is adopted only when it
 * differs from the requested one in CASE ALONE. `realpath` also resolves
 * symlinks, and a symlink is a path the operator asked for by name, so
 * reporting the link target instead would replace one wrong filename with
 * another. That distinction is what the symlink test below pins, and it runs on
 * every platform rather than only on a case-insensitive one.
 *
 * Case-insensitivity cannot be assumed: this project's Linux hosts are
 * case-sensitive ext4, where the whole feature is a no-op. So the suite PROBES
 * the temp filesystem rather than the platform name (a case-sensitive APFS
 * volume exists, and so does a case-insensitive mount on Linux), and when the
 * probe says case-sensitive it says so out loud in the test name rather than
 * quietly passing an assertion that proves nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { resolveStoredPathCase } from "@veyyon/coding-agent/tools/path-utils";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { removeWithRetries } from "@veyyon/utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	} as ToolSession;
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

/**
 * Whether `dir` stores names case-insensitively, decided by asking the
 * filesystem rather than by reading `process.platform`. Case sensitivity is a
 * property of the VOLUME: macOS can be formatted case-sensitive and Linux can
 * mount a case-insensitive filesystem, so the platform name is the wrong signal
 * and would make this suite claim coverage it does not have.
 */
async function isCaseInsensitive(dir: string): Promise<boolean> {
	const probe = path.join(dir, "case-probe-lower");
	await fs.writeFile(probe, "probe", "utf8");
	try {
		await fs.stat(path.join(dir, "CASE-PROBE-LOWER"));
		return true;
	} catch {
		return false;
	} finally {
		await fs.rm(probe, { force: true });
	}
}

describe("resolveStoredPathCase", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stored-case-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("returns the input unchanged for a path that does not exist", async () => {
		// A create has nothing stored yet, so there is no truer name to report.
		// Throwing or returning a resolved parent here would break every new file.
		const missing = path.join(tmpDir, "not-there.ts");
		expect(resolveStoredPathCase(missing)).toBe(missing);
	});

	it("returns the input unchanged when the spelling already matches what is stored", async () => {
		const exact = path.join(tmpDir, "exact.ts");
		await fs.writeFile(exact, "x", "utf8");
		expect(resolveStoredPathCase(exact)).toBe(exact);
	});

	it("does not follow a symlink to its target, on every platform", async () => {
		// realpath resolves symlinks too. Adopting that result would report the
		// target's name for a path the operator asked for by the link's name,
		// which swaps one wrong filename for another. Case-only differences are
		// the entire allowance.
		const target = path.join(tmpDir, "target.ts");
		const link = path.join(tmpDir, "link.ts");
		await fs.writeFile(target, "x", "utf8");
		await fs.symlink(target, link);
		expect(resolveStoredPathCase(link)).toBe(link);
	});

	it("does not rewrite a path whose real location differs by more than case", async () => {
		// A directory symlink resolves the PARENT to a different name. Same rule:
		// only a case-only difference is a spelling of the same request.
		const realDir = path.join(tmpDir, "real-dir");
		const linkDir = path.join(tmpDir, "link-dir");
		await fs.mkdir(realDir);
		await fs.writeFile(path.join(realDir, "file.ts"), "x", "utf8");
		await fs.symlink(realDir, linkDir);
		const viaLink = path.join(linkDir, "file.ts");
		expect(resolveStoredPathCase(viaLink)).toBe(viaLink);
	});
});

describe("write tool filename reporting", () => {
	let tmpDir: string;
	let caseInsensitive = false;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-case-"));
		caseInsensitive = await isCaseInsensitive(tmpDir);
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("reports the requested name when it is the name on disk", async () => {
		// The ordinary path, and the one that must not regress while fixing the
		// case-insensitive one: no rewriting when there is nothing to correct.
		const filePath = path.join(tmpDir, "module.ts");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		await fs.writeFile(filePath, "old\n", "utf8");

		const result = await new WriteTool(session).execute("call-1", { path: filePath, content: "new\n" });
		expect(resultText(result)).toBe(`Successfully wrote 4 bytes to module.ts`);
	});

	it("reports the stored spelling, not the requested one, when they differ only in case", async () => {
		const stored = path.join(tmpDir, "module.ts");
		const requested = path.join(tmpDir, "Module.ts");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		await fs.writeFile(stored, "old\n", "utf8");

		const result = await new WriteTool(session).execute("call-1", { path: requested, content: "new\n" });

		if (!caseInsensitive) {
			// Loudly stated rather than silently passed: on a case-sensitive
			// volume `Module.ts` is a DIFFERENT file, so the correct report names
			// it, and the divergence this row exists for cannot occur here. The
			// assertion still runs, so the case-sensitive behaviour is pinned too.
			expect(resultText(result)).toBe(`Successfully wrote 4 bytes to Module.ts`);
			expect(await fs.readFile(stored, "utf8")).toBe("old\n");
			return;
		}

		// The write landed in the existing entry, and the report names that entry.
		expect(resultText(result)).toBe(`Successfully wrote 4 bytes to module.ts`);
		expect(await fs.readFile(stored, "utf8")).toBe("new\n");
		// And the directory still holds exactly one entry: the write updated the
		// file rather than creating a second one under the other spelling.
		expect((await fs.readdir(tmpDir)).filter(name => name.toLowerCase() === "module.ts")).toEqual(["module.ts"]);
	});
});
