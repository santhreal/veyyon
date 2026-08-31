import { describe, expect, it } from "bun:test";
import { decodeJwtPayload } from "../src/jwt";
import { collectPackageSources, MEMBER_ROOTS, memberRootOf, type PackageSource } from "./support/package-sources";

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

	// Roots and keys come from the shared owner: this walk named `packages/` and could not see a
	// hand-rolled decode under any other root.

	function hasIdiom(text: string): boolean {
		return JWT_DECODE_IDIOMS.some(re => re.test(text));
	}

	// The sweep is the shared collector, which walks every declared member at whatever depth it
	// sits. The walk here read `<root>/<package>/src`, one level under each root, so
	// `hosts/terminal/engine`, `natives/bridge/bindings`, `python/veybot/web` and `kernel` itself
	// contributed nothing while the roots assertion below still listed them.
	//
	// Both shipped source and build scripts are in scope — a codegen script hand-rolled this decode
	// too.
	function sourceFiles(): Promise<PackageSource[]> {
		return collectPackageSources({ dirs: ["src", "scripts"] });
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

	// And the sweep opens every root the workspace declares. A root it never walked contributes no
	// file, so a hand-rolled decode under it is exempt by absence and the empty list below reads green.
	it("reads a module under every root the workspace declares", async () => {
		const keys = (await sourceFiles()).map(({ rel }) => rel);
		const roots = new Set(keys.map(memberRootOf));

		expect([...roots].sort()).toEqual([...MEMBER_ROOTS].sort());
		expect(keys).toContain("utils/src/jwt.ts");
	});

	it("no production source hand-rolls JWT payload decoding", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await sourceFiles()) {
			if (EXEMPT.has(rel)) continue;
			if (hasIdiom(text)) offenders.push(rel);
		}
		expect(offenders, "hand-rolled JWT decode — call decodeJwtPayload from @veyyon/utils instead").toEqual([]);
	});
});
