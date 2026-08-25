/**
 * Preflight verification, binary fresh-build checks, and auth database seeding.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai";
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
	return path.resolve(import.meta.dirname, "../..");
}

export function getCodingAgentDir(): string {
	return path.resolve(getBenchDir(), "../coding-agent");
}

export function getVeyBinaryPath(): string {
	return path.join(getCodingAgentDir(), "dist", "vey");
}

export function getAuthDbPath(): string {
	return path.join(getBenchDir(), "assets", "auth-agent.db");
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

export async function ensureBinaryUpToDate(): Promise<void> {
	const codingAgentDir = getCodingAgentDir();
	const veyBinary = getVeyBinaryPath();
	const srcDir = path.join(codingAgentDir, "src");
	let needsBuild = !fs.existsSync(veyBinary);
	if (!needsBuild) {
		const binaryMtime = fs.statSync(veyBinary).mtimeMs;
		function checkDir(d: string): boolean {
			for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, entry.name);
				if (entry.isDirectory()) {
					if (checkDir(p)) return true;
				} else if (entry.isFile() && fs.statSync(p).mtimeMs > binaryMtime) {
					return true;
				}
			}
			return false;
		}
		needsBuild = checkDir(srcDir);
	}
	if (needsBuild) {
		console.log("deepswe-bench: building fresh vey binary...");
		const proc = Bun.spawn(["bun", "scripts/build-binary.ts"], {
			cwd: codingAgentDir,
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
	const benchDir = getBenchDir();
	const authDb = getAuthDbPath();
	fs.mkdirSync(path.join(benchDir, "assets"), { recursive: true });
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
			`deepswe-bench: seeding from the pre-move store ${decision.source}; ` +
				`${AUTH_DB_SOURCES[0]} does not exist, so these credentials may predate your last login`,
		);
	}
	if (decision.kind === "current") return;
	if (decision.kind === "seed") {
		console.log(`deepswe-bench: seeding auth DB from ${decision.source}`);
	} else if (decision.reason === "stale") {
		console.log(
			`deepswe-bench: re-seeding auth DB from ${decision.source} (staged copy is older than the live store)`,
		);
	} else {
		console.warn(
			`deepswe-bench: staged auth DB ${authDb} does not open (${decision.fault}); ` +
				`re-seeding from ${decision.source}`,
		);
	}
	snapshotCredentialStore(decision.source, authDb);
}

export async function requireStagedAuthCanServeToken(model: string, dryRun = false): Promise<void> {
	const authDb = getAuthDbPath();
	const store = await SqliteAuthCredentialStore.open(authDb);
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
		console.error(`deepswe-bench: ${describeExhaustedPool(spent, model)}`);
		if (spentQuotaShouldAbort(spent, dryRun)) process.exit(1);
		console.error("deepswe-bench: continuing anyway because this is a --dry-run; no trial will be started.\n");
	}

	const verdict = decideAuthPreflight(probes);
	if (verdict.kind === "ok") {
		const vendor = modelVendor(model);
		const checked = vendor ? "" : ` Quota pool NOT checked: no vendor could be inferred from "${model}".`;
		console.log(`deepswe-bench: staged auth DB serves a token (${verdict.usable} usable credential(s))${checked}`);
		return;
	}
	if (verdict.kind === "unverifiable") {
		console.warn(
			`deepswe-bench: WARNING the staged auth DB could NOT be verified. No probe is configured for: ` +
				`${verdict.providers.join(", ")}. Proceeding UNVERIFIED; an auth failure will now surface per trial.`,
		);
		return;
	}
	console.error(describeAuthPreflightFailure(verdict, authDb));
	process.exit(1);
}
