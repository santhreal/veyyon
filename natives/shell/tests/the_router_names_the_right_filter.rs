//! What `minimizer::detect` promises the filters, stated as tests rather than
//! as convention.
//!
//! WHY THIS IS WORTH ITS OWN SUITE. The detector is the router: it turns a
//! command line into a `CommandIdentity`, and that identity is the only thing
//! that decides which filter sees a capture. A wrong answer here never looks
//! wrong. It produces a plausible, well-formed result from the wrong filter, or
//! none at all, and the operator sees a `cargo test` run streaming unminimized
//! with no error anywhere. The module's own `#[cfg(test)]` block covers a dozen
//! commands; what it does not state are the CONTRACTS the forty program arms
//! share, and those are what a new arm breaks.
//!
//! THE FOUR CONTRACTS.
//!
//! 1. The identity is LOWERCASE, both halves. Every filter matches it with `==`
//!    against a lowercase literal, so an arm that forgets `.to_lowercase()`
//!    does not fail loudly, it quietly stops matching and the capture passes
//!    through whole. That is a silent fallback with no log line, which is the
//!    one failure shape this codebase refuses outright.
//! 2. Nothing is INVENTED. The program is the base name of a token of the
//!    command, and the subcommand is carried by a later one. An off-by-one in
//!    the launch-prefix stripper still produces a name that looks like a
//!    program, so "it returned something sensible" is not evidence.
//! 3. The two entry points AGREE. `detect` tokenizes a command line;
//!    `detect_tokens` takes an argv a caller already has. The same command must
//!    not be minimized differently depending on which side of the shell it
//!    arrived from.
//! 4. The prefix stripper is TRANSPARENT, and the command ENDS at a separator.
//!    `sudo git status` is a `git status`, and what follows `;`, `|` or `&` is
//!    a different command that cannot reach back and change the answer.
//!
//! `fuzz/fuzz_targets/minimizer_detect.rs` asserts the same four over generated
//! commands. This suite is the part that names the cases a reader needs to see,
//! and the one that runs in the ordinary test gate.

use veyyon_shell::minimizer::detect::{CommandIdentity, detect, detect_tokens};

/// Every command below, so a contract is asserted over the same set each time.
///
/// Chosen to cover each shape the detector treats differently rather than each
/// program it knows: a bare program, a path, global flags with and without
/// inline values, a toolchain qualifier, every launch prefix, an environment
/// assignment, quoting, and the two Windows launcher rewrites.
const COMMANDS: &[&str] = &[
	"git status",
	"git -C repo -c color.ui=false status --short",
	"/usr/bin/git diff",
	"cargo test",
	"cargo --manifest-path 'a b/Cargo.toml' build",
	"cargo --manifest-path=/a/Cargo.toml build",
	"cargo +nightly test",
	"docker ps -a",
	"docker-compose -f compose.yml up",
	"docker compose up",
	"npm --prefix ./app install",
	"npx jest@latest --ci",
	"npx @scope/pkg@1.0 run",
	"pnpm -r --filter web build",
	"yarn --cwd app install",
	"bun --cwd app test",
	"pip install requests",
	"uv --directory app run pytest",
	"aws --region us-east-1 s3 ls",
	"aws --profile dev --output json ec2 describe-instances",
	"gh --repo o/r pr list",
	"glab -R o/r mr list",
	"jest --ci",
	"vitest run",
	"bundle --gemfile Gemfile exec",
	"./gradlew build",
	"gradlew.bat build",
	"mvnw.cmd package",
	"FOO=1 git status",
	"FOO=1 BAR=2 /usr/bin/cargo build",
	"env FOO=bar cargo test",
	"env -u HOME git status",
	"sudo docker ps",
	"sudo -u root -- docker ps",
	"command git status",
	"builtin cd",
	"noglob git status",
	"exec git status",
	"time cargo build",
	"tsc --noEmit",
	"eslint .",
	"ls -la",
	"GIT STATUS",
	"Docker PS",
];

/// The identities `COMMANDS` produces, paired with the command for failure
/// messages.
fn detected() -> Vec<(&'static str, CommandIdentity)> {
	COMMANDS
		.iter()
		.filter_map(|command| detect(command).map(|identity| (*command, identity)))
		.collect()
}

/// Split a command the way `tokenize` does for the plain cases used below.
///
/// Only correct for commands with no quoting, which is why the callers that
/// need it filter first. Restating it here rather than exposing `tokenize`
/// keeps the module's surface as small as it is.
fn plain_tokens(command: &str) -> Vec<String> {
	command.split_whitespace().map(str::to_string).collect()
}

/// True when joining a command's whitespace-separated pieces reproduces the
/// command.
fn is_plain(command: &str) -> bool {
	!command.contains(['\'', '"', '\\', ';', '|', '&'])
}

mod the_identity_is_lowercase {
	use super::*;

	/// THE CONTRACT EVERY FILTER DEPENDS ON. `filters::supports` and every arm
	/// inside it compare the program with `==` against a lowercase literal, so
	/// an arm returning `"GIT"` matches nothing and the capture streams through
	/// unminimized with nothing logged.
	#[test]
	fn every_detected_program_is_lowercase() {
		for (command, identity) in detected() {
			assert_eq!(
				identity.program,
				identity.program.to_lowercase(),
				"{command:?} produced the non-lowercase program {:?}, which no filter arm can match",
				identity.program,
			);
		}
	}

	/// The same for the subcommand, which selects the arm WITHIN a program's
	/// filter: a non-lowercase one falls through to that filter's default and
	/// minimizes as the wrong kind of output.
	#[test]
	fn every_detected_subcommand_is_lowercase() {
		for (command, identity) in detected() {
			let Some(subcommand) = identity.subcommand.as_deref() else {
				continue;
			};
			assert_eq!(
				subcommand,
				subcommand.to_lowercase(),
				"{command:?} produced the non-lowercase subcommand {subcommand:?}",
			);
		}
	}

	/// A SHOUTED COMMAND IS THE SAME COMMAND. The exact case the two rules above
	/// exist for, asserted on real values rather than as a property, because
	/// this is the one a reader will want to see.
	#[test]
	fn a_command_typed_in_capitals_detects_the_same_identity() {
		let lower = detect("git status").expect("git status is detected");
		let upper = detect("GIT STATUS").expect("GIT STATUS is detected");

		assert_eq!(upper, lower);
		assert_eq!(upper.program, "git");
		assert_eq!(upper.subcommand.as_deref(), Some("status"));
	}
}

mod nothing_is_invented {
	use super::*;

	/// The program is the base name of a token of the command, with three
	/// documented rewrites and no others.
	///
	/// The failure this rules out is not a garbled name, it is a PLAUSIBLE one:
	/// a launch-prefix stripper that lands one token early returns `sudo` or
	/// `env`, which reads like a program and routes every `sudo`-prefixed
	/// command to the wrong filter.
	#[test]
	fn every_program_is_the_base_name_of_a_token() {
		for (command, identity) in detected() {
			if !is_plain(command) {
				continue;
			}
			let tokens = plain_tokens(command);
			let carried = tokens.iter().any(|token| {
				let base = token.rsplit('/').next().unwrap_or(token).to_lowercase();
				base == identity.program
					|| (base == "gradlew.bat" && identity.program == "gradlew")
					|| (base == "mvnw.cmd" && identity.program == "mvnw")
					|| (base == "docker-compose" && identity.program == "docker")
			});
			assert!(
				carried,
				"{command:?} produced the program {:?}, which is not the base name of any of its \
				 tokens",
				identity.program,
			);
		}
	}

	/// And the subcommand is carried by a token too.
	#[test]
	fn every_subcommand_is_carried_by_a_token() {
		for (command, identity) in detected() {
			if !is_plain(command) {
				continue;
			}
			let Some(subcommand) = identity.subcommand.as_deref() else {
				continue;
			};
			assert!(
				plain_tokens(command)
					.iter()
					.any(|token| token.to_lowercase().starts_with(subcommand)),
				"{command:?} produced the subcommand {subcommand:?}, which none of its tokens carries",
			);
		}
	}

	/// An executable given by path routes as its base name, so a project that
	/// calls `/usr/bin/git` gets the git filter.
	#[test]
	fn a_path_to_an_executable_routes_as_its_base_name() {
		let identity = detect("/usr/local/bin/cargo build").expect("a path to cargo is detected");

		assert_eq!(identity.program, "cargo");
		assert_eq!(identity.subcommand.as_deref(), Some("build"));
	}

	/// The three rewrites, named. Each exists because the rewritten spelling
	/// must reach the same filter as the bare one, and a generic `.bat`/`.cmd`
	/// strip would over-match every unrelated script.
	#[test]
	fn the_three_documented_rewrites_and_no_others() {
		assert_eq!(detect("gradlew.bat build").unwrap().program, "gradlew");
		assert_eq!(detect("mvnw.cmd package").unwrap().program, "mvnw");
		assert_eq!(detect("docker-compose up").unwrap().program, "docker");
		// Not rewritten: an unrelated script keeps its own name rather than being
		// folded into some other program's filter.
		assert_eq!(detect("deploy.cmd run").unwrap().program, "deploy.cmd");
		assert_eq!(detect("foo.bat run").unwrap().program, "foo.bat");
	}
}

mod the_two_entry_points_agree {
	use super::*;

	/// A command line and the argv it tokenizes to must give one answer.
	///
	/// Both are public and both are used: the shell path has a string, an
	/// integration that already holds an argv calls `detect_tokens` directly.
	/// If they parted company the same program would be minimized one way from
	/// a terminal and another from an API caller.
	#[test]
	fn detect_agrees_with_detect_tokens_for_every_command() {
		for command in COMMANDS {
			if !is_plain(command) {
				continue;
			}
			assert_eq!(
				detect(command),
				detect_tokens(&plain_tokens(command)),
				"the string and argv entry points disagree about {command:?}",
			);
		}
	}

	/// An empty argv has no program, and neither does an argv of one empty
	/// string.
	///
	/// `detect_tokens` is public, so it is reachable with values `tokenize`
	/// would never produce; a caller passing an empty argv must get `None`
	/// rather than an identity with an empty program that then matches a filter
	/// arm by accident.
	#[test]
	fn an_argv_with_nothing_in_it_has_no_identity() {
		assert_eq!(detect_tokens(&[]), None);
		assert_eq!(detect_tokens(&[String::new()]), None);
		assert_eq!(detect(""), None);
		assert_eq!(detect("   "), None);
	}
}

mod a_prefix_and_a_separator {
	use super::*;

	/// A launch prefix is transparent: the command underneath is what gets
	/// filtered.
	#[test]
	fn every_launch_prefix_leaves_the_identity_alone() {
		let bare = detect("git status").expect("git status is detected");

		for prefix in ["env", "sudo", "command", "builtin", "noglob", "exec", "time"] {
			let prefixed = format!("{prefix} git status");
			assert_eq!(
				detect(&prefixed),
				Some(bare.clone()),
				"the {prefix:?} prefix changed the identity",
			);
		}
	}

	/// Prefixes stack, because real commands stack them.
	#[test]
	fn stacked_prefixes_are_all_stripped() {
		let identity =
			detect("time sudo env FOO=1 cargo test").expect("a stacked prefix is stripped");

		assert_eq!(identity.program, "cargo");
		assert_eq!(identity.subcommand.as_deref(), Some("test"));
	}

	/// A PREFIX'S OWN OPTIONS BELONG TO THE PREFIX, and this is the case that is
	/// easy to get backwards.
	///
	/// `env -i` means "ignore the environment", so the `-i` is `env`'s and the
	/// program is what follows. Without the prefix the very same tokens mean
	/// something else entirely: `-i git status` has `-i` as its program,
	/// because that is what the first token is. Found while writing the fuzz
	/// oracle for this module, which asserted that a prefix is
	/// always transparent and was wrong for exactly this reason.
	#[test]
	fn a_prefix_consumes_its_own_options_and_not_the_program() {
		let with_prefix = detect("env -i git status").expect("env -i strips to git");
		assert_eq!(with_prefix.program, "git");
		assert_eq!(with_prefix.subcommand.as_deref(), Some("status"));

		// The same tail without the prefix is a different command, not the same one.
		assert_eq!(detect("-i git status").map(|identity| identity.program), Some("-i".to_string()));

		// And the assignments a prefix skips are skipped before the option check, so a
		// leading assignment does not hide the option from `env`.
		assert_eq!(
			detect("env PATH=/usr/bin -i git status").map(|i| i.program),
			Some("git".to_string())
		);
	}

	/// `env -S` is refused rather than guessed at.
	///
	/// `-S` re-splits the following string into arguments, so the real program
	/// is inside a quoted blob this detector does not parse. Answering `None`
	/// leaves the capture streaming unchanged, which is the honest outcome;
	/// answering with the blob's first word would route a command nobody has
	/// actually parsed.
	#[test]
	fn env_split_string_declines_instead_of_guessing() {
		assert_eq!(detect("env -S 'git status'"), None);
		assert_eq!(detect("env --split-string 'git status'"), None);
	}

	/// The command ends at the first separator, so a chained command cannot
	/// change it.
	#[test]
	fn nothing_after_a_separator_reaches_the_identity() {
		let bare = detect("git status").expect("git status is detected");

		for tail in ["; cargo test", "| grep x", "&& docker ps", "|| npm test", "& sleep 1"] {
			let chained = format!("git status {tail}");
			assert_eq!(
				detect(&chained),
				Some(bare.clone()),
				"{chained:?} was read past its separator"
			);
		}
	}

	/// A quoted separator is DATA, not a separator, and must not end the
	/// command.
	#[test]
	fn a_separator_inside_quotes_is_part_of_an_argument() {
		let identity = detect("git commit -m 'fix; really'").expect("a quoted semicolon is data");

		assert_eq!(identity.program, "git");
		assert_eq!(identity.subcommand.as_deref(), Some("commit"));
	}

	/// Whitespace is a separator and not content: tabs, runs of blanks and
	/// padding all give the same answer.
	#[test]
	fn whitespace_between_tokens_never_changes_the_answer() {
		let bare = detect("cargo test").expect("cargo test is detected");

		for spelling in
			["  cargo test", "cargo test  ", "cargo\ttest", "cargo   test", "\n cargo \t test \n"]
		{
			assert_eq!(detect(spelling), Some(bare.clone()), "{spelling:?} answered differently");
		}
	}
}

mod what_declines {
	use super::*;

	/// A program with no filter still gets an identity; declining is the
	/// filters' decision, not the router's.
	///
	/// The distinction matters: an unknown program must reach `filters::filter`
	/// and come back as a passthrough, because that is where the decision is
	/// recorded. A router that returned `None` for anything it did not
	/// recognize would make adding a filter require changing two places.
	#[test]
	fn an_unknown_program_still_has_an_identity() {
		let identity =
			detect("some-unknown-tool --flag run").expect("an unknown program is still identified");

		assert_eq!(identity.program, "some-unknown-tool");
		assert_eq!(identity.subcommand.as_deref(), Some("run"));
	}

	/// A command that is only flags has a program and no subcommand.
	#[test]
	fn a_command_with_no_positional_argument_has_no_subcommand() {
		let identity = detect("cargo --version").expect("cargo --version is detected");

		assert_eq!(identity.program, "cargo");
		assert_eq!(identity.subcommand, None);
	}
}
