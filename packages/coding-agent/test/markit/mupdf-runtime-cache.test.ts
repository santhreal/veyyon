import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializeEmbeddedMupdf } from "@veyyon/coding-agent/markit/converters/pdf/extract";
import { __resetDirsFromEnvForTests, getAgentDir, removeWithRetries, setAgentDir } from "@veyyon/utils";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeMupdfCacheDir = useTrackedTempDirs("veyyon-mupdf-cache-");

/**
 * CACHE-2: the materialized mupdf runtime must never be imported half-written.
 *
 * A compiled binary cannot load mupdf from `node_modules`, so its JS modules
 * ride along as embedded assets and are written to a version-keyed cache dir the
 * first time someone opens a PDF. That cache is then `import`ed, which makes it
 * the one cache in the tree whose contents are EXECUTED. A truncated file there
 * does not degrade PDF conversion, it throws a syntax error from a path the user
 * has no reason to associate with a PDF, and it never repairs itself.
 *
 * Two failures are covered here and they need different defenses:
 *
 *  - a process killed MID-WRITE. Defended by writing to a temp file and
 *    renaming, so the visible path only ever holds a complete file.
 *  - a file that is already wrong when the process starts, from an unclean
 *    shutdown that kept the inode's size but lost its data blocks, or from an
 *    older build that wrote this dir directly. Defended by comparing BYTES, not
 *    sizes, before deciding a cache entry can be reused. The size check that
 *    used to guard this accepts a same-length NUL-filled file, which is exactly
 *    what an ext4 crash produces.
 *
 * The agent dir is moved to a temp root for every test, because this code writes
 * under `getAgentDir()` and must never touch the developer's real `~/.veyyon`.
 */
describe("the materialized mupdf runtime cache", () => {
	let root = "";
	let assetDir = "";
	let embedded = { version: "1.26.4", mupdfJs: "", mupdfWasmJs: "" };

	/** The exact bytes each embedded asset carries, so identity is assertable. */
	const MUPDF_JS = 'import "./mupdf-wasm.js";\nexport const marker = "real mupdf.js";\n';
	const MUPDF_WASM_JS = 'export const marker = "real mupdf-wasm.js";\n';

	beforeEach(() => {
		root = makeMupdfCacheDir();
		assetDir = path.join(root, "assets");
		fs.mkdirSync(assetDir, { recursive: true });
		const mupdfJs = path.join(assetDir, "mupdf.js");
		const mupdfWasmJs = path.join(assetDir, "mupdf-wasm.js");
		fs.writeFileSync(mupdfJs, MUPDF_JS);
		fs.writeFileSync(mupdfWasmJs, MUPDF_WASM_JS);
		embedded = { version: "1.26.4", mupdfJs, mupdfWasmJs };
		setAgentDir(path.join(root, "agent"));
	});

	afterEach(async () => {
		delete process.env.VEYYON_CODING_AGENT_DIR;
		__resetDirsFromEnvForTests();
		if (root) {
			await removeWithRetries(guardDestructivePath(root, "mupdf-runtime-cache"));
			root = "";
		}
	});

	/** The version-keyed directory the runtime is materialized into. */
	function cacheDir(): string {
		return path.join(getAgentDir(), "cache", "mupdf", embedded.version);
	}

	test("the agent dir really is the temp root, so nothing here touches ~/.veyyon", () => {
		// The isolation assertion proves only the path it names, and this suite
		// writes through exactly one: `getAgentDir()`. Without this, a failure to
		// redirect it would go unnoticed until the developer's real cache changed.
		expect(getAgentDir().startsWith(os.tmpdir())).toBe(true);
		expect(cacheDir().startsWith(os.tmpdir())).toBe(true);
	});

	test("writes both modules with their exact bytes, side by side", () => {
		// `mupdf.js` statically imports `./mupdf-wasm.js`, so the sibling layout is
		// part of the contract: one file without the other imports to an error.
		const entry = materializeEmbeddedMupdf(embedded);

		expect(entry).toBe(path.join(cacheDir(), "mupdf.js"));
		expect(fs.readFileSync(entry, "utf8")).toBe(MUPDF_JS);
		expect(fs.readFileSync(path.join(cacheDir(), "mupdf-wasm.js"), "utf8")).toBe(MUPDF_WASM_JS);
	});

	test("leaves no temp file behind, so nothing else in the dir can be imported", () => {
		// The atomic write's debris would sit next to the entry point. A stray
		// `.tmp` is not importable, but it is the visible sign of a torn write and
		// it accumulates once per launch if cleanup is wrong.
		materializeEmbeddedMupdf(embedded);

		expect(fs.readdirSync(cacheDir()).sort()).toEqual(["mupdf-wasm.js", "mupdf.js"]);
	});

	describe("reuse", () => {
		test("a byte-identical cache is reused rather than rewritten", () => {
			// The whole point of the cache. Asserted by mtime because content alone
			// cannot distinguish "kept" from "rewritten with the same bytes".
			materializeEmbeddedMupdf(embedded);
			const target = path.join(cacheDir(), "mupdf.js");
			const before = fs.statSync(target).mtimeMs;

			fs.utimesSync(target, new Date(0), new Date(0));
			materializeEmbeddedMupdf(embedded);

			expect(fs.statSync(target).mtimeMs).toBe(0);
			expect(before).toBeGreaterThan(0);
		});

		test("a SAME-SIZE but different file is rewritten, not trusted", () => {
			// The regression this row exists for. The previous guard compared sizes,
			// so this file passed as valid and was imported forever.
			materializeEmbeddedMupdf(embedded);
			const target = path.join(cacheDir(), "mupdf.js");
			const corrupted = "x".repeat(MUPDF_JS.length);
			fs.writeFileSync(target, corrupted);
			expect(fs.statSync(target).size).toBe(Buffer.byteLength(MUPDF_JS));

			materializeEmbeddedMupdf(embedded);

			expect(fs.readFileSync(target, "utf8")).toBe(MUPDF_JS);
		});

		test("a NUL-filled file of the right length is rewritten", () => {
			// The precise artifact of an unclean shutdown on ext4: the inode keeps its
			// size, the data blocks come back as zeros. It is the most likely way this
			// cache goes bad in the field, and the most invisible.
			materializeEmbeddedMupdf(embedded);
			const target = path.join(cacheDir(), "mupdf.js");
			fs.writeFileSync(target, Buffer.alloc(Buffer.byteLength(MUPDF_JS)));

			materializeEmbeddedMupdf(embedded);

			expect(fs.readFileSync(target, "utf8")).toBe(MUPDF_JS);
		});

		test("a truncated file is rewritten", () => {
			// The plain half-written case, which the size check did catch. Kept so a
			// future rewrite of the comparison cannot regress it while fixing the
			// same-size case.
			materializeEmbeddedMupdf(embedded);
			const target = path.join(cacheDir(), "mupdf.js");
			fs.writeFileSync(target, MUPDF_JS.slice(0, 10));

			materializeEmbeddedMupdf(embedded);

			expect(fs.readFileSync(target, "utf8")).toBe(MUPDF_JS);
		});

		test("an empty file is rewritten", () => {
			// Created-then-killed. Zero bytes is a length mismatch, so this passed
			// before too; it is pinned because it is the outcome of a kill in the
			// narrowest window and it must not become a special case.
			materializeEmbeddedMupdf(embedded);
			const target = path.join(cacheDir(), "mupdf.js");
			fs.writeFileSync(target, "");

			materializeEmbeddedMupdf(embedded);

			expect(fs.readFileSync(target, "utf8")).toBe(MUPDF_JS);
		});

		test("damage to the SIBLING is repaired too, not only the entry point", () => {
			// `mupdf-wasm.js` is never named by the returned path, so it is the file a
			// per-entry check would forget. It is imported by `mupdf.js`, which makes
			// its damage just as fatal and considerably harder to trace.
			materializeEmbeddedMupdf(embedded);
			const sibling = path.join(cacheDir(), "mupdf-wasm.js");
			fs.writeFileSync(sibling, "y".repeat(MUPDF_WASM_JS.length));

			materializeEmbeddedMupdf(embedded);

			expect(fs.readFileSync(sibling, "utf8")).toBe(MUPDF_WASM_JS);
		});
	});

	describe("versioning", () => {
		test("a different version materializes into its own directory", () => {
			// The cache is keyed by the mupdf version the assets came from, so an
			// upgrade must not overwrite or reuse the previous runtime.
			materializeEmbeddedMupdf(embedded);
			const first = cacheDir();

			const next = { ...embedded, version: "1.27.0" };
			const entry = materializeEmbeddedMupdf(next);

			expect(entry).not.toBe(path.join(first, "mupdf.js"));
			expect(entry).toContain(path.join("mupdf", "1.27.0"));
			expect(fs.existsSync(path.join(first, "mupdf.js"))).toBe(true);
		});
	});

	describe("when the cache cannot be written", () => {
		test("it throws rather than returning a path to a file that is not there", () => {
			// Fail closed. Returning the path anyway would move the failure to the
			// `import`, where the error names a missing module instead of an
			// unwritable cache dir, and `loadMupdf`'s guidance would never be shown.
			const parent = path.join(getAgentDir(), "cache", "mupdf");
			fs.mkdirSync(parent, { recursive: true });
			fs.chmodSync(parent, 0o500);

			try {
				expect(() => materializeEmbeddedMupdf(embedded)).toThrow();
			} finally {
				fs.chmodSync(parent, 0o700);
			}
		});
	});
});
