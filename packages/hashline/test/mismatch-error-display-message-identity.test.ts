/**
 * MismatchError.displayMessage equals message; rejectionHeader arrays are exact.
 */
import { describe, expect, it } from "bun:test";
import { MismatchError } from "../src/mismatch";
import { HL_FILE_HASH_SEP } from "../src/format";

describe("MismatchError displayMessage identity", () => {
	it("displayMessage === message for recognized and unrecognized", () => {
		const recognized = new MismatchError({
			path: "p.ts",
			expectedFileHash: "AAAA",
			actualFileHash: "BBBB",
			fileLines: ["x"],
			anchorLines: [1],
			hashRecognized: true,
		});
		expect(recognized.displayMessage).toBe(recognized.message);
		expect(recognized.message).toContain(`${HL_FILE_HASH_SEP}AAAA`);

		const unrecognized = new MismatchError({
			expectedFileHash: "DEAD",
			actualFileHash: "BEEF",
			fileLines: [],
			hashRecognized: false,
		});
		expect(unrecognized.displayMessage).toBe(unrecognized.message);
		expect(unrecognized.message).toContain("not from this session");
	});

	it("rejectionHeader lines are two for both branches", () => {
		const rec = MismatchError.rejectionHeader({
			expectedFileHash: "1111",
			actualFileHash: "2222",
			fileLines: [],
			hashRecognized: true,
		});
		expect(rec).toHaveLength(2);
		const un = MismatchError.rejectionHeader({
			expectedFileHash: "1111",
			actualFileHash: "2222",
			fileLines: [],
			hashRecognized: false,
		});
		expect(un).toHaveLength(2);
		expect(un[0]).toContain("not from this session");
		expect(rec[0]).toContain("file changed");
	});
});
