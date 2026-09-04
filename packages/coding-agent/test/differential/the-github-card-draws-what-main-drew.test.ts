/**
 * The `github` card draws what main's renderer drew, for every op row and for the whole watch panel.
 *
 * WHAT THIS SUITE OWNS. `github` is one tool over ten ops, and its card had two subjects: a row that
 * names the operation and its arguments, and the `run_watch` panel — the runs, the jobs under each
 * run with how long each ran, and the tail of every failed job's log. Both halves are compared here,
 * op by op and state by state: a call before any data has arrived, a settled result, a failure, a
 * commit watch with several runs, a run watch with none, a job in each of the five states GitHub
 * reports, and a failed log whose tail was trimmed.
 *
 * THE DEFECT CLASS. A converted card that loses a row, a colour or a column is invisible to a test
 * that asserts what the card contains, because the assertion is written from the same view. So every
 * cell here compares the drawn bytes against a frozen copy of main's renderer, and the op titles and
 * the job states are swept from the tables the tool itself declares rather than listed: an op that
 * gains a title, or a check-run state that gains a classification, lands red here until it is drawn.
 *
 * THE DIFFERENCES ARE HOST DECISIONS, AND EACH IS ONE NAMED FUNCTION. Main's renderer WAS the
 * terminal, so it made every layout and colour decision itself; a view states meaning and the host
 * decides. Nine of those decisions differ, each undone by one function below and asserted nowhere
 * else: the settled rail colour (`settledRail`), the space after a state mark
 * (`marks`), ordinary body text main coloured explicitly (`bodyText`), the section label
 * (`label`), the failed-log header's nested colour runs (`nestedLogHeader`), the held-back note
 * (`note`), the two columns a headed block indents its lines by (`unindent`), the empty colour runs
 * the wrap of a two-row `Text` reopened (`emptyRuns`), and the separator and colour of a status row's
 * trailing metadata (`callMeta`). One difference cannot be undone and is asserted as its own cell:
 * main cut an over-wide row with an ellipsis, and the host cuts a clipped row without one.
 *
 * WHAT IT DOES NOT CATCH. Nothing here proves the tool's own decisions — which runs it polls, which
 * logs it fetches — only what a reader is told about them. A card that is wrong in both arms is wrong
 * identically and passes. Two mutants are equivalent rather than uncaught: `isError === true` spelled
 * as a truthiness test, and `context.frame === undefined` spelled against `options.spinnerFrame`,
 * both of which draw the same card for every value the two fields are declared to hold.
 *
 * The comparison is taken through `test/differential/harness.ts`, whose header states the frozen
 * oracle, the shared defect class and the styling policy every cell here runs under.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { RenderResultOptions } from "@veyyon/agent-core";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import type { SymbolKey } from "@veyyon/coding-agent/theme/symbols";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { GhRunWatchJobDetails, GhRunWatchViewDetails, GhToolDetails } from "@veyyon/coding-agent/tools/web/gh";
import { githubToolView } from "@veyyon/coding-agent/tools/web/gh-view";
import { classifyGithubCheckRun, type GithubCheckRunState } from "@veyyon/utils/github-check-run";
import * as ghOracle from "../oracles/gh-main-renderer";
import { HOST_COLLAPSED, HOST_EXPANDED, renderCompLines, useDifferentialTheme, WIDTH } from "./harness";

useDifferentialTheme();

/** The production entry, which is the view drawn through the terminal's own drawer. */
const production = toolRenderers.github;

type GithubResult = { content: Array<{ type: string; text?: string }>; details?: GhToolDetails; isError?: boolean };
type GithubArgs = { op?: string; run?: string; branch?: string; repo?: string; pr?: string | string[]; query?: string };

const HOST_RUNNING: RenderResultOptions = { expanded: false, isPartial: false, spinnerFrame: 3 };

describe("github tool differential", () => {
	/** The rail glyph, read when a cell runs rather than when the file loads: the theme starts empty. */
	const rail = (): string => theme.symbol("block.rail");

	/**
	 * Main coloured a settled card's rail `borderMuted` by hand; a view names no colour, so the host
	 * draws the edge it gives every settled block. A failure is unaffected: both arms draw the error
	 * rail, which is what makes this an edge decision rather than a lost state.
	 */
	function settledRail(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(theme.fg("dim", rail()), theme.fg("borderMuted", rail())));
	}

	/**
	 * The state marks a row carries, whose trailing space main wrote INSIDE the mark's colour run.
	 *
	 * The host draws the mark from its own symbol table and the space is a span of the tool's, so the
	 * run closes after the glyph. Undoing the split moves the space back inside it. The card's own
	 * title mark is not a row and both arms draw it the same way, so the header line is left alone.
	 */
	const MARKS: ReadonlyArray<readonly [SymbolKey, ThemeColor]> = [
		["status.success", "accent"],
		["status.error", "error"],
		["status.enabled", "warning"],
		["status.shadowed", "muted"],
	];

	function marks(lines: readonly string[]): string[] {
		return lines.map((line, index) => {
			if (index === 0) return line;
			let out = line;
			for (const [key, color] of MARKS) {
				const glyph = theme.symbol(key);
				const styled = theme.styledSymbol(key, color);
				const close = styled.slice(styled.indexOf(glyph) + glyph.length);
				out = out.split(`${glyph}${close} `).join(`${glyph} ${close}`);
			}
			return out;
		});
	}

	/**
	 * The run rows main coloured in the theme's own body colour.
	 *
	 * A view states no tone for ordinary body text, which the contract already defines as the host's
	 * body colour, so the host writes the text and no escape at all. The card's header meta is the
	 * frame's, dim in both arms, so a token that also appears there is left alone.
	 */
	function bodyText(tokens: readonly string[], lines: readonly string[]): string[] {
		return lines.map((line, index) =>
			index === 0 ? line : tokens.reduce((out, token) => out.replaceAll(token, theme.fg("text", token)), line),
		);
	}

	/** Main left its one section label uncoloured; the host draws a label in the theme's body colour. */
	function label(text: string, lines: readonly string[]): string[] {
		return lines.map(line => line.replace(theme.fg("text", text), text));
	}

	/**
	 * The failed-log header, which main wrote as ONE error run: the mark, the job name and the two
	 * spaces after it, with the muted context nested inside that run.
	 *
	 * The view states three runs — mark, name, context — so the host opens and closes each. Undoing it
	 * folds the three back into the nesting `theme.fg` produced. Anchored on the mark, so a failed
	 * JOB row, which main also drew as a mark and a separately coloured name, is left alone.
	 */
	function nestedLogHeader(lines: readonly string[]): string[] {
		const close = "\u001b[39m";
		const error = theme.fg("error", "");
		const open = error.slice(0, error.length - close.length);
		const muted = theme.fg("muted", "");
		const mutedOpen = muted.slice(0, muted.length - close.length);
		const glyph = theme.symbol("status.error");
		const header = new RegExp(
			`${escapeRe(`${open}${glyph}${close} ${open}`)}([^\u001b]*)${escapeRe(close)} {2}(${escapeRe(mutedOpen)}[^\u001b]*${escapeRe(close)})`,
		);
		return lines.map(line =>
			line.replace(header, (_match, name, context) => `${open}${glyph} ${name}  ${context}${close}`),
		);
	}

	function escapeRe(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/**
	 * The held-back note, which main wrote as one dim run with the expand hint nested inside it, at the
	 * indent of the rows it followed.
	 *
	 * The host words the count from `hidden` and places the note at its section's own left edge, so
	 * undoing it closes the run once, pushes the note back to the rows above it, and takes main's
	 * wording where main pluralised a count of one.
	 */
	function note(text: string, indent: string, lines: readonly string[], wording = text): string[] {
		const close = "\u001b[39m";
		const dim = theme.fg("dim", "");
		const open = dim.slice(0, dim.length - close.length);
		const hint = theme.fg("dim", `${theme.nav.expand} Ctrl+O expand`);
		return lines.map(line =>
			line.replace(`${open}${text}${close} ${hint}`, `${indent}${open}${wording} ${hint}${close}`),
		);
	}

	/**
	 * A colour run main's wrapper closed on the line after the one it opened on.
	 *
	 * Main drew a watch panel as one `Text`, so a break at the exact end of a run moved its closing
	 * escape off the drawn line; a block's rows carry their own escapes and close where they end. A
	 * close at the end of a line paints nothing either way — the next line opens the rail's colour
	 * before any text — so both arms drop it and the columns are still compared byte for byte.
	 */
	function lineEndClose(lines: readonly string[]): string[] {
		const close = "\u001b[39m";
		return lines.map(line => (line.endsWith(close) ? line.slice(0, -close.length) : line));
	}

	/** The two columns a headed block indents its lines by, which main's rows did not carry. */
	function unindent(lines: readonly string[]): string[] {
		return lines.map((line, index) => (index === 0 ? line : line.replace(/^ {2}/, "")));
	}

	/**
	 * The empty colour runs main's second row opened and closed.
	 *
	 * Main drew a two-row card as one `Text`, and the wrap reopens whatever styles were active at the
	 * break before closing them again, so its second row starts with the header's colours around no
	 * text at all. A headed block is rows rather than one string, so nothing is reopened.
	 */
	function emptyRuns(lines: readonly string[]): string[] {
		return lines.map(line => line.replace(/(?:\u001b\[(?:38;2;\d+;\d+;\d+|39)m\u001b\[39m)+/g, ""));
	}

	/**
	 * A status row's trailing metadata, which main's hand-built watch row separated with two spaces and
	 * coloured itself.
	 *
	 * Every other row of this tool already went through the shared status line, which separates metadata
	 * with one space and dims it; the view states the fact and the host does the same for this row too.
	 */
	function callMeta(token: string, color: ThemeColor, lines: readonly string[]): string[] {
		return lines.map(line => line.replace(` ${theme.fg("dim", token)}`, `  ${theme.fg(color, token)}`));
	}

	function newCall(args: GithubArgs, options: RenderResultOptions, width = WIDTH): string[] {
		return renderCompLines(production.renderCall(args, options, theme), width);
	}

	function oldCall(args: GithubArgs, options: RenderResultOptions, width = WIDTH): string[] {
		return renderCompLines(ghOracle.githubToolRenderer.renderCall(args, options, theme), width);
	}

	function newResult(result: GithubResult, options: RenderResultOptions, args?: GithubArgs, width = WIDTH): string[] {
		return renderCompLines(production.renderResult(result, options, theme, args), width);
	}

	function oldResult(result: GithubResult, options: RenderResultOptions, args?: GithubArgs, width = WIDTH): string[] {
		return renderCompLines(ghOracle.githubToolRenderer.renderResult(result, options, theme, args), width);
	}

	/** One job per state GitHub reports, so every branch of the state table is drawn. */
	const JOBS: Record<GithubCheckRunState, GhRunWatchJobDetails> = {
		success: { id: 1, name: "typecheck", status: "completed", conclusion: "success", durationSeconds: 12 },
		failure: { id: 2, name: "tests", status: "completed", conclusion: "failure", durationSeconds: 305 },
		running: { id: 3, name: "lint", status: "in_progress", durationSeconds: 7 },
		pending: { id: 4, name: "publish", status: "queued" },
		unknown: { id: 5, name: "docs", status: "unrecognized" },
	};

	function runWatch(overrides: Partial<GhRunWatchViewDetails> = {}): GhRunWatchViewDetails {
		return {
			mode: "run",
			state: "watching",
			repo: "owner/repo",
			branch: "feature/x",
			headSha: "0123456789abcdef",
			run: {
				id: 42,
				workflowName: "checks",
				branch: "feature/x",
				jobs: Object.values(JOBS),
			},
			...overrides,
		};
	}

	function commitWatch(overrides: Partial<GhRunWatchViewDetails> = {}): GhRunWatchViewDetails {
		return {
			mode: "commit",
			state: "completed",
			repo: "owner/repo",
			headSha: "0123456789abcdef",
			runs: [
				{ id: 42, workflowName: "checks", branch: "feature/x", jobs: [JOBS.success] },
				{ id: 43, displayTitle: "release", headSha: "fedcba9876543210", jobs: [] },
			],
			...overrides,
		};
	}

	function watchResult(watch: GhRunWatchViewDetails, isError = false): GithubResult {
		return { content: [{ type: "text", text: "watched" }], details: { watch }, ...(isError ? { isError } : {}) };
	}

	/** The tokens main coloured in the theme's body colour: the branch and the commit a run names. */
	const RUN_BODY = ["feature/x", "0123456789ab", "fedcba987654"];

	/** A watch card's bytes as main drew them, with every host decision on it undone. */
	function watchAsMain(lines: readonly string[], options: { failed?: boolean } = {}): string[] {
		const railed = options.failed === true ? [...lines] : settledRail(lines);
		return label("failed logs", marks(nestedLogHeader(bodyText(RUN_BODY, railed))));
	}

	it("carries every policy main's entry carried, resolved off the oracle rather than listed", () => {
		const oracleEntry = ghOracle.githubToolRenderer as unknown as Record<string, unknown>;
		const policies = Object.keys(oracleEntry).filter(key => key !== "renderCall" && key !== "renderResult");
		// Pinned by exact equality: a policy main carried and this entry drops is a card placed
		// differently in the flow, which no drawn row can show. `animatedPendingPreview` is absent in
		// both arms on purpose — main's comment says why, and the view has no render closure either.
		expect(policies.sort()).toEqual(["mergeCallAndResult"]);
		const entry = production as unknown as Record<string, unknown>;
		for (const policy of policies) expect(entry[policy]).toEqual(oracleEntry[policy]);
		// The entry describes its card rather than drawing one, which is what a host other than a
		// terminal reads.
		expect(production.view).toBeDefined();
	});

	it("titles every op main titled, resolved from the op table rather than listed", () => {
		const ops = [
			"repo_view",
			"pr_checkout",
			"pr_push",
			"search_issues",
			"search_prs",
			"search_code",
			"search_commits",
			"search_repos",
			"run_watch",
		];
		// The titles main knew, pinned: an op that gains one is drawn here or fails.
		const titled = ops.filter(op => {
			const row = githubToolView.renderCall({ op }, { expanded: false });
			const head = row.kind === "headedBlock" ? row.header : row.kind === "statusRow" ? row : undefined;
			return head?.title !== undefined && head.title !== "GitHub";
		});
		expect(titled).toEqual(ops);
	});

	it("draws main's call row for every op, in both the pending and the running state", () => {
		const calls: GithubArgs[] = [
			{ op: "repo_view", repo: "owner/repo", branch: "main" },
			{ op: "pr_checkout", pr: "https://github.com/owner/repo/pull/7", repo: "owner/repo" },
			{ op: "pr_checkout", branch: "feature/x", repo: "owner/repo" },
			{ op: "pr_push", pr: ["#1", "#2", "#3", "#4"] },
			{ op: "pr_push", pr: [] },
			{ op: "search_issues", query: "is:open", repo: "owner/repo" },
			{ op: "search_prs", query: "is:merged" },
			{ op: "search_code", query: "viewToolRenderer" },
			{ op: "search_commits", query: "fix", repo: "owner/repo" },
			{ op: "search_repos", query: "veyyon" },
			{ repo: "owner/repo" },
			{},
			{ op: "   " },
			{ op: "unknown_op", repo: "owner/repo" },
			{ op: "search_repos", query: "q".repeat(200) },
			{ op: "repo_view", repo: "owner/re\tpo" },
		];
		for (const args of calls) {
			for (const options of [HOST_COLLAPSED, HOST_RUNNING, HOST_EXPANDED]) {
				expect(newCall(args, options)).toEqual(oldCall(args, options));
			}
		}
	});

	it("draws main's waiting row for a watch call, whichever reference it names", () => {
		const cases: ReadonlyArray<readonly [GithubArgs, string, ThemeColor]> = [
			[{ op: "run_watch", run: "42" }, "#42", "muted"],
			[{ op: "run_watch", run: "  ", branch: "feature/x" }, "feature/x", "text"],
			[{ op: "run_watch" }, "current HEAD", "muted"],
			[{ op: "run_watch", branch: "   " }, "current HEAD", "muted"],
		];
		for (const [args, token, color] of cases) {
			for (const options of [HOST_COLLAPSED, HOST_RUNNING]) {
				expect(callMeta(token, color, unindent(newCall(args, options)))).toEqual(emptyRuns(oldCall(args, options)));
			}
		}
		// Anti-vacuity: the row is the pending one, and it says what it is waiting for.
		const drawn = stripVTControlCharacters(newCall({ op: "run_watch", run: "42" }, HOST_COLLAPSED).join("\n"));
		expect(drawn).toContain("GitHub Run Watch");
		expect(drawn).toContain("#42");
		expect(drawn).toContain("waiting for workflow data...");
	});

	it("draws main's watch panel for a run, with a row per job state", () => {
		for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
			const watch = runWatch();
			expect(watchAsMain(newResult(watchResult(watch), options))).toEqual(oldResult(watchResult(watch), options));
		}
		// Anti-vacuity: every job state reached a row of its own, marked differently from the others.
		const drawn = newResult(watchResult(runWatch()), HOST_COLLAPSED);
		const plain = stripVTControlCharacters(drawn.join("\n"));
		for (const job of Object.values(JOBS)) expect(plain).toContain(job.name);
		const glyphs = new Set(
			Object.values(JOBS).map(job => {
				const row = drawn.find(line => stripVTControlCharacters(line).includes(job.name)) ?? "";
				// Past the rail every row carries, so the mark is what is compared rather than the edge.
				return stripVTControlCharacters(row).replace(rail(), "").trim().slice(0, 1);
			}),
		);
		expect(glyphs.size).toBeGreaterThan(1);
		// The classification table is the variant space: a state it gains has no row here until the
		// fixture above grows one, and this is the cell that says so.
		expect(Object.keys(JOBS).sort()).toEqual(
			[...new Set(Object.values(JOBS).map(job => classifyGithubCheckRun(job.status, job.conclusion)))].sort(),
		);
	});

	it("draws main's watch panel for a commit, for one run, none, and a note", () => {
		const cases: GhRunWatchViewDetails[] = [
			commitWatch(),
			commitWatch({ runs: [] }),
			commitWatch({ runs: undefined }),
			commitWatch({ note: "poll 4" }),
			commitWatch({ headSha: undefined }),
			commitWatch({ state: "watching" }),
			runWatch({ run: { id: 42, workflowName: "checks", branch: "feature/x", jobs: [] } }),
			runWatch({ note: "re-reading run" }),
			runWatch({ run: undefined }),
			runWatch({ state: "completed" }),
			runWatch({ run: { id: 9, headSha: "0123456789abcdef", jobs: [JOBS.success] } }),
			// A run that carries both names: main called it by its workflow, so a card that preferred the
			// commit title would name the same run differently.
			commitWatch({ runs: [{ id: 44, workflowName: "checks", displayTitle: "release", jobs: [] }] }),
		];
		for (const watch of cases) {
			for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
				expect(watchAsMain(newResult(watchResult(watch), options))).toEqual(oldResult(watchResult(watch), options));
			}
		}
	});

	it("draws main's failed-log group, with the tail it kept and the count it held back", () => {
		const watch = commitWatch({
			failedLogs: [
				{ runId: 42, workflowName: "checks", jobName: "tests", available: true, tail: "one\ntwo\nthree\nfour" },
				{ runId: 43, workflowName: "release", jobName: "publish", available: false },
				{ runId: 43, jobName: "docs", available: true, tail: "" },
				{ runId: 44, jobName: "tab\tjob", available: true, tail: "a\n\nb" },
			],
		});
		for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
			// Main wrote "lines" for a count of one; the host words the note from the count it held back.
			const drawn = note(
				"… 1 more log line",
				"  ",
				watchAsMain(newResult(watchResult(watch), options)),
				"… 1 more log lines",
			);
			expect(drawn).toEqual(oldResult(watchResult(watch), options));
		}
		// Anti-vacuity: the collapsed arm keeps the END of the log and says how much it dropped; the
		// expanded arm keeps all of it and says nothing.
		const collapsed = stripVTControlCharacters(newResult(watchResult(watch), HOST_COLLAPSED).join("\n"));
		expect(collapsed).toContain("… 1 more log line");
		expect(collapsed).toContain("four");
		expect(collapsed).not.toContain("one");
		const expanded = stripVTControlCharacters(newResult(watchResult(watch), HOST_EXPANDED).join("\n"));
		expect(expanded).toContain("one");
		expect(expanded).not.toContain("more log line");
		expect(collapsed).toContain("log tail unavailable");
	});

	it("draws main's failure card for a watch that failed", () => {
		for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
			const watch = commitWatch();
			expect(watchAsMain(newResult(watchResult(watch, true), options), { failed: true })).toEqual(
				oldResult(watchResult(watch, true), options),
			);
		}
		// Anti-vacuity: a failed watch is titled by its outcome and a settled one by the tool's mark.
		const failed = newResult(watchResult(commitWatch(), true), HOST_COLLAPSED)[0] ?? "";
		const settled = newResult(watchResult(commitWatch()), HOST_COLLAPSED)[0] ?? "";
		expect(failed).not.toBe(settled);
		expect(stripVTControlCharacters(failed)).toContain("GitHub Run Watch");
	});

	it("draws main's op card for a result with no output, one line, or many", () => {
		const args: GithubArgs = { op: "search_repos", query: "veyyon" };
		const rows = Array.from({ length: 9 }, (_, index) => `row ${index}`);
		const twoRow: Array<[GithubResult, string]> = [
			[{ content: [] }, "no output"],
			[{ content: [{ type: "image" }] }, "no output"],
			[{ content: [{ type: "text", text: "" }] }, "no output"],
			[{ content: [], isError: true }, "request failed"],
			[{ content: [{ type: "text", text: "owner/repo" }] }, "owner/repo"],
			[{ content: [{ type: "text", text: "owner/repo   stars: 3" }] }, "owner/repo"],
		];
		for (const [result] of twoRow) {
			for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
				expect(unindent(newResult(result, options, args))).toEqual(emptyRuns(oldResult(result, options, args)));
			}
		}
		// A body whose every line is blank leaves the row alone, in both arms.
		for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
			const blank: GithubResult = { content: [{ type: "text", text: "\n \n" }] };
			expect(newResult(blank, options, args)).toEqual(oldResult(blank, options, args));
		}
		// A framed body: the collapsed arm holds lines back and says so, the expanded arm shows ten.
		const many: GithubResult = { content: [{ type: "text", text: rows.join("\n") }] };
		expect(note("… 6 more lines", "", settledRail(newResult(many, HOST_COLLAPSED, args)))).toEqual(
			oldResult(many, HOST_COLLAPSED, args),
		);
		expect(settledRail(newResult(many, HOST_EXPANDED, args))).toEqual(oldResult(many, HOST_EXPANDED, args));
		const expanded = stripVTControlCharacters(newResult(many, HOST_EXPANDED, args).join("\n"));
		expect(expanded).toContain("row 8");
		const collapsed = stripVTControlCharacters(newResult(many, HOST_COLLAPSED, args).join("\n"));
		expect(collapsed).toContain("… 6 more lines");
		expect(collapsed).not.toContain("row 3");
	});

	it("draws main's framed failure for an error with one line and with several", () => {
		const args: GithubArgs = { op: "pr_push", pr: "#7", repo: "owner/repo" };
		const failures: GithubResult[] = [
			{ content: [{ type: "text", text: "gh: not found" }], isError: true },
			{ content: [{ type: "text", text: "line one\nline two" }], isError: true },
			{
				content: [{ type: "text", text: Array.from({ length: 6 }, (_, i) => `err ${i}`).join("\n") }],
				isError: true,
			},
		];
		for (const result of failures) {
			for (const options of [HOST_COLLAPSED, HOST_EXPANDED]) {
				const drawn = newResult(result, options, args);
				const expected = oldResult(result, options, args);
				expect(options === HOST_COLLAPSED ? note("… 3 more lines", "", drawn) : drawn).toEqual(expected);
			}
		}
		// Anti-vacuity: a failure frames even when it is one line, which is where main and a row differ.
		expect(newResult(failures[0] as GithubResult, HOST_COLLAPSED, args).length).toBeGreaterThan(1);
	});

	it("cuts an over-wide row where main cut it, without the ellipsis main wrote", () => {
		// The one difference no function above can undo, so it is asserted rather than normalised: the
		// tool states that a log row and an output row are rows rather than prose, and the host cuts a
		// row it composed without a mark. Main cut the same column and wrote `…` there.
		const args: GithubArgs = { op: "search_code", query: "x" };
		const wide: GithubResult = { content: [{ type: "text", text: `${"y".repeat(200)}\nsecond` }] };
		const mine = newResult(wide, HOST_COLLAPSED, args);
		const main = oldResult(wide, HOST_COLLAPSED, args);
		expect(mine).toHaveLength(main.length);
		const mineRow = stripVTControlCharacters(mine[1] ?? "");
		const mainRow = stripVTControlCharacters(main[1] ?? "");
		expect(mainRow.endsWith("…")).toBe(true);
		expect(mineRow.endsWith("…")).toBe(false);
		// Same columns, and the same content up to the column main spent on the mark.
		expect(mineRow.length).toBe(mainRow.length);
		expect(mineRow.slice(0, mainRow.length - 1)).toBe(mainRow.slice(0, mainRow.length - 1));
		// A log row is a row for the same reason, so an over-wide log line ends where main marked its
		// cut instead of wrapping into a second row: the arms have the same row count either way only
		// if this row is clipped.
		const logWatch = commitWatch({
			runs: [],
			failedLogs: [{ runId: 42, jobName: "tests", available: true, tail: `${"z".repeat(200)}\ntwo` }],
		});
		const logMine = newResult(watchResult(logWatch), HOST_COLLAPSED);
		const logMain = oldResult(watchResult(logWatch), HOST_COLLAPSED);
		expect(logMine).toHaveLength(logMain.length);
		const mineLog = stripVTControlCharacters(logMine.find(line => line.includes("zzz")) ?? "");
		const mainLog = stripVTControlCharacters(logMain.find(line => line.includes("zzz")) ?? "");
		expect(mainLog.endsWith("…")).toBe(true);
		expect(mineLog.endsWith("…")).toBe(false);
		expect(mineLog.length).toBe(mainLog.length);
		expect(mineLog.slice(0, mainLog.length - 1)).toBe(mainLog.slice(0, mainLog.length - 1));
	});

	it("keeps the two arms identical at a width both must cut", () => {
		const watch = commitWatch({
			failedLogs: [{ runId: 42, jobName: "tests", available: true, tail: "one\ntwo" }],
		});
		for (const width of [WIDTH, 60, 40, 24]) {
			expect(lineEndClose(watchAsMain(newResult(watchResult(watch), HOST_EXPANDED, {}, width)))).toEqual(
				lineEndClose(oldResult(watchResult(watch), HOST_EXPANDED, {}, width)),
			);
			expect(newCall({ op: "search_code", query: "veyyon" }, HOST_COLLAPSED, width)).toEqual(
				oldCall({ op: "search_code", query: "veyyon" }, HOST_COLLAPSED, width),
			);
		}
	});

	it("places a job's duration at the end of the row, whatever the row has room for", () => {
		const watch = runWatch({
			run: {
				id: 42,
				workflowName: "checks",
				branch: "feature/x",
				jobs: [{ id: 1, name: "a".repeat(120), status: "in_progress", durationSeconds: 3600 }],
			},
		});
		for (const width of [WIDTH, 60, 40, 24]) {
			expect(watchAsMain(newResult(watchResult(watch), HOST_COLLAPSED, {}, width))).toEqual(
				oldResult(watchResult(watch), HOST_COLLAPSED, {}, width),
			);
			// The duration is the last thing on the card and keeps every column it asks for, which is
			// what a trailing run means: a cut duration would read as a different number.
			const drawn = newResult(watchResult(watch), HOST_COLLAPSED, {}, width);
			const row = stripVTControlCharacters(drawn[drawn.length - 1] ?? "");
			expect(row.endsWith("3600s")).toBe(true);
		}
	});

	it("positive control: the arms are compared on bytes that differ between inputs", () => {
		const one = newResult(watchResult(runWatch()), HOST_COLLAPSED).join("\n");
		const two = newResult(watchResult(commitWatch()), HOST_COLLAPSED).join("\n");
		expect(one).not.toBe(two);
		expect(one).not.toBe(stripVTControlCharacters(one));
	});
});
