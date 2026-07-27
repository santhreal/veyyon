//! Every dispatcher arm settles after one pass, and none of them answers with
//! nothing.
//!
//! WHY A TABLE INSTEAD OF WAITING FOR THE FUZZER. Both properties below are
//! already fuzzed by `fuzz/fuzz_targets/minimizer_filters.rs`, and it has found
//! a genuine bug in nearly every session it has run: filters that re-read their
//! own annotations, compactors that emit a line their own entry conditions
//! drop, counters that grow on each pass, a table reshaper that answered with
//! the empty string. Each of those took a fuzzing round to surface, one at a
//! time, because the fuzzer has to rediscover which of sixty program names
//! routes to the arm it is probing before it can explore that arm at all.
//!
//! This suite spends that search for free. The programs are listed, the hostile
//! captures are listed, and every pair is checked in milliseconds. A regression
//! in any arm fails here in the next `cargo test` rather than in whichever
//! future fuzzing round happens to reach it.
//!
//! THE TWO PROPERTIES.
//!
//! IDEMPOTENCE. Filters chain, wrappers re-filter what they wrapped, and
//! captures get replayed, so a filter runs over its own output as a matter of
//! course. One that answers differently the second time cannot be cached,
//! compared across runs, or replayed, and in practice the difference has always
//! been a loss: an entry stripped, a count inflated, a grouping flattened.
//!
//! NOTHING FROM SOMETHING, ON THE SECOND PASS. Output that survived one pass
//! must not vanish on the next. Reducing a capture to nothing on the FIRST pass
//! is a deliberate part of the design: on a successful run it is the clean
//! signal, which `engine::apply` renders as `OK`, and the untouched capture is
//! kept in `original_text` for the caller to splice back as an
//! `artifact://<id>` reference either way. What is never right is answering
//! with something and then, given that same something, answering with nothing
//! -- that is a filter eating its own output, and the capture it ate is not in
//! `original_text` any more, because by then the original IS the filtered text.
//!
//! WHAT THIS SUITE IS NOT. It says nothing about whether a filter minimizes
//! WELL. Doing nothing satisfies both properties perfectly. The per-filter
//! suites are where the actual reductions are pinned; this one is the floor
//! underneath all of them.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

/// One dispatcher arm: the program, the subcommand the dispatcher would detect,
/// and a command line consistent with both.
struct Arm {
	program:    &'static str,
	subcommand: Option<&'static str>,
	command:    &'static str,
}

/// Every arm of `filters::supports`, with a representative subcommand for the
/// ones that route on it.
///
/// Kept explicit rather than derived. A derived list would drift silently when
/// an arm is added, and the point of this table is that adding an arm without
/// adding a row here is visible in review.
const ARMS: &[Arm] = &[
	Arm { program: "git", subcommand: Some("status"), command: "git status" },
	Arm { program: "git", subcommand: Some("diff"), command: "git diff" },
	Arm { program: "git", subcommand: Some("log"), command: "git log" },
	Arm { program: "yadm", subcommand: Some("status"), command: "yadm status" },
	Arm { program: "gt", subcommand: Some("log"), command: "gt log" },
	Arm { program: "bun", subcommand: Some("test"), command: "bun test" },
	Arm { program: "bun", subcommand: Some("install"), command: "bun install" },
	Arm { program: "bunx", subcommand: Some("tsc"), command: "bunx tsc" },
	Arm { program: "cargo", subcommand: Some("build"), command: "cargo build" },
	Arm { program: "cargo", subcommand: Some("test"), command: "cargo test" },
	Arm { program: "cargo", subcommand: Some("clippy"), command: "cargo clippy" },
	Arm { program: "cargo", subcommand: Some("fmt"), command: "cargo fmt" },
	Arm { program: "cargo", subcommand: Some("nextest"), command: "cargo nextest run" },
	Arm { program: "go", subcommand: Some("build"), command: "go build ./..." },
	Arm { program: "go", subcommand: Some("test"), command: "go test ./..." },
	Arm { program: "go", subcommand: Some("vet"), command: "go vet ./..." },
	Arm { program: "golangci-lint", subcommand: Some("run"), command: "golangci-lint run" },
	Arm { program: "cmake", subcommand: Some("--build"), command: "cmake --build ." },
	Arm { program: "ctest", subcommand: Some("ctest"), command: "ctest" },
	Arm { program: "ninja", subcommand: None, command: "ninja" },
	Arm { program: "dotnet", subcommand: Some("build"), command: "dotnet build" },
	Arm { program: "dotnet", subcommand: Some("test"), command: "dotnet test" },
	Arm { program: "mvn", subcommand: Some("install"), command: "mvn clean install" },
	Arm { program: "gradle", subcommand: Some("build"), command: "gradle build" },
	Arm { program: "ls", subcommand: None, command: "ls -la" },
	Arm { program: "tree", subcommand: None, command: "tree" },
	Arm { program: "find", subcommand: None, command: "find ." },
	Arm { program: "grep", subcommand: None, command: "grep -rn needle ." },
	Arm { program: "rg", subcommand: None, command: "rg needle" },
	Arm { program: "wc", subcommand: None, command: "wc -l" },
	Arm { program: "cat", subcommand: None, command: "cat file" },
	Arm { program: "stat", subcommand: None, command: "stat file" },
	Arm { program: "du", subcommand: None, command: "du -sh" },
	Arm { program: "df", subcommand: None, command: "df -h" },
	Arm { program: "jq", subcommand: None, command: "jq ." },
	Arm { program: "aws", subcommand: Some("s3"), command: "aws s3 ls" },
	Arm { program: "aws", subcommand: Some("ec2"), command: "aws ec2 describe-instances" },
	Arm { program: "curl", subcommand: None, command: "curl https://example.com" },
	Arm { program: "wget", subcommand: None, command: "wget https://example.com" },
	Arm { program: "psql", subcommand: None, command: "psql -c 'select 1'" },
	Arm { program: "docker", subcommand: Some("ps"), command: "docker ps -a" },
	Arm { program: "docker", subcommand: Some("logs"), command: "docker logs app" },
	Arm { program: "docker", subcommand: Some("build"), command: "docker build ." },
	Arm { program: "kubectl", subcommand: Some("get"), command: "kubectl get pods" },
	Arm { program: "helm", subcommand: Some("list"), command: "helm list" },
	Arm { program: "gh", subcommand: Some("pr"), command: "gh pr list" },
	Arm { program: "glab", subcommand: Some("mr"), command: "glab mr list" },
	Arm { program: "pytest", subcommand: Some("pytest"), command: "pytest" },
	Arm { program: "ruff", subcommand: Some("check"), command: "ruff check ." },
	Arm { program: "mypy", subcommand: None, command: "mypy ." },
	Arm { program: "python", subcommand: Some("-m"), command: "python -m pytest" },
	Arm { program: "rspec", subcommand: None, command: "rspec" },
	Arm { program: "rake", subcommand: Some("test"), command: "rake test" },
	Arm { program: "rubocop", subcommand: None, command: "rubocop" },
	Arm { program: "rustfmt", subcommand: None, command: "rustfmt --check src/lib.rs" },
	Arm { program: "xxd", subcommand: None, command: "xxd file" },
	Arm { program: "strings", subcommand: None, command: "strings binary" },
	Arm { program: "od", subcommand: None, command: "od -c file" },
	Arm { program: "tsc", subcommand: None, command: "tsc --noEmit" },
	Arm { program: "eslint", subcommand: None, command: "eslint ." },
	Arm { program: "biome", subcommand: Some("check"), command: "biome check ." },
	Arm { program: "shellcheck", subcommand: None, command: "shellcheck script.sh" },
	Arm { program: "markdownlint", subcommand: None, command: "markdownlint ." },
	Arm { program: "hadolint", subcommand: None, command: "hadolint Dockerfile" },
	Arm { program: "yamllint", subcommand: None, command: "yamllint ." },
	Arm { program: "oxlint", subcommand: None, command: "oxlint" },
	Arm { program: "pyright", subcommand: None, command: "pyright" },
	Arm { program: "jest", subcommand: None, command: "jest" },
	Arm { program: "vitest", subcommand: None, command: "vitest run" },
	Arm { program: "playwright", subcommand: Some("test"), command: "playwright test" },
	Arm { program: "next", subcommand: Some("build"), command: "next build" },
	Arm { program: "prettier", subcommand: None, command: "prettier --check ." },
	Arm { program: "prisma", subcommand: Some("migrate"), command: "prisma migrate dev" },
	Arm { program: "npx", subcommand: Some("tsc"), command: "npx tsc" },
	Arm { program: "npm", subcommand: Some("install"), command: "npm install" },
	Arm { program: "pnpm", subcommand: Some("install"), command: "pnpm install" },
	Arm { program: "yarn", subcommand: Some("install"), command: "yarn install" },
	Arm { program: "pip", subcommand: Some("install"), command: "pip install ." },
	Arm { program: "bundle", subcommand: Some("install"), command: "bundle install" },
	Arm { program: "brew", subcommand: Some("install"), command: "brew install jq" },
	Arm { program: "composer", subcommand: Some("install"), command: "composer install" },
	Arm { program: "poetry", subcommand: Some("install"), command: "poetry install" },
	Arm { program: "uv", subcommand: Some("sync"), command: "uv sync" },
	Arm { program: "uv", subcommand: Some("run"), command: "uv run pytest" },
	Arm { program: "env", subcommand: None, command: "env" },
	Arm { program: "log", subcommand: None, command: "log" },
	Arm { program: "ps", subcommand: None, command: "ps aux" },
	Arm { program: "ping", subcommand: None, command: "ping example.com" },
	Arm { program: "ssh", subcommand: None, command: "ssh host" },
	Arm { program: "gtest", subcommand: None, command: "gtest" },
	Arm { program: "gradlew", subcommand: Some("test"), command: "./gradlew test" },
	Arm { program: "mvnw", subcommand: Some("test"), command: "./mvnw test" },
	Arm { program: "read", subcommand: None, command: "read file" },
	Arm { program: "json", subcommand: None, command: "json ." },
	Arm { program: "rails", subcommand: Some("test"), command: "rails test" },
	Arm { program: "basedpyright", subcommand: None, command: "basedpyright" },
	Arm { program: "python3", subcommand: Some("-m"), command: "python3 -m pytest" },
	Arm { program: "npx", subcommand: Some("vitest"), command: "npx vitest run" },
	Arm { program: "pnpm", subcommand: Some("dlx"), command: "pnpm dlx tsc" },
	Arm { program: "uv", subcommand: Some("pytest"), command: "uv pytest" },
	Arm { program: "bundle", subcommand: Some("exec"), command: "bundle exec rspec" },
	Arm { program: "deps", subcommand: None, command: "deps" },
	Arm { program: "summary", subcommand: None, command: "summary" },
	Arm { program: "err", subcommand: None, command: "err" },
	Arm { program: "test", subcommand: None, command: "test" },
	Arm { program: "diff", subcommand: None, command: "diff a b" },
	Arm { program: "format", subcommand: None, command: "format" },
	Arm { program: "pipe", subcommand: None, command: "pipe" },
	Arm { program: "sops", subcommand: None, command: "sops -d secrets.yaml" },
	Arm { program: "not-a-known-tool", subcommand: None, command: "not-a-known-tool" },
];

/// One hostile capture, with a name that says what it is probing.
struct Capture {
	what: &'static str,
	text: &'static str,
}

/// Captures chosen to hit the shapes that have actually broken filters.
///
/// Every entry here corresponds to a bug that reached `main` at some point, or
/// to the boundary of one. They are deliberately small and ugly: a filter that
/// survives a realistic capture and falls over on a lone `|` is a filter with a
/// missing entry condition, which is the defect class this suite exists for.
const CAPTURES: &[Capture] = &[
	Capture { what: "nothing but newlines", text: "\n\n\n\n\n" },
	Capture { what: "whitespace only", text: "   \n\t\n  \n" },
	Capture { what: "no trailing newline", text: "raw output with no terminator" },
	Capture { what: "crlf line endings", text: "alpha\r\nbravo\r\n" },
	Capture { what: "a dangling carriage return", text: "alpha\r" },
	Capture { what: "a lone pipe row", text: "|\n|\n" },
	Capture {
		what: "a bordered table",
		text: "+---+---+\n| a | b |\n+---+---+\n| 1 | 2 |\n+---+---+\n",
	},
	Capture { what: "a bare border", text: "-+-\n" },
	Capture { what: "a colour code", text: "\x1b[31merror\x1b[0m: boom\n" },
	Capture { what: "a truncated escape", text: "\x1b\x1b[[[\n" },
	Capture { what: "an interior carriage return", text: "50%\r100%\n" },
	Capture { what: "a repeat counter we wrote", text: "0 (×2)\n" },
	Capture { what: "an elision marker we wrote", text: "[…5ln elided…]\nrest\n" },
	Capture {
		what: "a diagnostic report we wrote",
		text: "3 diagnostics in 2 files\nx (1 diagnostics)\n  y\n",
	},
	Capture { what: "a row tally we wrote", text: "13 rows\nHEADER\nrow one\n" },
	Capture { what: "a find summary we wrote", text: "find: 3 paths in 2 dirs\n./ a b\n" },
	Capture { what: "an entry tally we wrote", text: "100 entries\n./a.rs\n…\n./z.rs\n" },
	Capture {
		what: "a log summary we wrote",
		text: "log summary: 100 lines, 100 unique, 0 errors, 0 warnings, 0 info\nevent one\n",
	},
	Capture { what: "a prettier summary we wrote", text: "Prettier: no output\n" },
	Capture {
		what: "a directory tally we wrote",
		text: "25 files, 2 dirs (25 .rs)\nfile.rs  1.0K\n",
	},
	Capture { what: "a package tally we wrote", text: "package tree/list: 91 entries\nfoo@1.0.0\n" },
	Capture { what: "the engine clean signal", text: "OK\n" },
	Capture { what: "a no-op package summary we wrote", text: "ok (up to date)\n" },
	Capture { what: "a build summary we wrote", text: "ctest: ok\n" },
	Capture { what: "a failure header we wrote", text: "dotnet build: failed\n" },
	Capture { what: "a test summary we wrote", text: "go test: 3 packages ok\n" },
	Capture { what: "a clean lint summary we wrote", text: "golangci-lint: no issues found\n" },
	Capture { what: "a grouped listing we wrote", text: "src/main.rs:\n  10:5: boom\n" },
	Capture { what: "a tab separated row", text: "a\tb\nc\td\n" },
	Capture {
		what: "a single diagnostic",
		text: "src/main.rs:10:5: error[E0308]: mismatched types\n",
	},
	Capture { what: "a deep path with punctuation", text: "./a )/b (c)/d.rs\n" },
	Capture { what: "json", text: "{\"a\": 1, \"b\": [2, 3]}\n" },
	// The shapes the filters exist to RESHAPE. Everything above is a degenerate or
	// already-annotated capture, and those found plenty, but the `gt diff` defect
	// needed a real unified diff to appear: the summary a diff compactor writes
	// opens with `--- `, which is a file marker, so its own output parsed as a
	// diff and reported one file where there were two. A table of captures that
	// holds no realistic input can only find the bugs that degenerate input
	// reaches.
	Capture {
		what: "a unified diff",
		text: "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,3 +1,4 @@\n \
		       keep\n+added\n-removed\ndiff --git a/src/b.rs b/src/b.rs\n--- a/src/b.rs\n+++ \
		       b/src/b.rs\n@@ -1,2 +1,3 @@\n keep\n+added\n",
	},
	Capture {
		what: "a diff summary we wrote",
		text: "src/a.rs | 2 +-\nsrc/b.rs | 1 +\n2 files changed, 2 insertions(+), 1 \
		       deletions(-)\n\n--- Changes ---\n\nFile: src/a.rs\n  @@ -1,3 +1,4 @@\n  +added\n",
	},
	Capture {
		what: "a test runner failure block",
		text: "FAIL src/a.test.ts\n  \u{2022} it works\n    expected 1 to be 2\n  \u{2713} it also \
		       works\nTests: 1 failed, 1 passed\n",
	},
	Capture {
		what: "a psql result set",
		text: " id | name  \n----+-------\n  1 | ada\n  2 | grace\n(2 rows)\n",
	},
	Capture {
		what: "a compiler diagnostic with a code frame",
		text: "error[E0308]: mismatched types\n  --> src/main.rs:10:5\n   |\n10 |     let x: u8 = \
		       \"s\";\n   |            --   ^^^ expected `u8`\n   |\nerror: could not compile `x` \
		       (bin \"x\") due to 1 previous error\n",
	},
	// Every annotation shape again, this time with program output on BOTH sides of
	// it. The shapes above sit alone or nearly alone, and that is not where they
	// do damage: `---- (×2)` alone is harmless, while the same counter with lines
	// before it made `cargo test` latch on it as a failure header and throw the
	// head of the capture away. An annotation is dangerous in CONTEXT, because
	// what it changes is which of the surrounding lines survive.
	Capture {
		what: "a repeat counter in context",
		text: "leading line\n---- (×2)\ntrailing line\n",
	},
	Capture {
		what: "an elision marker in context",
		text: "leading line\n[…3ln elided…]\ntrailing line\n",
	},
	Capture { what: "a row tally in context", text: "leading line\n13 rows\ntrailing line\n" },
	Capture {
		what: "an entry tally in context",
		text: "leading line\n100 entries\ntrailing line\n",
	},
	Capture {
		what: "a find summary in context",
		text: "leading line\nfind: 3 paths in 2 dirs\ntrailing line\n",
	},
	Capture {
		what: "a diff changes header in context",
		text: "leading line\n--- Changes ---\ntrailing line\n",
	},
	Capture {
		what: "a diff file header in context",
		text: "leading line\nFile: src/a.rs\ntrailing line\n",
	},
	Capture {
		what: "a code summary in context",
		text: "leading line\nTop codes: E0308 (3)\ntrailing line\n",
	},
	Capture {
		what: "a log summary in context",
		text: "leading line\nlog summary: 10 lines, 10 unique, 0 errors, 0 warnings, 0 \
		       info\ntrailing line\n",
	},
	Capture {
		what: "a docker table",
		text: "CONTAINER ID   IMAGE   STATUS\nc0001          nginx   Up 2 hours\nc0002          \
		       redis   Exited (0)\n",
	},
	// Captures made of NOTHING BUT an annotation, which is the state a capture
	// reaches on its own: a table of only borders declines to compact, and the dedup
	// after it leaves one repeat counter and whatever whitespace the capture had.
	// The counters above all sit next to program output, and that is the easy case,
	// because the guard that stops a filter answering with nothing sees the output
	// and holds. With nothing beside it the guard used to stand down, and the psql
	// reshaper then kept the counter, dropped the rest, and answered differently on
	// the second pass than it had on the first.
	Capture { what: "a counter that is the whole capture", text: "| -+---- (×2)\n" },
	Capture { what: "a counter after a whitespace-only line", text: "\t \n\n| -+---- (×2)\n\n" },
	Capture { what: "an elision marker that is the whole capture", text: "[…5ln elided…]\n" },
	Capture { what: "a bordered table that deduped to a counter", text: "+---+ (×2)\n" },
	Capture { what: "a tally that is the whole capture", text: "13 rows\n" },
];

/// A hundred identical lines, which is where dedup and capping interact.
fn repeated_lines() -> String {
	"the same line\n".repeat(100)
}

/// A hundred distinct lines, which is where capping and elision interact.
fn distinct_lines() -> String {
	(1..=100).map(|n| format!("line {n} of output\n")).collect()
}

fn enabled() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

/// Check both properties for one arm, one capture, one exit code.
fn check(arm: &Arm, what: &str, input: &str, exit_code: i32) {
	let config = enabled();
	let ctx = MinimizerCtx {
		program:    arm.program,
		subcommand: arm.subcommand,
		command:    arm.command,
		config:     &config,
	};

	let first = filters::filter(&ctx, input, exit_code).text;
	let second = filters::filter(&ctx, &first, exit_code).text;

	// Stated separately from the equality below because it is the consequence
	// that matters, and a future regression could reach it by another route.
	if !first.trim().is_empty() {
		assert!(
			!second.trim().is_empty(),
			"{} exit {exit_code} on {what} turned its own output into NOTHING; input {input:?}, \
			 first pass {first:?}",
			arm.command,
		);
	}

	assert_eq!(
		second, first,
		"{} exit {exit_code} on {what} changed its own output on a second pass; input {input:?}",
		arm.command,
	);
}

/// Run `body` for every arm and report every failure at once.
///
/// One assertion per arm would stop at the first, and the first is rarely the
/// interesting one: these defects come in families, and seeing all of a family
/// together is what points at the shared cause rather than at one filter.
fn for_every_arm(body: impl Fn(&Arm)) {
	let mut failures = Vec::new();
	for arm in ARMS {
		if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(arm))) {
			let message = panic
				.downcast_ref::<String>()
				.cloned()
				.or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_string()))
				.unwrap_or_else(|| "non-string panic".to_string());
			failures.push(message);
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} arms failed:\n{}",
		failures.len(),
		ARMS.len(),
		failures.join("\n"),
	);
}

mod hostile_captures {
	use super::*;

	/// Every arm, every listed capture, at exit 0.
	#[test]
	fn every_arm_settles_on_a_successful_run() {
		for_every_arm(|arm| {
			for capture in CAPTURES {
				check(arm, capture.what, capture.text, 0);
			}
		});
	}

	/// And at a failing exit code, which routes differently in most filters.
	///
	/// Worth its own case because the failure path is the one that keeps
	/// diagnostics rather than collapsing to a summary, so it exercises entirely
	/// different branches.
	#[test]
	fn every_arm_settles_on_a_failing_run() {
		for_every_arm(|arm| {
			for capture in CAPTURES {
				check(arm, capture.what, capture.text, 1);
			}
		});
	}
}

mod volume {
	use super::*;

	/// A hundred identical lines, where dedup meets capping.
	#[test]
	fn every_arm_settles_on_repeated_lines() {
		let input = repeated_lines();
		for_every_arm(|arm| {
			check(arm, "a hundred identical lines", &input, 0);
			check(arm, "a hundred identical lines", &input, 1);
		});
	}

	/// A hundred distinct lines, where capping meets elision.
	#[test]
	fn every_arm_settles_on_distinct_lines() {
		let input = distinct_lines();
		for_every_arm(|arm| {
			check(arm, "a hundred distinct lines", &input, 0);
			check(arm, "a hundred distinct lines", &input, 1);
		});
	}
}

mod cross_filter_contamination {
	use std::collections::BTreeSet;

	use super::*;

	/// Everything any arm produces, deduplicated.
	///
	/// This is the interesting part: filters CHAIN. A wrapper re-filters what it
	/// wrapped, a pipeline hands one filter's output to the next, and a captured
	/// transcript gets replayed through whichever filter matches the command it
	/// was captured from -- which need not be the one that wrote it. So one
	/// filter's summary really does arrive at another filter's parser, and the
	/// annotations in it are, to that parser, just more lines of program output.
	fn every_output() -> BTreeSet<String> {
		let config = enabled();
		let mut outputs = BTreeSet::new();
		for arm in ARMS {
			let ctx = MinimizerCtx {
				program:    arm.program,
				subcommand: arm.subcommand,
				command:    arm.command,
				config:     &config,
			};
			for capture in CAPTURES {
				for exit_code in [0, 1] {
					let text = filters::filter(&ctx, capture.text, exit_code).text;
					if !text.trim().is_empty() {
						outputs.insert(text);
					}
				}
			}
		}
		outputs
	}

	/// Every arm settles on every other arm's output.
	///
	/// The listed captures probe each filter with shapes chosen by hand. This
	/// probes each filter with shapes chosen by ALL THE OTHER FILTERS, which is
	/// a much larger and much less predictable set, and it is the set that
	/// actually reaches them in a chain. Each of the self-consuming summaries
	/// fixed on 2026-07-26 -- the row tally, the entry tally, the log summary,
	/// the prettier line, the repeat counter read as a table row -- was exactly
	/// this shape: one filter's annotation arriving at a parser that had no
	/// idea it was an annotation.
	#[test]
	fn every_arm_settles_on_every_other_arms_output() {
		let outputs: Vec<String> = every_output().into_iter().collect();
		assert!(outputs.len() > 50, "the corpus should be substantial, got {}", outputs.len());

		for_every_arm(|arm| {
			for output in &outputs {
				// Every exit code, because the non-zero paths are not the zero path
				// with a header on it: `compact_pipe_like_output` declines to compact
				// at all when the command failed, the lint filters switch from
				// summarizing to keeping diagnostics, and the build filters change
				// which lines count as important. A capture that settles on success
				// says nothing about the same capture on a failure, and a failure is
				// when the agent is actually reading the output.
				for exit_code in [0, 1, 2] {
					check(arm, "another filter's output", output, exit_code);
				}
			}
		});
	}
}

mod the_empty_capture {
	use super::*;

	/// An empty capture does not panic, and whatever it produces settles.
	///
	/// A quiet command is a real case: `ninja` with nothing to do, `cmake
	/// --build` on an up-to-date tree, `dotnet build` that failed before it
	/// printed anything. Some filters answer with a summary derived from the
	/// EXIT CODE (`cmake: ok`, `dotnet build: failed`), and that is legitimate:
	/// the exit code is information the minimizer has and the agent would
	/// otherwise have to infer. What is not legitimate is that summary being
	/// unstable, so what is asserted here is that the answer settles, not that
	/// it is empty.
	#[test]
	fn every_arm_settles_on_an_empty_capture() {
		for_every_arm(|arm| {
			let config = enabled();
			let ctx = MinimizerCtx {
				program:    arm.program,
				subcommand: arm.subcommand,
				command:    arm.command,
				config:     &config,
			};
			for exit_code in [0, 1] {
				let first = filters::filter(&ctx, "", exit_code).text;
				let second = filters::filter(&ctx, &first, exit_code).text;
				assert_eq!(
					second, first,
					"{} exit {exit_code} on an empty capture changed its own answer on a second pass",
					arm.command,
				);
			}
		});
	}
}
