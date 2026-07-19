/**
 * On-disk cache inspection for Transformers.js model repos, and the tiny-models
 * `list` action's disk-state column built on top of it. Everything runs against
 * a real temporary cache directory with planted files so the byte totals and
 * downloaded flags are asserted as concrete values, not shapes.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildTinyModelListing } from "@veyyon/coding-agent/cli/tiny-models-cli";
import { transformersRepoCacheState, transformersRepoDir } from "@veyyon/coding-agent/subprocess/transformers-cache";
import { TINY_LOCAL_MODELS } from "@veyyon/coding-agent/tiny/models";

async function makeCacheDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "veyyon-tiny-cache-"));
}

// Plant a file at <cacheDir>/<repo segments>/<relative>, creating parents.
async function plant(cacheDir: string, repo: string, relative: string, contents: string): Promise<void> {
	const full = path.join(transformersRepoDir(repo, cacheDir), relative);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, contents);
}

describe("transformersRepoCacheState", () => {
	it("reports not-downloaded with zero bytes when the repo directory is absent", async () => {
		const cacheDir = await makeCacheDir();
		try {
			expect(await transformersRepoCacheState("onnx-community/Absent-ONNX", cacheDir)).toEqual({
				downloaded: false,
				bytes: 0,
			});
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	it("counts every cached file but flags downloaded only once an .onnx weight exists", async () => {
		const cacheDir = await makeCacheDir();
		try {
			// config.json (13 bytes) + tokenizer.json (5 bytes), no weights yet.
			await plant(cacheDir, "org/model", "config.json", '{"a":"bcde"}\n'); // 13 bytes
			await plant(cacheDir, "org/model", "tokenizer.json", "xyz{}"); // 5 bytes
			expect(await transformersRepoCacheState("org/model", cacheDir)).toEqual({
				downloaded: false,
				bytes: 18,
			});

			// A nested onnx weight (7 bytes) flips downloaded and adds to the total.
			await plant(cacheDir, "org/model", "onnx/model_q4.onnx", "weights"); // 7 bytes
			expect(await transformersRepoCacheState("org/model", cacheDir)).toEqual({
				downloaded: true,
				bytes: 25,
			});
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	it("splits the repo id into path segments under the cache root", async () => {
		const cacheDir = await makeCacheDir();
		try {
			expect(transformersRepoDir("onnx-community/LFM2-350M-ONNX", cacheDir)).toBe(
				path.join(cacheDir, "onnx-community", "LFM2-350M-ONNX"),
			);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});

describe("buildTinyModelListing", () => {
	it("marks exactly the planted model downloaded with its real cached size", async () => {
		const cacheDir = await makeCacheDir();
		try {
			const target = TINY_LOCAL_MODELS[0];
			await plant(cacheDir, target.repo, "onnx/model_q4.onnx", "0123456789"); // 10 bytes
			await plant(cacheDir, target.repo, "config.json", "{}"); // 2 bytes

			const listing = await buildTinyModelListing(cacheDir);
			expect(listing).toHaveLength(TINY_LOCAL_MODELS.length);

			const targetRow = listing.find(row => row.key === target.key);
			expect(targetRow).toBeDefined();
			expect(targetRow?.downloaded).toBe(true);
			expect(targetRow?.cachedBytes).toBe(12);

			// Every other catalog model is untouched on disk.
			for (const row of listing) {
				if (row.key === target.key) continue;
				expect(row.downloaded).toBe(false);
				expect(row.cachedBytes).toBe(0);
			}
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});
