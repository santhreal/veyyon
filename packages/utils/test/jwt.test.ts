import { describe, expect, it } from "bun:test";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { decodeJwtPayload } from "../src/jwt";

/** Build a JWT-shaped string from a payload object (header and signature are opaque). */
function makeJwt(payload: unknown): string {
	const seg = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${seg({ alg: "none" })}.${seg(payload)}.${"c".repeat(8)}`;
}

describe("decodeJwtPayload", () => {
	it("decodes the payload of a well-formed three-segment JWT", () => {
		const token = makeJwt({ exp: 1_700_000_000, email: "a@b.co" });
		expect(decodeJwtPayload<{ exp: number; email: string }>(token)).toEqual({
			exp: 1_700_000_000,
			email: "a@b.co",
		});
	});

	it("decodes a base64url payload containing url-safe bytes plain base64 would corrupt", () => {
		// A payload whose base64url encoding uses `-` and `_` (which plain base64
		// spells `+` and `/`). Decoding as plain "base64" would mangle it; the owner
		// uses "base64url" so it round-trips exactly.
		const payload = { sub: "ÿÿÿ", role: "ûÿ" };
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		expect(encoded).toMatch(/[-_]/);
		expect(decodeJwtPayload<typeof payload>(makeJwt(payload))).toEqual(payload);
	});

	it("returns null when the token is not three segments", () => {
		expect(decodeJwtPayload("only.two")).toBeNull();
		expect(decodeJwtPayload("a.b.c.d")).toBeNull();
		expect(decodeJwtPayload("nodots")).toBeNull();
	});

	it("returns null when the payload segment is empty or not JSON", () => {
		expect(decodeJwtPayload("h..s")).toBeNull();
		const notJson = `h.${Buffer.from("not json").toString("base64url")}.s`;
		expect(decodeJwtPayload(notJson)).toBeNull();
	});
});

describe("JWT-decode source lock", () => {
	// decodeJwtPayload owns "split a JWT, base64url-decode the middle segment, parse
	// its claims JSON". Two idioms only ever appear in a hand-rolled version of that:
	// feeding a base64url decode straight into JSON.parse, and the manual `-`/`_`
	// swap before atob. Either means a provider re-created the owner (often with the
	// plain-"base64" bug the owner exists to prevent) and must import it instead.
	const JWT_DECODE_IDIOMS = [
		/JSON\.parse\(\s*(?:new TextDecoder[^)]*\)\s*\.decode\(\s*)?(?:Buffer\.from\([^)]*"base64url"\)|Uint8Array\.fromBase64\([^)]*"base64url"[^)]*\))/,
		/atob\([^)]*\.replace\(\/-\/g/,
	];
	// The owner itself decodes then parses on separate statements, so it matches
	// neither idiom; it is listed for intent, not because the regex needs it.
	const EXEMPT = new Set(["utils/src/jwt.ts"]);

	const PACKAGES_DIR = path.join(import.meta.dir, "..", "..");

	function hasIdiom(text: string): boolean {
		return JWT_DECODE_IDIOMS.some(re => re.test(text));
	}

	async function walk(dir: string, packagesDir: string, out: { rel: string; body: string }[]): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "test" || entry.name === "__tests__") continue;
				await walk(full, packagesDir, out);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			out.push({ rel: path.relative(packagesDir, full), body: await readFile(full, "utf8") });
		}
	}

	async function sourceFiles(): Promise<{ rel: string; body: string }[]> {
		const out: { rel: string; body: string }[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			// Walk both shipped source and build scripts — a codegen script hand-rolled
			// this decode too, so scripts are in scope for the lock.
			await walk(path.join(PACKAGES_DIR, pkg.name, "src"), PACKAGES_DIR, out);
			await walk(path.join(PACKAGES_DIR, pkg.name, "scripts"), PACKAGES_DIR, out);
		}
		return out;
	}

	it("matches the hand-rolled idioms but not the owner or a plain byte decode", () => {
		expect(hasIdiom('JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))')).toBe(true);
		expect(
			hasIdiom(
				'JSON.parse(new TextDecoder("utf-8").decode(Uint8Array.fromBase64(parts[1], { alphabet: "base64url" })))',
			),
		).toBe(true);
		expect(hasIdiom('JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))')).toBe(true);
		// Owner shape: decode to a string first, then tryParseJson separately.
		expect(
			hasIdiom('const decoded = Buffer.from(payload, "base64url").toString("utf8");\nreturn tryParseJson(decoded);'),
		).toBe(false);
		// Non-JWT base64url decode to bytes (no JSON.parse) is unrelated.
		expect(hasIdiom('const secret = new Uint8Array(Buffer.from(fragment, "base64url"));')).toBe(false);
	});

	it("no production source hand-rolls JWT payload decoding", async () => {
		const offenders: string[] = [];
		for (const { rel, body } of await sourceFiles()) {
			const key = rel.split(path.sep).join("/");
			if (EXEMPT.has(key)) continue;
			if (hasIdiom(body)) offenders.push(key);
		}
		expect(offenders, "hand-rolled JWT decode — call decodeJwtPayload from @veyyon/utils instead").toEqual([]);
	});
});
