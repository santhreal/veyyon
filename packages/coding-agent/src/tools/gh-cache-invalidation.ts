/** Detect cache-mutating `gh` subcommands inside a bash invocation and drop the matching `github-cache` rows so a subsequent `issue://<n>` or */
import { parseIssueUrl, parsePrUrl } from "./gh-url";
import { invalidateAllForNumber, invalidateAllForRepo } from "./github-cache";

/** Subcommands that mutate the rendered issue/PR view in any meaningful way. */
const MUTATING_ISSUE_SUBCMDS: Record<string, true> = {
	close: true,
	reopen: true,
	delete: true,
	edit: true,
	comment: true,
	lock: true,
	unlock: true,
	pin: true,
	unpin: true,
	transfer: true,
	develop: true,
};

const MUTATING_PR_SUBCMDS: Record<string, true> = {
	close: true,
	reopen: true,
	merge: true,
	ready: true,
	edit: true,
	comment: true,
	review: true,
	lock: true,
	unlock: true,
};

/** Parse `token` as an issue or PR URL (per `subject`) via the shared `gh-url` parsers. */
function parseSubjectUrl(subject: "issue" | "pr", token: string): { repo?: string; num?: number } {
	if (subject === "pr") {
		const { repo, prNumber } = parsePrUrl(token);
		return { repo, num: prNumber };
	}
	const { repo, issueNumber } = parseIssueUrl(token);
	return { repo, num: issueNumber };
}

/** Flags whose value is the next argv token (`--milestone 3`). The detector must skip those values so `gh pr edit --milestone 3 14` invalidates #14, */
const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
	"-m",
	"--milestone",
	"-t",
	"--title",
	"-b",
	"--body",
	"-F",
	"--body-file",
	"-a",
	"--assignee",
	"--add-assignee",
	"--remove-assignee",
	"-l",
	"--label",
	"--add-label",
	"--remove-label",
	"-p",
	"--project",
	"--add-project",
	"--remove-project",
	"--add-reviewer",
	"--remove-reviewer",
	"-B",
	"--base",
	"-c",
	"--comment",
	"-r",
	"--reason",
	"--branch",
	"--subject",
	"--match-head-commit",
	"--author-email",
]);
/** Walk a single shell command's token stream looking for a top-level `gh (issue|pr) <subcmd> [<id-or-url>]` invocation and return the */
function detectGhMutation(tokens: readonly string[]): { number?: number; repo?: string } | null {
	const ghIdx = tokens.indexOf("gh");
	if (ghIdx === -1) return null;
	const subject = tokens[ghIdx + 1];
	if (subject !== "issue" && subject !== "pr") return null;
	const subcmd = tokens[ghIdx + 2];
	if (!subcmd) return null;
	const expected = subject === "issue" ? MUTATING_ISSUE_SUBCMDS : MUTATING_PR_SUBCMDS;
	if (!expected[subcmd]) return null;

	let repo: string | undefined;
	// First pass: scan for --repo so it wins regardless of position relative
	// to the issue/PR identifier (gh accepts the flag both before and after
	// the positional argument).
	for (let i = ghIdx + 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-R" || token === "--repo") {
			const next = tokens[i + 1];
			if (next) repo = next;
			i++;
			continue;
		}
		if (token.startsWith("--repo=")) {
			repo = token.slice("--repo=".length);
		}
	}
	for (let i = ghIdx + 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-R" || token === "--repo" || VALUE_TAKING_FLAGS.has(token)) {
			// Skip the flag's value so it is never mistaken for the positional
			// identifier (`--milestone 3 14` must invalidate #14, not #3).
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		const direct = /^\d+$/.test(token) ? Number(token) : undefined;
		if (direct !== undefined && Number.isSafeInteger(direct) && direct > 0) {
			return repo !== undefined ? { number: direct, repo } : { number: direct };
		}
		const { repo: urlRepo, num } = parseSubjectUrl(subject, token);
		if (num !== undefined && Number.isSafeInteger(num) && num > 0) {
			// URL carries its own repo and wins over a stray --repo flag.
			return { number: num, repo: urlRepo };
		}
	}
	// Mutating subcommand with no identifier: gh operates on the current
	// branch's PR, which we cannot resolve synchronously here.
	return repo !== undefined ? { repo } : {};
}

/** Conservative tokenizer that splits a bash command into individual word tokens. Handles single/double-quoted strings, backslash escapes, and */
function tokenize(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	let buffer = "";
	let inSingle = false;
	let inDouble = false;
	const pushBuffer = () => {
		if (buffer.length > 0) {
			current.push(buffer);
			buffer = "";
		}
	};
	const pushSegment = () => {
		pushBuffer();
		if (current.length > 0) segments.push(current);
		current = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					buffer += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			buffer += command[i + 1];
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushBuffer();
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			pushSegment();
			// `&&`, `||` already collapsed by the segment break above.
			continue;
		}
		buffer += ch;
	}
	pushSegment();
	return segments;
}

/** Drop `github-cache` rows for any `gh issue|pr <mutating-subcmd>` call embedded in `command`. Safe to invoke unconditionally; no-op when the */
export function invalidateGithubCacheForBashCommand(command: string): void {
	if (!command?.includes("gh")) return;
	const segments = tokenize(command);
	for (const segment of segments) {
		const hit = detectGhMutation(segment);
		if (!hit) continue;
		if (hit.number !== undefined) {
			invalidateAllForNumber(hit.number, hit.repo);
		} else {
			invalidateAllForRepo(hit.repo);
		}
	}
}
