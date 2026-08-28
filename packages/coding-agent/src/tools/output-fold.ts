type FoldClass = "run" | "pass" | "noTestFiles" | "packageOk" | "buildProgress" | "dependencyFetch";

const LINE_PATTERNS: ReadonlyArray<readonly [FoldClass, RegExp]> = [
	["run", /^=== (?:RUN|CONT|PAUSE)\s+\S/],
	["pass", /^\s*--- (?:PASS|SKIP): \S/],
	["noTestFiles", /^\?\s+\S+\s+\[no test files\]$/],
	["packageOk", /^ok\s+\S+\s+[\d.]+s(?: \(cached\))?$/],
	["pass", /^\S+::\S+\s+(?:PASSED|SKIPPED|XFAIL|XPASS)(?:\s+\[\s*\d+%\])?$/],
	["pass", /^test \S+ \.\.\. (?:ok|ignored)$/],
	["pass", /^\s+[✓√] \S/],
	["packageOk", /^\s*(?:PASS|SKIP)\s+\S+\.\S+$/],
	["pass", /^\((?:pass|skip|todo)\) \S/],
	["pass", /^ok \d+(?: - \S| \S|$)/],
	["pass", /^\S+ \(\S+\) \.\.\. (?:ok|skipped(?: .*)?|expected failure)$/],
	["buildProgress", /^\s+(?:Compiling|Checking|Downloaded|Downloading|Installing|Fresh|Unpacking) \S+ v\S+/],
	["buildProgress", /^\[ *\d+%\] (?:Building|Linking|Built target|Generating|Automatic MOC) /],
	["buildProgress", /^make(?:\[\d+\])?: (?:Entering|Leaving) directory /],
	["buildProgress", /^> Task :\S+ (?:UP-TO-DATE|SKIPPED|NO-SOURCE|FROM-CACHE)$/],
	["buildProgress", /^ ---> (?:Running in )?[0-9a-f]{12}$/],
	["dependencyFetch", /^\[INFO\] Download(?:ing|ed) from \S+: \S+/],
	["dependencyFetch", /^go: (?:downloading|extracting|finding) \S+ v\S+/],
	["dependencyFetch", /^Requirement already satisfied: \S+ in \S+/],
	["dependencyFetch", /^Collecting \S+/],
	["dependencyFetch", /^\s+(?:Downloading|Using cached) \S+ \([\d.]+ ?[kKMG]?B\)$/],
	["dependencyFetch", /^Get:\d+ \S+ /],
	["dependencyFetch", /^Selecting previously unselected package \S+\.$/],
	["dependencyFetch", /^Preparing to unpack \.\.\./],
	["dependencyFetch", /^(?:Unpacking|Setting up|Processing triggers for) \S+ \([^)]+\)(?: over \([^)]+\))? \.\.\.$/],
	["dependencyFetch", /^\(Reading database \.\.\./],
];

export interface FoldResult {
	readonly text: string;
	readonly folded: Readonly<Partial<Record<FoldClass, number>>>;
	readonly skippedReason?: "nothing-to-fold" | "below-threshold";
}

export const MIN_FOLDABLE_LINES = 12;

const CLASS_LABEL: Record<FoldClass, string> = {
	run: "=== RUN/CONT/PAUSE",
	pass: "--- PASS/SKIP",
	noTestFiles: "packages with no test files",
	packageOk: "passing package results",
	buildProgress: "build progress",
	dependencyFetch: "dependency fetch/install",
};

export function classifyLine(line: string): FoldClass | null {
	const candidate = line.endsWith("\r") ? line.slice(0, -1) : line;
	for (const [cls, pattern] of LINE_PATTERNS) {
		if (pattern.test(candidate)) return cls;
	}
	return null;
}

export function foldToolOutputBookkeeping(text: string): FoldResult {
	const lines = text.split("\n");
	const counts: Partial<Record<FoldClass, number>> = {};
	let foldable = 0;
	for (const line of lines) {
		const cls = classifyLine(line);
		if (cls) {
			counts[cls] = (counts[cls] ?? 0) + 1;
			foldable++;
		}
	}
	if (foldable === 0) return { text, folded: {}, skippedReason: "nothing-to-fold" };
	if (foldable < MIN_FOLDABLE_LINES) return { text, folded: {}, skippedReason: "below-threshold" };

	const emitted = new Set<FoldClass>();
	const out: string[] = [];
	for (const line of lines) {
		const cls = classifyLine(line);
		if (!cls) {
			out.push(line);
			continue;
		}
		if (emitted.has(cls)) continue;
		emitted.add(cls);
		out.push(`[folded ${counts[cls]} ${CLASS_LABEL[cls]} lines; failures are never folded]`);
	}
	return { text: out.join("\n"), folded: counts };
}
