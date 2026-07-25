import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@veyyon/utils";

/**
 * The bearer-token file a local auth service authenticates its clients with.
 *
 * The auth gateway and the auth broker each ship one of these, and each had its own private copy of the
 * whole family: path, read, write, generate, ensure. The copies had drifted in two ways that both
 * matter, and the broker had the worse half of each:
 *
 *  - CONCURRENCY. The gateway created the file with `O_EXCL` and, on `EEXIST`, re-read what the other
 *    process wrote, so two simultaneous starts converge on ONE token. The broker read, generated, and
 *    wrote unconditionally, so two simultaneous starts each minted a token and the second overwrote the
 *    first: a client holding the first token is then rejected by the service that handed it out.
 *  - PERMISSIONS. The gateway created the file with mode `0600` in the open call. The broker wrote it
 *    with `Bun.write` (default `0644`) and chmod'd afterwards, leaving a window in which any local user
 *    could read the token, and on Windows, where `chmod` does nothing, no narrowing at all.
 *
 * This module is the one owner, and it takes the gateway's behaviour in both cases: create exclusively,
 * at `0600`, and treat losing the create race as success by reading the winner's token.
 */
export class AuthTokenFile {
	readonly #fileName: string;

	/**
	 * @param fileName file name under the config root, e.g. `auth-broker.token`. Each service passes its
	 * own, which is the ONLY thing that differed between the two copies.
	 */
	constructor(fileName: string) {
		this.#fileName = fileName;
	}

	/** Absolute path of the token file. Resolved per call, so a changed config root is honoured. */
	path(): string {
		return path.join(getConfigRootDir(), this.#fileName);
	}

	/**
	 * The stored token, or null when there is none.
	 *
	 * A missing file is the ordinary first-run state and reads as null. Any other failure (a permission
	 * error, a directory in its place) is raised: silently treating an unreadable token file as "no
	 * token" would mint a second token and lock out every client holding the first.
	 */
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

	/**
	 * Write the token, replacing whatever was there.
	 *
	 * Used to ROTATE a token, where clobbering is the point. Everything else goes through
	 * {@link ensure}, which will not overwrite a token another process just created.
	 */
	async write(token: string): Promise<void> {
		const file = this.path();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(file, token, { mode: 0o600 });
		await this.#restrict(file);
	}

	/**
	 * Create the token file, refusing to clobber an existing one.
	 *
	 * Returns false when the file already existed, so the caller re-reads it rather than racing another
	 * concurrent {@link ensure}.
	 */
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
		// Another invocation won the create race; its token is the real one.
		const fromRace = await this.read();
		if (fromRace) return fromRace;
		// The file existed at EEXIST and was gone by the read, so something removed it in between.
		// Writing unconditionally is the last resort: the caller must not be handed an empty token.
		await this.write(token);
		return token;
	}

	/**
	 * Narrow the mode after the fact.
	 *
	 * The creating call already asked for `0600`, so this only matters where the platform ignored it.
	 * A failure here is not raised because Windows has no equivalent and the file is already created;
	 * the mode is stated in the log line each service writes when it loads the token.
	 */
	async #restrict(file: string): Promise<void> {
		try {
			await fs.chmod(file, 0o600);
		} catch {
			// Best-effort (e.g. Windows).
		}
	}
}

/**
 * A fresh bearer token: 32 random bytes, base64url so it survives a header, a URL, and a shell.
 *
 * 256 bits from the CSPRNG, not a uuid or a timestamp: this is the only thing standing between a local
 * HTTP port and a caller's provider credentials.
 */
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

/**
 * Render what the `token` subcommand prints, including its trailing newline.
 *
 * The plain form is the bare token and nothing else, because it is written to be
 * substituted straight into a shell (`--header "authorization: Bearer $(veyyon
 * auth-gateway token)"`): a label, a colour, or the path alongside it would end
 * up inside the header. The JSON form carries the path as well, since a script
 * that wants both should not have to guess where the file lives.
 */
export function formatTokenOutput(token: string, filePath: string, json: boolean): string {
	return json ? `${JSON.stringify({ token, path: filePath })}\n` : `${token}\n`;
}

/**
 * Run the `token` subcommand: print the stored token, or mint a replacement.
 *
 * The auth gateway and the auth broker each had a byte-identical copy of this,
 * which is how the two ended up printing the same shape by coincidence rather
 * than by contract. Both services offer the subcommand identically, so it lives
 * here with the file it prints.
 *
 * `--regenerate` writes unconditionally, which is the one path that MAY clobber:
 * rotating a token is a deliberate act that ends every session using the old
 * one. Without it the token is only minted when there is none, so running the
 * subcommand twice does not lock out a client that read the first answer.
 */
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
