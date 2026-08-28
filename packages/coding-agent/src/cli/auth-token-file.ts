import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@veyyon/utils";

/** The bearer-token file a local auth service authenticates its clients with. The auth gateway and the auth broker each ship one of these, and each had its own private copy of the */
/** How long a caller that lost the create race waits for the winner to write the token. The window is one `writeFile` wide, so this is generous by orders of magnitude on purpose: the cost of */
const TOKEN_RACE_TIMEOUT_MS = 2_000;

/** Poll interval while waiting out the create-then-write window. */
const TOKEN_RACE_POLL_MS = 2;

export class AuthTokenFile {
	readonly #fileName: string;

	/** @param fileName file name under the config root, e.g. `auth-broker.token`. Each service passes its own, which is the ONLY thing that differed between the two copies. */
	constructor(fileName: string) {
		this.#fileName = fileName;
	}

	/** Absolute path of the token file. Resolved per call, so a changed config root is honoured. */
	path(): string {
		return path.join(getConfigRootDir(), this.#fileName);
	}

	/** The stored token, or null when there is none. A missing file is the ordinary first-run state and reads as null. Any other failure (a permission */
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

	/** Write the token, replacing whatever was there. Used to ROTATE a token, where clobbering is the point. Everything else goes through */
	async write(token: string): Promise<void> {
		const file = this.path();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(file, token, { mode: 0o600 });
		await this.#restrict(file);
	}

	/** Create the token file, refusing to clobber an existing one. Returns false when the file already existed, so the caller re-reads it rather than racing another */
	async createExclusive(token: string): Promise<boolean> {
		const file = this.path();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		try {
			// `wx` is O_CREAT | O_EXCL: it fails with EEXIST rather than truncating, and the mode applies
			// at creation, so the token is never briefly readable by other local users.
			await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
		await this.#restrict(file);
		return true;
	}

	/** The stored token, minting and storing one on first run. Safe against concurrent callers. */
	async ensure(): Promise<string> {
		const existing = await this.read();
		if (existing) return existing;
		const token = generateAuthToken();
		if (await this.createExclusive(token)) return token;
		// Another invocation won the create race; its token is the real one. Reading it can lose a second, narrower race: `O_CREAT | O_EXCL` makes the file EXIST before its contents are written, so a
		const fromRace = await this.#readWhileCreatorWrites();
		if (fromRace) return fromRace;
		// Still empty after the wait: either something removed the file between EEXIST and the read, or a creator died between creating it and writing to it and left an empty file behind. Either way the
		logger.warn("Auth token file existed but stayed empty; minting a replacement token", {
			path: this.path(),
			waitedMs: TOKEN_RACE_TIMEOUT_MS,
		});
		await this.write(token);
		return token;
	}

	/** Re-read the token file until the invocation that created it has written its contents. Bounded and short: the gap being waited out is one `writeFile` between `O_CREAT` and the bytes */
	async #readWhileCreatorWrites(): Promise<string | null> {
		const deadline = Date.now() + TOKEN_RACE_TIMEOUT_MS;
		for (;;) {
			const token = await this.read();
			if (token) return token;
			if (Date.now() >= deadline) return null;
			await Bun.sleep(TOKEN_RACE_POLL_MS);
		}
	}

	/** Narrow the mode after the fact. The creating call already asked for `0600`, so this only matters where the platform ignored it. */
	async #restrict(file: string): Promise<void> {
		try {
			await fs.chmod(file, 0o600);
		} catch {
			// Best-effort (e.g. Windows).
		}
	}
}

/** A fresh bearer token: 32 random bytes, base64url so it survives a header, a URL, and a shell. 256 bits from the CSPRNG, not a uuid or a timestamp: this is the only thing standing between a local */
export function generateAuthToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

/** Flags the `token` subcommand of a local auth service accepts. */
export interface TokenCommandFlags {
	/** Mint a new token and replace the stored one, invalidating every client holding the old one. */
	regenerate?: boolean;
	/** Print `{ token, path }` instead of the bare token. */
	json?: boolean;
}

/** Render what the `token` subcommand prints, including its trailing newline. The plain form is the bare token and nothing else, because it is written to be */
export function formatTokenOutput(token: string, filePath: string, json: boolean): string {
	return json ? `${JSON.stringify({ token, path: filePath })}\n` : `${token}\n`;
}

/** Run the `token` subcommand: print the stored token, or mint a replacement. The auth gateway and the auth broker each had a byte-identical copy of this, */
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
