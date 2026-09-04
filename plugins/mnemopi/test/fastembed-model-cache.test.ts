import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureFastembedModelSidecars } from "../src/core/fastembed-model-cache";

describe("fastembed model cache repair", () => {
	it("downloads missing config and tokenizer sidecars without overwriting cached files", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-fastembed-"));
		const model = "fast-bge-base-en-v1.5";
		const modelDir = path.join(cacheDir, model);
		const requested: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				(input: string | URL | Request, _init?: RequestInit) => {
					const url = String(input);
					requested.push(url);
					return Promise.resolve(new Response(`body:${path.basename(url)}`));
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		try {
			await fs.mkdir(modelDir, { recursive: true });
			await Bun.write(path.join(modelDir, "tokenizer.json"), "cached-tokenizer");

			expect(await ensureFastembedModelSidecars(model, cacheDir)).toBe(true);

			expect(requested).toEqual([
				"https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/config.json",
				"https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/tokenizer_config.json",
				"https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/special_tokens_map.json",
			]);
			expect(await Bun.file(path.join(modelDir, "config.json")).text()).toBe("body:config.json");
			expect(await Bun.file(path.join(modelDir, "tokenizer.json")).text()).toBe("cached-tokenizer");
			expect(await Bun.file(path.join(modelDir, "tokenizer_config.json")).text()).toBe("body:tokenizer_config.json");
			expect(await Bun.file(path.join(modelDir, "special_tokens_map.json")).text()).toBe(
				"body:special_tokens_map.json",
			);
		} finally {
			fetchSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	it("throws with the model, file, repo, and HTTP status when a sidecar download fails", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-fastembed-fail-"));
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				(_input: string | URL | Request, _init?: RequestInit) =>
					Promise.resolve(new Response("gone", { status: 404, statusText: "Not Found" })),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		try {
			// config.json is the first sidecar, so the 404 surfaces on it before any write.
			expect(ensureFastembedModelSidecars("fast-bge-small-en", cacheDir)).rejects.toThrow(
				"Failed to download fast-bge-small-en config.json from BAAI/bge-small-en: 404 Not Found",
			);
			await Bun.sleep(0);
			// A failed download writes nothing to the cache directory.
			expect(await Bun.file(path.join(cacheDir, "fast-bge-small-en", "config.json")).exists()).toBe(false);
		} finally {
			fetchSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	/**
	 * Why: concurrent initialization of the same model must share one repair and
	 * create its directory, or duplicate downloads race to overwrite cache files.
	 */
	it("coalesces concurrent repairs into a newly created model directory", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-fastembed-concurrent-"));
		const requested: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request) => {
					requested.push(String(input));
					return new Response(`body:${path.basename(String(input))}`);
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		try {
			expect(
				await Promise.all([
					ensureFastembedModelSidecars("fast-bge-small-en", cacheDir),
					ensureFastembedModelSidecars("fast-bge-small-en", cacheDir),
				]),
			).toEqual([true, true]);
			expect(requested).toHaveLength(4);
			expect(new Set(requested).size).toBe(4);
			expect(await Bun.file(path.join(cacheDir, "fast-bge-small-en", "config.json")).text()).toBe(
				"body:config.json",
			);
		} finally {
			fetchSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	/**
	 * Why: an aborted shared repair must be evicted from the in-flight cache so a
	 * later initializer can retry instead of inheriting the cancelled rejection.
	 */
	it("retries after a shared sidecar repair is cancelled", async () => {
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-fastembed-abort-"));
		let calls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request) => {
					calls += 1;
					if (calls === 1) throw new DOMException("cancelled", "AbortError");
					return new Response(`body:${path.basename(String(input))}`);
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		try {
			await expect(ensureFastembedModelSidecars("fast-bge-base-en", cacheDir)).rejects.toHaveProperty(
				"name",
				"AbortError",
			);
			expect(await ensureFastembedModelSidecars("fast-bge-base-en", cacheDir)).toBe(true);
			expect(calls).toBe(5);
		} finally {
			fetchSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	it("reports unsupported fastembed cache names without network access", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				() => {
					throw new Error("fetch should not run");
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		try {
			expect(await ensureFastembedModelSidecars("unknown-model", "/tmp/missing")).toBe(false);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
