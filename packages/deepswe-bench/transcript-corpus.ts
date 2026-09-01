import * as fs from "node:fs";
import * as path from "node:path";

export type EmissionChannel = "toolCall" | "message";

export interface Emission {
	channel: EmissionChannel;
	text: string;
}

export interface EmissionCounts {
	assistantMessages: number;
	toolCallParts: number;
	textParts: number;
	thinkingParts: number;
}

export function emptyCounts(): EmissionCounts {
	return { assistantMessages: 0, toolCallParts: 0, textParts: 0, thinkingParts: 0 };
}

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

export function findTranscripts(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
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

export interface EmissionCorpus {
	files: number;
	filesRead: number;
	counts: EmissionCounts;
	malformedLines: number;
}

export interface ReadOptions {
	cwdFilter?: (cwd: string) => boolean;
}

function sessionCwd(events: unknown[]): string | null {
	for (const event of events) {
		if (event === null || typeof event !== "object") continue;
		const record = event as Record<string, unknown>;
		if (record.type === "session" && typeof record.cwd === "string") return record.cwd;
	}
	return null;
}

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
		console.error(`transcript-corpus: skipped ${malformedLines} unparseable transcript lines under ${root}`);
	}
	return { files: files.length, filesRead, counts, malformedLines };
}

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
