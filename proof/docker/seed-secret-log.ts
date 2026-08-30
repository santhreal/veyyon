/**
 * Seed the secret use log with two real uses and one line nothing can read, so a
 * scene can photograph the row `/secret log` states its unreadable lines on.
 *
 * The two uses go through the product's own encoder — `buildExpansionRecord`
 * builds the record from tool arguments the way the audit seam does, and
 * `encodeRecord` writes the line the reader parses — so the rows under capture
 * are rows veyyon wrote. The third line is a truncated JSON object, which is what
 * a log damaged by a crash or a half-flushed write actually looks like, and the
 * decoder counts it rather than dropping it.
 *
 * ONE unreadable line on purpose: the count is the point of the frame, and one is
 * the count that needs its verb to agree.
 *
 * Run inside the recorder before veyyon starts:
 *   bun /repo/proof/docker/seed-secret-log.ts /sandbox/home/.veyyon/profiles/default/agent
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildExpansionRecord,
	encodeRecord,
	SECRET_AUDIT_FILENAME,
} from "../../packages/coding-agent/src/secrets/audit";

const profileDir = path.resolve(process.argv[2] ?? "/sandbox/home/.veyyon/profiles/default/agent");
const logPath = path.join(profileDir, SECRET_AUDIT_FILENAME);

/** The placeholder these uses spend. Recorded by name; no value is ever in the file. */
const PLACEHOLDER = "#DEMO_API_TOKEN#";
const KNOWN = (placeholder: string): boolean => placeholder === PLACEHOLDER;
/** No masking to do here: nothing in these arguments is a credential. */
const OBFUSCATE = (value: string): string => value;

const now = Date.now();
const uses = [
	{
		tool: "bash",
		at: now - 22 * 60_000,
		args: { command: `curl -sS -H "Authorization: Bearer ${PLACEHOLDER}" https://api.example.com/v1/usage` },
	},
	{
		tool: "read",
		at: now - 4 * 60_000,
		args: { path: "https://api.example.com/v1/projects", headers: { authorization: `Bearer ${PLACEHOLDER}` } },
	},
];

const lines: string[] = [];
for (const use of uses) {
	const record = buildExpansionRecord({
		args: use.args,
		tool: use.tool,
		session: "0198f2b1-scene",
		at: use.at,
		known: KNOWN,
		obfuscate: OBFUSCATE,
	});
	if (record === null) throw new Error(`seed-secret-log: ${use.tool} carried no placeholder to record`);
	lines.push(encodeRecord(record));
}

// Cut mid-object, the way an interrupted append leaves a line. The decoder's
// JSON.parse rejects it, which is what makes it countable.
lines.push('{"at":' + String(now - 12 * 60_000) + ',"secrets":["#DEMO_API_TOKEN#"],"tool":"ba');

fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(logPath, `${lines.join("\n")}\n`, { mode: 0o600 });
process.stdout.write(`seed-secret-log: ${uses.length} uses and 1 unreadable line at ${logPath}\n`);
