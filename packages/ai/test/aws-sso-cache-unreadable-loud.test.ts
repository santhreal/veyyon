import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearAwsCredentialCache, resolveAwsCredentials } from "@veyyon/ai/providers/aws-credentials";
import { logger } from "@veyyon/utils";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * An AWS SSO cache file that cannot be read must not vanish into a debug line.
 *
 * `loadSsoCachedToken` scans `~/.aws/sso/cache` for the JSON blob holding the
 * session's bearer token. It cannot know which file is the right one without
 * reading it, so a read or parse failure is genuinely ambiguous: the file might
 * have been an unrelated profile's stale entry, or it might have been exactly
 * the token being looked for. The old code caught the error, logged it at debug
 * level, and returned `undefined` either way. The user then saw "no cached
 * credentials, run `aws sso login`" with nothing anywhere above debug level to
 * say that a token file WAS present and merely unreadable — a permissions
 * mistake or a half-written file presenting as a plain expired login.
 *
 * The fix is deliberately conditional rather than blanket. Warning on every
 * failed read would fire constantly on machines with several SSO profiles,
 * where other profiles' files are read and rejected as a matter of course, and
 * a warning that fires on the healthy path is a warning nobody reads. So the
 * errors are collected and reported only when the scan found nothing, which is
 * precisely the case where a swallowed error is the explanation.
 */
describe("An unreadable AWS SSO cache file is reported when it may have been the token", () => {
	let home = "";
	let cacheDir = "";
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	// Ambient AWS configuration on the developer's machine would resolve before
	// the SSO scan is ever reached, so every one of these has to be out of the way
	// for the suite to be testing what it says it is.
	const ENV_KEYS = [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_PROFILE",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_CONFIG_FILE",
		"AWS_SHARED_CREDENTIALS_FILE",
	] as const;
	const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		clearAwsCredentialCache();
		home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-aws-sso-"));
		cacheDir = path.join(home, ".aws", "sso", "cache");
		await fs.mkdir(cacheDir, { recursive: true });
		warnings = [];
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearAwsCredentialCache();
		delete Bun.env.AWS_EC2_METADATA_DISABLED;
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = savedEnv[key];
		}
		if (home) {
			await removeWithRetries(home);
			home = "";
		}
	});

	const START_URL = "https://veyyon-test.awsapps.com/start";

	/** A profile pointing at the SSO start URL above, with nothing else configured. */
	async function writeSsoProfile(): Promise<void> {
		await fs.writeFile(
			path.join(home, ".aws", "config"),
			`[default]\nsso_start_url = ${START_URL}\nsso_region = us-east-1\nsso_account_id = 111122223333\nsso_role_name = ReadOnly\n`,
			"utf8",
		);
	}

	const ssoWarnings = () => warnings.filter(entry => entry.message.includes("could not be read"));

	/**
	 * The core case. A single corrupt file, no other candidates, and the scan
	 * comes up empty: the corrupt file is the only possible explanation and the
	 * operator has to be told which one it was.
	 */
	test("names the unreadable file when the scan finds no token", async () => {
		await writeSsoProfile();
		await fs.writeFile(path.join(cacheDir, "botched.json"), "{ this is not json", "utf8");

		await resolveAwsCredentials({}).catch(() => undefined);

		const reported = ssoWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("log in again");
		expect(String(reported[0]?.fields.unreadable)).toContain("botched.json");
		expect(reported[0]?.fields.startUrl).toBe(START_URL);
	});

	/**
	 * A file that is present and parses but belongs to another start URL is a
	 * normal miss, not a fault. Without this the suite would pass against an
	 * implementation that warned on every empty scan, which is the ordinary state
	 * of a machine that has simply not logged in yet.
	 */
	test("stays silent when every cache file is readable and simply does not match", async () => {
		await writeSsoProfile();
		await fs.writeFile(
			path.join(cacheDir, "other.json"),
			JSON.stringify({ startUrl: "https://someone-else.awsapps.com/start", accessToken: "t" }),
			"utf8",
		);

		await resolveAwsCredentials({}).catch(() => undefined);

		expect(ssoWarnings()).toHaveLength(0);
	});

	/**
	 * An empty cache directory is the most common state of all and must be
	 * completely quiet. This pins that the report is tied to a read FAILURE and
	 * not merely to the scan returning nothing.
	 */
	test("stays silent when the cache directory holds no files at all", async () => {
		await writeSsoProfile();

		await resolveAwsCredentials({}).catch(() => undefined);

		expect(ssoWarnings()).toHaveLength(0);
	});

	/**
	 * The half that keeps the warning from firing on the healthy path: a corrupt
	 * file sitting next to the one that DOES match must not produce a warning,
	 * because the login worked and nothing degraded.
	 */
	test("stays silent when a token was found despite an unreadable neighbour", async () => {
		await writeSsoProfile();
		await fs.writeFile(path.join(cacheDir, "botched.json"), "{ this is not json", "utf8");
		await fs.writeFile(
			path.join(cacheDir, "good.json"),
			JSON.stringify({
				startUrl: START_URL,
				accessToken: "sso-access-token",
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			}),
			"utf8",
		);

		await resolveAwsCredentials({}).catch(() => undefined);

		expect(ssoWarnings()).toHaveLength(0);
	});

	/**
	 * Every unreadable file is listed, not just the first. With several profiles
	 * on one machine the operator needs to know which of them to look at, and a
	 * report naming one file out of three sends them to fix the wrong one.
	 */
	test("lists every file that could not be read", async () => {
		await writeSsoProfile();
		await fs.writeFile(path.join(cacheDir, "one.json"), "{ broken", "utf8");
		await fs.writeFile(path.join(cacheDir, "two.json"), "also broken", "utf8");

		await resolveAwsCredentials({}).catch(() => undefined);

		const reported = ssoWarnings();
		expect(reported).toHaveLength(1);
		const listed = String(reported[0]?.fields.unreadable);
		expect(listed).toContain("one.json");
		expect(listed).toContain("two.json");
	});
});
