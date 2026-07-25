import { expect, test } from "bun:test";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { __tripwire } from "../../utils/test/helpers/real-data-tripwire";

/**
 * A replay of the real incident, kept as a permanent regression test.
 *
 * What happened: a profile-isolation test believed it had redirected `HOME` to a
 * temp directory and called `SqliteAuthCredentialStore.open` on what it thought
 * was a disposable path. Bun resolves `os.homedir()` once at process start, so
 * the redirect did nothing, the store opened the developer's REAL
 * `~/.veyyon/shared-auth/agent.db`, and three fabricated `anthropic` rows were
 * written into it. Every assertion in that test passed.
 *
 * This test performs the SAME call on the SAME real path and requires it to be
 * refused. It is deliberately written against the shipped store rather than a raw
 * `bun:sqlite` handle, because that indirection is what made the original damage
 * possible: the write went through native SQLite and never touched a `node:fs`
 * function, so a tripwire that wrapped only `fs` would have watched it happen. If
 * a future change to the tripwire stops covering the ESM-imported `Database`
 * binding the store actually uses, this fails while the tripwire's own unit tests
 * would still pass.
 *
 * If this test ever fails, the suite can damage real credentials again. Treat it
 * as a stop-everything failure, and never "fix" it by pointing it at a temp path.
 */
test("the real shared credential store cannot be opened from a test", async () => {
	// Taken from the tripwire's own forbidden root rather than recomputed from
	// `os.homedir()`: under the test runner HOME is a sandbox, so recomputing it here
	// would aim this test at a temp path and prove nothing. One owner for "where the
	// real data is" means this test cannot drift away from what the tripwire guards.
	const realRoot = __tripwire.FORBIDDEN[0];
	if (!realRoot) throw new Error("tripwire reported no forbidden root; the preload did not initialize");
	const realStore = path.join(realRoot, "shared-auth", "agent.db");

	let error = "";
	try {
		const store = await SqliteAuthCredentialStore.open(realStore);
		store.close();
	} catch (caught) {
		error = String(caught);
	}

	// The tripwire's own message, not merely "some error": an ENOENT or a
	// permissions error would mean the file simply was not there on this machine,
	// which would make a laxer assertion pass without proving anything.
	expect(error).toContain("REAL-DATA TRIPWIRE");
	expect(error).toContain("shared-auth");
});
