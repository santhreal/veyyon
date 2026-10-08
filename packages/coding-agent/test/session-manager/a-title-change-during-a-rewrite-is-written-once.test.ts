/**
 * WHY THIS SUITE EXISTS:
 *
 * A title change is written by appending its entry on the disk chain and patching the title slot.
 * The entry joins the in-memory log first, so a whole-file publish that runs before the append
 * already wrote it, and the append then wrote the same line again: a resumed session whose first
 * turn set its title while the overflow prune's rewrite was queued held two `title_change` lines
 * with one id. Skipping the append after a publish is only half of it, because a publish already
 * in progress may have serialized its body before the entry arrived, and skipping then loses it.
 *
 * CLASS: every way a publish can overlap a title change (none, queued ahead of it, in progress
 * before its body is read, in progress after its body is read), for both publishes a rewrite runs
 * (the whole file and the tail after the first changed entry), writes the change exactly once, the
 * title slot holds the new title, no entry id appears twice in the file, and a reopen reads the
 * title back.
 *
 * DOES NOT CATCH: a second process writing the same file, which the foreign-line merge owns, and a
 * synchronous rewrite, which retires the queued append through the disk epoch rather than here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TITLE_CHANGE_ENTRY_TYPE } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	FileSessionStorage,
	type SessionFileBody,
	type WriteTextAtomicOptions,
} from "@veyyon/kernel/session/session-storage";
import { removeSyncWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";
import { makeAssistantMessage } from "./helpers";

/** Where the publish a case overlaps stands when the title changes. */
type Overlap = "none" | "queued" | "before-body" | "after-body";

/** The publish the rewrite runs first. */
type Publish = "whole" | "tail";

const OVERLAPS: readonly Overlap[] = ["none", "queued", "before-body", "after-body"];
const PUBLISHES: readonly Publish[] = ["whole", "tail"];

const TITLE = "Overlapping title";

/** File storage that records its publishes and holds the first one, before or after reading its body. */
class HeldPublishStorage extends FileSessionStorage {
	publishes: Publish[] = [];
	hold: Overlap = "none";
	readonly held = Promise.withResolvers<void>();
	readonly release = Promise.withResolvers<void>();

	override async writeTextAtomic(filePath: string, body: SessionFileBody, options?: WriteTextAtomicOptions) {
		this.publishes.push("whole");
		return super.writeTextAtomic(filePath, await this.#held(body), options);
	}

	override async rewriteTailAtomic(
		filePath: string,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	) {
		this.publishes.push("tail");
		return super.rewriteTailAtomic(filePath, keepBytes, head, await this.#held(tail), options);
	}

	async #held(body: SessionFileBody): Promise<SessionFileBody> {
		const hold = this.hold;
		if (hold !== "before-body" && hold !== "after-body") return body;
		this.hold = "none";
		const kept = hold === "after-body" && typeof body !== "string" ? [...body()].join("") : body;
		this.held.resolve();
		await this.release.promise;
		return kept;
	}
}

interface FileLine {
	type?: unknown;
	id?: unknown;
	title?: unknown;
}

function fileLines(file: string): FileLine[] {
	return fs
		.readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.map(line => JSON.parse(line) as FileLine);
}

describe("a title change during a rewrite is written once", () => {
	let agentDir: string;
	let cwd: string;
	const dirOverrides = captureDirOverrides();

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-title-rewrite-"));
		cwd = path.join(agentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(agentDir);
	});

	afterEach(() => {
		restoreDirOverrides(dirOverrides);
		removeSyncWithRetries(agentDir);
	});

	async function overlap(publish: Publish, when: Overlap): Promise<{ file: string; storage: HeldPublishStorage }> {
		const storage = new HeldPublishStorage();
		const session = SessionManager.create(cwd, undefined, storage);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		const revised = session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const file = session.getSessionFile();
		if (file === undefined) throw new Error("the session wrote no file");
		storage.publishes = [];

		if (when === "none") {
			await session.setSessionName(TITLE, "auto");
			await session.flush();
			return { file, storage };
		}

		// An in-place update of a later entry, as a prune makes, lets the rewrite keep the lines before it.
		const entry = session.getEntry(revised);
		if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("the revised entry is missing");
		entry.message.content = "second, revised";
		storage.hold = when;
		const rewrite = session.rewriteEntries(publish === "tail" ? [entry] : undefined);
		if (when !== "queued") await storage.held.promise;
		const titled = session.setSessionName(TITLE, "auto");
		storage.release.resolve();
		await Promise.all([rewrite, titled]);
		await session.flush();
		return { file, storage };
	}

	for (const publish of PUBLISHES) {
		for (const when of OVERLAPS) {
			it(`writes the change once when the ${publish} publish is ${when === "none" ? "absent" : when}`, async () => {
				const { file, storage } = await overlap(publish, when);

				// The publish in progress is the one the case names, so the case is not proving the other one. A
				// queued rewrite plans after the title change, which leaves the header line alone, so a tail
				// rewrite still keeps the lines before its update.
				const first: Publish | undefined = when === "none" ? undefined : publish;
				expect(storage.publishes.at(0)).toBe(first);
				const lines = fileLines(file);
				expect(lines[0]).toMatchObject({ type: "title", title: TITLE });
				const titles = lines.filter(line => line.type === TITLE_CHANGE_ENTRY_TYPE).map(line => line.title);
				expect(titles).toEqual([TITLE]);
				const ids = lines
					.filter(line => line.type !== "session" && typeof line.id === "string")
					.map(line => line.id);
				expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
				expect((await SessionManager.open(file)).getSessionName()).toBe(TITLE);
			});
		}
	}
});
