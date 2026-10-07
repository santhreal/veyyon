// WHY: the auth broker and the auth gateway admit a request through one bearer allow-list. A token
// that differs from an allowed one in any byte, in its length, or only by being a prefix or an
// extension of it must be turned away, and an allowed token must be admitted wherever it sits in the
// list and however the `Bearer` scheme is cased or padded. The broker compared tokens with a set
// lookup and the gateway with a constant-time loop; both now read `BearerAllowList`, and the public
// `isAuthorized` function delegates to it, so every case below runs through both entry points.
//
// Not caught: the constant-time property itself. Every token is compared on every request and the
// comparison does not stop at the first differing byte, but no assertion here measures timing.
import { describe, expect, it } from "bun:test";
import { BearerAllowList, isAuthorized } from "@veyyon/ai/utils/http-server";

function request(authorization?: string): Request {
	const headers = new Headers();
	if (authorization !== undefined) headers.set("authorization", authorization);
	return new Request("http://broker.test/v1/snapshot", { headers });
}

type Admission = (req: Request) => boolean;

const ENTRY_POINTS: Record<string, (tokens: string[]) => Admission> = {
	BearerAllowList: tokens => {
		const list = new BearerAllowList(tokens);
		return req => list.authorizes(req);
	},
	isAuthorized: tokens => {
		const set = new Set(tokens);
		return req => isAuthorized(req, set);
	},
};

describe.each(Object.entries(ENTRY_POINTS))("a bearer check through %s", (_name, allow) => {
	const admits = allow(["alpha-token", "beta-token-2"]);

	it.each([
		["the first allowed token", "Bearer alpha-token"],
		["the second allowed token", "Bearer beta-token-2"],
		["a lower-case scheme", "bearer alpha-token"],
		["an upper-case scheme with padding around the token", "BEARER   alpha-token  "],
	])("admits %s", (_case, authorization) => {
		expect(admits(request(authorization))).toBe(true);
	});

	it.each([
		["no Authorization header", undefined],
		["an empty header", ""],
		["another scheme", "Basic alpha-token"],
		["a token without a scheme", "alpha-token"],
		["a scheme without a token", "Bearer"],
		["a token differing in its last byte", "Bearer alpha-tokeN"],
		["a token differing in its first byte", "Bearer Alpha-token"],
		["a prefix of an allowed token", "Bearer alpha-toke"],
		["an extension of an allowed token", "Bearer alpha-token-2"],
		["two allowed tokens joined", "Bearer alpha-tokenbeta-token-2"],
		["a token followed by a non-breaking space", "Bearer alpha-token\u00a0"],
	])("turns away %s", (_case, authorization) => {
		expect(admits(request(authorization))).toBe(false);
	});

	it("turns away a token that differs from an allowed one only by trailing zero bytes", () => {
		// A zero byte pads the shorter input during the comparison, so only the length term keeps
		// `token` apart from `token\0`.
		expect(allow(["token\u0000"])(request("Bearer token"))).toBe(false);
	});

	it("admits a token listed twice", () => {
		expect(allow(["same", "same"])(request("Bearer same"))).toBe(true);
	});

	it("admits every request when no token is allowed", () => {
		const open = allow([]);
		expect(open(request())).toBe(true);
		expect(open(request("Basic anything"))).toBe(true);
	});
});
