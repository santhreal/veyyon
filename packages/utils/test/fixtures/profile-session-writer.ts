/**
 * Child process for the PROF-6 cross-process isolation suite
 * (`profile-cross-process-writes.test.ts`).
 *
 * It resolves the sessions directory with the REAL resolver, writes `count`
 * files stamped with its own profile name, and prints the directory it chose so
 * the parent can verify where the write actually landed rather than where it
 * assumed it would.
 *
 * This lives in the repo rather than being written to a temp directory because a
 * script outside the workspace cannot resolve `@veyyon/*` imports, and resolving
 * the real module is the entire point: a child that imported a stub would prove
 * nothing about the app's own path resolution.
 *
 * Usage: `bun run profile-session-writer.ts <count>` with `VEYYON_PROFILE`,
 * `HOME` and `VEYYON_CONFIG_DIR` set by the parent at spawn time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir } from "@veyyon/utils/dirs";

const count = Number(process.argv[2] ?? "0");
if (!Number.isInteger(count) || count <= 0) throw new Error(`profile-session-writer: bad count ${process.argv[2]}`);

const profile = process.env.VEYYON_PROFILE;
if (!profile) throw new Error("profile-session-writer: VEYYON_PROFILE must be set");

const dir = getSessionsDir();
fs.mkdirSync(dir, { recursive: true });

for (let i = 0; i < count; i++) {
	// A short yield between writes so a sibling process actually interleaves; a
	// single burst could pass even if the two profiles shared a directory.
	fs.writeFileSync(path.join(dir, `${profile}-${i}.jsonl`), `${profile}:${i}\n`);
	await Bun.sleep(1);
}

console.log(JSON.stringify({ sessionsDir: dir }));
