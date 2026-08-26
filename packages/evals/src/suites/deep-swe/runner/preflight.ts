/**
 * Preflight verification, binary fresh-build checks, and auth database seeding.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AUTH_DB_SOURCES, requireStagedAuthCanServeToken } from "../../../core";
import { decideAuthSeed, probeCredentialStore, snapshotCredentialStore } from "../../../core/auth-seed";
import { assetsDir, authDbPath, codingAgentDir, evalsPackageDir, veyBinaryPath } from "../../../paths";
import { BinaryBuildFailedError, MissingCredentialStoreError, MissingRequiredFileError } from "./errors";

export function getBenchDir(): string {
	return evalsPackageDir();
}

export function getCodingAgentDir(): string {
	return codingAgentDir();
}

export function getVeyBinaryPath(): string {
	return veyBinaryPath();
}

export function getAuthDbPath(): string {
	return authDbPath();
}

export { AUTH_DB_SOURCES };

export function requireFile(p: string, hint: string): void {
	if (!fs.existsSync(p)) {
		throw new MissingRequiredFileError(`missing: ${p}\n${hint}`);
	}
}

export function sha256File(p: string): string {
	return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export interface BinaryBuildCheck {
	readonly needsBuild: boolean;
	readonly binaryPath: string;
	readonly reason?: "missing" | "stale";
	readonly newerFile?: string;
	readonly buildCommand: string;
}

/**
 * Source files generated or rewritten by build-binary.ts teardown / generators.
 *
 * These files are rewritten during build completion / reset and will have
 * mtimes slightly newer than the compiled binary, which would otherwise cause
 * checkBinaryBuildNeeded() to report false staleness.
 */
export const BUILD_GENERATED_EXCLUSIONS: readonly string[] = [
	"src/embedded-client.generated.txt",
	"src/utils/mupdf-wasm-embed.ts",
];

export function isBuildGeneratedFile(relPath: string, basename: string): boolean {
	const normalized = relPath.replace(/\\/g, "/");
	if (BUILD_GENERATED_EXCLUSIONS.includes(normalized)) {
		return true;
	}
	if (basename.includes(".generated.")) {
		return true;
	}
	return false;
}

export function checkBinaryBuildNeeded(customBinaryPath?: string): BinaryBuildCheck {
	const codingAgentDir = getCodingAgentDir();
	const veyBinary = customBinaryPath ? path.resolve(customBinaryPath) : getVeyBinaryPath();
	const srcDir = path.join(codingAgentDir, "src");
	const buildCommand = "bun --cwd=packages/coding-agent scripts/build-binary.ts";

	if (!fs.existsSync(veyBinary)) {
		return {
			needsBuild: true,
			binaryPath: veyBinary,
			reason: "missing",
			buildCommand,
		};
	}

	const binaryMtime = fs.statSync(veyBinary).mtimeMs;
	let newerFile: string | undefined;

	function checkDir(d: string): boolean {
		if (!fs.existsSync(d)) return false;
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, entry.name);
			if (entry.isDirectory()) {
				if (checkDir(p)) return true;
			} else if (entry.isFile()) {
				const relPath = path.relative(codingAgentDir, p);
				if (isBuildGeneratedFile(relPath, entry.name)) {
					continue;
				}
				if (fs.statSync(p).mtimeMs > binaryMtime) {
					newerFile = p;
					return true;
				}
			}
		}
		return false;
	}

	if (checkDir(srcDir)) {
		return {
			needsBuild: true,
			binaryPath: veyBinary,
			reason: "stale",
			newerFile,
			buildCommand,
		};
	}

	return {
		needsBuild: false,
		binaryPath: veyBinary,
		buildCommand,
	};
}

export async function ensureBinaryUpToDate(): Promise<void> {
	const status = checkBinaryBuildNeeded();
	if (!status.needsBuild) return;
	console.log("deep-swe: building fresh vey binary...");
	const built = spawnSync("bun", ["scripts/build-binary.ts"], {
		cwd: getCodingAgentDir(),
		stdio: "inherit",
	});
	if (built.status !== 0) {
		throw new BinaryBuildFailedError(
			`failed to build vey binary (${status.buildCommand} exited with ${built.status ?? built.signal})`,
		);
	}
}

export function ensureAuthDbSeeded(): void {
	const authDb = getAuthDbPath();
	fs.mkdirSync(assetsDir(), { recursive: true });
	const mtimeOf = (p: string): number | undefined => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : undefined);
	const decision = decideAuthSeed(AUTH_DB_SOURCES, authDb, mtimeOf, probeCredentialStore);
	if (decision.kind === "missing") {
		throw new MissingCredentialStoreError(
			`missing credential store: no agent.db at any of\n  ${AUTH_DB_SOURCES.join("\n  ")}\n` +
				"log in first: vey (then /login), which writes ~/.veyyon/shared-auth/agent.db",
		);
	}
	if (decision.legacy) {
		console.warn(
			`deep-swe: seeding from the pre-move store ${decision.source}; ` +
				`${AUTH_DB_SOURCES[0]} does not exist, so these credentials may predate your last login`,
		);
	}
	if (decision.kind === "current") return;
	if (decision.kind === "seed") {
		console.log(`deep-swe: seeding auth DB from ${decision.source}`);
	} else if (decision.reason === "stale") {
		console.log(`deep-swe: re-seeding auth DB from ${decision.source} (staged copy is older than the live store)`);
	} else {
		console.warn(
			`deep-swe: staged auth DB ${authDb} does not open (${decision.fault}); ` +
				`re-seeding from ${decision.source}`,
		);
	}
	snapshotCredentialStore(decision.source, authDb);
}

export { requireStagedAuthCanServeToken };
