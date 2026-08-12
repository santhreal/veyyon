/**
 * A rule scoped to `tool:bash` is matched against the COMMAND, never the argument JSON.
 *
 * THE DEFECT. A tool without a `matcherDigest` has its stream rules matched against the raw
 * streamed argument JSON. `bash` had none, so every `tool:bash` rule was really being run
 * against `{"i":"…","command":"grep -rn foo src"}`, and both bundled bash rules were wrong in
 * both directions at once:
 *
 *   - SILENT WHERE IT SHOULD FIRE. The search nudge anchors on a search opening a command
 *     (start of text, `&&`, `||`, `;`, `(`). In the wire form the command starts mid-string
 *     after `"command":"`, so the plainest local search there is — `grep -rn foo src` — never
 *     nudged. `test-scope` was dead the same way: its terminator is `$` or `[|;&]`, and in the
 *     wire form `bun test` is followed by a quote.
 *   - FIRING WHERE IT CANNOT BE OBEYED. The `&&` and `;` inside a QUOTED remote command
 *     (`ssh host "ls x && grep -n foo y"`) are ordinary characters to the remote shell, but the
 *     rule read them as its own boundary and nudged the model to use a built-in tool that
 *     cannot reach that host at all. That is the misfire this suite was opened for.
 *
 * THE CLASS. Any `tool:bash` rule, present or future, matched against the wrong text. So this
 * file does not test one rule: it enumerates the bundled bash-scoped rules AT RUN TIME, pins
 * that set by exact equality, and requires a sample command for each. A new bash-scoped rule
 * turns this suite RED until someone writes down a command it fires on and confirms it fires
 * through the digest.
 *
 * The second half is the digest's own contract: heredoc bodies are DATA the command writes,
 * not commands it runs, so a script authored with `cat <<'EOF'` cannot trip a rule with its
 * contents, and an unterminated heredoc (the normal state mid-stream) is body to the end.
 *
 * WHAT IT DOES NOT CATCH. That `agent-session` prefers the digest over the raw delta — that
 * wiring is one branch shared by every tool exposing the hook, and `write` has relied on it
 * since it was added. What is checked here is that the bash tool exposes it and that its text
 * is the command.
 */
import { describe, expect, test } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { buildBuiltinRules } from "@veyyon/coding-agent/discovery/builtin-defaults";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { makeToolSession } from "../helpers/tool-session";

/** The real tool, so the digest under test is the one the session would call. */
const digest = new BashTool(makeToolSession()).matcherDigest;

/** Every bundled rule scoped to bash, discovered rather than listed. */
const bashRules: Rule[] = buildBuiltinRules().filter(rule => rule.scope?.includes("tool:bash") === true);

/**
 * A command each bash-scoped rule must fire on. Keyed by rule name and pinned below by exact
 * equality against the discovered set, so a new bash rule cannot land without one.
 */
const FIRES_ON: Record<string, string> = {
	"bash-tool-nudge": "grep -rn foo src",
	"test-scope": "bun test",
};

function firedRules(text: string): string[] {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "never",
		repeatMode: "once",
		repeatGap: 10,
	});
	for (const rule of bashRules) {
		expect(manager.addRule(rule), `${rule.name} carries no TTSR condition`).toBe(true);
	}
	return manager.checkSnapshot(text, { source: "tool", toolName: "bash", streamKey: text }).map(rule => rule.name);
}

/** What the session would match: the tool's digest of the streamed arguments. */
function firedThroughDigest(command: string, args: Record<string, unknown> = {}): string[] {
	return firedRules(digest({ i: "some intent", command, ...args }));
}

describe("the bash rules the digest has to serve", () => {
	test("every bundled bash-scoped rule has a command pinned here", () => {
		expect(bashRules.map(rule => rule.name).sort()).toEqual(Object.keys(FIRES_ON).sort());
	});

	test.each(Object.entries(FIRES_ON))("%s fires on its command through the digest", (name, command) => {
		expect(firedThroughDigest(command)).toContain(name);
	});

	test.each(Object.entries(FIRES_ON))("%s never sees the argument JSON that carries it", (_name, command) => {
		// The wire form is what the matcher used to get. The digest is the command itself, so
		// no rule can be anchored against `"command":"` or terminated by a closing quote.
		const wire = JSON.stringify({ i: "some intent", command });
		expect(digest({ i: "some intent", command })).toBe(command);
		expect(digest({ i: "some intent", command })).not.toBe(wire);
	});
});

describe("a search that does not run on this machine", () => {
	test("the reported misfire: an ssh command whose remote shell has its own && and ;", () => {
		const remote =
			'ssh -o BatchMode=yes box "ls /srv/app/nodes_minimax.py && grep -n minimax /srv/app/nodes.py | head -5; ' +
			"grep -rn 'class CLIPLoader' /srv/app/nodes_model.py | head -3\"";
		expect(firedThroughDigest(remote)).not.toContain("bash-tool-nudge");
	});

	// Each remote command carries a shell operator of its own, so the rule has a boundary to
	// anchor on and the silence below is the exemption doing its job rather than a command
	// that happened not to match. Dropping the exemption turns all of these RED.
	test.each([
		["a quoted remote find", "ssh box 'cd /var/log && find . -name \"*.gz\"'"],
		["a container exec", "docker exec web sh -c 'cd /app; grep -rn foo .'"],
		["a pod exec", "kubectl exec pod -- sh -c 'cd /srv && grep -c ready status'"],
		["podman", "podman run --rm img sh -c 'cd /src; rg needle .'"],
	])("stays quiet on %s", (_label, command) => {
		expect(firedThroughDigest(command)).not.toContain("bash-tool-nudge");
	});

	test("but the same searches on this machine still nudge", () => {
		// Non-vacuity: the silences above are the dispatcher's doing, not a dead rule.
		expect(firedThroughDigest("grep -rn foo /app")).toContain("bash-tool-nudge");
		expect(firedThroughDigest("rg needle /src")).toContain("bash-tool-nudge");
		// And a local command on a LATER line is not covered by an earlier ssh.
		expect(firedThroughDigest("ssh box uptime\ngrep -rn foo src")).toContain("bash-tool-nudge");
	});
});

describe("heredoc bodies are data, not commands", () => {
	test("a script written with a heredoc cannot trip a rule with its contents", () => {
		const command = "cat > probe.sh <<'EOF'\ngrep -rn foo src\nbun test\nEOF\nchmod +x probe.sh";
		expect(digest({ command })).toBe("cat > probe.sh <<'EOF'\nchmod +x probe.sh");
		expect(firedThroughDigest(command)).toEqual([]);
	});

	test("an unterminated heredoc is body to the end, which is the normal state mid-stream", () => {
		const command = "cat > probe.sh <<'EOF'\ngrep -rn foo src";
		expect(digest({ command })).toBe("cat > probe.sh <<'EOF'");
		expect(firedThroughDigest(command)).toEqual([]);
	});

	test.each([
		["an indented terminator after <<-", "cat <<-EOF > f\n\tfind . -name x\n\tEOF\nfind . -name real"],
		["an unquoted marker", "cat <<EOF > f\nbun test\nEOF\nbun test"],
	])("a real command after %s still reaches the rules", (_label, command) => {
		expect(firedThroughDigest(command).length).toBeGreaterThan(0);
	});

	test("a herestring is not a heredoc and keeps its text", () => {
		// `<<<` feeds one line to the command; there is no body to remove and no terminator
		// to look for, so treating it as an opener would swallow the rest of the command.
		const command = 'grep -q ok <<<"$out"; find . -name "*.ts"';
		expect(digest({ command })).toBe(command);
		expect(firedThroughDigest(command)).toContain("bash-tool-nudge");
		// The discriminating case is a BARE-WORD herestring with lines after it: read `<<<yes`
		// as an opener and `yes` becomes a marker whose terminator never comes, so every later
		// command is swallowed as its body.
		const bareWord = 'grep -q ok <<<yes\nfind . -name "*.ts"';
		expect(digest({ command: bareWord })).toBe(bareWord);
		expect(firedThroughDigest(bareWord)).toContain("bash-tool-nudge");
	});
});

describe("arguments that carry no command", () => {
	test.each([
		["nothing at all", {}],
		["an intent but no command yet", { i: "Searching" }],
		["a non-string command", { command: 42 }],
	])("%s digests to empty rather than to the wire form", (_label, args) => {
		expect(digest(args)).toBe("");
		expect(firedRules(digest(args))).toEqual([]);
	});
});
