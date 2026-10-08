import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { shouldBypassProxy } from "@veyyon/ai/utils/proxy";

/**
 * Defect: a NO_PROXY entry naming an IPv6 address never matched. A URL's hostname keeps the
 * address's brackets while the rule parser stripped them from the entry before comparing, and a
 * bare address lost its last group to the port split, so `2001:db8::1`, `[2001:db8::1]` and
 * `[2001:db8::1]:8443` each sent the request through the proxy.
 *
 * Class: every spelling of an entry for every host kind (a name, an IPv4 address, an IPv6 address
 * bare, bracketed, uncompressed or in capitals), each with no port, the request's port or another
 * port, bypasses the proxy exactly when it names the request's host and any port it gives is the
 * request's port. A different host of the same kind never matches.
 *
 * Gap: CIDR ranges and `*.`-prefixed entries are not forms this parser reads, and an IPv6 zone id
 * is compared as written.
 */

interface HostKind {
	kind: string;
	/** The host as a URL authority writes it. */
	authority: string;
	/** Every spelling of an entry that names the host. */
	spellings: string[];
	/** An entry naming a different host of the same kind. */
	other: string;
}

const KINDS: HostKind[] = [
	{
		kind: "name",
		authority: "api.example.com",
		spellings: ["api.example.com", "API.Example.COM"],
		other: "api.example.org",
	},
	{ kind: "IPv4", authority: "203.0.113.7", spellings: ["203.0.113.7"], other: "203.0.113.8" },
	{
		kind: "IPv6",
		authority: "[2001:db8::1]",
		spellings: [
			"2001:db8::1",
			"[2001:db8::1]",
			"2001:0db8:0000:0000:0000:0000:0000:0001",
			"2001:DB8::1",
			"[2001:DB8:0::1]",
		],
		other: "2001:db8::2",
	},
];

const REQUEST_PORT = "8443";

/** `spelling` limited to `port`; a bare IPv6 address takes brackets so the port stays separable. */
function withPort(spelling: string, port: string): string {
	const host = spelling.includes(":") && !spelling.startsWith("[") ? `[${spelling}]` : spelling;
	return `${host}:${port}`;
}

let saved: { upper: string | undefined; lower: string | undefined };
beforeEach(() => {
	saved = { upper: process.env.NO_PROXY, lower: process.env.no_proxy };
	delete process.env.no_proxy;
});
afterEach(() => {
	if (saved.upper === undefined) delete process.env.NO_PROXY;
	else process.env.NO_PROXY = saved.upper;
	if (saved.lower === undefined) delete process.env.no_proxy;
	else process.env.no_proxy = saved.lower;
});

function bypasses(entry: string, authority: string): boolean {
	process.env.NO_PROXY = entry;
	return shouldBypassProxy(new URL(`https://${authority}:${REQUEST_PORT}/v1`));
}

describe("a NO_PROXY entry matches its host however the entry is written", () => {
	for (const { kind, authority, spellings, other } of KINDS) {
		for (const spelling of spellings) {
			it(`${kind} entry ${spelling} bypasses ${authority}`, () => {
				expect(bypasses(spelling, authority)).toBe(true);
			});
			it(`${kind} entry ${spelling} on the request's port bypasses ${authority}`, () => {
				expect(bypasses(withPort(spelling, REQUEST_PORT), authority)).toBe(true);
			});
			it(`${kind} entry ${spelling} on another port does not bypass ${authority}`, () => {
				expect(bypasses(withPort(spelling, "9443"), authority)).toBe(false);
			});
		}
		it(`${kind} entry ${other} does not bypass ${authority}`, () => {
			expect(bypasses(other, authority)).toBe(false);
			expect(bypasses(withPort(other, REQUEST_PORT), authority)).toBe(false);
		});
	}
});
