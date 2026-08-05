import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactProtocolHandler } from "@veyyon/coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";
import {
	ambiguousSessionFileIds,
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	sessionFilesFromDisk,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";

/**
 * THE BUG THIS LOCKS OUT.
 *
 * `artifactsDirsFromRegistry` deliberately enumerates EVERY registered session's
 * artifacts dir, because `agent://` must reach a nested peer's write-time dir or it 404s
 * a live agent. Both consumers then took the FIRST hit across those dirs:
 * `resolveArtifactFile` broke out of the loop on the first match, and
 * `sessionFilesFromDisk` kept the first id it saw.
 *
 * Artifact ids are PER-SESSION COUNTERS, so a collision is the norm in a multi-session
 * host rather than an edge case. `artifact://3` therefore resolved to whichever
 * conversation the registry happened to enumerate first and handed back another
 * conversation's third artifact as though it were the caller's: wrong output presented
 * as correct output, with nothing for the operator to notice. `history://Worker` had the
 * same shape for transcripts, which is what an operator reads to decide what an agent
 * actually did.
 *
 * WHY REFUSAL IS SCOPED TO THE ID AND NOT TO THE DIR COUNT. Scanning several dirs is
 * REQUIRED and must keep working; the id resolving in two of them is the failure. A
 * guard that refused whenever more than one dir existed would break nested-peer
 * resolution, which is a working feature. Every case below therefore registers several
 * dirs and varies only whether the ID collides.
 *
 * THE PROPER FIX IS PER-CONVERSATION ARTIFACT IDS, which would make the collision
 * impossible rather than merely detected. Not done here: it touches id generation, every
 * existing reference and persisted transcripts. These tests pin the guard, not the end
 * state.
 *
 * IF IT REGRESSES: `artifact://3` and `history://Worker` silently serve another
 * conversation's content, and an operator reading it has no way to tell.
 */
describe("cross-conversation id ambiguity", () => {
	let root: string;
	let dirA: string;
	let dirB: string;
	const unregisters: Array<() => void> = [];
	const handler = new ArtifactProtocolHandler();

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "xconv-ambiguity-"));
		dirA = path.join(root, "conversationA");
		dirB = path.join(root, "conversationB");
		await fs.mkdir(dirA, { recursive: true });
		await fs.mkdir(dirB, { recursive: true });
		resetRegisteredArtifactDirsForTests();
		// TWO live conversations, always. The guard must key off the id colliding, not
		// off there being more than one dir, so every case here has two dirs registered.
		unregisters.push(registerArtifactsDir(dirA), registerArtifactsDir(dirB));
	});

	afterEach(async () => {
		for (const off of unregisters.splice(0)) off();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	describe("artifact://", () => {
		/**
		 * THE CONTROL, and the case that matters most. An id present in only ONE dir still
		 * resolves, with two conversations registered. Without this the fix could be
		 * satisfied by refusing always, which would break every nested-peer read.
		 */
		it("resolves an id that exists in exactly one conversation", async () => {
			await Bun.write(path.join(dirA, "7.out.md"), "A seven");

			const resource = await handler.resolve(parseInternalUrl("artifact://7"), { pathOnly: true });

			expect(resource.sourcePath).toBe(path.join(dirA, "7.out.md"));
		});

		/** The same, from the other side, so the pass is not an artifact of enumeration order. */
		it("resolves an id that exists only in the second conversation", async () => {
			await Bun.write(path.join(dirB, "7.out.md"), "B seven");

			const resource = await handler.resolve(parseInternalUrl("artifact://7"), { pathOnly: true });

			expect(resource.sourcePath).toBe(path.join(dirB, "7.out.md"));
		});

		/**
		 * THE DEFECT. Both conversations have a #3. First-hit-wins returned one of them.
		 */
		it("refuses an id that exists in two conversations rather than picking one", async () => {
			await Bun.write(path.join(dirA, "3.out.md"), "A three");
			await Bun.write(path.join(dirB, "3.out.md"), "B three");

			await expect(handler.resolve(parseInternalUrl("artifact://3"), { pathOnly: true })).rejects.toThrow(
				/Artifact 3 is ambiguous/,
			);
		});

		/**
		 * The refusal must NAME the problem. "Not found" would be actively misleading here:
		 * the artifact exists, twice, and an operator told it was missing goes looking for
		 * something they have not lost.
		 */
		it("names the collision and the remedy rather than reporting a miss", async () => {
			await Bun.write(path.join(dirA, "3.out.md"), "A three");
			await Bun.write(path.join(dirB, "3.out.md"), "B three");

			const error = await handler
				.resolve(parseInternalUrl("artifact://3"), { pathOnly: true })
				.then(() => undefined)
				.catch((err: unknown) => (err instanceof Error ? err.message : String(err)));

			expect(error).toContain("ambiguous");
			expect(error).not.toContain("not found");
			// The remedy, and both candidate paths, so the operator can pick.
			expect(error).toContain("Re-read it from the session that produced it");
			expect(error).toContain(path.join(dirA, "3.out.md"));
			expect(error).toContain(path.join(dirB, "3.out.md"));
		});

		/**
		 * THE CALLER'S OWN DIR DISAMBIGUATES. A session that threaded its options asked for
		 * ITS #3, so a collision elsewhere is not ambiguity and must not refuse: this is
		 * the ordinary in-session read and it has to keep working.
		 */
		it("resolves a collision when the caller pinned its own conversation", async () => {
			await Bun.write(path.join(dirA, "3.out.md"), "A three");
			await Bun.write(path.join(dirB, "3.out.md"), "B three");

			const resource = await handler.resolve(parseInternalUrl("artifact://3"), {
				pathOnly: true,
				localProtocolOptions: { getArtifactsDir: () => dirB, getSessionId: () => "B" },
			});

			expect(resource.sourcePath).toBe(path.join(dirB, "3.out.md"));
		});

		/** A genuine miss still reports a miss, with the available ids. */
		it("still reports a plain miss for an id no conversation has", async () => {
			await Bun.write(path.join(dirA, "1.out.md"), "A one");

			await expect(handler.resolve(parseInternalUrl("artifact://9"), { pathOnly: true })).rejects.toThrow(
				/Artifact 9 not found\. Available: 1/,
			);
		});
	});

	describe("history://", () => {
		/** The control: a transcript in exactly one conversation still resolves. */
		it("finds a transcript that exists in exactly one conversation", async () => {
			await Bun.write(path.join(dirA, "Solo.jsonl"), "{}\n");

			expect((await sessionFilesFromDisk()).get("Solo")).toBe(path.join(dirA, "Solo.jsonl"));
			expect(await ambiguousSessionFileIds()).not.toContain("Solo");
		});

		/**
		 * THE DEFECT. Two conversations each ran an agent named `Worker`. First-hit-wins
		 * served one of their transcripts as the other's.
		 */
		it("omits a transcript id that exists in two conversations", async () => {
			await Bun.write(path.join(dirA, "Worker.jsonl"), "{}\n");
			await Bun.write(path.join(dirB, "Worker.jsonl"), "{}\n");

			expect((await sessionFilesFromDisk()).has("Worker")).toBe(false);
			expect([...(await ambiguousSessionFileIds())]).toEqual(["Worker"]);
		});

		/**
		 * Omitting the ambiguous one must not drop the unambiguous ones alongside it, or a
		 * single collision would blank the whole index.
		 */
		it("keeps every unambiguous transcript when one id collides", async () => {
			await Bun.write(path.join(dirA, "Worker.jsonl"), "{}\n");
			await Bun.write(path.join(dirB, "Worker.jsonl"), "{}\n");
			await Bun.write(path.join(dirA, "OnlyA.jsonl"), "{}\n");
			await Bun.write(path.join(dirB, "OnlyB.jsonl"), "{}\n");

			const files = await sessionFilesFromDisk();

			expect([...files.keys()].sort()).toEqual(["OnlyA", "OnlyB"]);
		});

		/**
		 * THE SAME FILE reached twice is not a collision. `artifactsDirsFromRegistry`
		 * returns overlapping roots on purpose (the adopted dir and the write-time dir),
		 * and the recursive walk can arrive at one transcript by both routes. Treating
		 * that as ambiguous would break nested-peer lookup, which is the exact feature the
		 * cross-session scan exists to serve.
		 */
		it("does not call one transcript ambiguous when two registered roots overlap", async () => {
			await Bun.write(path.join(dirA, "Nested.jsonl"), "{}\n");
			// Register the PARENT of dirA as well, so the walk reaches the same file twice.
			unregisters.push(registerArtifactsDir(root));

			expect((await sessionFilesFromDisk()).get("Nested")).toBe(path.join(dirA, "Nested.jsonl"));
			expect([...(await ambiguousSessionFileIds())]).toEqual([]);
		});
	});
});
