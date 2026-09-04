/**
 * Every collab guest waits on the host for the same length of time.
 *
 * A guest makes three round trips to the host and gives up on each after a
 * budget: the `welcome` frame that starts a join, the `snapshot-chunk` stream
 * that carries the initial state, and a `fetch-transcript` request. There are
 * two guest implementations today, the TUI's `collab/guest.ts` and the web
 * client, and both talk to the same host over the same relay, so those budgets
 * describe the PROTOCOL, not either client.
 *
 * They had been declared separately in each. Two of the three were kept in
 * step by hand, and the web client said so in as many words:
 *
 *     /** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: ... *\/
 *     const WELCOME_TIMEOUT_MS = 30_000;
 *
 * The third had already drifted. `TRANSCRIPT_TIMEOUT_MS` was 10 s in the
 * browser and 20 s in the terminal, so a host taking 15 s to read a large
 * transcript answered the TUI guest fine and looked dead to a web viewer,
 * which resolves the fetch to `null` on timeout. Two viewers of one session
 * disagreeing about whether the host is alive is a support ticket nobody can
 * reproduce, and the comment that was supposed to prevent it is the proof that
 * a comment is not a mechanism.
 *
 * So `@veyyon/wire` owns the three values, both guests import them, and these
 * tests fail if either grows a local copy again.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_PROGRESS_TIMEOUT_MS, TRANSCRIPT_TIMEOUT_MS, WELCOME_TIMEOUT_MS } from "../src/index";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The guest implementations that must agree, and where each one lives. */
const GUESTS = [
	{ name: "the TUI guest", file: "packages/coding-agent/src/collab/guest.ts" },
	{ name: "the web client", file: "packages/collab-web/src/lib/client.ts" },
] as const;

/** The budgets the protocol owns, each paired with the value it is pinned at. */
const BUDGETS = [
	{ name: "WELCOME_TIMEOUT_MS", value: WELCOME_TIMEOUT_MS, expected: 30_000 },
	{ name: "SNAPSHOT_PROGRESS_TIMEOUT_MS", value: SNAPSHOT_PROGRESS_TIMEOUT_MS, expected: 30_000 },
	{ name: "TRANSCRIPT_TIMEOUT_MS", value: TRANSCRIPT_TIMEOUT_MS, expected: 20_000 },
] as const;

const sourceOf = (file: string): string => readFileSync(join(REPO_ROOT, file), "utf8");

describe("the collab guest join budgets", () => {
	for (const { name, value, expected } of BUDGETS) {
		it(`${name} is ${expected} ms`, () => {
			// Pinned by value: these are the numbers a host implementation has to
			// stay under, so changing one is a protocol decision, not a tweak.
			expect(value).toBe(expected);
		});
	}

	it("resolves the drift by taking the longer transcript budget", () => {
		// The web client's old 10 s was the wrong half of the disagreement to keep:
		// the host may be reading a large transcript off disk, and a viewer that
		// gives up early reports a working host as unreachable. Held above the
		// abandoned value so a future edit back to 10 s fails here.
		expect(TRANSCRIPT_TIMEOUT_MS).toBeGreaterThan(10_000);
	});

	it("gives a join more room than a single transcript fetch", () => {
		// The relationship the three values encode: joining involves more work
		// than one request, so its budget has to be the larger one.
		expect(WELCOME_TIMEOUT_MS).toBeGreaterThan(TRANSCRIPT_TIMEOUT_MS);
		expect(SNAPSHOT_PROGRESS_TIMEOUT_MS).toBeGreaterThan(TRANSCRIPT_TIMEOUT_MS);
	});
});

describe("both guests take their budgets from the protocol", () => {
	for (const { name, file } of GUESTS) {
		it(`${name} imports all three from @veyyon/wire`, () => {
			const source = sourceOf(file);

			for (const { name: budget } of BUDGETS) {
				expect(source).toMatch(new RegExp(`import \\{[^}]*\\b${budget}\\b[^}]*\\} from "@veyyon/wire"`, "s"));
			}
		});

		for (const { name: budget } of BUDGETS) {
			it(`${name} declares no local ${budget}`, () => {
				// A local `const` shadows the import silently and compiles, which is
				// exactly how the drift happened the first time.
				expect(sourceOf(file)).not.toMatch(new RegExp(`^\\s*const ${budget}\\s*=`, "m"));
			});
		}
	}

	it("leaves no guest waiting on a hard-coded 10 second transcript budget", () => {
		// The specific abandoned literal, checked at its use site rather than by
		// name, so reintroducing it under a different name still fails.
		for (const { file } of GUESTS) {
			expect(sourceOf(file)).not.toMatch(/}, 10_000\)/);
		}
	});
});
