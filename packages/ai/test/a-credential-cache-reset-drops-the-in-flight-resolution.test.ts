import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as awsCredentials from "@veyyon/ai/providers/aws-credentials";
import * as googleAuth from "@veyyon/ai/providers/google-auth";
import { removeWithRetries } from "../../utils/src/temp";

// WHY: a credential cache reset used to drop the cached VALUE and keep the
// RESOLUTION still in flight. `clearAwsCredentialCache()` cleared `cache` and
// left `inflight` populated, so the next caller joined the promise the reset was
// meant to discard: seven wall-clock assertions in packages/ai/test only failed
// under a full-directory run, where an earlier file had left a resolution
// pending, and `invalidateAwsCredentialCache()` — called on a 401/403 so stale
// credentials are re-resolved — could not reach a resolution that was already
// running with the credentials just rejected.
//
// The class this closes: a module holding a value cache beside a single-flight
// map must drop both from every reset seam it exports, and the seam must not
// break single flight for the keys it was not asked about. The variant space is
// the exported reset seams of the two credential modules, read from the module
// objects at run time, so a third seam (or a third module wired into the table)
// turns this suite red until someone covers it.
//
// What it does not catch: a reset seam in a module not listed in MODULES below,
// and cancellation — dropping an in-flight entry does not abort the resolution
// already running, it only stops later callers from adopting it.

const AWS_ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
] as const;

const GOOGLE_ENV_KEYS = [
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_ACCESS_TOKEN",
	"CLOUDSDK_AUTH_ACCESS_TOKEN",
	"GOOGLE_VERTEX_REFRESH_SKEW_MS",
] as const;

/** Reset seams covered below, by module. A seam absent from this table fails the sweep. */
const MODULES: ReadonlyArray<{ name: string; module: Record<string, unknown>; covered: readonly string[] }> = [
	{
		name: "aws-credentials",
		module: awsCredentials as unknown as Record<string, unknown>,
		covered: ["clearAwsCredentialCache", "invalidateAwsCredentialCache"],
	},
	{
		name: "google-auth",
		module: googleAuth as unknown as Record<string, unknown>,
		covered: ["__resetVertexTokenCache"],
	},
];

function quoteForConfig(p: string): string {
	if (!/[\s"]/.test(p)) return p;
	return `"${p.replace(/(["])/g, "\\$1")}"`;
}

describe("a credential cache reset drops the in-flight resolution", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of [...AWS_ENV_KEYS, ...GOOGLE_ENV_KEYS]) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cred-reset-"));
		awsCredentials.clearAwsCredentialCache();
		googleAuth.__resetVertexTokenCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		awsCredentials.clearAwsCredentialCache();
		googleAuth.__resetVertexTokenCache();
	});

	/**
	 * A credential_process helper that records one file per invocation, blocks until
	 * `release` exists, then prints a credential envelope. Real spawn, real envelope, so
	 * the resolution is genuinely in flight while the test calls a reset, and the
	 * invocation count is what separates "resolved fresh" from "joined the pending flight".
	 */
	async function writeGatedHelper(name: string, invocations: string, release: string): Promise<string> {
		const script = path.join(tmp, name);
		await Bun.write(
			script,
			`const fs = require("node:fs");
fs.mkdirSync(${JSON.stringify(invocations)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(invocations)} + "/" + process.pid + "-" + Date.now() + "-" + Math.random(), "1");
// Bounded: 4000 x 5ms, so a lost release file ends the helper instead of hanging the run.
for (let i = 0; i < 4000 && !fs.existsSync(${JSON.stringify(release)}); i++) Bun.sleepSync(5);
console.log(JSON.stringify({ Version: 1, AccessKeyId: "AKIA_TEST", SecretAccessKey: "sek" }));`,
		);
		return script;
	}

	async function writeConfig(profiles: ReadonlyArray<{ profile: string; script: string }>): Promise<void> {
		const cfg = path.join(tmp, "config");
		const text = profiles
			.map(
				({ profile, script }) =>
					`[profile ${profile}]\ncredential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}\n`,
			)
			.join("");
		await Bun.write(cfg, text);
		Bun.env.AWS_CONFIG_FILE = cfg;
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	/** How many times the helper ran. One means the later caller joined the pending flight. */
	async function invocationCount(dir: string): Promise<number> {
		const entries = await fs.readdir(dir).catch(() => [] as string[]);
		return entries.length;
	}

	test("clearAwsCredentialCache: a caller after the reset resolves fresh instead of joining the pending resolution", async () => {
		const invocations = path.join(tmp, "inv-1");
		const release = path.join(tmp, "release-1");
		const helper = await writeGatedHelper("gated.js", invocations, release);
		await writeConfig([{ profile: "p", script: helper }]);

		// The single-flight entry is registered synchronously by the call itself, so the
		// reset below lands while the first resolution is still running.
		const pending = awsCredentials.resolveAwsCredentials({ profile: "p", region: "us-east-1" });

		awsCredentials.clearAwsCredentialCache();

		const afterReset = awsCredentials.resolveAwsCredentials({ profile: "p", region: "us-east-1" });
		await Bun.write(release, "1");

		// Both settle: the reset drops the entry, it never cancels the resolution.
		expect((await pending).accessKeyId).toBe("AKIA_TEST");
		expect((await afterReset).accessKeyId).toBe("AKIA_TEST");
		expect(await invocationCount(invocations)).toBe(2);
	});

	test("invalidateAwsCredentialCache: only the named profile's pending resolution is dropped", async () => {
		const invocationsA = path.join(tmp, "inv-a");
		const invocationsB = path.join(tmp, "inv-b");
		const release = path.join(tmp, "release-ab");
		const helperA = await writeGatedHelper("gated-a.js", invocationsA, release);
		const helperB = await writeGatedHelper("gated-b.js", invocationsB, release);
		await writeConfig([
			{ profile: "a", script: helperA },
			{ profile: "b", script: helperB },
		]);

		const pendingA = awsCredentials.resolveAwsCredentials({ profile: "a", region: "us-east-1" });
		const pendingB = awsCredentials.resolveAwsCredentials({ profile: "b", region: "us-east-1" });

		awsCredentials.invalidateAwsCredentialCache({ profile: "a", region: "us-east-1" });

		const secondA = awsCredentials.resolveAwsCredentials({ profile: "a", region: "us-east-1" });
		const secondB = awsCredentials.resolveAwsCredentials({ profile: "b", region: "us-east-1" });
		await Bun.write(release, "1");

		expect((await pendingA).accessKeyId).toBe("AKIA_TEST");
		expect((await pendingB).accessKeyId).toBe("AKIA_TEST");
		expect((await secondA).accessKeyId).toBe("AKIA_TEST");
		expect((await secondB).accessKeyId).toBe("AKIA_TEST");

		// `a` was invalidated, so its second caller resolved on its own; `b` was never
		// named, so its second caller joined the flight already running.
		expect(await invocationCount(invocationsA)).toBe(2);
		expect(await invocationCount(invocationsB)).toBe(1);
	});

	test("__resetVertexTokenCache: a caller after the reset exchanges again instead of joining the pending exchange", async () => {
		const adc = path.join(tmp, "adc.json");
		await Bun.write(
			adc,
			JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "sec", refresh_token: "rt" }),
		);
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adc;

		const firstReached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const tokenResponse = (accessToken: string): Response =>
			new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600, token_type: "Bearer" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const pending = googleAuth.getVertexAccessToken({
			fetch: async () => {
				firstReached.resolve();
				await gate.promise;
				return tokenResponse("token-before-reset");
			},
		});
		await firstReached.promise;

		googleAuth.__resetVertexTokenCache();

		const afterReset = await googleAuth.getVertexAccessToken({
			fetch: async () => tokenResponse("token-after-reset"),
		});
		expect(afterReset).toBe("token-after-reset");

		gate.resolve();
		expect(await pending).toBe("token-before-reset");
	});

	test("every exported reset seam of both credential modules is covered here", () => {
		for (const { name, module, covered } of MODULES) {
			const seams = Object.keys(module)
				.filter(key => typeof module[key] === "function")
				.filter(key => /^(clear|invalidate|__reset)/.test(key))
				.sort();
			expect(seams, `${name}: a reset seam is uncovered by this suite`).toEqual([...covered].sort());
		}
	});
});
