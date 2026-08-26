// Regression test for #2564: the CI workflow's `concurrency` block must route
// release runs to a per-sha group with no cancellation, so a later main push
// can't kill the in-flight release and leave the tag unpublished. The block is
// evaluated by GitHub at workflow-scheduling time (before any job can produce
// the signal), so this test re-implements the small subset of GitHub
// expression semantics the block uses and asserts the resolved group / cancel
// flag for every event shape we care about.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOW_PATH = path.resolve(import.meta.dir, "..", ".github", "workflows", "ci.yml");

type Value = string | boolean | null;

// `github` context fed into the evaluator. Nested objects are walked the same
// way as in real GHA expressions; missing keys resolve to `null`.
interface GhaCtx {
	workflow: string;
	ref: string;
	sha: string;
	event_name: string;
	event: {
		head_commit?: { message?: string };
	};
}

// Single-purpose, hand-rolled evaluator for the operators / functions the
// workflow's `concurrency` block uses: `startsWith`, `format`, `!`, `==`,
// `&&`, `||`, parens, single-quoted strings, dotted property access. Matches
// short-circuit semantics: `&&`/`||` return the underlying value (not a coerced
// bool), missing identifiers resolve to `null`, and `startsWith(null, …)` is
// false because the searchString coerces to `""`.
class GhaEval {
	#pos = 0;

	private constructor(
		private readonly src: string,
		private readonly ctx: { github: GhaCtx },
	) {}

	static run(expr: string, ctx: { github: GhaCtx }): Value {
		const ev = new GhaEval(expr.trim(), ctx);
		const value = ev.#or();
		ev.#skipWs();
		if (ev.#pos !== ev.src.length) {
			throw new Error(`trailing input at offset ${ev.#pos}: ${ev.src.slice(ev.#pos)}`);
		}
		return value;
	}

	// Substitute every `${{ … }}` placeholder in a workflow template string.
	static template(template: string, ctx: { github: GhaCtx }): string {
		let out = "";
		let i = 0;
		while (i < template.length) {
			const start = template.indexOf("${{", i);
			if (start === -1) {
				out += template.slice(i);
				break;
			}
			out += template.slice(i, start);
			const end = template.indexOf("}}", start);
			if (end === -1) throw new Error("unterminated ${{ expression");
			const v = GhaEval.run(template.slice(start + 3, end), ctx);
			out += v === null ? "" : String(v);
			i = end + 2;
		}
		return out;
	}

	#or(): Value {
		let left = this.#and();
		while (this.#consume("||")) {
			const right = this.#and();
			// Truthy left wins; only null/false/"" fall through.
			if (left !== null && left !== false && left !== "") continue;
			left = right;
		}
		return left;
	}

	#and(): Value {
		let left = this.#eq();
		while (this.#consume("&&")) {
			const right = this.#eq();
			// Falsy left short-circuits and is returned verbatim.
			if (left === null || left === false || left === "") continue;
			left = right;
		}
		return left;
	}

	#eq(): Value {
		let left = this.#unary();
		while (true) {
			if (this.#consume("==")) {
				const right = this.#unary();
				left = left === right;
				continue;
			}
			if (this.#consume("!=")) {
				const right = this.#unary();
				left = left !== right;
				continue;
			}
			return left;
		}
	}

	#unary(): Value {
		this.#skipWs();
		if (this.src[this.#pos] === "!") {
			this.#pos++;
			const v = this.#unary();
			return v === null || v === false || v === "";
		}
		return this.#primary();
	}

	#primary(): Value {
		this.#skipWs();
		const ch = this.src[this.#pos];
		if (ch === "(") {
			this.#pos++;
			const v = this.#or();
			this.#skipWs();
			if (this.src[this.#pos] !== ")") throw new Error("expected `)`");
			this.#pos++;
			return v;
		}
		if (ch === "'") return this.#string();
		// Identifier or function call.
		const ident = this.#identifier();
		this.#skipWs();
		if (this.src[this.#pos] === "(") return this.#call(ident);
		return this.#readPath(ident);
	}

	#string(): string {
		// GHA single-quoted: `''` is an escaped quote.
		this.#pos++; // opening quote
		let out = "";
		while (this.#pos < this.src.length) {
			const c = this.src[this.#pos];
			if (c === "'") {
				if (this.src[this.#pos + 1] === "'") {
					out += "'";
					this.#pos += 2;
					continue;
				}
				this.#pos++;
				return out;
			}
			out += c;
			this.#pos++;
		}
		throw new Error("unterminated string literal");
	}

	#identifier(): string {
		const start = this.#pos;
		while (this.#pos < this.src.length && /[A-Za-z0-9_.]/.test(this.src[this.#pos]!)) {
			this.#pos++;
		}
		if (start === this.#pos) throw new Error(`expected identifier at ${this.#pos}`);
		return this.src.slice(start, this.#pos);
	}

	#call(name: string): Value {
		this.#pos++; // opening paren
		const args: Value[] = [];
		this.#skipWs();
		if (this.src[this.#pos] !== ")") {
			for (;;) {
				args.push(this.#or());
				this.#skipWs();
				if (this.src[this.#pos] === ",") {
					this.#pos++;
					continue;
				}
				break;
			}
		}
		this.#skipWs();
		if (this.src[this.#pos] !== ")") throw new Error("expected `)` closing call");
		this.#pos++;
		switch (name) {
			case "startsWith": {
				const hay = args[0] === null || args[0] === false ? "" : String(args[0]);
				const needle = args[1] === null || args[1] === false ? "" : String(args[1]);
				return hay.startsWith(needle);
			}
			case "format": {
				const tmpl = args[0] === null ? "" : String(args[0]);
				return tmpl.replace(/\{(\d+)\}/g, (_, idx) => {
					const v = args[Number(idx) + 1];
					return v === null || v === false ? "" : String(v);
				});
			}
			default:
				throw new Error(`unsupported function: ${name}`);
		}
	}

	#readPath(dotted: string): Value {
		let cur: unknown = this.ctx;
		for (const seg of dotted.split(".")) {
			if (cur == null || typeof cur !== "object") return null;
			cur = (cur as Record<string, unknown>)[seg];
		}
		if (cur === undefined || cur === null) return null;
		if (typeof cur === "object") return null;
		return cur as Value;
	}

	#consume(op: string): boolean {
		this.#skipWs();
		if (this.src.startsWith(op, this.#pos)) {
			this.#pos += op.length;
			return true;
		}
		return false;
	}

	#skipWs(): void {
		while (this.#pos < this.src.length && /\s/.test(this.src[this.#pos]!)) this.#pos++;
	}
}

const workflowYaml = await Bun.file(WORKFLOW_PATH).text();
// The block sits at indent 0 immediately under the top-level `concurrency:`
// key and uses single-line values, so a flat-line extract is unambiguous.
// Values are double-quoted in YAML, so we unwrap the wrapping `"…"` here.
const concurrencySection = workflowYaml.slice(workflowYaml.indexOf("\nconcurrency:") + 1);
const groupRaw = /^\s*group:\s*(\S.*?)\s*$/m.exec(concurrencySection)?.[1];
const cancelRaw = /^\s*cancel-in-progress:\s*(\S.*?)\s*$/m.exec(concurrencySection)?.[1];
const groupTemplate = groupRaw?.startsWith('"') && groupRaw.endsWith('"') ? groupRaw.slice(1, -1) : groupRaw;
const cancelTemplate = cancelRaw?.startsWith('"') && cancelRaw.endsWith('"') ? cancelRaw.slice(1, -1) : cancelRaw;
if (!groupTemplate || !cancelTemplate) {
	throw new Error("could not locate concurrency.group / cancel-in-progress in ci.yml");
}

const RELEASE_SUBJECT = "chore: bump version to 15.12.6";

const baseCtx = (overrides: Partial<GhaCtx> = {}): { github: GhaCtx } => ({
	github: {
		workflow: "CI",
		ref: "refs/heads/main",
		sha: "deadbeefcafebabe",
		event_name: "push",
		event: {},
		...overrides,
	},
});

describe("ci.yml concurrency", () => {
	// A tag push is the publishing run, so it gets a per-sha group with no
	// cancellation. This is the #2564 root cause stated in the terms of the
	// tag-push model: the run that carries the release must not be cancellable by
	// anything that happens on main afterwards.
	it("release tag push: per-sha group, no cancellation (#2564 root cause)", () => {
		const ctx = baseCtx({ ref: "refs/tags/v15.12.6", sha: "deadbeefcafebabe" });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-release-deadbeefcafebabe");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	// Retagging after a red release run schedules a second run at the same sha,
	// and the group is keyed on the sha, so the retry lands in the same slot
	// rather than racing the original.
	it("a tag re-push at the same sha stays in that sha's group", () => {
		const first = baseCtx({ ref: "refs/tags/v15.12.6", sha: "deadbeefcafebabe" });
		const again = baseCtx({ ref: "refs/tags/v15.12.7", sha: "deadbeefcafebabe" });
		expect(GhaEval.template(groupTemplate, again)).toBe(GhaEval.template(groupTemplate, first));
	});

	// THE CONTRACT THE TAG-PUSH MODEL ADDS. The version-bump commit is now an
	// ordinary main push that must be tested like any other, and it must NOT be
	// mistaken for the release run: the old expression sniffed the commit subject
	// and gave the bump its own per-sha group, which is precisely the behaviour
	// that made a subject string load-bearing. Here the subject is inert.
	it("the version-bump commit is an ordinary main push, not a release run", () => {
		const ctx = baseCtx({ event: { head_commit: { message: `${RELEASE_SUBJECT}\n\nbody` } } });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-main-deadbeefcafebabe");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});

	// THE HAZARD THE PER-SHA MAIN GROUP CREATES, and the reason the two prefixes
	// differ. A cut pushes the bump commit to main and then pushes the tag at THAT
	// SAME SHA. Keyed on the sha alone the two runs would share one group with
	// cancellation off, so the publishing run would sit behind the run that tested
	// it, or take its place. That is #2564 again by a different route.
	it("a tag and the main push at the same sha are different groups", () => {
		const sha = "deadbeefcafebabe";
		const mainPush = baseCtx({ sha });
		const tagPush = baseCtx({ ref: "refs/tags/v15.12.6", sha });
		expect(GhaEval.template(groupTemplate, mainPush)).not.toBe(GhaEval.template(groupTemplate, tagPush));
	});

	it("each main push gets its own group, so no run queues behind another (release-train starvation guard)", () => {
		// 2026-07-24: six consecutive main CI runs were cancelled by successor
		// pushes (bot traffic every ~2 minutes), so no run ever completed and no
		// commit on main was ever green enough to tag. Turning cancellation off was
		// the first answer, and it moved the failure rather than removing it: one
		// shared group holds ONE pending run, and 2026-08-09 read four cancelled,
		// two stuck queued for over an hour, one failure and zero successes across
		// the last twenty-five main runs. Two pushes at different shas are two
		// different questions, so they get different groups and are answered in
		// parallel; what they wait on is a runner, and that queue drains.
		const first = baseCtx({ sha: "aaaa1111", event: { head_commit: { message: "fix(ux): theme tweak" } } });
		const second = baseCtx({ sha: "bbbb2222", event: { head_commit: { message: "fix(ux): another" } } });
		expect(GhaEval.template(groupTemplate, first)).toBe("CI-main-aaaa1111");
		expect(GhaEval.template(groupTemplate, second)).toBe("CI-main-bbbb2222");
		expect(GhaEval.template(cancelTemplate, first)).toBe("false");
	});

	it("push to a non-main branch keeps cancel-on-newer-push (feedback latency wins there)", () => {
		const ctx = baseCtx({
			ref: "refs/heads/feature/foo",
			event: { head_commit: { message: "wip" } },
		});
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/heads/feature/foo");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");
	});

	it("pull_request (no head_commit): branch-wide group, cancel enabled", () => {
		const ctx = baseCtx({ ref: "refs/pull/42/merge", event_name: "pull_request", event: {} });
		expect(GhaEval.template(groupTemplate, ctx)).toBe("CI-refs/pull/42/merge");
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("true");
	});

	it("two release tags at distinct shas land in disjoint groups", () => {
		const a = baseCtx({ ref: "refs/tags/v15.12.6", sha: "aaaa1111" });
		const b = baseCtx({ ref: "refs/tags/v15.12.7", sha: "bbbb2222" });
		expect(GhaEval.template(groupTemplate, a)).not.toBe(GhaEval.template(groupTemplate, b));
	});

	// A manual re-run of main CI must not be cancellable either: it is usually
	// someone recovering a flake on the exact commit they intend to tag.
	it("workflow_dispatch is never cancelled", () => {
		const ctx = baseCtx({ event_name: "workflow_dispatch" });
		expect(GhaEval.template(cancelTemplate, ctx)).toBe("false");
	});
});

// The same scheduling-time cancellation bug bit the SIBLING workflows on
// 2026-07-24: checks.yml / docs.yml still used branch-wide
// `cancel-in-progress: true`, so a release sha's sibling runs could be cancelled
// by the next main push. The fix copies ci.yml's expression into each sibling
// (GitHub cannot share concurrency expressions across workflow files).
//
// The sibling set is READ OFF DISK rather than listed here. It was a literal
// `["checks", "docs"]` for a while, which is the same defect one level up: a new
// workflow triggered by a push to main could ship `cancel-in-progress: true` and
// nothing would say so, because the list did not know about it. Every workflow
// that a push to `main` or a `v*` tag can schedule is now enumerated and checked,
// so a new one is red on arrival until it states how it survives a successor push.
//
// Two ways to survive one, and both are accepted: never cancel at all (site.yml's
// `production-site-deploy` group, which serializes deploys instead), or take a
// group unique to the sha (ci.yml's expression and the copies of it). Anything
// that copies the shared expression must copy it BYTE FOR BYTE, so an edit to
// ci.yml cannot silently leave the others behind.

function extractConcurrency(yaml: string, file: string): { group: string; cancel: string } | undefined {
	const marker = "\nconcurrency:";
	const at = yaml.indexOf(marker);
	// No block at all is safe: nothing groups the run, so nothing cancels it.
	if (at < 0) return undefined;
	const section = yaml.slice(at + 1);
	const groupRaw = /^\s*group:\s*(\S.*?)\s*$/m.exec(section)?.[1];
	const cancelRaw = /^\s*cancel-in-progress:\s*(\S.*?)\s*$/m.exec(section)?.[1];
	const unwrap = (s: string | undefined) => (s?.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
	const group = unwrap(groupRaw);
	const cancel = unwrap(cancelRaw);
	if (!group) throw new Error(`could not locate concurrency.group in ${file}`);
	// An omitted `cancel-in-progress` defaults to false on GitHub.
	return { group, cancel: cancel ?? "false" };
}

const WORKFLOW_DIR = path.resolve(import.meta.dir, "..", ".github", "workflows");

/** A workflow a push to `main` or a `v*` tag can schedule, and therefore a release sha reaches. */
function releasePathWorkflows(): { name: string; yaml: string }[] {
	return fs
		.readdirSync(WORKFLOW_DIR)
		.filter(f => f.endsWith(".yml"))
		.map(f => ({ name: f, yaml: fs.readFileSync(path.join(WORKFLOW_DIR, f), "utf8") }))
		.filter(({ yaml }) => {
			const on = yaml.slice(yaml.indexOf("\non:"));
			const pushBlock = /\n\s*push:\n((?:\s{3,}.*\n|\n)*)/.exec(on)?.[1] ?? "";
			return /branches:.*\bmain\b/.test(pushBlock) || /tags:.*v\*/.test(pushBlock);
		});
}

/** The shared expression's fingerprint: a per-sha release arm. Copying it means copying it exactly. */
const SHARED_GROUP_MARK = "format('release-{0}', github.sha)";

describe("a release sha's run cannot be cancelled by a successor push", () => {
	const workflows = releasePathWorkflows();

	it("finds the workflows a release sha reaches", () => {
		// Names, not a count: a rename has to be seen, and this is the list every
		// case below is generated from, so an empty or truncated scan cannot pass.
		expect(workflows.map(w => w.name).sort()).toEqual([
			"changelog-sync.yml",
			"checks.yml",
			"ci.yml",
			"docs.yml",
			"site.yml",
		]);
	});

	for (const { name, yaml } of workflows) {
		const concurrency = extractConcurrency(yaml, name);

		for (const [label, ctx] of [
			["a release tag", baseCtx({ ref: "refs/tags/v15.12.6", sha: "deadbeefcafebabe" })],
			["a main push", baseCtx({ event: { head_commit: { message: RELEASE_SUBJECT } } })],
		] as const) {
			it(`${name} survives a successor push at ${label}`, () => {
				if (!concurrency) return; // no group, no cancellation
				const cancel = GhaEval.template(concurrency.cancel, ctx);
				if (cancel === "false") return;
				// Cancellation is on, so the group has to be unique to this sha.
				expect(GhaEval.template(concurrency.group, ctx)).toContain(ctx.github.sha);
			});
		}

		if (concurrency?.group.includes(SHARED_GROUP_MARK)) {
			it(`${name} copies ci.yml's expression byte for byte`, () => {
				// ci.yml prefixes with `${{ github.workflow }}-`; a sibling hardcodes
				// its own name. Everything after the prefix must match ci.yml exactly.
				// biome-ignore lint/suspicious/noTemplateCurlyInString: "${{ github.workflow }}" is GitHub Actions syntax being stripped
				const shared = groupTemplate.replace("${{ github.workflow }}-", "");
				expect(concurrency.group.endsWith(shared)).toBe(true);
				expect(concurrency.cancel).toBe(cancelTemplate);
			});

			it(`${name} groups a release tag per sha and never cancels it`, () => {
				const ctx = baseCtx({ ref: "refs/tags/v15.12.6", sha: "deadbeefcafebabe" });
				expect(GhaEval.template(concurrency.group, ctx)).toContain("release-deadbeefcafebabe");
				expect(GhaEval.template(concurrency.cancel, ctx)).toBe("false");
			});
		}
	}
});
