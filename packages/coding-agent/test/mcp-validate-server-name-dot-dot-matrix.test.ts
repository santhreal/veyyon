/**
 * validateServerName rejects . and .. (product fix) and other illegal names;
 * accepts simple identifiers.
 */
import { describe, expect, it } from "bun:test";
import { validateServerName } from "@veyyon/coding-agent/mcp/config-writer";

describe("validateServerName matrix", () => {
	const good = ["github", "my-server", "a", "srv_1", "cloudflare", "a.b", "ns:tool"];
	for (const name of good) {
		it(`accepts ${JSON.stringify(name)}`, () => {
			expect(validateServerName(name)).toBeUndefined();
		});
	}

	const bad = [".", "..", "", " ", "a/b", "a b", "../x", "./x", "foo/bar"];
	for (const name of bad) {
		it(`rejects ${JSON.stringify(name)}`, () => {
			const err = validateServerName(name);
			expect(err).toBeDefined();
			expect(typeof err).toBe("string");
			expect(err!.length).toBeGreaterThan(0);
		});
	}

	it(". and .. are explicitly rejected (product fix)", () => {
		expect(validateServerName(".")).toContain("path segment");
		expect(validateServerName("..")).toContain("path segment");
	});
});
