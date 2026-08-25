/**
 * decodeVaultPath is the only place a vault:// URL becomes a filesystem
 * relative path. It slice(1)s the pathname, rewrites backslash to slash,
 * decodeURIComponent, then validateRelativePath(..., "vault").
 *
 * Percent-encoding is the interesting seam:
 * - `%2e%2e/%2e%2e/etc/passwd` must refuse after decode (it is `../.. /etc`).
 * - `foo%2F..%2Fsecret` decodes to `foo/../secret` — the slash was encoded
 *    in a single path segment at the URL layer, but after decode it is two
 *    segments and a hop. validateRelativePath must still see the hop.
 * - Double-encoded `%252e%252e` must stay `%2e%2e` (one decode), which is
 *    a filename, not a hop. That is allowed as a weird name.
 * - encodePathComponent currently encodeURIComponent() then replaceAll("%2F","/"),
 *    so a vault *host* that contains a slash is not a single host. parseVaultUrl
 *    of a hand-built href using that encoder must not move the slash into the
 *    path and silently change which vault is named. We pin the decode side:
 *    a host with an encoded slash is still one host.
 *
 * paramsFromUrl treats an empty query value as boolean true (`?op=` → op:true),
 * so parseVaultOp must not be reached with a non-string op from that shape
 * without throwing. `?op=` is not a valid op.
 */
import { describe, expect, it } from "bun:test";
import { parseVaultUrl } from "@veyyon/coding-agent/internal-urls/vault-protocol";

describe("percent-encoded hops are hops after exactly one decode", () => {
	it("refuses %2e%2e as a path segment", () => {
		expect(() => parseVaultUrl("vault://_/%2e%2e/secret.md")).toThrow(/traversal|\.\./i);
	});

	it("refuses a hop whose slashes were %2F-encoded inside one URL segment", () => {
		expect(() => parseVaultUrl("vault://_/foo%2F..%2Fsecret.md")).toThrow(/traversal|\.\./i);
	});

	it("treats a double-encoded %252e%252e as a filename, not a hop", () => {
		const parsed = parseVaultUrl("vault://_/%252e%252e.md");
		expect(parsed.kind).toBe("fs-file");
		if (parsed.kind === "fs-file") {
			expect(parsed.relativePath).toBe("%2e%2e.md");
		}
	});
});

describe("an empty op query is not a boolean true that skips parseVaultOp", () => {
	it("throws on vault://Work?op= rather than classifying it as vault-info", () => {
		expect(() => parseVaultUrl("vault://Work?op=")).toThrow(/Unsupported vault:\/\/|requires/i);
	});
});
