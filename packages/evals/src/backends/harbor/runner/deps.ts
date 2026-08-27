/**
 * Host-side dependency preparation for Harbor container mounts: linux bun/node_modules
 * caching, local tarball packing, and version detection.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryParseJson } from "@veyyon/utils";
import { BUILD_COMMAND_TIMEOUT_MS, syncCommandOptions } from "../../../core/external-command";
import { codingAgentDir, repoRootDir } from "../../../paths";
import type { Config } from "./config";

function readJson(file: string): unknown {
	try {
		return tryParseJson(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

export function readPkgVersion(): string {
	const raw = readJson(path.join(codingAgentDir(), "package.json"));
	if (raw && typeof raw === "object") {
		const v = (raw as Record<string, unknown>).version;
		if (typeof v === "string") return v;
	}
	return "0.0.0-dev";
}

export function buildTarball(benchDir: string): string {
	process.stdout.write("packing local veyyon (bun pm pack)…\n");
	const r = spawnSync("bun", ["pm", "pack", "--destination", benchDir], {
		...syncCommandOptions(BUILD_COMMAND_TIMEOUT_MS),
		cwd: codingAgentDir(),
	});
	if (r.status !== 0) {
		throw new Error(`bun pm pack failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
	}
	// bun pm pack writes veyyon-<version>.tgz into destination
	const match = (r.stdout ?? "").match(/([^\s]+\.tgz)/);
	const name = match ? path.basename(match[1]) : null;
	if (name && fs.existsSync(path.join(benchDir, name))) return path.join(benchDir, name);
	const newest = newestTarball(benchDir);
	if (newest) return newest;
	throw new Error(`bun pm pack succeeded but no .tgz found in ${benchDir}`);
}

export function newestTarball(benchDir: string): string | null {
	try {
		const tgz = fs
			.readdirSync(benchDir)
			.filter(f => f.endsWith(".tgz"))
			.map(f => path.join(benchDir, f))
			.map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		return tgz[0]?.p ?? null;
	} catch {
		return null;
	}
}

/** Linux deps tree + mount plan for running veyyon straight from the mounted repo. */
export interface SourceMount {
	arch: "arm64" | "x64";
	/** Host dir holding the linux `bin/bun` + skeleton `node_modules` trees. */
	depsDir: string;
	/** Workspace node_modules paths (repo-relative) populated under depsDir. */
	nodeModules: string[];
}

/** Bun version pinned by the repo's `packageManager` field. */
function repoBunVersion(): string {
	const raw = readJson(path.join(repoRootDir(), "package.json"));
	if (raw && typeof raw === "object") {
		const pm = (raw as Record<string, unknown>).packageManager;
		if (typeof pm === "string" && pm.startsWith("bun@")) return pm.slice("bun@".length);
	}
	return "1.2.2";
}

/** Native arch of the docker daemon (what non-emulated task containers run as). */
function dockerServerArch(): "arm64" | "x64" {
	const r = spawnSync("docker", ["version", "--format", "{{.Server.Arch}}"], syncCommandOptions());
	const a = (r.stdout ?? "").trim();
	if (a === "arm64" || a === "aarch64") return "arm64";
	return "x64";
}

/** Workspace member dirs (repo-relative), expanded from root package.json `workspaces.packages`. */
function workspacePackageDirs(): string[] {
	const raw = readJson(path.join(repoRootDir(), "package.json")) as {
		workspaces?: { packages?: string[] };
	} | null;
	const globs = raw?.workspaces?.packages ?? ["packages/*", "crates/*"];
	const dirs: string[] = [];
	for (const g of globs) {
		if (g.endsWith("/*")) {
			const parent = g.slice(0, -2);
			try {
				for (const ent of fs.readdirSync(path.join(repoRootDir(), parent), { withFileTypes: true })) {
					if (ent.isDirectory()) dirs.push(`${parent}/${ent.name}`);
				}
			} catch {
				/* parent dir missing */
			}
		} else {
			dirs.push(g);
		}
	}
	return dirs;
}

/** Manifest files (repo-relative) that fully determine a `bun install` result. */
function sourceManifestFiles(pkgDirs: string[]): string[] {
	const files = ["package.json", "bun.lock"];
	if (fs.existsSync(path.join(repoRootDir(), "bunfig.toml"))) files.push("bunfig.toml");
	const patchesDir = path.join(repoRootDir(), "patches");
	if (fs.existsSync(patchesDir)) {
		try {
			for (const f of fs.readdirSync(patchesDir)) files.push(`patches/${f}`);
		} catch {
			/* ignore */
		}
	}
	for (const d of pkgDirs) {
		const pj = `${d}/package.json`;
		if (fs.existsSync(path.join(repoRootDir(), pj))) files.push(pj);
	}
	return files;
}

function sourceDepsStamp(manifests: string[], bunVersion: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(`bun@${bunVersion}\0source-deps-v1\0`);
	for (const rel of manifests) {
		const full = path.join(repoRootDir(), rel);
		try {
			h.update(`${rel}\0`);
			h.update(fs.readFileSync(full));
			h.update("\0");
		} catch {
			h.update(`${rel}\0MISSING\0`);
		}
	}
	return h.digest("hex").slice(0, 16);
}

/**
 * Docker user flag (`--user uid:gid`) matching the host process so files written
 * to host bind mounts are owned by the caller, not root (avoids un-deletable
 * files in the repo/cache). On platforms without getuid (Windows) returns empty.
 */
function hostUserArgs(): string[] {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const gid = typeof process.getgid === "function" ? process.getgid() : null;
	if (uid === null || gid === null) return [];
	return ["--user", `${uid}:${gid}`];
}

/**
 * Clean slate for a fresh build: root-owned node_modules from older runs
 * will make bun fail with EACCES unless wiped via the container first.
 */
function resetDepsDir(depsDir: string, runtime: string, image: string): void {
	try {
		fs.rmSync(depsDir, { recursive: true, force: true });
	} catch {
		// Host rm failed (likely permission denied on container-created files).
		// Wipe from inside a container using root if necessary.
		if (fs.existsSync(depsDir)) {
			spawnSync(runtime, [
				"run",
				"--rm",
				"-v",
				`${depsDir}:/wipe`,
				image,
				"sh",
				"-c",
				"rm -rf /wipe/* /wipe/.* 2>/dev/null || true",
			]);
			try {
				fs.rmSync(depsDir, { recursive: true, force: true });
			} catch {
				/* proceed anyway; mkdir will fail if truly unfixable */
			}
		}
	}
	fs.mkdirSync(depsDir, { recursive: true });
}

/**
 * Pre-warms a Linux `bun` binary and `node_modules` trees on the host so task
 * containers can bind-mount the working tree directly without running `bun install`
 * per-trial. Cached by hashing all workspace package.json + bun.lock files.
 */
export function prepareSourceDeps(cfg: Config): SourceMount {
	const arch = cfg.envType === "apple-container" ? "arm64" : dockerServerArch();
	const bunVersion = repoBunVersion();
	const depsDir = path.join(cfg.jobsDir, "_bench", "_deps", `linux-${arch}`);
	const pkgDirs = workspacePackageDirs();
	const manifests = sourceManifestFiles(pkgDirs);
	const stamp = sourceDepsStamp(manifests, bunVersion);
	const stampFile = path.join(depsDir, ".stamp");

	const nodeModules = ["node_modules", ...pkgDirs.map(d => `${d}/node_modules`)];

	let cachedStamp: string | null = null;
	try {
		cachedStamp = fs.readFileSync(stampFile, "utf8").trim();
	} catch {
		/* no stamp yet */
	}

	const binBun = path.join(depsDir, "bin", "bun");
	const isComplete =
		cachedStamp === stamp && fs.existsSync(binBun) && fs.existsSync(path.join(depsDir, "node_modules"));

	if (isComplete) {
		return { arch, depsDir, nodeModules };
	}

	process.stdout.write(`preparing linux-${arch} dependencies for source mount…\n`);
	const image = `oven/bun:${bunVersion}-debian`;
	const runtime = cfg.envType === "apple-container" ? "container" : "docker";

	resetDepsDir(depsDir, runtime, image);

	// Copy all manifests into a skeleton mirror under depsDir
	for (const rel of manifests) {
		const src = path.join(repoRootDir(), rel);
		const dst = path.join(depsDir, "mirror", rel);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
	}

	// Run `bun install` inside the container against the skeleton mirror.
	// We run as the host user so output files are owned by the caller.
	const userArgs = cfg.envType === "apple-container" ? [] : hostUserArgs();
	const runArgs = [
		"run",
		"--rm",
		...userArgs,
		"-v",
		`${depsDir}/mirror:/work`,
		"-w",
		"/work",
		image,
		"sh",
		"-c",
		"bun install --frozen-lockfile && mkdir -p /work/_bin && cp $(which bun) /work/_bin/bun",
	];

	const res = spawnSync(runtime, runArgs, syncCommandOptions(BUILD_COMMAND_TIMEOUT_MS));
	if (res.status !== 0) {
		throw new Error(`Failed to prepare Linux source dependencies via ${runtime}:\n${res.stderr || res.stdout}`);
	}

	// Move bin/bun into depsDir/bin/bun
	fs.mkdirSync(path.join(depsDir, "bin"), { recursive: true });
	fs.renameSync(path.join(depsDir, "mirror", "_bin", "bun"), binBun);

	// Move all generated node_modules trees up into depsDir
	for (const rel of nodeModules) {
		const src = path.join(depsDir, "mirror", rel);
		const dst = path.join(depsDir, rel);
		if (fs.existsSync(src)) {
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.renameSync(src, dst);
		}
	}

	// Clean up mirror
	try {
		fs.rmSync(path.join(depsDir, "mirror"), { recursive: true, force: true });
	} catch {
		/* ignore */
	}

	fs.writeFileSync(stampFile, stamp);
	return { arch, depsDir, nodeModules };
}
