import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// @ts-expect-error Plain .mjs module, no types; imported for its deployment contract.
import {
	assertNewDeployment,
	findExternalNodeExecutable,
	stageDeployTree,
} from "./deploy-staging.mjs";
const repoRoot = path.join(import.meta.dir, "..");
const deployScript = path.join(import.meta.dir, "deploy.mjs");
const buildScript = path.join(import.meta.dir, "build.mjs");
const getDirectory = path.join(repoRoot, "website-get");

function runScript(script: string, project?: string): string {
	const env = { ...process.env };
	if (project === undefined) delete env.VEYYON_PAGES_PROJECT;
	else env.VEYYON_PAGES_PROJECT = project;

	const run = Bun.spawnSync([process.execPath, script, ...(script === deployScript ? ["--dry-run"] : [])], {
		cwd: repoRoot,
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
	it(
		"publishes the staged installer tree for the veyyon-get project",
		() => {
			const output = runScript(deployScript, "veyyon-get");
			expect(output).toContain(`would stage '${getDirectory}' with symlinks dereferenced`);
			expect(output).toContain(
				"npx --yes wrangler@4.114.0 pages deploy . --project-name veyyon-get",
			);
			expect(output).toContain("--commit-dirty=true --skip-caching");
			expect(output).not.toContain(`would stage '${import.meta.dir}'`);
		},
		30_000,
	);

	it(
		"publishes the marketing tree for the default project",
		() => {
			const output = runScript(deployScript);
			expect(output).toContain(`would stage '${import.meta.dir}' with symlinks dereferenced`);
			expect(output).toContain("npx --yes wrangler@4.114.0 pages deploy . --project-name veyyon");
			expect(output).toContain("--commit-dirty=true --skip-caching");
			expect(output).not.toContain(`would stage '${getDirectory}'`);
		},
		30_000,
	);

	it("rejects an unknown project before building or deploying any tree", () => {
		const run = Bun.spawnSync([process.execPath, deployScript, "--dry-run"], {
			cwd: repoRoot,
			env: { ...process.env, VEYYON_PAGES_PROJECT: "typo-production" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain(
			"unknown Pages project 'typo-production'; expected 'veyyon' or 'veyyon-get'",
		);
		expect(run.stdout.toString()).not.toContain("website build OK");
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
		const handbookPage = path.join(handbook, "subagents.html");
		fs.writeFileSync(handbookPage, "rebuilt handbook");
		fs.symlinkSync(handbook, path.join(source, "docs"), "dir");

		const staged = stageDeployTree(source);
		try {
			const stagedDocs = path.join(staged.directory, "docs");
			expect(fs.lstatSync(stagedDocs).isSymbolicLink()).toBe(false);
			expect(fs.statSync(stagedDocs).isDirectory()).toBe(true);
			expect(fs.readFileSync(path.join(stagedDocs, "subagents.html"), "utf8")).toBe("rebuilt handbook");

			fs.writeFileSync(handbookPage, "changed after staging");
			expect(fs.readFileSync(path.join(stagedDocs, "subagents.html"), "utf8")).toBe("rebuilt handbook");
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

	/** A missing real Node runtime must fail with an operator-actionable fix. */
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
		expect(() => assertNewDeployment("same-id", "same-id", "veyyon")).toThrow(
			"Wrangler exited without uploading",
		);
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
		const headers = fs.readFileSync(path.join(import.meta.dir, "_headers"), "utf8");
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
		const redirects = fs.readFileSync(path.join(import.meta.dir, "_redirects"), "utf8");
		expect(redirects).not.toMatch(/^\/install(?:\s|$)/m);
		expect(fs.readFileSync(path.join(import.meta.dir, "install.html"), "utf8")).toContain(
			"<title>Install | Veyyon</title>",
		);
	});
});

describe("website-get staging", () => {
	beforeAll(() => runScript(buildScript), 30_000);

	it("stages both installers byte for byte", () => {
		for (const name of ["install.sh", "install.ps1"]) {
			expect(fs.readFileSync(path.join(getDirectory, name))).toEqual(
				fs.readFileSync(path.join(repoRoot, "scripts", name)),
			);
		}
	});

	it("stages the root rewrite and explicit no-cache content types", () => {
		expect(fs.readFileSync(path.join(getDirectory, "_redirects"), "utf8")).toBe("/  /install.sh  200\n");
		const headers = fs.readFileSync(path.join(getDirectory, "_headers"), "utf8");
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
