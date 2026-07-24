/**
 * ONE-PLACE lock for the paste byte cap.
 *
 * Why this suite exists: the 64 MiB bound on a runaway bracketed paste was
 * defined twice — `DEFAULT_BYTE_LIMIT` in bracketed-paste.ts and a private
 * `PASTE_MAX_BYTES` copy in stdin-buffer.ts. Byte-identical copies drift:
 * whoever tunes one cap will not know the sibling defense-in-depth layer
 * exists. The cap now has exactly ONE owner (`PASTE_MAX_BYTES`, exported from
 * bracketed-paste.ts) and this suite fails if a second inline copy of the
 * literal reappears in either module.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PASTE_MAX_BYTES } from "@veyyon/tui/bracketed-paste";

const srcDir = path.join(import.meta.dir, "..", "src");

describe("paste byte cap ownership", () => {
	it("the exported owner carries the intended 64 MiB value", () => {
		expect(PASTE_MAX_BYTES).toBe(64 * 1024 * 1024);
	});

	it("the cap literal appears exactly once across the two paste layers", async () => {
		const bracketed = await Bun.file(path.join(srcDir, "bracketed-paste.ts")).text();
		const stdinBuffer = await Bun.file(path.join(srcDir, "stdin-buffer.ts")).text();
		const occurrences = (bracketed + stdinBuffer).split("64 * 1024 * 1024").length - 1;
		expect(occurrences).toBe(1);
		// stdin-buffer consumes the owner, never a local copy.
		expect(stdinBuffer).toContain('import { PASTE_MAX_BYTES } from "./bracketed-paste"');
		expect(stdinBuffer).not.toContain("const PASTE_MAX_BYTES");
	});
});
