/**
 * A slash command nothing can handle must be refused, not handed to the model as prose.
 *
 * THE BUG, found by driving the real TUI. `/secret list` was typed into a build whose binary
 * predated the `/secret` command by one day. `executeBuiltinSlashCommand` returns `false` for a name
 * it does not know, `input-controller.ts` falls through to treating the text as a prompt, and the
 * model received the literal string "/secret list" as a user message. It did what a model does with
 * that: it searched the filesystem for secrets, reaching outside the project into
 * `~/.config/axial/secrets.env` and `~/ryadom-recon/secrets_search.sh`.
 *
 * WHY THIS IS WORSE THAN A COSMETIC MISS. The user's intent when typing `/secret` is "handle this
 * credential safely". The behaviour was "give the string to the model, which then goes looking for
 * credential files". The same path is reached by an ordinary typo (`/secrt`), by a command belonging
 * to an extension that failed to load, and by a known command handed arguments it does not accept
 * (`parsed.args.length > 0 && !command.allowArgs` also returns `false`). A version skew between a
 * user's muscle memory and their installed build is not an exotic condition.
 *
 * WHERE THE CHECK HAD TO GO. Not in the input controller: extension commands, custom commands,
 * file-based commands and prompt templates are all resolved INSIDE `prompt()`, and every one of them
 * is invoked as `/name`. So the refusal sits after the last resolver, and it fires only when nothing
 * changed the text.
 *
 * THE ARGUMENTS ARE NEVER IN THE MESSAGE. A miss on `/secret add DB_PASSWORD hunter2` must name
 * `secrt` and stop. The suite asserts that directly, because an error message becomes history, a
 * transcript entry, and a headless log line.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import {
	unknownSlashCommandMessage,
	unresolvedSlashCommandName,
} from "@veyyon/coding-agent/slash-commands/helpers/parse";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

describe("telling a command apart from a path", () => {
	/** The names that must be recognised as commands, including the one that started this. */
	it.each(["secret", "secrt", "help", "set_cwd", "auto-edit", "a"])("treats /%s as a command", name => {
		expect(unresolvedSlashCommandName(`/${name}`)).toBe(name);
	});

	/** Arguments do not change the verdict, only the name is returned. */
	it("returns the name for an invocation with arguments", () => {
		expect(unresolvedSlashCommandName("/secret list")).toBe("secret");
		expect(unresolvedSlashCommandName("/secret add DB_PASSWORD hunter2")).toBe("secret");
	});

	/**
	 * A message about a file is not a command, and this is the case that keeps the refusal usable.
	 *
	 * "/etc/hosts is broken" is a sentence a user types. Refusing it would be a worse bug than the
	 * one being fixed, so the separator does the work: a name containing `/` is a path.
	 */
	it.each([
		"/etc/hosts is broken",
		"/usr/bin/env is missing",
		"/var/log/syslog filled up",
		"/home/user/project/src/main.ts needs a fix",
	])("treats %s as prose", text => {
		expect(unresolvedSlashCommandName(text)).toBeUndefined();
	});

	/** A name beginning with a digit is prose, matching the naming rule commands actually follow. */
	it("treats a digit-leading token as prose", () => {
		expect(unresolvedSlashCommandName("/2fa is enabled")).toBeUndefined();
		expect(unresolvedSlashCommandName("/500 errors in the log")).toBeUndefined();
	});

	/** Text that does not begin with a slash is never a command. */
	it("returns undefined for text with no leading slash", () => {
		expect(unresolvedSlashCommandName("secret list")).toBeUndefined();
		expect(unresolvedSlashCommandName("tell me about /secret")).toBeUndefined();
	});

	/** A bare slash is an empty invocation, which the palette handles rather than the refusal. */
	it("returns undefined for a bare slash", () => {
		expect(unresolvedSlashCommandName("/")).toBeUndefined();
		expect(unresolvedSlashCommandName("")).toBeUndefined();
	});

	/**
	 * `parseSlashCommand` splits on `:` as well as whitespace, so a namespaced command reduces to
	 * its namespace. `/skill:humanizer` is therefore reported as `skill`, which is the name a user
	 * needs to hear about when no skill commands are registered.
	 */
	it("reduces a namespaced invocation to its namespace", () => {
		expect(unresolvedSlashCommandName("/skill:humanizer")).toBe("skill");
	});
});

describe("the message a refused command produces", () => {
	/** It has to say what happened and what to do, in one sentence each. */
	it("names the command, says it was not sent, and gives two ways forward", () => {
		const message = unknownSlashCommandMessage("secrt");
		expect(message).toBe(
			'Unknown command "/secrt". Nothing handled it, so it was not sent to the model. ' +
				"Type / to see the commands this build has, or drop the leading slash to send it as a message.",
		);
	});

	/**
	 * THE INVARIANT. The tail of a missed credential command is a credential.
	 *
	 * The message is built from the name alone, so this holds by construction. It is asserted anyway
	 * because the message is the one part of this that reaches history, the transcript, and a
	 * headless log, and a future edit that helpfully echoed the full input would leak.
	 */
	it("cannot contain the arguments of the invocation that produced it", () => {
		const name = unresolvedSlashCommandName("/secrt add DB_PASSWORD hunter2");
		expect(name).toBe("secrt");
		const message = unknownSlashCommandMessage(name!);
		expect(message).not.toContain("hunter2");
		expect(message).not.toContain("DB_PASSWORD");
		expect(message).toContain("secrt");
	});
});

describe("the refusal is reachable from prompt()", () => {
	/**
	 * The wiring, which is the half a predicate test cannot see.
	 *
	 * The predicate above can be perfect and the bug still ship if nothing calls it. These cases run
	 * a real session and assert the refusal happens INSIDE `prompt()`, after the resolvers, and
	 * before any provider work: an unknown command must never become a request, so the rejection
	 * arrives without a credential, a network call, or a message in the transcript.
	 */
	let tempDir: string;
	let session: AgentSession;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `unknown-slash-${Snowflake.next()}-`));
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir,
			sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
			authStorage: await AuthStorage.create(path.join(tempDir, "auth.db")),
			settings: Settings.isolated({ "async.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});
		session = created.session;
	});

	afterAll(async () => {
		await session.dispose();
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// A busy temp dir is not a test failure.
		}
	});

	/** THE REGRESSION. This exact string was forwarded to a model and started a secrets hunt. */
	it("refuses /secret list on a build without the command instead of prompting", async () => {
		await expect(session.prompt("/secret list")).rejects.toThrow(/Unknown command "\/secret"/);
	});

	/** A typo is the everyday form of the same mistake. */
	it("refuses a mistyped command", async () => {
		await expect(session.prompt("/secrt")).rejects.toThrow(/Unknown command "\/secrt"/);
	});

	/** The credential in a missed `/secret add` must not reach the error, and so not the transcript. */
	it("does not echo the arguments of a missed credential command", async () => {
		let message = "";
		try {
			await session.prompt("/secrt add DB_PASSWORD hunter2");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('"/secrt"');
		expect(message).not.toContain("hunter2");
		expect(message).not.toContain("DB_PASSWORD");
	});

	/** Nothing was recorded: a refused command is not a turn, so the message list is untouched. */
	it("adds no message to the session when it refuses", async () => {
		const before = session.agent.state.messages.length;
		await expect(session.prompt("/notacommandatall")).rejects.toThrow(/Unknown command/);
		expect(session.agent.state.messages.length).toBe(before);
	});

	/**
	 * A synthetic prompt is exempt.
	 *
	 * Agent-authored turns (auto-continue, reminders, plan steps) are not a user reaching for a
	 * command, and a refusal there would break an internal caller rather than help anyone. Asserted
	 * as "not the unknown-command error": with no credentials the request fails for its own reasons,
	 * and what matters is that it got past this check.
	 */
	it("does not refuse a synthetic prompt", async () => {
		let message = "";
		try {
			await session.prompt("/notacommandatall", { synthetic: true });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toContain("Unknown command");
	});
});
