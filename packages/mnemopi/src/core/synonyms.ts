export const SYNONYM_GROUPS = {
	database: ["db", "datastore", "data_store"],
	password: ["pass", "pwd", "passwd", "credential", "secret", "token"],
	config: ["configuration", "settings", "cfg", "setup"],
	error: ["bug", "issue", "fault", "failure", "crash", "exception", "traceback"],
	fix: ["repair", "resolve", "solve", "patch", "correct", "address"],
	deploy: ["deployment", "release", "ship", "push", "rollout"],
	server: ["host", "machine", "vm", "instance", "node", "vps"],
	api: ["endpoint", "interface", "service"],
	key: ["token", "credential", "secret", "api_key"],
	user: ["account", "profile", "identity", "person"],
	model: ["llm", "ai", "provider", "gpt", "claude", "gemini"],
	speed: ["fast", "quick", "performance", "latency", "throughput"],
	memory: ["recall", "remember", "storage", "retention"],
	search: ["find", "lookup", "query", "retrieve", "locate"],
	file: ["document", "doc", "text", "note"],
	code: ["script", "program", "source", "implementation"],
	test: ["verify", "check", "validate", "probe", "examine"],
	backup: ["snapshot", "copy", "save", "archive"],
	install: ["setup", "configure", "bootstrap", "init"],
	update: ["upgrade", "refresh", "renew", "sync"],
	delete: ["remove", "destroy", "purge", "clean", "wipe", "erase"],
	list: ["show", "display", "enumerate", "catalog"],
	time: ["date", "when", "timestamp", "schedule"],
	url: ["link", "address", "uri", "path"],
	health: ["status", "check", "pulse", "alive", "up"],
	service: ["daemon", "process", "systemd", "worker"],
	port: ["socket", "bind", "listen"],
	network: ["internet", "connection", "connectivity", "dns"],
	ssh: ["terminal", "shell", "remote", "connect"],
	git: ["commit", "push", "pull", "repo", "repository", "branch"],
	log: ["output", "stdout", "stderr", "trace", "debug"],
	cron: ["schedule", "job", "task", "timer", "periodic"],
	email: ["mail", "message", "inbox", "smtp"],
	image: ["picture", "photo", "screenshot", "graphic"],
	browser: ["web", "page", "site", "navigate", "chrome"],
	monitor: ["watch", "observe", "track", "survey"],
	alert: ["notify", "notification", "warning", "ping"],
	migrate: ["transfer", "move", "relocate", "port"],
	compare: ["diff", "versus", "vs", "contrast"],
	save: ["store", "persist", "preserve", "keep"],
} as const;

// The most common high-frequency function words. This minimal core is the set
// used for symmetric query↔content token-overlap filtering in beam/recall.ts,
// which imports it as the ONE owner instead of re-typing the same 28 literals.
// The full query STOP_WORDS below is built from this core plus the extended
// pronoun/temporal/discourse fillers used only for synonym-expansion cleaning.
export const CORE_QUERY_STOP_WORDS: ReadonlySet<string> = new Set<string>([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"was",
	"what",
	"when",
	"where",
	"who",
	"with",
]);

export const STOP_WORDS = new Set<string>([
	...CORE_QUERY_STOP_WORDS,
	"were",
	"been",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"must",
	"you",
	"he",
	"she",
	"we",
	"they",
	"me",
	"him",
	"her",
	"us",
	"them",
	"my",
	"your",
	"his",
	"its",
	"our",
	"their",
	"mine",
	"yours",
	"hers",
	"ours",
	"theirs",
	"which",
	"whom",
	"why",
	"these",
	"those",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"under",
	"but",
	"nor",
	"not",
	"so",
	"than",
	"too",
	"very",
	"just",
	"about",
	"also",
	"really",
	"actually",
	"basically",
	"simply",
	"if",
	"then",
	"else",
	"while",
	"because",
	"though",
	"although",
]);

type Canonical = keyof typeof SYNONYM_GROUPS;

const WORD_TO_CANONICAL = buildReverseMap();

function buildReverseMap(): ReadonlyMap<string, Canonical> {
	const reverse = new Map<string, Canonical>();
	for (const canonical in SYNONYM_GROUPS) {
		const key = canonical as Canonical;
		reverse.set(key, key);
		for (const synonym of SYNONYM_GROUPS[key]) reverse.set(synonym, key);
	}
	return reverse;
}

export function normalizeQuery(query: string): string {
	const canonicalWords = new Set<string>();
	for (const rawWord of query.toLowerCase().split(/\s+/)) {
		if (rawWord.length === 0 || STOP_WORDS.has(rawWord)) continue;
		canonicalWords.add(WORD_TO_CANONICAL.get(rawWord) ?? rawWord);
	}
	return Array.from(canonicalWords).sort().join(" ");
}
export function expandQuery(query: string): string {
	const words = query.toLowerCase().split(/\s+/);
	const expandedParts: string[] = [];
	for (const word of words) {
		if (word.length === 0) continue;
		if (STOP_WORDS.has(word)) {
			expandedParts.push(word);
			continue;
		}
		const canonical = WORD_TO_CANONICAL.get(word);
		if (canonical !== undefined) {
			const group = SYNONYM_GROUPS[canonical];
			let expanded = `(${canonical}`;
			for (const synonym of group) expanded += `|${synonym}`;
			expanded += ")";
			expandedParts.push(expanded);
		} else {
			expandedParts.push(word);
		}
	}
	return expandedParts.join(" ");
}
export function getSynonyms(word: string): string[] {
	const lowered = word.toLowerCase();
	const canonical = WORD_TO_CANONICAL.get(lowered);
	if (canonical === undefined) return [lowered];
	return [canonical, ...SYNONYM_GROUPS[canonical]];
}
