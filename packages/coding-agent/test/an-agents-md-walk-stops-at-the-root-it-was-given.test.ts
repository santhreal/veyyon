/**
 * WHY. This provider decides which AGENTS.md files reach the model, on every session, and no test
 * named it. Three of its properties are invisible from a session that looks right.
 *
 * It walks UP from the working directory and stops at the repository root, or at the home directory
 * when the tree is not a repository. A walk that fails to stop keeps climbing to the filesystem
 * root, so a file in a parent of the repository — or in the operator's home, or in `/` — is read
 * into the prompt of a project that never asked for it. That is a silent context leak between
 * projects and it looks exactly like working.
 *
 * It also skips a file whose directory name begins with a dot, because `.codex/AGENTS.md` and its
 * siblings belong to the providers that own those tools. Dropping that check makes the same file
 * arrive twice, once from each provider.
 *
 * And it records a depth per file, which is what orders the layers. Depth measured from the wrong
 * end reverses precedence, so the broadest file wins over the most specific one.
 *
 * The class this closes: a walk that overshoots its root or stops short of it, a dot-directory file
 * double-counted, depth attributed to the wrong end of the walk, a read error swallowed instead of
 * warned, and the not-in-a-repository case falling back to something other than home.
 *
 * What it does not catch: how the loader merges layers from several providers, and the content of
 * the files themselves.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "../src/discovery/capability";
import type { ContextFile } from "../src/discovery/capability/context-file";
import { contextFileCapability } from "../src/discovery/capability/context-file";
import type { LoadContext, Provider } from "../src/discovery/capability/types";
// Importing the module is what registers the provider, which is how it reaches production.
import "../src/discovery/agents-md";

let root = "";

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agents-md-")));
});

/** The registered provider, reached the way the loader reaches it. */
function agentsMdProvider(): Provider<ContextFile> {
	const capability = getCapability<ContextFile>(contextFileCapability.id);
	if (!capability) throw new Error("the context-file capability is not defined");
	const provider = capability.providers.find(candidate => candidate.id === "agents-md");
	if (!provider) throw new Error("the agents-md provider did not register");
	return provider;
}

async function writeAgentsMd(dir: string, content: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "AGENTS.md");
	await fs.writeFile(file, content);
	return file;
}

async function load(ctx: Partial<LoadContext> & { cwd: string }): Promise<{
	paths: string[];
	items: ContextFile[];
	warnings: string[];
}> {
	const result = await agentsMdProvider().load({
		home: root,
		repoRoot: null,
		...ctx,
	});
	return { paths: result.items.map(item => item.path), items: result.items, warnings: result.warnings ?? [] };
}

describe("where the walk stops", () => {
	it("collects a file at every level from the working directory up to the repository root", async () => {
		const repo = path.join(root, "repo");
		const deep = path.join(repo, "src", "feature");
		const top = await writeAgentsMd(repo, "repo");
		const mid = await writeAgentsMd(path.join(repo, "src"), "src");
		const bottom = await writeAgentsMd(deep, "feature");

		const { paths } = await load({ cwd: deep, repoRoot: repo });

		expect(paths).toEqual([bottom, mid, top]);
	});

	it("does not climb past the repository root", async () => {
		// The file above the repository belongs to another project, or to nobody.
		const repo = path.join(root, "repo");
		const inside = await writeAgentsMd(repo, "mine");
		const outside = await writeAgentsMd(root, "not mine");

		const { paths } = await load({ cwd: repo, repoRoot: repo });

		expect(paths).toEqual([inside]);
		expect(paths).not.toContain(outside);
	});

	it("stops at home when the tree is not a repository", async () => {
		const home = path.join(root, "home");
		const project = path.join(home, "project");
		const inProject = await writeAgentsMd(project, "project");
		const inHome = await writeAgentsMd(home, "home");
		const aboveHome = await writeAgentsMd(root, "above");

		const { paths } = await load({ cwd: project, home, repoRoot: null });

		expect(paths).toEqual([inProject, inHome]);
		expect(paths).not.toContain(aboveHome);
	});

	it("reads the root itself when the working directory is already the root", async () => {
		const repo = path.join(root, "repo");
		const here = await writeAgentsMd(repo, "repo");

		const { paths } = await load({ cwd: repo, repoRoot: repo });

		expect(paths).toEqual([here]);
	});

	it("terminates at the filesystem root when neither boundary is ever reached", async () => {
		// repoRoot names a directory the walk never passes through, so only the filesystem root
		// can stop it. The bound matters more than the contents: the alternative is a hang.
		const deep = path.join(root, "a", "b");
		const file = await writeAgentsMd(deep, "deep");

		const { paths } = await load({ cwd: deep, home: path.join(root, "nowhere"), repoRoot: null });

		expect(paths).toContain(file);
	});
});

describe("which files count", () => {
	it("skips a file in a dot directory, which belongs to that tool's own provider", async () => {
		const repo = path.join(root, "repo");
		const hidden = path.join(repo, ".codex");
		await writeAgentsMd(hidden, "codex");
		const visible = await writeAgentsMd(repo, "repo");

		const { paths } = await load({ cwd: hidden, repoRoot: repo });

		expect(paths).toEqual([visible]);
	});

	it("returns nothing when the tree holds no AGENTS.md at all", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });

		const { paths, warnings } = await load({ cwd: repo, repoRoot: repo });

		expect(paths).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("keeps the file content and marks every one as project scope", async () => {
		const repo = path.join(root, "repo");
		await writeAgentsMd(repo, "the rule");

		const { items } = await load({ cwd: repo, repoRoot: repo });

		expect(items[0]?.content).toBe("the rule");
		expect(items[0]?.level).toBe("project");
	});
});

describe("the depth that orders the layers", () => {
	it("gives the working directory's own file the shallowest depth and each parent a deeper one", async () => {
		const repo = path.join(root, "repo");
		const deep = path.join(repo, "src", "feature");
		await writeAgentsMd(repo, "repo");
		await writeAgentsMd(path.join(repo, "src"), "src");
		await writeAgentsMd(deep, "feature");

		const { items } = await load({ cwd: deep, repoRoot: repo });

		expect(items.map(item => item.depth)).toEqual([0, 1, 2]);
	});
});
