/**
 * WHY: `read` took `skill://report-formats/platforms/bugcrowd.md;.templates/FINDING_TEMPLATE.md`
 * as one path and reported `File not found: …bugcrowd.md;.templates/FINDING_TEMPLATE.md`. The
 * semicolon list is the documented form for `grep` and `glob`, and `read` already fanned a
 * delimited argument out into one read per entry — but only for filesystem paths, because the
 * shared splitter refused every internal URL.
 *
 * Class closed: a semicolon-delimited list of internal resources, under any scheme the router
 * registers, reaches every entry it names, keeps each entry's own selector, and names the entry
 * that missed. The list stays opt-in, so a search scope still treats an internal URL as one
 * target, and a resource whose own name contains a semicolon still resolves. The working-directory
 * boundary measures each entry as well: it used to measure the joint string, which resolves
 * `a.md;/etc/passwd` to one path inside the working directory that no read ever opens.
 *
 * Not caught here: what a schemeless later entry should mean. Each entry is a complete target, so
 * `skill://a/one.md;two.md` reads `two.md` from the cwd and reports the miss; no rule resolves it
 * inside the resource the previous entry named.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "@veyyon/coding-agent/extensibility/skills";
import { InternalUrlRouter, LocalProtocolHandler } from "@veyyon/coding-agent/internal-urls";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { cwdEscapingTargets } from "@veyyon/coding-agent/tools/core/cwd-boundary";
import { splitDelimitedPathEntry } from "@veyyon/coding-agent/tools/core/path-utils";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { removeWithRetries } from "@veyyon/utils";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("a read of a semicolon-delimited list", () => {
	let tmpDir: string;
	let skillDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-list-"));
		skillDir = path.join(tmpDir, "skills", "demo");
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		await fs.mkdir(path.join(skillDir, "platforms"), { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Demo\n");
		await fs.writeFile(
			path.join(skillDir, "platforms", "one.md"),
			"one-first-line\none-second-line\none-third-line\n",
		);
		await fs.writeFile(path.join(skillDir, "platforms", "two.md"), "two-first-line\n");
		await fs.writeFile(path.join(skillDir, "weird;name.md"), "semicolon-in-the-filename\n");
		setActiveSkills([
			{
				name: "demo",
				description: "demo skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
	});

	function session(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		};
	}

	it("reads every internal resource the list names", async () => {
		const result = await new ReadTool(session()).execute("call", {
			path: "skill://demo/platforms/one.md;skill://demo/platforms/two.md",
		});

		const text = resultText(result);
		expect(text).toContain(
			"Note: interpreted as 2 paths: skill://demo/platforms/one.md, skill://demo/platforms/two.md",
		);
		expect(text).toContain("one-first-line");
		expect(text).toContain("two-first-line");
		expect(result.details?.displayReadTargets).toEqual([
			"skill://demo/platforms/one.md",
			"skill://demo/platforms/two.md",
		]);
	});

	it("keeps each entry's own selector", async () => {
		const result = await new ReadTool(session()).execute("call", {
			path: "skill://demo/platforms/one.md:raw:2-2;skill://demo/platforms/two.md:raw:1-1",
		});

		const text = resultText(result);
		expect(text).toContain(
			"Note: interpreted as 2 paths: skill://demo/platforms/one.md:raw:2-2, skill://demo/platforms/two.md:raw:1-1",
		);
		expect(text).toContain("one-second-line");
		expect(text).not.toContain("one-first-line");
		expect(text).toContain("two-first-line");
	});

	it("names the entry that missed instead of resolving it inside the previous resource", async () => {
		const result = await new ReadTool(session()).execute("call", {
			path: "skill://demo/platforms/one.md;.templates/FINDING_TEMPLATE.md",
		});

		const text = resultText(result);
		expect(text).toContain("one-first-line");
		expect(text).toContain("Could not read .templates/FINDING_TEMPLATE.md");
		expect(text).toContain(
			"(every entry in a semicolon-delimited list is a complete target: give this one its own scheme)",
		);
		expect(result.details?.displayReadTargets).toEqual([
			"skill://demo/platforms/one.md",
			".templates/FINDING_TEMPLATE.md",
		]);
	});

	it("reads a resource whose own name contains a semicolon as one target", async () => {
		const result = await new ReadTool(session()).execute("call", { path: "skill://demo/weird;name.md" });

		const text = resultText(result);
		expect(text).toContain("semicolon-in-the-filename");
		expect(text).not.toContain("interpreted as");
		expect(result.details?.displayReadTargets).toBeUndefined();
	});

	it("leaves a comma inside an internal resource name alone", async () => {
		await expect(
			new ReadTool(session()).execute("call", { path: "skill://demo/platforms/one.md,two.md" }),
		).rejects.toThrow(/one\.md,two\.md/);
	});

	it("still fans a list of filesystem paths out without the internal-URL option", async () => {
		await fs.writeFile(path.join(tmpDir, "alpha.md"), "alpha-body\n");
		await fs.writeFile(path.join(tmpDir, "beta.md"), "beta-body\n");

		const text = resultText(await new ReadTool(session()).execute("call", { path: "alpha.md;beta.md" }));

		expect(text).toContain("alpha-body");
		expect(text).toContain("beta-body");
	});

	it("mixes a file and an internal resource in one list, spaced as the description writes it", async () => {
		await fs.writeFile(path.join(tmpDir, "alpha.md"), "alpha-body\n");

		const text = resultText(
			await new ReadTool(session()).execute("call", { path: "alpha.md; skill://demo/platforms/two.md" }),
		);

		expect(text).toContain("Note: interpreted as 2 paths: alpha.md, skill://demo/platforms/two.md");
		expect(text).toContain("alpha-body");
		expect(text).toContain("two-first-line");
	});

	it("splits a list under every scheme the router registers, and only when the caller asks", async () => {
		const schemes = InternalUrlRouter.instance().schemes();
		expect(schemes.length).toBeGreaterThan(0);

		for (const scheme of schemes) {
			const entry = `${scheme}://alpha/one.md;${scheme}://beta/two.md`;
			expect(await splitDelimitedPathEntry(entry, tmpDir, { internalUrls: "split-on-semicolon" })).toEqual([
				`${scheme}://alpha/one.md`,
				`${scheme}://beta/two.md`,
			]);
			// A search scope resolves a base path on disk, so it keeps an internal URL whole.
			// A scheme missing from the internal-URL prefix table fails here, because the
			// entry is then split as though it named two files.
			expect(await splitDelimitedPathEntry(entry, tmpDir)).toBeNull();
		}
	});

	it("measures every entry of a list against the working-directory boundary", () => {
		const tool = new ReadTool(session());

		expect(cwdEscapingTargets(tool, { path: "alpha.md;/etc/passwd" }, tmpDir)).toEqual(["/etc/passwd"]);
		expect(cwdEscapingTargets(tool, { path: "skill://demo/platforms/one.md;/etc/passwd" }, tmpDir)).toEqual([
			"/etc/passwd",
		]);
		expect(cwdEscapingTargets(tool, { path: "skill://demo/platforms/one.md" }, tmpDir)).toEqual([]);
		expect(cwdEscapingTargets(tool, { path: "alpha.md;beta.md" }, tmpDir)).toEqual([]);
	});
});
