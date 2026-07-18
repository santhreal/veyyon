/**
 * Locks the single owner of the internal:// extension → content-type mapping
 * (src/internal-urls/content-type.ts). Behavior tests pin the exact mapping;
 * the ONE-PLACE test fails if skill/local/vault (or any sibling protocol)
 * re-introduces a local `getContentType` instead of importing the shared one,
 * which is how the three copies drifted before (BACKLOG H1-7 / DEDUP).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getContentType } from "../../src/internal-urls/content-type";

describe("getContentType", () => {
	it("maps .md to text/markdown", () => {
		expect(getContentType("notes.md")).toBe("text/markdown");
		expect(getContentType("/abs/deep/dir/README.md")).toBe("text/markdown");
	});

	it("maps .json to application/json", () => {
		expect(getContentType("config.json")).toBe("application/json");
	});

	it("falls back to text/plain for anything else", () => {
		expect(getContentType("script.ts")).toBe("text/plain");
		expect(getContentType("data.yaml")).toBe("text/plain");
		expect(getContentType("LICENSE")).toBe("text/plain");
		expect(getContentType("archive.tar.gz")).toBe("text/plain");
	});

	it("is case-insensitive on the extension", () => {
		expect(getContentType("NOTES.MD")).toBe("text/markdown");
		expect(getContentType("Config.JSON")).toBe("application/json");
	});

	it("keys off only the final extension, not earlier dots", () => {
		expect(getContentType("a.md.json")).toBe("application/json");
		expect(getContentType("a.json.md")).toBe("text/markdown");
		expect(getContentType("v1.2.3.txt")).toBe("text/plain");
	});
});

describe("getContentType has exactly one owner (ONE-PLACE lock)", () => {
	const protocolDir = path.resolve(import.meta.dir, "../../src/internal-urls");
	const sources = readdirSync(protocolDir).filter(name => name.endsWith("-protocol.ts") && name !== "content-type.ts");

	it("no *-protocol.ts declares its own getContentType", () => {
		const offenders: string[] = [];
		for (const name of sources) {
			const text = readFileSync(path.join(protocolDir, name), "utf-8");
			if (/(?:function|const)\s+getContentType\b/.test(text)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});

	it("every protocol that resolves file content types imports the shared owner", () => {
		for (const name of ["skill-protocol.ts", "local-protocol.ts", "vault-protocol.ts"]) {
			const text = readFileSync(path.join(protocolDir, name), "utf-8");
			expect(text).toContain('from "./content-type"');
		}
	});
});
