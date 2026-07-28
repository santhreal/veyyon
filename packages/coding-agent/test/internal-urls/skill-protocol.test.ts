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

	/**
	 * A child symlink must not turn an installed skill into an arbitrary-file
	 * reader outside its directory.
	 */
	it("rejects a file symlink that escapes the skill root", async () => {
		await withSkillDir(async skill => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-outside-"));
			try {
				const secret = path.join(outside, "secret.txt");
				await fs.writeFile(secret, "outside");
				await fs.symlink(secret, path.join(skill.baseDir, "escape.txt"));

				await expect(
					handler.resolve(parseInternalUrl("skill://demo/escape.txt"), { skills: [skill] }),
				).rejects.toThrow(/skill:\/\/ URL escapes skill root/);
			} finally {
				await removeWithRetries(outside);
			}
		});
	});

	/**
	 * Directory listings need the same realpath boundary as file reads; otherwise
	 * a symlink exposes every filename in an outside directory.
	 */
	it("rejects a directory symlink that escapes the skill root", async () => {
		await withSkillDir(async skill => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-outside-"));
			try {
				await fs.writeFile(path.join(outside, "secret.txt"), "outside");
				await fs.symlink(outside, path.join(skill.baseDir, "escape-dir"));

				await expect(
					handler.resolve(parseInternalUrl("skill://demo/escape-dir"), { skills: [skill] }),
				).rejects.toThrow(/skill:\/\/ URL escapes skill root/);
			} finally {
				await removeWithRetries(outside);
			}
		});
	});

	/**
	 * A skill directory may itself be a symlink installed by the operator. The
	 * boundary follows that root while still refusing child escapes.
	 */
	it("serves a skill whose declared root is a symlink", async () => {
		await withSkillDir(async skill => {
			const parent = await fs.mkdtemp(path.join(os.tmpdir(), "skill-protocol-link-"));
			const linkedRoot = path.join(parent, "installed-skill");
			try {
				await fs.symlink(skill.baseDir, linkedRoot, "dir");
				const linkedSkill = {
					...skill,
					baseDir: linkedRoot,
					filePath: path.join(linkedRoot, "SKILL.md"),
				};

				const resource = await handler.resolve(parseInternalUrl("skill://demo"), { skills: [linkedSkill] });
				expect(resource.content).toBe("# Demo skill\n");
				expect(resource.sourcePath).toBe(await fs.realpath(skill.filePath));
			} finally {
				await removeWithRetries(parent);
			}
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
