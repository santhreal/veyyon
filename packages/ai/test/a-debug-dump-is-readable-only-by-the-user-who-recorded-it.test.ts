/**
 * A debug dump is readable only by the user who recorded it, whatever the umask says.
 *
 * WHY THIS SUITE EXISTS. `VEYYON_REQ_DEBUG=1` writes the provider exchange into the
 * working directory, which is normally a project tree: prompts, file contents, an OAuth
 * body carrying a refresh token, and whatever a provider echoed back. The mode is
 * passed explicitly at `open` time, and that is exactly the kind of detail a later
 * refactor drops — `fs.open(path, "wx")` without a mode inherits the umask, and on a
 * shared workstation with the ordinary 022 (or a permissive 000 from a container image
 * or a misconfigured shell) the dump lands group- or world-readable. Switching on
 * recording is consent to write the file, never consent to widen who can read it.
 *
 * THE CLASS, not the incident. The umask is swept, including 000 where nothing is
 * masked, and the assertion is over EVERY file the recording produced rather than the
 * two names known today: a third dump file added later with no mode turns this red.
 * The bytes are asserted too, because a mode fix that costs the owner the contents is
 * not a fix.
 *
 * WHAT THIS DOES NOT CATCH. POSIX modes only. Windows has no umask and Node's `mode`
 * is ignored there, so an owner-only ACL on Windows is a separate contract that needs a
 * Windows host to prove; this suite states its platform rather than pretending.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@veyyon/ai/types";
import { wrapFetchForRequestDebug } from "@veyyon/ai/utils/request-debug";
import { removeWithRetries } from "../../utils/src/temp";

const ENDPOINT = "https://provider.test/v1/messages";
const REFRESH_TOKEN = "refresh-token-value-0123456789";

let previousDebugFlag: string | undefined;
let previousCwd: string;
let previousUmask: number | undefined;
let tempDir: string;

beforeEach(async () => {
	previousDebugFlag = Bun.env.VEYYON_REQ_DEBUG;
	previousCwd = process.cwd();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-req-debug-mode-"));
	process.chdir(tempDir);
	Bun.env.VEYYON_REQ_DEBUG = "1";
});

afterEach(async () => {
	if (previousUmask !== undefined) {
		process.umask(previousUmask);
		previousUmask = undefined;
	}
	process.chdir(previousCwd);
	if (previousDebugFlag === undefined) delete Bun.env.VEYYON_REQ_DEBUG;
	else Bun.env.VEYYON_REQ_DEBUG = previousDebugFlag;
	await removeWithRetries(tempDir);
});

/** Record one exchange whose request body is the kind of secret a dump really carries. */
async function record(): Promise<{ files: string[]; requestText: string }> {
	const fetchImpl: FetchImpl = async () => new Response("granted", { headers: { "content-type": "text/plain" } });
	const response = await wrapFetchForRequestDebug(fetchImpl)(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN }),
	});
	await response.text();
	const entries = await fs.readdir(tempDir);
	const files = entries.filter(name => name.startsWith("rr-session-")).sort();
	const requestName = files.find(name => name.endsWith(".json"));
	if (requestName === undefined) throw new Error(`no request dump in ${tempDir}: ${entries.join(", ")}`);
	return { files, requestText: await fs.readFile(path.join(tempDir, requestName), "utf8") };
}

const OWNER_ONLY = 0o600;

describe("a debug dump is owner-only under any umask", () => {
	// 000 is the one that matters: nothing is masked, so a missing mode argument shows up
	// as a 0666 file. 022 is the ordinary workstation default, and 077 is the strict one
	// that would hide the defect entirely.
	it.each([0o000, 0o022, 0o077, 0o007])("creates every dump file 0600 under umask %p", async mask => {
		previousUmask = process.umask(mask);

		const recorded = await record();

		expect(recorded.files.length).toBeGreaterThanOrEqual(2);
		const modes: Record<string, number> = {};
		for (const name of recorded.files) {
			const stat = await fs.stat(path.join(tempDir, name));
			modes[name] = stat.mode & 0o777;
		}
		// Every file the recording produced, not the two names known today: a third dump
		// added later without a mode fails here rather than shipping world-readable.
		for (const [name, mode] of Object.entries(modes)) {
			expect({ name, mode }).toEqual({ name, mode: OWNER_ONLY });
		}
	});

	it("keeps the recorded bytes exact for the owner", async () => {
		previousUmask = process.umask(0o000);

		const recorded = await record();

		// The mode is what other accounts cannot do; the owner still gets a real dump,
		// body included. A dump that is private and empty would satisfy the mode alone.
		const parsed = JSON.parse(recorded.requestText) as { body?: { refresh_token?: string } };
		expect(parsed.body?.refresh_token).toBe(REFRESH_TOKEN);
	});

	it("does not widen an existing dump when a second request reuses the directory", async () => {
		previousUmask = process.umask(0o000);

		const first = await record();
		const second = await record();

		expect(second.files.length).toBeGreaterThan(first.files.length);
		for (const name of second.files) {
			const stat = await fs.stat(path.join(tempDir, name));
			expect({ name, mode: stat.mode & 0o777 }).toEqual({ name, mode: OWNER_ONLY });
		}
	});

	/**
	 * The remaining route to a wide dump is a file the recording did not create: `open(path, "w")`
	 * reuses it and ignores `mode`, so a name left world-readable by an earlier run, or planted by
	 * another account, would keep 0666 while the exchange was written into it. Every candidate
	 * response-log name is planted here, so whichever id the reservation picks has one waiting: the
	 * secret must not appear in any file that is not owner-only, whether the recording refuses the
	 * name or takes a fresh one.
	 */
	it("never writes the exchange into a file it did not create", async () => {
		previousUmask = process.umask(0o000);
		for (let id = 1; id <= 64; id++) {
			const planted = path.join(tempDir, `rr-session-${id}.res.log`);
			await fs.writeFile(planted, "", { mode: 0o666 });
			await fs.chmod(planted, 0o666);
		}

		await record();

		for (const name of await fs.readdir(tempDir)) {
			const filePath = path.join(tempDir, name);
			const stat = await fs.stat(filePath);
			if ((stat.mode & 0o777) === OWNER_ONLY) continue;
			const contents = await fs.readFile(filePath, "utf8");
			expect({ name, holdsSecret: contents.includes(REFRESH_TOKEN) }).toEqual({ name, holdsSecret: false });
			expect({ name, holdsResponse: contents.includes("granted") }).toEqual({ name, holdsResponse: false });
		}
	});
});
