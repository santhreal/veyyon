import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SILENT_UPDATE_REPORTER, updateViaBinaryAt } from "@veyyon/coding-agent/cli/update-cli";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { removeWithRetries } from "@veyyon/utils";
import { enterTempHome, type TempHome } from "./helpers/temp-home";

const VERSION = "9.9.9";
const tempDirs: string[] = [];
let tempHome: TempHome | undefined;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(async () => {
	vi.restoreAllMocks();
	tempHome?.restore();
	tempHome = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

function fakeBinaryScript(version: string): string {
	return [
		"#!/bin/sh",
		'if [ "$1" = "grep" ]; then',
		"  shift",
		'  [ "$1" = "--help" ] && exit 0',
		'  pattern="$1"',
		"  shift",
		'  exec grep -rl "$pattern" "$@"',
		"fi",
		`echo "veyyon/${version}"`,
		"# complete release A",
		"",
	].join("\n");
}

function sha256Hex(text: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(text);
	return hasher.digest("hex");
}

async function stagingContents(dir: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const entry of await fs.readdir(dir)) {
		if (!entry.endsWith(".new")) continue;
		try {
			result.set(entry, await fs.readFile(path.join(dir, entry), "utf8"));
		} catch {
			// The updater may remove a failed attempt between readdir and readFile.
		}
	}
	return result;
}

async function waitForStaging(
	dir: string,
	predicate: (files: Map<string, string>) => boolean,
): Promise<Map<string, string>> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const files = await stagingContents(dir);
		if (predicate(files)) return files;
	}
	throw new Error("timed out waiting for updater staging files");
}

describe.skipIf(process.platform === "win32")("concurrent explicit binary updates", () => {
	/**
	 * Regression: explicit forced updates formerly opened the same `<binary>.new`
	 * file, so the second download truncated it and its failure cleanup unlinked
	 * the first attempt's still-live staging. Holding both response streams at
	 * barriers proves the attempts have distinct files before failing one, then
	 * proves that cleanup leaves the survivor able to install its complete bytes.
	 */
	it("isolates live staging and cleanup for overlapping forced attempts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-update-concurrency-"));
		tempDirs.push(dir);
		const targetPath = path.join(dir, "veyyon");
		await fs.writeFile(targetPath, fakeBinaryScript("1.0.0"), { mode: 0o755 });

		// A completed update refreshes the shell completions it finds under HOME, and the
		// updater resolves its own config root from `os.homedir()`. `enterTempHome` moves
		// both, so neither the developer's dotfiles nor their `~/.veyyon` is in reach, and
		// the redirect is asserted rather than assumed.
		tempHome = enterTempHome();
		const home = tempHome.home;
		expect(os.homedir()).toBe(home);
		process.env.XDG_CONFIG_HOME = path.join(home, ".config");

		const completeBinary = fakeBinaryScript(VERSION);
		const splitAt = Math.floor(completeBinary.length / 2);
		const firstPrefix = completeBinary.slice(0, splitAt);
		const firstSuffix = completeBinary.slice(splitAt);
		const secondPrefix = "#!/bin/sh\necho incomplete release B\n";
		const encoder = new TextEncoder();
		let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let secondController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let binaryRequests = 0;

		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith(".sha256")) {
				return new Response(`${sha256Hex(completeBinary)}  veyyon\n`, { status: 200 });
			}
			binaryRequests += 1;
			if (binaryRequests === 1) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							firstController = controller;
							controller.enqueue(encoder.encode(firstPrefix));
						},
					}),
					{ status: 200 },
				);
			}
			if (binaryRequests === 2) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							secondController = controller;
							controller.enqueue(encoder.encode(secondPrefix));
						},
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected binary request ${binaryRequests}`);
		}) as typeof fetch);

		const firstAttempt = updateViaBinaryAt(targetPath, VERSION, SILENT_UPDATE_REPORTER);
		const firstFiles = await waitForStaging(dir, files => [...files.values()].some(body => body === firstPrefix));
		const firstStage = [...firstFiles].find(([, body]) => body === firstPrefix)?.[0];
		expect(firstStage).toBeDefined();
		if (firstStage === undefined) throw new Error("first update staging path was not observed");

		const secondAttempt = updateViaBinaryAt(targetPath, VERSION, SILENT_UPDATE_REPORTER);
		const overlapping = await waitForStaging(
			dir,
			files =>
				files.size === 2 && [...files.values()].includes(firstPrefix) && [...files.values()].includes(secondPrefix),
		);
		expect(new Set(overlapping.keys()).size).toBe(2);

		if (!secondController) throw new Error("second response stream did not start");
		secondController.error(new Error("connection reset during second forced update"));
		await expect(secondAttempt).rejects.toThrow(/connection reset/);

		const survivor = await waitForStaging(dir, files => files.size === 1 && files.get(firstStage) === firstPrefix);
		expect([...survivor.keys()]).toEqual([firstStage]);

		if (!firstController) throw new Error("first response stream did not start");
		firstController.enqueue(encoder.encode(firstSuffix));
		firstController.close();
		await firstAttempt;

		expect(await fs.readFile(targetPath, "utf8")).toBe(completeBinary);
		const artifacts = (await fs.readdir(dir)).filter(entry => entry !== "veyyon" && !entry.endsWith(".veyyon-owner"));
		expect(artifacts).toEqual([]);
	});
});
