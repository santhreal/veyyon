import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SILENT_UPDATE_REPORTER, updateViaBinaryAt } from "@veyyon/coding-agent/cli/update-cli";
import { removeWithRetries } from "@veyyon/utils";

/**
 * UPD-1, UPD-2, UPD-3: a failed binary update must leave the binary the user
 * already has exactly as it was, and must not litter the install directory.
 *
 * `update-cli.test.ts` proves the pieces in isolation: `verifyDownloadChecksum`
 * rejects a bad digest, `replaceBinaryForUpdate` restores its backup when the
 * post-install version check fails. Neither answers the question a user has
 * after a failed update, which is whether the command they type tomorrow still
 * works. That is a property of the whole sequence, and it is only observable by
 * driving the real download, verify and swap path against a real file on disk.
 *
 * So every test here writes a real "installed binary", makes one stage of the
 * update fail the way it fails in the field (the connection drops mid-stream,
 * the asset is missing, a proxy corrupts the bytes, the sidecar is unreachable),
 * and then asserts three things every time:
 *
 *  1. the failure was LOUD, naming what went wrong,
 *  2. the original file is byte-for-byte unchanged, and
 *  3. no partial `<binary>.new` was left behind, because a leftover partial is
 *     what turns one failed update into a broken install later.
 *
 * The third is not hypothetical: the temp file is written with mode 0755 next to
 * the real binary, so anything that leaves it there leaves an executable-looking
 * half-download in the install directory.
 */
describe("a failed binary update leaves the installed binary intact", () => {
	const tempDirs: string[] = [];
	const ORIGINAL_BYTES = "#!/bin/sh\necho 'veyyon/1.0.0'\n";
	const VERSION = "9.9.9";

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	/** A directory holding a real, executable stand-in for the installed binary. */
	async function installedBinary(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-binary-integrity-"));
		tempDirs.push(dir);
		const target = path.join(dir, "veyyon");
		await fs.writeFile(target, ORIGINAL_BYTES, { mode: 0o755 });
		return target;
	}

	/**
	 * Assert the install directory is exactly as it was: the original bytes, the
	 * executable bit, and nothing else added.
	 */
	async function expectUntouched(target: string): Promise<void> {
		expect(await fs.readFile(target, "utf8")).toBe(ORIGINAL_BYTES);
		const mode = (await fs.stat(target)).mode & 0o777;
		expect(mode & 0o111).toBeGreaterThan(0);
		const entries = await fs.readdir(path.dirname(target));
		// Named exactly: a `.new` or a `.bak` surviving a failure is the litter that
		// makes the NEXT update behave differently from this one.
		expect(entries).toEqual(["veyyon"]);
	}

	/**
	 * Route `fetch` by URL: the `.sha256` sidecar and the binary asset are two
	 * separate requests and the tests need to fail them independently.
	 */
	function routeFetch(handlers: { binary: () => Response | Promise<Response>; sidecar?: () => Response }): void {
		const impl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith(".sha256")) {
				if (!handlers.sidecar) throw new Error(`test did not expect a sidecar request for ${url}`);
				return handlers.sidecar();
			}
			return await handlers.binary();
		}) as unknown as typeof fetch;
		spyOn(globalThis, "fetch").mockImplementation(impl);
	}

	describe("the download never starts", () => {
		it("a missing release asset (404) fails naming the version and asset, changing nothing", async () => {
			const target = await installedBinary();
			routeFetch({ binary: () => new Response("Not Found", { status: 404, statusText: "Not Found" }) });

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow(/9\.9\.9/);
			await expectUntouched(target);
		});

		it("a 5xx from the release host fails loudly rather than installing nothing quietly", async () => {
			const target = await installedBinary();
			routeFetch({ binary: () => new Response("", { status: 503, statusText: "Service Unavailable" }) });

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow(/503/);
			await expectUntouched(target);
		});

		it("a 200 with no body is refused instead of writing a zero-byte binary", async () => {
			// The outcome this prevents is the worst one available: a zero-byte file with
			// the executable bit set, sitting on PATH under the name the user types.
			const target = await installedBinary();
			routeFetch({ binary: () => new Response(null, { status: 200 }) });

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow(/empty body/);
			await expectUntouched(target);
		});

		it("a connection failure propagates rather than being swallowed", async () => {
			const target = await installedBinary();
			spyOn(globalThis, "fetch").mockImplementation((async () => {
				throw new TypeError("Unable to connect. Is the computer able to access the url?");
			}) as unknown as typeof fetch);

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow(/Unable to connect/);
			await expectUntouched(target);
		});
	});

	describe("the download fails partway through", () => {
		it("a stream that errors mid-body removes its partial file and keeps the old binary", async () => {
			// UPD-1 stated precisely: the network drops after some bytes have landed. The
			// partial `.new` must not survive, because it is mode 0755 and sits beside the
			// real binary.
			const target = await installedBinary();
			routeFetch({
				binary: () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode("#!/bin/sh\necho partial"));
								controller.error(new Error("connection reset by peer"));
							},
						}),
						{ status: 200 },
					),
			});

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow();
			await expectUntouched(target);
		});
	});

	describe("the bytes arrive but do not verify", () => {
		/** The published digest of some OTHER content, so the download cannot match. */
		const WRONG_DIGEST = "0".repeat(64);

		function servesBinary(body: string) {
			return () => new Response(body, { status: 200 });
		}

		it("a digest mismatch refuses the install and keeps the old binary", async () => {
			// UPD-2. A tampered or corrupted download of the SAME version would sail past
			// a post-install `--version` check, so the checksum is the only thing standing
			// between the user and installing bytes nobody published.
			const target = await installedBinary();
			routeFetch({
				binary: servesBinary("#!/bin/sh\necho 'veyyon/9.9.9'\n"),
				sidecar: () => new Response(`${WRONG_DIGEST}  veyyon\n`, { status: 200 }),
			});

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow(/checksum|sha256/i);
			await expectUntouched(target);
		});

		it("names both digests so the failure is diagnosable rather than mysterious", async () => {
			const target = await installedBinary();
			routeFetch({
				binary: servesBinary("#!/bin/sh\necho 'veyyon/9.9.9'\n"),
				sidecar: () => new Response(`${WRONG_DIGEST}  veyyon\n`, { status: 200 }),
			});

			let message = "";
			await updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER).catch(err => {
				message = String(err);
			});
			// The expected digest is what a user compares against the release page to tell
			// a corrupt mirror apart from a genuinely tampered artifact.
			expect(message).toContain(WRONG_DIGEST);
		});

		it("a missing sidecar refuses instead of installing unverified bytes", async () => {
			// Fail closed (Law 10): "the checksum could not be fetched" must never
			// degrade into "install it anyway", which is the whole value of the gate.
			const target = await installedBinary();
			routeFetch({
				binary: servesBinary("#!/bin/sh\necho 'veyyon/9.9.9'\n"),
				sidecar: () => new Response("Not Found", { status: 404, statusText: "Not Found" }),
			});

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow();
			await expectUntouched(target);
		});

		it("an unparseable sidecar refuses rather than treating garbage as a match", async () => {
			const target = await installedBinary();
			routeFetch({
				binary: servesBinary("#!/bin/sh\necho 'veyyon/9.9.9'\n"),
				sidecar: () => new Response("<html>404</html>", { status: 200 }),
			});

			await expect(updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER)).rejects.toThrow();
			await expectUntouched(target);
		});
	});

	describe("the request itself", () => {
		it("asks for the tagged release asset of the exact version requested", async () => {
			// A version that reaches the URL wrong is how an update silently installs
			// something other than what it announced, so the URL is asserted literally.
			const target = await installedBinary();
			const urls: string[] = [];
			spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
				urls.push(String(input));
				return new Response("", { status: 404, statusText: "Not Found" });
			}) as unknown as typeof fetch);

			await updateViaBinaryAt(target, "1.2.3", SILENT_UPDATE_REPORTER).catch(() => {});

			expect(urls).toHaveLength(1);
			expect(urls[0]).toContain("https://github.com/santhreal/veyyon/releases/download/v1.2.3/");
		});

		it("never requests the sidecar when the binary download already failed", async () => {
			// Ordering matters: verifying a download that does not exist would produce a
			// confusing checksum error for what is really a missing asset.
			const target = await installedBinary();
			const urls: string[] = [];
			spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
				urls.push(String(input));
				return new Response("", { status: 500, statusText: "Internal Server Error" });
			}) as unknown as typeof fetch);

			await updateViaBinaryAt(target, VERSION, SILENT_UPDATE_REPORTER).catch(() => {});

			expect(urls.some(url => url.endsWith(".sha256"))).toBe(false);
		});
	});
});
