/**
 * WHY: a static import or an early loader call can initialize URL execution for a
 * local operation, or before a disabled URL operation is rejected. A fresh process
 * exercises each URL-capable entrypoint first, then verifies shared range/search
 * caching and cancellation against a real loopback HTTP server. Search variants
 * come from the production schema. This does not cover remote provider outages or
 * converted document/image formats; their existing fetch suites remain separate.
 */
import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { searchSchema } from "../../src/tools/search/search";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const execFileAsync = promisify(execFile);
const urlSearchTypes = searchSchema.shape.type.options.filter(type => type !== "files");
const fixture = path.resolve(import.meta.dirname, "../fixtures/url-reader-runtime.ts");

for (const firstAction of ["read", ...urlSearchTypes]) {
	it(`loads URL execution on the first enabled ${firstAction} operation, not before`, async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const { stdout, stderr } = await execFileAsync(process.execPath, [fixture, firstAction], {
				env,
				timeout: 10_000,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
			});
			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toMatchObject({
				firstAction,
				requests: 1,
				disabledReaderStayedUnloaded: true,
				cacheShared: true,
				cancellationPreventedRequest: true,
			});
		} finally {
			cleanup();
		}
	}, 15_000);
}
