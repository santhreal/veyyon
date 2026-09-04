/**
 * Reads what an agent actually EMITTED out of recorded veyyon transcripts.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE INSTRUMENTS THAT USE IT. Two different
 * questions about argot are answered by the same corpus and would otherwise be
 * answered by two copies of the same reader. `measure-channel-split.ts` asks WHERE
 * the agent wrote its line structure; `measure-retype-likelihood.ts` asks WHICH
 * strings it wrote at all. Both need exactly one thing: the text an assistant turn
 * produced, tagged with the channel it went out on. A second copy of the walk
 * would drift on the part that is easy to get wrong, which is what to leave out.
 *
 * What is left out, and why each exclusion matters:
 *
 *   - TOOL RESULTS. The largest text in any transcript, and none of it is model
 *     output. A `read` returns a whole file; counting it would credit argot for
 *     text no handle can shorten and would swamp everything the model really
 *     wrote.
 *   - USER TURNS. That is the human, not the agent.
 *   - NON-MESSAGE EVENTS. A transcript is mostly titles, settings snapshots, and
 *     model changes. They carry text with newlines and none of it was emitted.
 *
 * What is kept, including the part that is easy to skip:
 *
 *   - TOOL-CALL ARGUMENTS, walked to their string leaves so a list of edits is not
 *     read as a single top-level value.
 *   - TEXT parts.
 *   - THINKING parts, because they are billed output. In the measured corpus they
 *     are 18,980 parts against 811 text parts, so dropping them would leave the
 *     picture of what an agent writes outside tool calls almost empty.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Where a piece of emitted text went. */
export type EmissionChannel =
	/** Inside a tool call's arguments, so JSON-escaped on the wire. */
	| "toolCall"
	/** A text or thinking part, carrying real control characters. */
	| "message";

/** One piece of text an assistant turn emitted. */
export interface Emission {
	channel: EmissionChannel;
	text: string;
}

/** Counts of what was read, so a zero result can be told apart from an empty corpus. */
export interface EmissionCounts {
	assistantMessages: number;
	toolCallParts: number;
	textParts: number;
	thinkingParts: number;
}

export function emptyCounts(): EmissionCounts {
	return { assistantMessages: 0, toolCallParts: 0, textParts: 0, thinkingParts: 0 };
}

/** Walk a tool call's arguments down to every string leaf. */
function* argumentStrings(value: unknown): Generator<string> {
	if (typeof value === "string") {
		yield value;
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) yield* argumentStrings(item);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) yield* argumentStrings(item);
	}
}

/**
 * Yield every emission in one transcript event, updating `counts`.
 *
 * Tolerant by design. Transcripts are appended to live and a killed process leaves
 * partial records, so a shape that is not recognized is skipped rather than thrown
 * on: refusing to run is how a measurement gets abandoned instead of fixed.
 */
export function* emissionsOf(event: unknown, counts: EmissionCounts): Generator<Emission> {
	if (event === null || typeof event !== "object") return;
	const record = event as Record<string, unknown>;
	if (record.type !== "message") return;
	const message = (record.message ?? record) as Record<string, unknown>;
	if (message.role !== "assistant") return;

	counts.assistantMessages += 1;
	const content = message.content;
	if (typeof content === "string") {
		counts.textParts += 1;
		yield { channel: "message", text: content };
		return;
	}
	if (!Array.isArray(content)) return;

	for (const raw of content) {
		if (raw === null || typeof raw !== "object") continue;
		const part = raw as Record<string, unknown>;
		if (part.type === "toolCall") {
			counts.toolCallParts += 1;
			for (const text of argumentStrings(part.arguments)) yield { channel: "toolCall", text };
		} else if (part.type === "text" || part.type === "thinking") {
			if (part.type === "text") counts.textParts += 1;
			else counts.thinkingParts += 1;
			const text = part.type === "text" ? part.text : (part.thinking ?? part.text);
			if (typeof text === "string") yield { channel: "message", text };
		}
	}
}

/** Every `.jsonl` transcript under `root`, recursively, in a stable order. */
export function findTranscripts(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// A directory that cannot be read is reported, never skipped in silence: a
			// measurement that quietly drops half its corpus is worse than none.
			throw new Error(`cannot read transcript directory ${dir}`);
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
		}
	};
	walk(root);
	return found.sort();
}

/** What a corpus read produced, alongside the counts that make it interpretable. */
export interface EmissionCorpus {
	/** Transcripts found under the root. */
	files: number;
	/** Transcripts actually read, which is fewer when a `cwd` filter is given. */
	filesRead: number;
	counts: EmissionCounts;
	/** Transcript lines that would not parse. Reported, never swallowed. */
	malformedLines: number;
}

/** Options for {@link readEmissions}. */
export interface ReadOptions {
	/**
	 * Keep only sessions whose working directory satisfies this predicate.
	 *
	 * A transcript tree holds every project the user has worked in, so a question
	 * about ONE repository ("did the agent retype these strings") must not count
	 * turns from another. The directory comes from the transcript's own `session`
	 * event rather than from the file name, which is a lossy slug of it.
	 *
	 * A transcript with no `session` event is skipped when a filter is given. It
	 * cannot be attributed, and counting an unattributable turn toward a specific
	 * repository is exactly the error the filter exists to prevent.
	 */
	cwdFilter?: (cwd: string) => boolean;
}

/** Pull the session working directory out of a transcript's own events. */
function sessionCwd(events: unknown[]): string | null {
	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		const record = event as Record<string, unknown>;
		if (record.type === "session" && typeof record.cwd === "string") return record.cwd;
	}
	return null;
}

/**
 * Stream every emission under `root` into `visit`.
 *
 * Streaming rather than returning an array: the measured corpus is 362 MB and
 * holding its emissions at once would cost more memory than any instrument needs.
 */
export function readEmissions(
	root: string,
	visit: (emission: Emission) => void,
	options: ReadOptions = {},
): EmissionCorpus {
	const files = findTranscripts(root);
	const counts = emptyCounts();
	let malformedLines = 0;
	let filesRead = 0;
	for (const file of files) {
		const events: unknown[] = [];
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (line.length === 0) continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				malformedLines += 1;
			}
		}
		if (options.cwdFilter) {
			const cwd = sessionCwd(events);
			if (cwd === null || !options.cwdFilter(cwd)) continue;
		}
		filesRead += 1;
		for (const event of events) {
			for (const emission of emissionsOf(event, counts)) visit(emission);
		}
	}
	if (malformedLines > 0) {
		// Loud, because a transcript truncated mid-write is exactly the case where a
		// figure computed from what survived would be quietly wrong.
		console.error(`transcript-corpus: skipped ${malformedLines} unparseable transcript lines under ${root}`);
	}
	return { files: files.length, filesRead, counts, malformedLines };
}

/** The default transcript tree: the current profile's recorded sessions. */
export function defaultSessionsDir(): string {
	return path.join(
		process.env.HOME ?? "",
		".veyyon",
		"profiles",
		process.env.VEYYON_PROFILE ?? "work",
		"agent",
		"sessions",
	);
}
