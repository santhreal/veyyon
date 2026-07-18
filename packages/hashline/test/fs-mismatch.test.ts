import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Filesystem, InMemoryFilesystem, isNotFound, NodeFilesystem, NotFoundError } from "../src/fs";
import { MismatchError, parseTag, validateLineRef } from "../src/mismatch";

class MinimalFs extends Filesystem {
	store = new Map<string, string>();
	async readText(path: string): Promise<string> {
		const text = this.store.get(path);
		if (text === undefined) throw new NotFoundError(path);
		return text;
	}
	async writeText(path: string, content: string) {
		this.store.set(path, content);
		return { text: content };
	}
}

describe("Filesystem base defaults", () => {
	it("delete and move are unsupported by default", async () => {
		const fs = new MinimalFs();
		await expect(fs.delete("a")).rejects.toThrow(/does not support delete: a/);
		await expect(fs.move("a", "b")).rejects.toThrow(/does not support move: a -> b/);
	});

	it("exists probes via readText, distinguishing not-found from real errors", async () => {
		const fs = new MinimalFs();
		fs.store.set("present", "x");
		expect(await fs.exists("present")).toBe(true);
		expect(await fs.exists("absent")).toBe(false);
		const broken = new (class extends MinimalFs {
			override async readText(): Promise<string> {
				throw new Error("EACCES-ish failure");
			}
		})();
		await expect(broken.exists("any")).rejects.toThrow("EACCES-ish failure");
	});

	it("canonicalPath and tag-path recovery default to identity/allow", () => {
		const fs = new MinimalFs();
		expect(fs.canonicalPath("rel/p.ts")).toBe("rel/p.ts");
		expect(fs.allowTagPathRecovery("a.ts", "/x/a.ts")).toBe(true);
	});
});

describe("isNotFound", () => {
	it("accepts NotFoundError, ENOENT-coded errors, and nothing else", () => {
		expect(isNotFound(new NotFoundError("p"))).toBe(true);
		const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
		expect(isNotFound(enoent)).toBe(true);
		expect(isNotFound(new Error("other"))).toBe(false);
		expect(isNotFound("ENOENT")).toBe(false);
	});

	it("NotFoundError carries code, name, and optional cause", () => {
		const cause = new Error("root");
		const err = new NotFoundError("some/path", cause);
		expect(err.code).toBe("ENOENT");
		expect(err.name).toBe("NotFoundError");
		expect(err.message).toBe("File not found: some/path");
		expect((err as Error & { cause?: unknown }).cause).toBe(cause);
		expect((new NotFoundError("p") as Error & { cause?: unknown }).cause).toBeUndefined();
	});
});

describe("InMemoryFilesystem", () => {
	it("supports seeded construction, move preserving or replacing content, and delete", async () => {
		const fs = new InMemoryFilesystem([["a.txt", "alpha"]]);
		expect(await fs.readText("a.txt")).toBe("alpha");
		await fs.move("a.txt", "b.txt");
		expect(await fs.exists("a.txt")).toBe(false);
		expect(await fs.readText("b.txt")).toBe("alpha");
		await fs.move("b.txt", "c.txt", "replaced");
		expect(await fs.readText("c.txt")).toBe("replaced");
		await fs.delete("c.txt");
		await expect(fs.delete("c.txt")).rejects.toThrow(NotFoundError);
		await expect(fs.move("missing", "x")).rejects.toThrow(NotFoundError);
	});

	it("exposes sync set/get/clear/entries helpers", async () => {
		const fs = new InMemoryFilesystem();
		fs.set("k", "v");
		expect(fs.get("k")).toBe("v");
		expect([...fs.entries()]).toEqual([["k", "v"]]);
		fs.clear();
		expect(fs.get("k")).toBeUndefined();
	});
});

describe("NodeFilesystem", () => {
	it("round-trips text, bytes, move, and delete on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hashline-fs-"));
		try {
			const fs = new NodeFilesystem();
			const a = join(dir, "a.txt");
			await fs.writeText(a, "hello");
			expect(await fs.readText(a)).toBe("hello");
			expect(new TextDecoder().decode(await fs.readBinary(a))).toBe("hello");
			const b = join(dir, "b.txt");
			await fs.move(a, b);
			expect(await fs.exists(a)).toBe(false);
			expect(await fs.readText(b)).toBe("hello");
			await fs.move(b, join(dir, "c.txt"), "new content");
			expect(await fs.readText(join(dir, "c.txt"))).toBe("new content");
			await fs.delete(join(dir, "c.txt"));
			expect(await fs.exists(join(dir, "c.txt"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("maps missing paths to NotFoundError across read/readBinary/delete/move", async () => {
		const fs = new NodeFilesystem();
		const missing = join(tmpdir(), "hashline-definitely-missing.txt");
		await expect(fs.readText(missing)).rejects.toThrow(NotFoundError);
		await expect(fs.readBinary(missing)).rejects.toThrow(NotFoundError);
		await expect(fs.delete(missing)).rejects.toThrow(NotFoundError);
		await expect(fs.move(missing, join(tmpdir(), "x"))).rejects.toThrow(NotFoundError);
	});

	it("canonicalPath resolves to an absolute path", () => {
		const fs = new NodeFilesystem();
		expect(isAbsolute(fs.canonicalPath("rel.txt"))).toBe(true);
	});
});

describe("parseTag / validateLineRef", () => {
	it("parses bare and decorated line references", () => {
		expect(parseTag("42")).toEqual({ line: 42 });
		expect(parseTag(" > 7")).toEqual({ line: 7 });
		expect(parseTag("*42:foo")).toEqual({ line: 42 });
		expect(parseTag("+-3:x")).toEqual({ line: 3 });
	});

	it("rejects malformed references and line 0", () => {
		expect(() => parseTag("abc")).toThrow(/Invalid line reference/);
		expect(() => parseTag("")).toThrow(/Invalid line reference/);
		expect(() => parseTag("0")).toThrow(/must be >= 1/);
	});

	it("validateLineRef bounds-checks against the file", () => {
		const lines = ["a", "b"];
		expect(() => validateLineRef({ line: 1 }, lines)).not.toThrow();
		expect(() => validateLineRef({ line: 3 }, lines)).toThrow(/Line 3 does not exist \(file has 2 lines\)/);
		expect(() => validateLineRef({ line: 0 }, lines)).toThrow(/does not exist/);
	});
});

describe("MismatchError", () => {
	const base = {
		path: "src/foo.ts",
		expectedFileHash: "1A2B",
		actualFileHash: "3C4D",
		fileLines: ["one", "two", "three"],
	};

	it("renders the drifted-file rejection when the hash is recognized", () => {
		const err = new MismatchError({ ...base, anchorLines: [2] });
		expect(err.name).toBe("MismatchError");
		expect(err.message).toContain("Edit rejected for src/foo.ts: file changed between read and edit.");
		expect(err.message).toContain("#1A2B");
		expect(err.message).toContain("#3C4D");
		expect(err.hashRecognized).toBe(true);
		expect(err.displayMessage).toBe(err.message);
	});

	it("renders the fabricated-hash rejection when the hash is unrecognized", () => {
		const err = new MismatchError({ ...base, hashRecognized: false });
		expect(err.message).toContain("is not from this session");
		expect(err.message).toContain("never invent the tag");
		expect(err.anchorLines).toEqual([]);
	});

	it("omits the path clause when no path is given", () => {
		const err = new MismatchError({ ...base, path: undefined });
		expect(err.message).toContain("Edit rejected: file changed");
		expect(err.path).toBeUndefined();
	});
});
