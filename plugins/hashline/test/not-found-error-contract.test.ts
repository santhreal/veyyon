/**
 * NotFoundError / isNotFound — patcher create-vs-update gate.
 */
import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, isNotFound, NotFoundError } from "@veyyon/hashline";

describe("NotFoundError", () => {
	it("has ENOENT code and path in message", () => {
		const err = new NotFoundError("missing.ts");
		expect(err.code).toBe("ENOENT");
		expect(err.name).toBe("NotFoundError");
		expect(err.message).toBe("File not found: missing.ts");
	});

	it("isNotFound true for NotFoundError and structural ENOENT", () => {
		expect(isNotFound(new NotFoundError("x"))).toBe(true);
		const e = new Error("nope") as Error & { code: string };
		e.code = "ENOENT";
		expect(isNotFound(e)).toBe(true);
		expect(isNotFound(new Error("other"))).toBe(false);
		expect(isNotFound(null)).toBe(false);
		expect(isNotFound("ENOENT")).toBe(false);
	});
});

describe("InMemoryFilesystem readText missing throws NotFound", () => {
	it("readText on missing path throws isNotFound", async () => {
		const fs = new InMemoryFilesystem();
		try {
			await fs.readText("ghost.ts");
			throw new Error("expected throw");
		} catch (e) {
			expect(isNotFound(e)).toBe(true);
		}
	});

	it("exists false for missing, true for present", async () => {
		const fs = new InMemoryFilesystem([["here.ts", "x"]]);
		expect(await fs.exists("here.ts")).toBe(true);
		expect(await fs.exists("gone.ts")).toBe(false);
	});
});
