/**
 * `/secret log X N` shows the last N uses OF X, not the uses of X among the last N.
 *
 * WHY THIS SUITE EXISTS. `--name` is new, and the log is read through `SecretAuditLog.read({ limit })`,
 * which keeps the last N records of the whole file. Filtering after that read is the obvious
 * implementation and it answers a different question from the one asked: on a busy session where one
 * credential is spent constantly and another was spent this morning, `--limit 20` keeps twenty
 * records that are all the busy one, and `/secret log THE_OTHER 20` reports that the
 * other credential has never been used.
 *
 * That is the worst possible failure for this command. The log exists to answer "where has this
 * credential been spent", which is the question somebody asks while deciding whether to rotate a key
 * they think has leaked, and the wrong answer is the reassuring one.
 *
 * WHAT IT CLOSES. The ORDER of the three steps: read everything, narrow to the name, then take the
 * last N. The fixture below is built so that limiting first and narrowing second returns nothing at
 * all, so an implementation that gets the order wrong cannot pass by accident. It also pins that the
 * unnamed log still limits the way it always did, so the wider read did not change the default, and
 * that an empty result for one name is worded differently from an empty log, because the two support
 * opposite conclusions.
 *
 * WHAT IT DOES NOT CATCH. The log's own rotation and decode ceilings, which bound the read before
 * any of this runs and are asserted in `audit-log-rotation.test.ts` and
 * `audit-log-decoding-is-strict.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretAuditLog } from "@veyyon/coding-agent/secrets/audit";
import { runSecretCommand } from "@veyyon/coding-agent/secrets/secret-command";
import { SecretVault } from "@veyyon/coding-agent/secrets/vault";

const NOW = Date.parse("2026-08-02T15:00:00Z");
const MINUTE = 60_000;

/**
 * A log whose tail is entirely the OTHER secret.
 *
 * Five uses of `#DEPLOY_KEY#` first, then twenty of `#BUSY_KEY#`. Any implementation that limits
 * before it narrows sees only `#BUSY_KEY#` records and reports that `DEPLOY_KEY` was never spent.
 */
async function logWithABuriedSecret(): Promise<{ auditLog: SecretAuditLog; cleanup: () => Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-log-"));
	const auditLog = new SecretAuditLog(path.join(root, "secret-use.jsonl"));
	for (let index = 1; index <= 5; index++) {
		auditLog.record({
			at: NOW - (30 - index) * MINUTE,
			secrets: ["#DEPLOY_KEY#"],
			tool: "bash",
			command: `deploy-step-${index}`,
		});
	}
	for (let index = 1; index <= 20; index++) {
		auditLog.record({
			at: NOW - (20 - index) * MINUTE,
			secrets: ["#BUSY_KEY#"],
			tool: "bash",
			command: `poll-step-${index}`,
		});
	}
	await auditLog.flush();
	return { auditLog, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function vaultIn(root: string): SecretVault {
	return new SecretVault(
		{
			globalConfigRoot: path.join(root, "global"),
			profileDir: path.join(root, "profile"),
			projectDir: path.join(root, "project"),
		},
		() => NOW,
	);
}

async function showLog(auditLog: SecretAuditLog, request: { name?: string; limit?: number }): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-secret-log-vault-"));
	try {
		const result = await runSecretCommand(
			{ subcommand: "log", ...request },
			{ vault: vaultIn(root), readEnv: () => undefined, defaultTtl: null, now: NOW, auditLog },
		);
		return result.message;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("the log narrows to a name before it limits", () => {
	/**
	 * The headline case. A limit smaller than the number of uses, and a tail holding none of them.
	 *
	 * Narrowing first gives the last three uses of the named secret. Limiting first gives nothing,
	 * which is the reassuring wrong answer this suite exists to make impossible.
	 */
	it("shows the last uses of the named secret even when the tail holds none of them", async () => {
		const { auditLog, cleanup } = await logWithABuriedSecret();
		try {
			const message = await showLog(auditLog, { name: "DEPLOY_KEY", limit: 3 });

			expect(message).toContain("Uses of #DEPLOY_KEY#:");
			expect(message).toContain("deploy-step-3");
			expect(message).toContain("deploy-step-4");
			expect(message).toContain("deploy-step-5");
			// The limit still bites, from the narrowed set: the two oldest uses are outside it.
			expect(message).not.toContain("deploy-step-1");
			expect(message).not.toContain("deploy-step-2");
			// And nothing belonging to the other secret leaks into an answer about this one.
			expect(message).not.toContain("poll-step");
		} finally {
			await cleanup();
		}
	});

	/** Every use, when no limit is given, rather than the default twenty of the whole log. */
	it("shows every use of the named secret when no limit is given", async () => {
		const { auditLog, cleanup } = await logWithABuriedSecret();
		try {
			const message = await showLog(auditLog, { name: "DEPLOY_KEY" });

			for (let index = 1; index <= 5; index++) expect(message).toContain(`deploy-step-${index}`);
			expect(message).not.toContain("poll-step");
		} finally {
			await cleanup();
		}
	});

	/** The unnamed log is unchanged by the wider read: a limit still keeps the last N of everything. */
	it("still limits the unnamed log to the last records of the whole file", async () => {
		const { auditLog, cleanup } = await logWithABuriedSecret();
		try {
			const message = await showLog(auditLog, { limit: 3 });

			expect(message).not.toContain("Uses of #");
			expect(message).toContain("poll-step-20");
			expect(message).toContain("poll-step-18");
			expect(message).not.toContain("poll-step-17");
			expect(message).not.toContain("deploy-step");
		} finally {
			await cleanup();
		}
	});

	/**
	 * An empty answer for one name is not the same sentence as an empty log.
	 *
	 * "This credential has not been spent" and "nothing has been spent" support opposite decisions
	 * about whether to rotate it, so the heading stays even when there is nothing under it.
	 */
	it("names the secret even when it has never been used", async () => {
		const { auditLog, cleanup } = await logWithABuriedSecret();
		try {
			const message = await showLog(auditLog, { name: "NEVER_SPENT" });

			expect(message).toContain("Uses of #NEVER_SPENT#:");
			expect(message).toContain("No secret has been used yet.");
			expect(message).not.toContain("deploy-step");
			expect(message).not.toContain("poll-step");
		} finally {
			await cleanup();
		}
	});
});
