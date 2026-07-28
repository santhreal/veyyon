import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { InternalUrlRouter, type ResolveContext, resolveLocalUrlToPath } from "@veyyon/coding-agent/internal-urls";
import { expandInternalUrls } from "@veyyon/coding-agent/tools/bash-skill-urls";
import { removeWithRetries } from "@veyyon/utils";

function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

function createSkill(name: string, baseDir: string): Skill {
	const resolvedBaseDir = path.resolve(baseDir);
	return {
		name,
		description: `${name} description`,
		filePath: path.join(resolvedBaseDir, "SKILL.md"),
		baseDir: resolvedBaseDir,
		source: "test",
	};
}

function createInternalRouter(resources: Record<string, { sourcePath?: string; error?: string }>): {
	canHandle: (input: string) => boolean;
	resolve: (
		input: string,
		context?: ResolveContext,
	) => Promise<{ url: string; content: string; contentType: "text/plain"; sourcePath?: string; immutable: boolean }>;
} {
	return {
		canHandle: input => /^(agent|artifact|plan|memory|rule):\/\//.test(input),
		resolve: async input => {
			const entry = resources[input];
			if (!entry) {
				throw new Error(`No mapping for ${input}`);
			}
			if (entry.error) {
				throw new Error(entry.error);
			}
			return {
				url: input,
				content: "",
				contentType: "text/plain",
				sourcePath: entry.sourcePath,
				immutable: true,
			};
		},
	};
}

interface SkillFixture {
	root: string;
	skills: Skill[];
	paths: {
		script: string;
		spaced: string;
		namespaced: string;
		quoted: string;
	};
}

async function createSkillFixture(): Promise<SkillFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-fixture-"));
	const brainstormDir = path.join(root, "brain storm");
	const namespacedDir = path.join(root, "plugin-review");
	const quotedDir = path.join(root, "with'quote");
	const paths = {
		script: path.join(brainstormDir, "scripts", "init.py"),
		spaced: path.join(brainstormDir, "a b.md"),
		namespaced: path.join(namespacedDir, "README.md"),
		quoted: path.join(quotedDir, "scripts", "init.py"),
	};
	const files = [
		path.join(brainstormDir, "SKILL.md"),
		path.join(namespacedDir, "SKILL.md"),
		path.join(quotedDir, "SKILL.md"),
		...Object.values(paths),
	];
	await Promise.all(
		files.map(async file => {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, `fixture: ${path.basename(file)}\n`);
		}),
	);
	return {
		root,
		skills: [
			createSkill("brainstorm", brainstormDir),
			createSkill("plugin:review", namespacedDir),
			createSkill("quote-skill", quotedDir),
		],
		paths,
	};
}

describe("expandInternalUrls", () => {
	it("expands agent/artifact/memory/rule URLs in one command", async () => {
		const router = createInternalRouter({
			"artifact://12": { sourcePath: "/tmp/artifacts/12.bash.log" },
			"agent://reviewer_0": { sourcePath: "/tmp/session/reviewer_0.md" },
			"memory://root/memory_summary.md": { sourcePath: "/tmp/memories/memory_summary.md" },
			"rule://rs-no-unwrap": { sourcePath: "/tmp/rules/rs-no-unwrap.md" },
		});
		const command = "cat agent://reviewer_0 artifact://12 memory://root/memory_summary.md rule://rs-no-unwrap";

		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/session/reviewer_0.md")} ${shellEscape("/tmp/artifacts/12.bash.log")} ${shellEscape("/tmp/memories/memory_summary.md")} ${shellEscape("/tmp/rules/rs-no-unwrap.md")}`,
		);
	});

	/**
	 * The async expansion surface is the sole skill:// path resolver. Exercise
	 * quoting, percent-decoding, namespaced hosts, multiple URLs, and the bare
	 * directory form against files the canonical protocol can realpath.
	 */
	it("expands real skill resources through the default canonical router", async () => {
		const fixture = await createSkillFixture();
		try {
			const command =
				'python skill://brainstorm/scripts/init.py "skill://brainstorm/a%20b.md" skill://plugin:review/README.md skill://quote-skill/scripts/init.py skill://brainstorm';
			const expanded = await expandInternalUrls(command, { skills: fixture.skills });

			expect(expanded).toBe(
				`python ${shellEscape(fixture.paths.script)} ${shellEscape(fixture.paths.spaced)} ${shellEscape(fixture.paths.namespaced)} ${shellEscape(fixture.paths.quoted)} ${shellEscape(path.dirname(path.dirname(fixture.paths.script)))}`,
			);
		} finally {
			await removeWithRetries(fixture.root);
		}
	});

	/**
	 * Unknown hosts, encoded traversal, and the removed `:line-range` ambiguity
	 * must fail closed. In bash expansion that means preserving the literal token,
	 * never inventing a lexical filesystem path.
	 */
	it("leaves invalid and ambiguous skill URLs unexpanded", async () => {
		const fixture = await createSkillFixture();
		try {
			const command =
				"cat skill://missing/file.txt skill://brainstorm/..%2f..%2fetc/passwd skill://plugin:review:1-5";
			await expect(expandInternalUrls(command, { skills: fixture.skills })).resolves.toBe(command);
		} finally {
			await removeWithRetries(fixture.root);
		}
	});

	/**
	 * `read skill://...` enforces the skill root after following symlinks. Bash
	 * expansion must use that same resolver rather than expose the lexical child
	 * path and let the shell follow it outside the root.
	 */
	it("does not expand a child symlink that escapes the skill root", async () => {
		const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-root-"));
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-outside-"));
		try {
			await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Demo\n");
			const secretPath = path.join(outsideRoot, "secret.txt");
			await fs.writeFile(secretPath, "outside secret");
			await fs.symlink(secretPath, path.join(skillRoot, "escape.txt"));
			const command = "cat skill://demo/escape.txt";

			const expanded = await expandInternalUrls(command, {
				skills: [createSkill("demo", skillRoot)],
				internalRouter: InternalUrlRouter.instance(),
			});

			expect(expanded).toBe(command);
			expect(expanded).not.toContain(secretPath);
		} finally {
			await Promise.all([removeWithRetries(skillRoot), removeWithRetries(outsideRoot)]);
		}
	});

	it("passes caller cwd to the router when expanding memory URLs", async () => {
		const cwd = "/tmp/session-b";
		const sourcePath = "/tmp/session-b-memory/memory_summary.md";
		let observedCwd: string | undefined;
		let observedPathOnly: boolean | undefined;
		const router = {
			canHandle: (input: string) => input === "memory://root/memory_summary.md",
			resolve: async (input: string, context?: ResolveContext) => {
				observedCwd = context?.cwd;
				observedPathOnly = context?.pathOnly;
				return {
					url: input,
					content: "",
					contentType: "text/plain" as const,
					sourcePath,
					immutable: true,
				};
			},
		};

		await expect(
			expandInternalUrls("cat memory://root/memory_summary.md", { skills: [], internalRouter: router, cwd }),
		).resolves.toBe(`cat ${shellEscape(sourcePath)}`);
		expect(observedCwd).toBe(cwd);
		expect(observedPathOnly).toBe(true);
	});

	it("expands quoted non-skill URLs and shell-escapes quotes in paths", async () => {
		const router = createInternalRouter({
			"artifact://7": { sourcePath: "/tmp/artifacts/with'quote.log" },
		});
		await expect(expandInternalUrls('cat "artifact://7"', { skills: [], internalRouter: router })).resolves.toBe(
			`cat ${shellEscape("/tmp/artifacts/with'quote.log")}`,
		);
	});

	it("leaves literal internal URLs embedded in quoted text unchanged", async () => {
		const router = createInternalRouter({
			"memory://root/summary.md": { sourcePath: "/tmp/memories/summary.md" },
		});
		const command = `printf '%s\\n' 'the literal memory://root/summary.md string'`;

		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("leaves unresolved quoted literal URLs unchanged", async () => {
		const router = createInternalRouter({});
		const command = "grep 'memory://xyz-quoted' file.txt";

		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("expands agent:// URLs when router is available", async () => {
		const router = createInternalRouter({
			"agent://abc": { sourcePath: "/tmp/session/abc.md" },
		});
		await expect(expandInternalUrls("echo agent://abc", { skills: [], internalRouter: router })).resolves.toBe(
			`echo ${shellEscape("/tmp/session/abc.md")}`,
		);
	});

	it("expands local:// URLs to filesystem paths without requiring preexisting files", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "mv /tmp/source.json local://handoffs/new-file.json";
		const expectedPath = resolveLocalUrlToPath("local://handoffs/new-file.json", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`mv /tmp/source.json ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in double quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = 'cat "local:/PLAN.md"';
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL in single quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat 'local:/PLAN.md'";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("expands local:/ (single-slash) URL without quotes", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local:///PLAN.md", localOptions);

		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("leaves local:// URLs unchanged without local protocol options", async () => {
		const command = "mv foo local://bar";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("leaves non-skill URLs unchanged without an internal router", async () => {
		const command = "cat artifact://1";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("leaves internal URLs unchanged when they resolve without sourcePath", async () => {
		const router = createInternalRouter({
			"rule://my-rule": {},
		});
		const command = "cat rule://my-rule";
		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("leaves internal URLs unchanged when the resolver fails", async () => {
		const router = createInternalRouter({
			"memory://root/missing.md": { error: "Memory file not found" },
		});
		const command = "cat memory://root/missing.md";
		await expect(expandInternalUrls(command, { skills: [], internalRouter: router })).resolves.toBe(command);
	});

	it("does not match local:/ inside filesystem paths (e.g. /repo/local:/PLAN.md)", async () => {
		const command = "cat /repo/local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("does not match local:/ after ./ or ../ prefixes", async () => {
		const command = "cat ./local:/PLAN.md ../local:/other.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);
	});

	it("still matches standalone local:/ at a real token boundary", async () => {
		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		const command = "cat local:/PLAN.md";
		const expectedPath = resolveLocalUrlToPath("local://PLAN.md", localOptions);
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(
			`cat ${shellEscape(expectedPath)}`,
		);
	});

	it("does not match local:/ when embedded in words (e.g., notlocal:/, mylocal:/)", async () => {
		const command1 = "cat notlocal:/PLAN.md";
		await expect(expandInternalUrls(command1, { skills: [] })).resolves.toBe(command1);

		const command2 = "cat mylocal:/data.json";
		await expect(expandInternalUrls(command2, { skills: [] })).resolves.toBe(command2);

		const command3 = "cat getlocal:/file.txt";
		await expect(expandInternalUrls(command3, { skills: [] })).resolves.toBe(command3);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command1, { skills: [], localOptions })).resolves.toBe(command1);
	});

	it("does not match local:/ after a hyphen (e.g. not-local:/PLAN.md)", async () => {
		const command = "cat not-local:/PLAN.md";
		await expect(expandInternalUrls(command, { skills: [] })).resolves.toBe(command);

		const localOptions = {
			getArtifactsDir: () => "/tmp/session-artifacts",
			getSessionId: () => "session-1",
		};
		await expect(expandInternalUrls(command, { skills: [], localOptions })).resolves.toBe(command);
	});
});
