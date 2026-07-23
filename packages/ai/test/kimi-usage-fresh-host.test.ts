/**
 * Regression: kimiUsageProvider.fetchUsage must return a real report on a fresh
 * host whose veyyon config dir does not exist yet.
 *
 * The bug: building the Kimi request headers calls getDeviceId(), which writes a
 * device-id file under getAgentDir(). getAgentDir() only names the config root;
 * it does not create it. On a clean CI runner (or a first-ever launch) that
 * directory is absent, so fs.writeFileSync threw ENOENT. That throw propagated
 * up through getKimiCommonHeaders() into fetchUsage's network try-block and was
 * swallowed as a null "usage unavailable" (a Law-10 silent fallback that masked
 * a filesystem failure as a network one). The visible symptom: every
 * fetchUsage call returned null on CI while passing on developer machines whose
 * config dir already existed. The fix creates the missing directory before
 * writing, and hoists header construction out of the network try so any real
 * local error surfaces loudly instead of becoming null.
 *
 * This runs in a SUBPROCESS with VEYYON_CONFIG_DIR pointed at a fresh empty temp
 * directory: getDeviceId()/getKimiCommonHeaders() memoize their result for the
 * life of a process after the first success, so an in-process test would observe
 * another test's already-memoized value instead of the fresh-host path.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PKG_ROOT = path.join(import.meta.dir, "..");
const USAGE_KIMI = path.join(PKG_ROOT, "src", "usage", "kimi.ts");

describe("kimiUsageProvider.fetchUsage on a fresh host (no config dir yet)", () => {
	it("returns a real report instead of a null masked by an ENOENT device-id write", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-fresh-host-"));
		// The config root itself does not exist yet, so <configRoot>/agent (where
		// the device-id file lives) and its parent are both absent — a first-ever
		// launch. Do NOT create it.
		const configDir = path.join(root, "config-never-created");

		const script = [
			`import { kimiUsageProvider } from ${JSON.stringify(USAGE_KIMI)};`,
			`const ctx = { fetch: async () => new Response(JSON.stringify({ usage: { name: "Q", used: 90, limit: 100 } }), { status: 200 }) };`,
			`const params = { provider: "kimi-code", baseUrl: "https://api.kimi.com/coding/v1", credential: { type: "oauth", accessToken: "t", accountId: "a" } };`,
			`const report = await kimiUsageProvider.fetchUsage(params, ctx);`,
			`if (report === null) { console.error("NULL_REPORT_ON_FRESH_HOST"); process.exit(3); }`,
			`process.stdout.write(String(report.limits[0].amount.used));`,
		].join("\n");

		// Build a genuinely-fresh env: strip every inherited VEYYON_* var (the
		// dirs module writes VEYYON_CODING_AGENT_DIR into process.env at runtime,
		// which would otherwise redirect the child back to the real, existing
		// agent dir and defeat the fresh-host reproduction), and point HOME and
		// VEYYON_CONFIG_DIR at brand-new temp paths.
		const childEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && !key.startsWith("VEYYON_")) childEnv[key] = value;
		}
		childEnv.HOME = path.join(root, "home");
		childEnv.VEYYON_CONFIG_DIR = configDir;

		const proc = Bun.spawnSync(["bun", "-e", script], {
			cwd: PKG_ROOT,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});

		const stderr = proc.stderr.toString();
		// The failure mode printed NULL_REPORT_ON_FRESH_HOST and exited 3.
		expect(stderr).not.toContain("NULL_REPORT_ON_FRESH_HOST");
		expect(stderr).toBe("");
		expect(proc.exitCode).toBe(0);
		// The summary row parsed cleanly: used = 90 from the 200 payload.
		expect(proc.stdout.toString().trim()).toBe("90");

		// The device-id file was persisted under the freshly created agent dir
		// (a profiles/default/agent subtree of the config root), proving the fix
		// created the previously-absent parent directory before writing.
		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name === "kimi-device-id") found.push(full);
			}
		};
		walk(root);
		expect(found).toHaveLength(1);
		expect(fs.readFileSync(found[0]!, "utf-8").trim()).toMatch(/^[0-9a-f]{32}$/);

		fs.rmSync(root, { recursive: true, force: true });
	});
});
