/**
 * Preflight verification, binary fresh-build checks, and auth database seeding.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
import { assetsDir, authDbPath, codingAgentDir, evalsPackageDir, veyBinaryPath } from "../../../../paths";
import {
	type CredentialProbe,
	decideAuthPreflight,
	decideAuthSeed,
	describeAuthPreflightFailure,
	describeExhaustedPool,
	exhaustedPoolFor,
	modelVendor,
	probeCredentialStore,
	snapshotCredentialStore,
	spentQuotaShouldAbort,
} from "../shared";

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

export const AUTH_DB_SOURCES = [
	path.join(os.homedir(), ".veyyon", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "default", "shared-auth", "agent.db"),
	path.join(os.homedir(), ".veyyon", "profiles", "work", "shared-auth", "agent.db"),
];

export function requireFile(p: string, hint: string): void {
	if (!fs.existsSync(p)) {
		console.error(`missing: ${p}\n${hint}`);
		process.exit(1);
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
			} else if (entry.isFile() && fs.statSync(p).mtimeMs > binaryMtime) {
				newerFile = p;
				return true;
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
	if (status.needsBuild) {
		console.log("deep-swe: building fresh vey binary...");
		const proc = Bun.spawn(["bun", "scripts/build-binary.ts"], {
			cwd: getCodingAgentDir(),
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) {
			console.error("failed to build vey binary");
			process.exit(1);
		}
	}
}

export function ensureAuthDbSeeded(): void {
	const authDb = getAuthDbPath();
	fs.mkdirSync(assetsDir(), { recursive: true });
	const mtimeOf = (p: string): number | undefined => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : undefined);
	const decision = decideAuthSeed(AUTH_DB_SOURCES, authDb, mtimeOf, probeCredentialStore);
	if (decision.kind === "missing") {
		console.error(
			`missing credential store: no agent.db at any of\n  ${AUTH_DB_SOURCES.join("\n  ")}\n` +
				"log in first: vey (then /login), which writes ~/.veyyon/shared-auth/agent.db",
		);
		process.exit(1);
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

export async function requireStagedAuthCanServeToken(
	model: string,
	dryRun = false,
	dbPath = getAuthDbPath(),
): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	let probes: CredentialProbe[];
	try {
		const storage = new AuthStorage(store);
		await storage.reload();
		probes = await storage.checkCredentials();
	} finally {
		store.close();
	}

	const spent = exhaustedPoolFor(probes, model);
	if (spent) {
		console.error(`deep-swe: ${describeExhaustedPool(spent, model)}`);
		if (spentQuotaShouldAbort(spent, dryRun)) {
			throw new Error(describeExhaustedPool(spent, model));
		}
		console.error("deep-swe: continuing anyway because this is a --dry-run; no trial will be started.\n");
	}

	const verdict = decideAuthPreflight(probes);
	if (verdict.kind === "ok") {
		const vendor = modelVendor(model);
		const checked = vendor ? "" : ` Quota pool NOT checked: no vendor could be inferred from "${model}".`;
		console.log(`deep-swe: staged auth DB serves a token (${verdict.usable} usable credential(s))${checked}`);
		return;
	}
	if (verdict.kind === "unverifiable") {
		console.warn(
			`deep-swe: WARNING the staged auth DB could NOT be verified. No probe is configured for: ` +
				`${verdict.providers.join(", ")}. Proceeding UNVERIFIED; an auth failure will now surface per trial.`,
		);
		return;
	}
	const failureMessage = describeAuthPreflightFailure(verdict, dbPath);
	console.error(failureMessage);
	throw new Error(failureMessage);
}
