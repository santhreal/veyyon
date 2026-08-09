import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { renderLicenseBundle } from "../../../scripts/generate-license-bundle";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const ROOT = `${import.meta.dir}/../../..`;
const UPSTREAM_LICENSE_SHA256 = "545636e19386d3d4e0ae6d77354527499999c3ebfbca61b9fa5aa4ead7c0b308";

async function readRepositoryFile(path: string): Promise<string> {
	return Bun.file(`${ROOT}/${path}`).text();
}

describe("license preservation", () => {
	/**
	 * The rebrand must retain the complete oh-my-pi MIT grant and both upstream
	 * copyright lines. A byte-level digest catches deleted or rewritten terms.
	 */
	it("preserves the upstream MIT license verbatim", async () => {
		const license = await readRepositoryFile("LICENSE");
		const digest = new Bun.CryptoHasher("sha256").update(license).digest("hex");
		expect(digest).toBe(UPSTREAM_LICENSE_SHA256);
	});

	/**
	 * Every separately licensed vendored or adapted component must retain a
	 * nearby notice whose text identifies both its origin and license grant.
	 */
	it("retains the vendored and adapted component notices", async () => {
		const expectations = new Map<string, readonly string[]>([
			["crates/veyyon-shell/NOTICE", ["rtk-ai/rtk", "MIT License"]],
			[
				"crates/veyyon-natives/src/fonts/Silver.LICENSE",
				["Poppy Works", "Creative Commons Attribution 4.0 International"],
			],
			["docs/handbook/book/fonts/OPEN-SANS-LICENSE.txt", ["Apache License", "Version 2.0"]],
			[
				"docs/handbook/book/fonts/SOURCE-CODE-PRO-LICENSE.txt",
				["Adobe Systems Incorporated", "SIL OPEN FONT LICENSE Version 1.1"],
			],
			["packages/coding-agent/src/markit/NOTICE", ["markit-ai", "@oharato/pdf2md-ts", "MIT License"]],
			[
				"packages/utils/src/vendor/mermaid-ascii/NOTICE",
				[
					"beautiful-mermaid",
					"AlexanderGrooff/mermaid-ascii",
					"Copyright (c) 2023 Alexander Grooff",
					"MIT License",
				],
			],
		]);

		for (const [path, requiredText] of expectations) {
			const notice = await readRepositoryFile(path);
			for (const text of requiredText) expect(notice).toContain(text);
		}
	});

	/**
	 * The root attribution index is the discoverable map for redistributed
	 * source. Every non-MIT font and crate notice must remain linked by its
	 * current post-rebrand path rather than a removed pi-* path.
	 */
	it("indexes every separate notice at its current Veyyon path", async () => {
		const notice = await readRepositoryFile("NOTICE");
		const requiredPaths = [
			"crates/veyyon-shell/NOTICE",
			"crates/veyyon-natives/src/fonts/Silver.LICENSE",
			"docs/handbook/book/fonts/OPEN-SANS-LICENSE.txt",
			"docs/handbook/book/fonts/SOURCE-CODE-PRO-LICENSE.txt",
			"packages/coding-agent/src/markit/NOTICE",
			"packages/utils/src/vendor/mermaid-ascii/NOTICE",
		] as const;
		for (const path of requiredPaths) expect(notice).toContain(`\`${path}\``);
		expect(notice).not.toContain("crates/pi-shell/NOTICE");
		for (const attribution of [
			"NousResearch/hermes-agent",
			"NoeFabris/opencode-antigravity-auth",
			"@oharato/pdf2md-ts",
		]) {
			expect(notice).toContain(attribution);
		}
	});

	/**
	 * Rebranding package identities must not remove their machine-readable MIT
	 * declaration. This scans every JavaScript workspace package, including new
	 * packages added after this regression suite.
	 */
	it("keeps every Veyyon JavaScript package manifest MIT licensed", async () => {
		const paths = ["package.json"];
		for (const pattern of ["packages/*/package.json", "python/**/package.json"]) {
			const glob = new Glob(pattern);
			for await (const path of glob.scan({ cwd: ROOT })) paths.push(path);
		}

		const offenders: Array<{ name: string; license: unknown }> = [];
		for (const path of paths) {
			const manifest = (await Bun.file(`${ROOT}/${path}`).json()) as { name?: unknown; license?: unknown };
			if (typeof manifest.name === "string" && manifest.license !== "MIT") {
				offenders.push({ name: manifest.name, license: manifest.license });
			}
		}
		// Non-vacuity without a magic count. A hardcoded 20 broke the moment a
		// twenty-first package landed, and the number never described anything a
		// reader could check: what matters is that the scan reached the root manifest
		// and the packages the grant has to cover, so adding a package cannot silently
		// exempt it and cannot fail this test either.
		expect(paths).toContain("package.json");
		for (const owner of ["packages/coding-agent", "packages/tui", "packages/argot", "packages/hashline"]) {
			expect(paths).toContain(`${owner}/package.json`);
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * Both Python distributions are independently installable and must carry
	 * the same machine-readable MIT grant as the repository that ships them.
	 */
	it("keeps every Veyyon Python package MIT licensed", async () => {
		const pyprojects = ["python/veyyon-rpc/pyproject.toml", "python/veybot/pyproject.toml"] as const;
		for (const path of pyprojects) {
			const pyproject = await readRepositoryFile(path);
			expect(pyproject).toMatch(/\[project\][\s\S]*?\nlicense\s*=\s*"MIT"/);
		}
	});

	/**
	 * Python wheels and the Veybot image must contain the complete upstream
	 * notice, not only a short metadata label that drops copyright terms.
	 */
	it("ships the complete MIT text in each Python package", async () => {
		const rootLicense = await readRepositoryFile("LICENSE");
		for (const root of ["python/veyyon-rpc", "python/veybot"]) {
			expect(await readRepositoryFile(`${root}/LICENSE`)).toBe(rootLicense);
			expect(await readRepositoryFile(`${root}/pyproject.toml`)).toContain('license-files = ["LICENSE"]');
		}
		const dockerfile = await readRepositoryFile("Dockerfile.veybot");
		expect(dockerfile).toContain("COPY python/veybot/LICENSE ./");
		const dockerignore = await readRepositoryFile("Dockerfile.veybot.dockerignore");
		expect(dockerignore).toMatch(/^\/LICENSE$/m);
		expect(dockerignore).not.toMatch(/^LICENSE$/m);
	});

	/**
	 * Every vendored Rust crate with package metadata must carry its adjacent
	 * authoritative license. This locks out the uu-find and uu-tail omissions.
	 */
	it("keeps a license beside every vendored Rust manifest", async () => {
		const manifests = new Glob("crates/vendor/*/Cargo.toml");
		const missing: string[] = [];
		for await (const manifest of manifests.scan({ cwd: ROOT, onlyFiles: true })) {
			const licensePath = manifest.replace(/Cargo\\.toml$/, "LICENSE");
			try {
				await readRepositoryFile(licensePath);
			} catch {
				missing.push(licensePath);
			}
		}
		expect(missing).toEqual([]);
	});

	/**
	 * The generated bundle is the exact reproducible legal payload embedded in
	 * release binaries. Any source notice change must regenerate it.
	 */
	it("keeps the embedded legal bundle synchronized", async () => {
		const expected = await renderLicenseBundle(ROOT);
		const committed = await readRepositoryFile("THIRD_PARTY_LICENSES.txt");
		expect(committed).toBe(expected);
		for (const required of [
			"Copyright (c) 2025-2026 Can Bölük",
			"Copyright (c) 2025 Nous Research",
			"Copyright (c) 2025 Jens",
			"Copyright (c) 2023 Alexander Grooff",
			"Apache License",
			"SIL OPEN FONT LICENSE Version 1.1",
		]) {
			expect(committed).toContain(required);
		}
	});

	/**
	 * The real source CLI must route `licenses` as a command and print the exact
	 * embedded bundle, proving the self-contained binary entry graph retains it.
	 */
	it("prints the embedded legal bundle through the CLI", async () => {
		const { env, cleanup } = hermeticSpawnEnv({ VEYYON_NO_TITLE: "1" });
		try {
			const child = Bun.spawn([process.execPath, `${ROOT}/packages/coding-agent/src/cli.ts`, "licenses"], {
				cwd: ROOT,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toBe(await readRepositoryFile("THIRD_PARTY_LICENSES.txt"));
		} finally {
			cleanup();
		}
	});

	/**
	 * The provenance map must name the current crate and repository topology,
	 * never removed pi-* paths, a nonexistent backlog, or an unconfigured remote.
	 */
	it("keeps fork provenance aligned with the current repository", async () => {
		const upstream = await readRepositoryFile("UPSTREAM.md");
		for (const current of ["crates/veyyon-natives", "crates/veyyon-shell", "santhreal/veyyon", "can1357/oh-my-pi"]) {
			expect(upstream).toContain(current);
		}
		for (const stale of ["crates/pi-grep", "crates/pi-pty", "BACKLOG.md", "origin    ", "upstream  "]) {
			expect(upstream).not.toContain(stale);
		}
	});

	/**
	 * Rust crates inherit their published license from the workspace manifest.
	 * The shared declaration must stay MIT when package branding changes.
	 */
	it("keeps the Rust workspace MIT licensed", async () => {
		const cargo = await readRepositoryFile("Cargo.toml");
		expect(cargo).toMatch(/\[workspace\.package\][\s\S]*?\nlicense\s*=\s*"MIT"/);
	});
});
