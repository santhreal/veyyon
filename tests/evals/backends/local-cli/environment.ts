/** Variables a trial inherits by exact name; each is how a process finds programs, text, time or a proxy. */
const INHERITED_VARIABLES = new Set([
	"PATH",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"TZ",
	"SYSTEMROOT",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
]);

/**
 * The part of the runner's environment a trial sees: the variables above and `PUPPETEER_*`. Run code
 * reads `process.env`, so every other variable (tokens, keys, paths into the runner's work) stays out
 * of what the model can print, and of the transcript.
 */
export function trialEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && (INHERITED_VARIABLES.has(name) || name.startsWith("PUPPETEER_"))) kept[name] = value;
	}
	return kept;
}
