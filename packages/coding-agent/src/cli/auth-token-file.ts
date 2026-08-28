import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@veyyon/utils";

const TOKEN_RACE_TIMEOUT_MS = 2_000;

const TOKEN_RACE_POLL_MS = 2;

export class AuthTokenFile {
	readonly #fileName: string;

	constructor(fileName: string) {
		this.#fileName = fileName;
	}

	path(): string {
		return path.join(getConfigRootDir(), this.#fileName);
	}

	async read(): Promise<string | null> {
		try {
			const raw = await Bun.file(this.path()).text();
			const trimmed = raw.trim();
			return trimmed.length > 0 ? trimmed : null;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async write(token: string): Promise<void> {
		const file = this.path();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(file, token, { mode: 0o600 });
		await this.#restrict(file);
	}

	async createExclusive(token: string): Promise<boolean> {
		const file = this.path();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		try {
			await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
		await this.#restrict(file);
		return true;
	}

	async ensure(): Promise<string> {
		const existing = await this.read();
		if (existing) return existing;
		const token = generateAuthToken();
		if (await this.createExclusive(token)) return token;
		const fromRace = await this.#readWhileCreatorWrites();
		if (fromRace) return fromRace;
		logger.warn("Auth token file existed but stayed empty; minting a replacement token", {
			path: this.path(),
			waitedMs: TOKEN_RACE_TIMEOUT_MS,
		});
		await this.write(token);
		return token;
	}

	async #readWhileCreatorWrites(): Promise<string | null> {
		const deadline = Date.now() + TOKEN_RACE_TIMEOUT_MS;
		for (;;) {
			const token = await this.read();
			if (token) return token;
			if (Date.now() >= deadline) return null;
			await Bun.sleep(TOKEN_RACE_POLL_MS);
		}
	}

	async #restrict(file: string): Promise<void> {
		try {
			await fs.chmod(file, 0o600);
		} catch {}
	}
}

export function generateAuthToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export interface TokenCommandFlags {
	regenerate?: boolean;
	json?: boolean;
}

export function formatTokenOutput(token: string, filePath: string, json: boolean): string {
	return json ? `${JSON.stringify({ token, path: filePath })}\n` : `${token}\n`;
}

export async function printToken(file: AuthTokenFile, flags: TokenCommandFlags): Promise<void> {
	let token: string;
	if (flags.regenerate) {
		token = generateAuthToken();
		await file.write(token);
	} else {
		token = await file.ensure();
	}
	process.stdout.write(formatTokenOutput(token, file.path(), flags.json ?? false));
}
