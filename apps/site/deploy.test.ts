import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// @ts-expect-error Plain .mjs module, no types; imported for its deployment contract.
import { assertNewDeployment, findExternalNodeExecutable, stageDeployTree } from "./deploy-staging.mjs";

const repoRoot = path.join(import.meta.dir, "..", "..");

interface TestWorkspace {
	workspaceRoot: string;
	siteDir: string;
	deployScript: string;
	buildScript: string;
	getDirectory: string;
	cleanup: () => void;
}

function createDisposableWorkspace(): TestWorkspace {
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-site-workspace-"));
	const siteDir = path.join(workspaceRoot, "apps", "site");
	fs.cpSync(path.join(repoRoot, "apps", "site"), siteDir, { recursive: true, verbatimSymlinks: true });

	fs.mkdirSync(path.join(workspaceRoot, "scripts"), { recursive: true });
	for (const script of ["install.sh", "install.ps1"]) {
		const src = path.join(repoRoot, "scripts", script);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(workspaceRoot, "scripts", script));
	}

	fs.mkdirSync(path.join(workspaceRoot, "assets"), { recursive: true });
	for (const asset of ["demo-hd.webp", "agents-cockpit.webp"]) {
		const src = path.join(repoRoot, "assets", asset);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(workspaceRoot, "assets", asset));
	}

	fs.mkdirSync(path.join(workspaceRoot, "packages", "coding-agent"), { recursive: true });
	const changelogSrc = path.join(repoRoot, "packages", "coding-agent", "CHANGELOG.md");
	if (fs.existsSync(changelogSrc)) {
		fs.copyFileSync(changelogSrc, path.join(workspaceRoot, "packages", "coding-agent", "CHANGELOG.md"));
	}

	fs.mkdirSync(path.join(workspaceRoot, "packages", "catalog", "src", "provider-models"), { recursive: true });
	const modelsJsonSrc = path.join(repoRoot, "packages", "catalog", "src", "models.json");
	if (fs.existsSync(modelsJsonSrc)) {
		fs.copyFileSync(modelsJsonSrc, path.join(workspaceRoot, "packages", "catalog", "src", "models.json"));
	}
	const descriptorsSrc = path.join(repoRoot, "packages", "catalog", "src", "provider-models", "descriptors.ts");
	if (fs.existsSync(descriptorsSrc)) {
		fs.copyFileSync(
			descriptorsSrc,
			path.join(workspaceRoot, "packages", "catalog", "src", "provider-models", "descriptors.ts"),
		);
	}

	const handbookSource = path.join(repoRoot, "docs", "handbook");
	fs.cpSync(handbookSource, path.join(workspaceRoot, "docs", "handbook"), {
		recursive: true,
		verbatimSymlinks: true,
		filter: source => source !== path.join(handbookSource, "book"),
	});

	if (fs.existsSync(path.join(repoRoot, ".github", "workflows"))) {
		fs.mkdirSync(path.join(workspaceRoot, ".github", "workflows"), { recursive: true });
		fs.copyFileSync(
			path.join(repoRoot, ".github", "workflows", "docs.yml"),
			path.join(workspaceRoot, ".github", "workflows", "docs.yml"),
		);
	}

	return {
		workspaceRoot,
		siteDir,
		deployScript: path.join(siteDir, "deploy.mjs"),
		buildScript: path.join(siteDir, "build.mjs"),
		getDirectory: path.join(workspaceRoot, "website-get"),
		cleanup: () => {
			fs.rmSync(workspaceRoot, { recursive: true, force: true });
		},
	};
}

let workspace: TestWorkspace;
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-deploy-fetch-mock-"));
const mockPreloadPath = path.join(mockDir, "mock-github.cjs");
fs.writeFileSync(
	mockPreloadPath,
	`
const originalFetch = globalThis.fetch;
if (originalFetch) {
	globalThis.fetch = async function (url, options) {
		const target = typeof url === "string" ? url : url?.url || url?.href || String(url);
		if (target.includes("api.github.com/repos/santhreal/veyyon/releases")) {
			return new Response("[]", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return originalFetch.call(this, url, options);
	};
}
`,
);

beforeAll(() => {
	workspace = createDisposableWorkspace();
});

afterAll(() => {
	workspace.cleanup();
	fs.rmSync(mockDir, { recursive: true, force: true });
});

function testSubprocessEnv(extra: Record<string, string> = {}): Record<string, string> {
	const nodeOptions = [process.env.NODE_OPTIONS, `--require ${mockPreloadPath}`].filter(Boolean).join(" ");
	return {
		...process.env,
		NODE_OPTIONS: nodeOptions,
		...extra,
	};
}

function runScript(script: string, project?: string): string {
	const env = testSubprocessEnv();
	if (project === undefined) delete env.VEYYON_PAGES_PROJECT;
	else env.VEYYON_PAGES_PROJECT = project;

	const executable = script === workspace.buildScript ? findExternalNodeExecutable() : process.execPath;
	const run = Bun.spawnSync([executable, script, ...(script === workspace.deployScript ? ["--dry-run"] : [])], {
		cwd: workspace.workspaceRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = run.stdout.toString();
	const stderr = run.stderr.toString();
	expect(run.exitCode, stderr || stdout).toBe(0);
	return stdout;
}
describe("website deploy dry run", () => {
	it("publishes the staged installer tree for the veyyon-get project", () => {
		const output = runScript(workspace.deployScript, "veyyon-get");
		expect(output).toContain(`would stage '${workspace.getDirectory}' with symlinks dereferenced`);
		expect(output).toContain("npx --yes wrangler@4.114.0 pages deploy . --project-name veyyon-get");
		expect(output).toContain("--commit-dirty=true --skip-caching");
		expect(output).not.toContain(`would stage '${workspace.siteDir}'`);
	}, 30_000);

	it("publishes the marketing tree for the default project", () => {
		const output = runScript(workspace.deployScript);
		expect(output).toContain(`would stage '${workspace.siteDir}' with symlinks dereferenced`);
		expect(output).toContain("npx --yes wrangler@4.114.0 pages deploy . --project-name veyyon");
		expect(output).toContain("--commit-dirty=true --skip-caching");
		expect(output).not.toContain(`would stage '${workspace.getDirectory}'`);
	}, 30_000);

	it("rejects an unknown project before building or deploying any tree", () => {
		const run = Bun.spawnSync([process.execPath, workspace.deployScript, "--dry-run"], {
			cwd: workspace.workspaceRoot,
			env: testSubprocessEnv({ VEYYON_PAGES_PROJECT: "typo-production" }),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain(
			"unknown Pages project 'typo-production'; expected 'veyyon' or 'veyyon-get'",
		);
		expect(run.stdout.toString()).not.toContain("website build OK");
	});

	it("fails the site build with actionable error when mdbook is missing from PATH", () => {
		const docsWorkflow = fs.readFileSync(
			path.join(workspace.workspaceRoot, ".github", "workflows", "docs.yml"),
			"utf8",
		);
		const expectedMdbookVersion = docsWorkflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		expect(expectedMdbookVersion).toBeDefined();

		const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-isolated-path-"));
		try {
			// Link node and sh into an isolated bin directory that contains no mdbook
			const nodeExe = findExternalNodeExecutable();
			fs.symlinkSync(nodeExe, path.join(isolatedDir, path.basename(nodeExe)));
			const shPath = "/bin/sh";
			if (fs.existsSync(shPath)) {
				fs.symlinkSync(shPath, path.join(isolatedDir, "sh"));
			}

			const run = Bun.spawnSync([nodeExe, workspace.buildScript], {
				cwd: workspace.workspaceRoot,
				env: testSubprocessEnv({ PATH: isolatedDir }),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.exitCode).toBe(1);
			expect(run.stderr.toString()).toContain("site build FAILED: 'mdbook' is not on PATH");
			expect(run.stderr.toString()).toContain(`Install mdbook v${expectedMdbookVersion}`);
			expect(run.stdout.toString()).not.toContain("website build OK");
		} finally {
			fs.rmSync(isolatedDir, { recursive: true, force: true });
		}
	});

	it("fails the site build with specific diagnostic when mdbook build fails with non-zero exit", () => {
		const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-failing-mdbook-"));
		try {
			const nodeExe = findExternalNodeExecutable();
			fs.symlinkSync(nodeExe, path.join(isolatedDir, path.basename(nodeExe)));
			const shPath = "/bin/sh";
			if (fs.existsSync(shPath)) {
				fs.symlinkSync(shPath, path.join(isolatedDir, "sh"));
			}
			const mdbookScript = path.join(isolatedDir, "mdbook");
			fs.writeFileSync(mdbookScript, '#!/bin/sh\necho "mdbook: failed to parse book.toml" >&2\nexit 1\n');
			fs.chmodSync(mdbookScript, 0o755);
			const run = Bun.spawnSync([nodeExe, workspace.buildScript], {
				cwd: workspace.workspaceRoot,
				env: testSubprocessEnv({ PATH: isolatedDir }),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.exitCode).toBe(1);
			expect(run.stderr.toString()).toContain("Command failed: mdbook build");
			expect(run.stdout.toString()).not.toContain("website build OK");
		} finally {
			fs.rmSync(isolatedDir, { recursive: true, force: true });
		}
	});
});

describe("website deploy staging", () => {
	/**
	 * Wrangler can hash a symlink inode instead of its rebuilt target and silently
	 * reuse stale handbook files. The deploy snapshot must contain real files and
	 * remain unchanged when the source behind the symlink changes.
	 */
	it("dereferences handbook symlinks into an immutable deploy snapshot", () => {
		const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-deploy-staging-test-"));
		const source = path.join(fixtureRoot, "website");
		const handbook = path.join(fixtureRoot, "handbook");
		fs.mkdirSync(source);
		fs.mkdirSync(handbook);
		const handbookPage = path.join(handbook, "agents.html");
		fs.writeFileSync(handbookPage, "rebuilt handbook");
		fs.symlinkSync(handbook, path.join(source, "docs"), "dir");

		const staged = stageDeployTree(source);
		try {
			const stagedDocs = path.join(staged.directory, "docs");
			expect(fs.lstatSync(stagedDocs).isSymbolicLink()).toBe(false);
			expect(fs.statSync(stagedDocs).isDirectory()).toBe(true);
			expect(fs.readFileSync(path.join(stagedDocs, "agents.html"), "utf8")).toBe("rebuilt handbook");

			fs.writeFileSync(handbookPage, "changed after staging");
			expect(fs.readFileSync(path.join(stagedDocs, "agents.html"), "utf8")).toBe("rebuilt handbook");
		} finally {
			staged.cleanup();
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});

describe("website deploy runtime selection", () => {
	/**
	 * `bun run` places a node-compatible Bun shim before real Node. Wrangler must
	 * execute with the later real binary or it can exit before uploading assets.
	 */
	it("skips a node shim that resolves to the current Bun executable", () => {
		const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-node-runtime-test-"));
		const bunDirectory = path.join(fixtureRoot, "bun");
		const nodeDirectory = path.join(fixtureRoot, "node");
		fs.mkdirSync(bunDirectory);
		fs.mkdirSync(nodeDirectory);
		const bunExecutable = path.join(bunDirectory, "bun");
		const shim = path.join(bunDirectory, "node");
		const nodeExecutable = path.join(nodeDirectory, "node");
		fs.writeFileSync(bunExecutable, "");
		fs.chmodSync(bunExecutable, 0o755);
		fs.symlinkSync(bunExecutable, shim);
		fs.writeFileSync(nodeExecutable, "");
		fs.chmodSync(nodeExecutable, 0o755);

		try {
			expect(
				findExternalNodeExecutable({
					pathValue: [bunDirectory, nodeDirectory].join(path.delimiter),
					currentExecutable: bunExecutable,
				}),
			).toBe(nodeExecutable);
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	/** A missing real Node runtime must fail with a developer-actionable fix. */
	it("rejects a path that contains only the Bun node shim", () => {
		const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-node-runtime-test-"));
		const bunExecutable = path.join(fixtureRoot, "bun");
		const shim = path.join(fixtureRoot, "node");
		fs.writeFileSync(bunExecutable, "");
		fs.chmodSync(bunExecutable, 0o755);
		fs.symlinkSync(bunExecutable, shim);

		try {
			expect(() =>
				findExternalNodeExecutable({
					pathValue: fixtureRoot,
					currentExecutable: bunExecutable,
				}),
			).toThrow("install Node 22 or set VEYYON_NODE_BINARY");
		} finally {
			fs.rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});

describe("website deploy completion verification", () => {
	/**
	 * A zero Wrangler exit without a changed deployment id uploaded nothing.
	 * The deploy command must surface that false success instead of printing OK.
	 */
	it("rejects an unchanged production deployment", () => {
		expect(() => assertNewDeployment("same-id", "same-id", "veyyon")).toThrow("Wrangler exited without uploading");
	});

	/** A newly visible id is the durable Pages-side proof that the upload completed. */
	it("accepts and returns a new production deployment id", () => {
		expect(assertNewDeployment("old-id", "new-id", "veyyon")).toBe("new-id");
	});
});

describe("website response metadata", () => {
	/**
	 * The marketing homepage is HTML. A root installer header changes its MIME
	 * type to a shell script even when Pages serves the correct index bytes.
	 */
	it("does not apply installer content metadata to the marketing root", () => {
		const headers = fs.readFileSync(path.join(workspace.siteDir, "_headers"), "utf8");
		expect(headers).not.toContain(
			"/\n  Content-Type: application/x-sh; charset=utf-8\n  Cache-Control: no-cache, must-revalidate",
		);
		expect(headers).toContain(
			"/install.sh\n  Content-Type: application/x-sh; charset=utf-8\n  Cache-Control: no-cache, must-revalidate",
		);
	});

	/**
	 * Pages redirects `/install.html` to its clean `/install` URL. Rewriting the
	 * clean URL back to the file creates an endless 308 self-redirect.
	 */
	it("leaves the extensionless install page to Pages clean-URL routing", () => {
		const redirects = fs.readFileSync(path.join(workspace.siteDir, "_redirects"), "utf8");
		expect(redirects).not.toMatch(/^\/install(?:\s|$)/m);
		expect(fs.readFileSync(path.join(workspace.siteDir, "install.html"), "utf8")).toContain(
			"<title>Install | Veyyon</title>",
		);
	});
});

describe("website-get staging", () => {
	beforeAll(() => {
		expect(fs.existsSync(path.join(workspace.workspaceRoot, "docs", "handbook", "book"))).toBe(false);
		runScript(workspace.buildScript);
	}, 30_000);

	it("builds handbook pages and the site docs link from source alone", () => {
		const book = path.join(workspace.workspaceRoot, "docs", "handbook", "book");
		expect(fs.realpathSync(path.join(workspace.siteDir, "docs"))).toBe(fs.realpathSync(book));
		expect(fs.readFileSync(path.join(book, "index.html"), "utf8")).toContain("The Veyyon Harness Handbook");
	});

	it("stages both installers byte for byte", () => {
		for (const name of ["install.sh", "install.ps1"]) {
			expect(fs.readFileSync(path.join(workspace.getDirectory, name))).toEqual(
				fs.readFileSync(path.join(workspace.workspaceRoot, "scripts", name)),
			);
		}
	});

	it("stages the root rewrite and explicit no-cache content types", () => {
		expect(fs.readFileSync(path.join(workspace.getDirectory, "_redirects"), "utf8")).toBe("/  /install.sh  200\n");
		const headers = fs.readFileSync(path.join(workspace.getDirectory, "_headers"), "utf8");
		expect(headers).toContain(
			"/\n  Content-Type: application/x-sh; charset=utf-8\n  Cache-Control: no-cache, must-revalidate",
		);
		expect(headers).toContain(
			"/install.sh\n  Content-Type: application/x-sh; charset=utf-8\n  Cache-Control: no-cache, must-revalidate",
		);
		expect(headers).toContain(
			"/install.ps1\n  Content-Type: text/plain; charset=utf-8\n  Cache-Control: no-cache, must-revalidate",
		);
	});
});
