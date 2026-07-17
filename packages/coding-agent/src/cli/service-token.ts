/**
 * Shared bearer-token file bootstrap for the local auth services
 * (`veyyon auth-broker`, `veyyon auth-gateway`).
 *
 * One owner for the read/generate/ensure lifecycle so every service token
 * gets the same 0600 permissions and the same race-safe exclusive-create
 * behavior when two invocations bootstrap concurrently.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/pi-utils";

export async function readServiceToken(file: string): Promise<string | null> {
	try {
		const raw = await Bun.file(file).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

export async function writeServiceToken(file: string, token: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/**
 * Atomically create the token file, refusing to clobber an existing one.
 * Returns `true` on success, `false` when the file already existed (so the
 * caller re-reads it instead of racing another concurrent `ensureServiceToken`).
 */
async function createServiceTokenExclusive(file: string, token: string): Promise<boolean> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		// `wx` = O_CREAT | O_EXCL — fails with EEXIST if the file is already there.
		await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	return true;
}

export function generateServiceToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export async function ensureServiceToken(file: string): Promise<string> {
	const existing = await readServiceToken(file);
	if (existing) return existing;
	const token = generateServiceToken();
	if (await createServiceTokenExclusive(file, token)) return token;
	// Another concurrent invocation won the create race; read what they wrote.
	const fromRace = await readServiceToken(file);
	if (fromRace) return fromRace;
	// File existed-then-disappeared between EEXIST and read; last resort, write
	// our generated token unconditionally so callers don't see an empty string.
	await writeServiceToken(file, token);
	return token;
}
