import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { parseInternalUrl, SkillProtocolHandler, validateRelativePath } from "@veyyon/coding-agent/internal-urls";
import { removeWithRetries } from "@veyyon/utils";

async function withSkillDir<T>(fn: (skill: Skill) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-"));
	try {
		await fs.writeFile(path.join(dir, "SKILL.md"), "# Demo skill\n");
		await fs.writeFile(path.join(dir, "config.json"), '{"key": "value"}');
		await fs.writeFile(path.join(dir, "notes.txt"), "plain notes");
		const skill: Skill = {
			name: "demo",
			description: "demo skill",
			filePath: path.join(dir, "SKILL.md"),
			baseDir: dir,
			source: "test",
		};
		return await fn(skill);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("SkillProtocolHandler resolve", () => {
	const handler = new SkillProtocolHandler();

	it("serves SKILL.md as text/markdown for the bare skill URL", async () => {
		await withSkillDir(async skill => {
			const resource = await handler.resolve(parseInternalUrl("skill://demo"), { skills: [skill] });
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.content).toBe("# Demo skill\n");
			expect(resource.sourcePath).toBe(skill.filePath);
		});
	});

	it("serves .json files as application/json, matching local://", async () => {
		await withSkillDir(async skill => {
			const resource = await handler.resolve(parseInternalUrl("skill://demo/config.json"), { skills: [skill] });
			expect(resource.contentType).toBe("application/json");
			expect(resource.content).toBe('{"key": "value"}');
		});
	});

	it("serves unknown extensions as text/plain", async () => {
		await withSkillDir(async skill => {
			const resource = await handler.resolve(parseInternalUrl("skill://demo/notes.txt"), { skills: [skill] });
			expect(resource.contentType).toBe("text/plain");
		});
	});

	it("never serves content above the skill baseDir for dot-segment URLs", async () => {
		// WHATWG URL parsing collapses ../ (even percent-encoded) before resolve
		// runs, so the escape lands inside baseDir and simply does not exist.
		await withSkillDir(async skill => {
			await expect(
				handler.resolve(parseInternalUrl("skill://demo/%2e%2e/escape.md"), { skills: [skill] }),
			).rejects.toThrow(/File not found/);
		});
	});

	it("validateRelativePath rejects absolute paths and traversal", () => {
		expect(() => validateRelativePath("/etc/passwd")).toThrow(/Absolute paths/);
		expect(() => validateRelativePath("../escape.md")).toThrow(/traversal/i);
		expect(() => validateRelativePath("nested/../../escape.md")).toThrow(/traversal/i);
		expect(() => validateRelativePath("nested/ok.md")).not.toThrow();
	});

	it("names the available skills when the skill is unknown", async () => {
		await withSkillDir(async skill => {
			await expect(handler.resolve(parseInternalUrl("skill://nope"), { skills: [skill] })).rejects.toThrow(
				/Unknown skill: nope[\s\S]*Available: demo/,
			);
		});
	});
});
