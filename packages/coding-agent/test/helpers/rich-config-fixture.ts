/**
 * A real machine's `config.yml`: every domain populated, a credential inside an MCP
 * server block, a comment the user wrote, and keys from a newer build.
 *
 * One owner, because two suites need the SAME file to mean anything. `settings-rich-config-survives-a-write`
 * carries it through a Settings round trip, and `update-rich-config-survives-a-binary-swap`
 * carries it through a real binary swap. If each kept its own copy they would drift, and
 * "the config survived the update" would be a claim about two different configs.
 */
export const RICH_CONFIG = [
	"# A comment a user wrote",
	"theme:",
	"  dark: titanium",
	"temperature: 0.7",
	"topK: 40",
	"compaction:",
	"  threshold: 85%",
	"  reserveTokens: 8000",
	"display:",
	"  showTokenUsage: true",
	"  cacheMissMarker: true",
	"argot:",
	"  enabled: true",
	"  tokenBudget: 2048",
	"mcpServers:",
	"  paid-api:",
	"    command: node",
	"    args:",
	"      - server.js",
	"    env:",
	"      API_TOKEN: sk-live-do-not-touch-me",
	"keybindings:",
	"  submit: ctrl+enter",
	"futureFeature: from-a-newer-build",
	"futureBlock:",
	"  nested: alsoKept",
	"",
].join("\n");

/** The credential the fixture carries, so a test can assert on it without restating it. */
export const RICH_CONFIG_SECRET = "sk-live-do-not-touch-me";
