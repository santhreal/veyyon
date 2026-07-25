import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "../src/temp";
import { guardDestructivePath } from "./helpers/destructive-guard";

/**
 * PROF-6: two veyyon PROCESSES running different profiles at the same time must
 * not write into each other's state. Single-process tests cannot prove this: the
 * dangerous case is two independent resolvers, each having decided where "my
 * profile" lives, racing on the filesystem. That is the shape of the real
 * complaint behind this campaign (a rebuild starting a second process while the
 * first is live), and it is why these run as genuine subprocesses rather than
 * two resolvers in one process.
 *
 * Isolation note, and the reason this suite is written the way it is: `HOME` IS
 * the right lever HERE and only here. Bun resolves `os.homedir()` once at process
 * start, so an inherited-but-mutated `process.env.HOME` does nothing — but a
 * SPAWNED process reads the HOME we hand it at spawn time, before its own
 * resolver runs. Each child therefore resolves entirely inside the temp root, and
 * the parent verifies that claim by asserting the child reported a path under
 * that root before trusting anything else it did.
 */
describe("concurrent processes on different profiles never cross-write", () => {
	/** The child that does the real resolution and writing; see its own doc comment. */
	const WRITER_FIXTURE = path.join(import.meta.dir, "fixtures", "profile-session-writer.ts");
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-xproc-"));
	});

	afterEach(async () => {
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "profile-cross-process-writes"));
			tempRoot = "";
		}
	});

	/**
	 * Run one child that activates `profile`, writes `count` session files stamped
	 * with its own profile name, and prints the directory it resolved.
	 */
	async function runWriter(profile: string, count: number): Promise<{ sessionsDir: string }> {
		const proc = Bun.spawn(["bun", "run", WRITER_FIXTURE, String(count)], {
			env: {
				...process.env,
				// Handed to the child BEFORE it starts, which is the only point at which
				// HOME can steer os.homedir().
				HOME: tempRoot,
				VEYYON_PROFILE: profile,
				VEYYON_CONFIG_DIR: ".veyyon",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`writer for ${profile} failed (${code}): ${stderr}`);

		const reported = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { sessionsDir?: string };
		const sessionsDir = reported.sessionsDir;
		if (!sessionsDir) throw new Error(`writer for ${profile} reported no directory: ${stdout}`);
		// Verify the CHILD's own resolution landed in the temp root. Asserting on a
		// path the parent computed would prove nothing about where the child wrote.
		guardDestructivePath(sessionsDir, `profile-cross-process-writes child ${profile}`);
		return { sessionsDir };
	}

	it("two processes writing concurrently keep every file in its own profile", async () => {
		const COUNT = 12;
		const [work, client] = await Promise.all([runWriter("work", COUNT), runWriter("client", COUNT)]);

		expect(work.sessionsDir).not.toBe(client.sessionsDir);

		// Exact file sets, not counts: a cross-write would show up as a foreign name.
		const workFiles = fs.readdirSync(work.sessionsDir).sort();
		const clientFiles = fs.readdirSync(client.sessionsDir).sort();
		expect(workFiles).toEqual(Array.from({ length: COUNT }, (_, i) => `work-${i}.jsonl`).sort());
		expect(clientFiles).toEqual(Array.from({ length: COUNT }, (_, i) => `client-${i}.jsonl`).sort());

		// And every file's CONTENT names its own profile, so a clobber that preserved
		// the filename is still caught.
		for (const name of workFiles) {
			expect(fs.readFileSync(path.join(work.sessionsDir, name), "utf8")).toStartWith("work:");
		}
		for (const name of clientFiles) {
			expect(fs.readFileSync(path.join(client.sessionsDir, name), "utf8")).toStartWith("client:");
		}
	}, 60_000);

	it("two processes on the SAME profile share one directory without losing writes", async () => {
		const COUNT = 8;
		// The counterpart case: same profile is supposed to converge on one directory.
		// Both children write distinct names, and every write must survive — a lost
		// write here would be a dropped session, which is the same class of loss as a
		// dropped credential.
		const [first, second] = await Promise.all([runWriter("work", COUNT), runWriter("work", COUNT)]);
		expect(first.sessionsDir).toBe(second.sessionsDir);
		expect(fs.readdirSync(first.sessionsDir).sort()).toEqual(
			Array.from({ length: COUNT }, (_, i) => `work-${i}.jsonl`).sort(),
		);
	}, 60_000);
});
