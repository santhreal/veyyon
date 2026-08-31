/**
 * missingSnapshotTagMessage exact path embedding.
 */
import { describe, expect, it } from "bun:test";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";
import { missingSnapshotTagMessage } from "../src/messages";

describe("missingSnapshotTagMessage exact", () => {
	const paths = ["a.ts", "src/foo.ts", "pkg/nested/x.tsx"];
	for (const p of paths) {
		it(p, () => {
			const m = missingSnapshotTagMessage(p);
			expect(m).toContain(p);
			expect(m).toContain(`${HL_FILE_PREFIX}${p}${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}`);
			expect(m).toContain("write tool");
		});
	}
});
