import { describe, expect, it } from "bun:test";
import { shortenPath } from "../src/util";

// `shortenPath` is the single browser-safe owner (collab-web re-exports it, the
// coding-agent TUI has a separate Node owner). These lock the home-prefix
// collapse and the opt-in long-middle elision that HeaderBar relies on.
describe("shortenPath", () => {
	it("collapses a /home/<user> prefix to ~", () => {
		expect(shortenPath("/home/alice/proj/src/main.ts")).toBe("~/proj/src/main.ts");
		expect(shortenPath("/home/alice")).toBe("~");
	});

	it("collapses a /Users/<user> prefix to ~", () => {
		expect(shortenPath("/Users/bob/code/app.tsx")).toBe("~/code/app.tsx");
		expect(shortenPath("/Users/bob")).toBe("~");
	});

	it("leaves a non-home path unchanged", () => {
		expect(shortenPath("/etc/hosts")).toBe("/etc/hosts");
		expect(shortenPath("relative/path")).toBe("relative/path");
		expect(shortenPath("")).toBe("");
	});

	it("does not elide the middle without collapseAfter", () => {
		expect(shortenPath("/home/alice/a/b/c/d/e")).toBe("~/a/b/c/d/e");
	});

	it("elides a long middle when collapseAfter is set, keeping first + last two", () => {
		// The exact output collab-web's HeaderBar produced before this became the
		// shared owner: `/home/<user>/a/b/c/d/e` → `~` → 6 segments > 4 → `~/…/d/e`.
		expect(shortenPath("/home/alice/a/b/c/d/e", { collapseAfter: 4 })).toBe("~/…/d/e");
	});

	it("leaves a short path unelided even when collapseAfter is set", () => {
		expect(shortenPath("/home/alice/proj", { collapseAfter: 4 })).toBe("~/proj");
		expect(shortenPath("/home/alice/a/b/c", { collapseAfter: 4 })).toBe("~/a/b/c");
	});

	it("elides a non-home path once it exceeds collapseAfter", () => {
		expect(shortenPath("/var/lib/app/data/cache/blob", { collapseAfter: 4 })).toBe("/…/cache/blob");
	});
});
