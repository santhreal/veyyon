import { describe, expect, it } from "bun:test";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@veyyon/coding-agent/config/bash-interceptor-rules";
import { checkBashInterception } from "@veyyon/coding-agent/tools/shell/bash-interceptor";

/**
 * The redirect and launch default rules already have coverage; this suite fills the
 * gap for the read / grep / glob / edit rules, which had none. Each rule is a Tier-B
 * regex whose boundaries are load-bearing: the read/grep rules require a trailing
 * argument (a bare `cat`/`grep` or a word like "category" that merely starts with the
 * verb must NOT be intercepted), the glob rule fires only when find/fd carries a
 * name/type/glob predicate (a plain `find .` or `find . -exec` is a real shell need),
 * and the edit rule fires only for in-place flags (`sed s/a/b/` without -i is a
 * read-only stream and must pass). It also locks the availability gate: a rule fires
 * only when its suggested replacement tool is actually available, so disabling `read`
 * does not block `cat`. A regression would either nag on legitimate commands or let an
 * interceptable command slip through with the wrong suggested tool.
 */

const ALL = ["read", "search", "edit", "write", "launch"];
const check = (command: string, tools: string[] = ALL) =>
	checkBashInterception(command, tools, DEFAULT_BASH_INTERCEPTOR_RULES);

describe("read rule (cat/head/tail/less/more)", () => {
	it.each(["cat package.json", "head -n5 file", "tail file", "less file", "more file"])(
		"routes %s to read",
		command => {
			const r = check(command);
			expect(r.block).toBe(true);
			expect(r.suggestedTool).toBe("read");
		},
	);

	it.each(["cat", "category list", "header.txt"])(
		"does not intercept %s (no file argument / prefix word)",
		command => {
			expect(check(command).block).toBe(false);
		},
	);
});

describe("grep/rg rule (grep/rg/ripgrep/ag/ack)", () => {
	it.each(["grep foo file", "rg foo", "ripgrep foo", "ag foo", "ack foo"])("routes %s to search", command => {
		const r = check(command);
		expect(r.block).toBe(true);
		expect(r.suggestedTool).toBe("search");
	});

	it("does not intercept a bare grep with no pattern", () => {
		expect(check("grep").block).toBe(false);
	});
});

describe("find/fd rule (find/fd/locate)", () => {
	it.each(["find . -name x", "fd --type f", "find . -iname '*.ts'"])("routes %s to search", command => {
		const r = check(command);
		expect(r.block).toBe(true);
		expect(r.suggestedTool).toBe("search");
	});

	it.each(["find .", "find . -exec rm {} \\;", "find . -delete", "locate foo"])(
		"does not redirect %s when search cannot preserve its behavior",
		command => {
			expect(check(command).block).toBe(false);
		},
	);
});

describe("edit rule (in-place sed/perl/awk)", () => {
	it.each(["sed -i s/a/b/ file", "sed --in-place s/a/b/ file", "perl -pi -e s/a/b/ file", "awk -i inplace 1 file"])(
		"routes %s to edit",
		command => {
			const r = check(command);
			expect(r.block).toBe(true);
			expect(r.suggestedTool).toBe("edit");
		},
	);

	it("does not intercept a read-only sed without -i", () => {
		expect(check("sed s/a/b/ file").block).toBe(false);
	});
});

describe("tool-availability gate", () => {
	it("fires only when the suggested replacement tool is available", () => {
		expect(check("cat file", ["read"]).block).toBe(true);
		expect(check("cat file", ["search", "edit"]).block).toBe(false);
	});
});
