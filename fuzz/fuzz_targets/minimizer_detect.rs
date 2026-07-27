#![no_main]

//! Fuzzes command detection in `veyyon-shell`.
//!
//! WHAT IS UNDER TEST. `detect` turns a command line into a `CommandIdentity`, and
//! `detect_tokens` does the same from an already-expanded argv. Every minimizer filter is
//! chosen by that identity, so a wrong answer here does not produce a wrong-looking
//! result, it produces a right-looking one from the wrong filter: `cargo test` output
//! condensed as if it were `docker ps`, or a `git diff` handed to the lint condenser. The
//! filters themselves are covered by `minimizer_filters.rs`; nothing covered the router,
//! which is the one component every other one depends on.
//!
//! WHY THE SHAPES ARE GENERATED AND NOT RAW BYTES. The detector has forty program arms and
//! a launch-prefix stripper that knows `env`, `sudo`, `command`, `builtin`, `noglob`,
//! `exec` and `time`, each with its own option table. A raw byte string almost never
//! reaches any of them, so a run spends itself rediscovering that `xyzzy` has no filter.
//! Words are drawn from a table of real program names, subcommands and global flags, and a
//! free-form word keeps the unstructured space reachable.
//!
//! THE PROPERTIES. Panics are the least of them; the detector is `&str -> Option<_>` with
//! no allocation tricks and it has never panicked. What is asserted instead is the set of
//! things a caller relies on and no test states:
//!
//!   - The program and subcommand are LOWERCASE. Every filter compares them with `==`
//!     against a lowercase literal, so an arm that forgets `.to_lowercase()` does not fail,
//!     it silently stops matching and the capture streams through unminimized. That is a
//!     Law 10 silent fallback with no log line anywhere.
//!   - Nothing is INVENTED. The program comes from a token of the command and the
//!     subcommand from a later one, so a detector that shifted an index by one would be
//!     caught even when the result still looks like a program name.
//!   - The two entry points AGREE. `detect` tokenizes and calls `detect_tokens`; a caller
//!     with a real argv uses the second directly. If they disagreed, the same command would
//!     be filtered differently depending on which side of the shell it came from.
//!   - The prefix stripper is TRANSPARENT. `sudo x` and `env x` detect as `x` does, and
//!     everything after `;`, `|` or `&` is another command and cannot change the answer.

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use veyyon_shell::minimizer::detect::{CommandIdentity, detect, detect_tokens};

/// Real program names, subcommands, launch prefixes and global flags.
///
/// Mixed together on purpose rather than split into program and argument tables: the
/// detector's hardest cases are the ones where a flag lands where a subcommand was
/// expected, or a launch prefix appears in the middle, and a generator that could not
/// produce those would never test the option tables at all.
const WORDS: &[&str] = &[
	// launch prefixes and their options
	"env",
	"sudo",
	"command",
	"builtin",
	"noglob",
	"exec",
	"time",
	"--",
	"-u",
	"root",
	"-i",
	"-E",
	"-S",
	"--split-string",
	"-C",
	"--chdir=/tmp",
	"FOO=1",
	"PATH=/usr/bin",
	"_A_B=x",
	// programs
	"git",
	"cargo",
	"docker",
	"docker-compose",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"pip",
	"uv",
	"uvx",
	"aws",
	"gh",
	"glab",
	"gt",
	"jest",
	"vitest",
	"bundle",
	"yadm",
	"/usr/bin/git",
	"./gradlew",
	"gradlew.bat",
	"mvnw.cmd",
	"GIT",
	"Docker",
	// subcommands
	"status",
	"diff",
	"test",
	"build",
	"install",
	"ps",
	"logs",
	"up",
	"s3",
	"run",
	"jest@latest",
	"@scope/pkg@1.0",
	// global flags with and without inline values
	"-C",
	"-c",
	"color.ui=false",
	"--manifest-path",
	"--manifest-path=/a/Cargo.toml",
	"--git-dir",
	"--locked",
	"--profile",
	"--region=us-east-1",
	"+nightly",
	"-w",
	"--repo",
];

/// One word of a generated command: a real one, or free-form bytes.
#[derive(Arbitrary, Debug)]
enum Word {
	Known(u8),
	Free(String),
}

impl Word {
	fn render(&self) -> String {
		match self {
			Word::Known(index) => WORDS[*index as usize % WORDS.len()].to_string(),
			Word::Free(text) => text.clone(),
		}
	}
}

/// The longest command the target will build. Past this the detector is answering from the
/// first few tokens anyway, and the extra bytes only slow the run down.
const MAX_WORDS: usize = 24;

/// A token is PLAIN when joining it with single spaces round-trips through `tokenize`.
///
/// Quotes, backslashes and the command separators are exactly what tokenizing is FOR, so a
/// command containing them is not the same command as its token list, and the properties
/// that compare the two entry points do not hold for it. Those inputs still reach `detect`
/// through the string path; they are only excluded from the comparisons.
fn is_plain(token: &str) -> bool {
	!token.is_empty()
		&& !token.chars().any(|ch| {
			ch.is_whitespace() || matches!(ch, '\'' | '"' | '\\' | ';' | '|' | '&')
		})
}

/// Mirrors `detect::is_env_assignment`, which is private.
///
/// A mirror rather than an export: the guard below needs to skip what the launch-prefix
/// stripper skips, and restating the rule here means a change to the real one shows up as a
/// disagreement rather than being silently adopted by the oracle.
fn is_env_assignment(token: &str) -> bool {
	let Some((name, _)) = token.split_once('=') else {
		return false;
	};
	let mut chars = name.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	(first == '_' || first.is_ascii_alphabetic()) && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

/// Everything a caller may assume about an identity, given the tokens it came from.
fn check_identity(identity: &CommandIdentity, tokens: &[String], origin: &str) {
	assert!(!identity.program.is_empty(), "{origin}: empty program from {tokens:?}");
	assert_eq!(
		identity.program,
		identity.program.to_lowercase(),
		"{origin}: program is not lowercase, so every filter's `==` comparison misses it: {tokens:?}",
	);
	assert!(
		!identity.program.contains('/'),
		"{origin}: program kept a path separator instead of being reduced to a base name: {tokens:?}",
	);

	// The program is a token's base name, lowercased, with three documented rewrites.
	let from_a_token = tokens.iter().any(|token| {
		let base = token.rsplit('/').next().unwrap_or(token).to_lowercase();
		base == identity.program
			|| (base == "gradlew.bat" && identity.program == "gradlew")
			|| (base == "mvnw.cmd" && identity.program == "mvnw")
			|| (base == "docker-compose" && identity.program == "docker")
	});
	assert!(
		from_a_token,
		"{origin}: program {:?} is not the base name of any token in {tokens:?}",
		identity.program,
	);

	let Some(subcommand) = identity.subcommand.as_deref() else {
		return;
	};
	assert_eq!(
		subcommand,
		subcommand.to_lowercase(),
		"{origin}: subcommand is not lowercase, so the filter arm that names it never matches: {tokens:?}",
	);
	// Every arm returns `arg.to_lowercase()` of some argument; the npx arm additionally
	// truncates at a version qualifier, which leaves a prefix of that same value.
	assert!(
		tokens
			.iter()
			.any(|token| token.to_lowercase().starts_with(subcommand)),
		"{origin}: subcommand {subcommand:?} is not carried by any token in {tokens:?}",
	);
}

fuzz_target!(|words: Vec<Word>| {
	let tokens: Vec<String> = words.iter().take(MAX_WORDS).map(Word::render).collect();

	let from_tokens = detect_tokens(&tokens);
	if let Some(identity) = &from_tokens {
		check_identity(identity, &tokens, "detect_tokens");
	}
	assert_eq!(from_tokens, detect_tokens(&tokens), "detect_tokens is not deterministic");

	if !tokens.iter().all(|token| is_plain(token)) {
		return;
	}
	let command = tokens.join(" ");

	// The two entry points are one answer. A caller holding a real argv uses `detect_tokens`
	// and a caller holding a command line uses `detect`; if they parted company the same
	// command would be minimized differently depending on where it came from.
	let from_command = detect(&command);
	assert_eq!(
		from_command, from_tokens,
		"detect and detect_tokens disagree about {command:?}",
	);
	if let Some(identity) = &from_command {
		check_identity(identity, &tokens, "detect");
	}

	// Whitespace is a separator, not content. A command formatted with tabs or padded with
	// blanks is the same command.
	let respaced = format!("  {}  ", command.replace(' ', "\t"));
	assert_eq!(
		detect(&respaced),
		from_command,
		"whitespace changed the answer for {command:?}",
	);

	// Everything after a separator is a DIFFERENT command and cannot reach back.
	for separator in [";", "|", "&", "&&", "||"] {
		let chained = format!("{command} {separator} rm -rf /");
		assert_eq!(
			detect(&chained),
			from_command,
			"what follows {separator:?} changed the answer for {command:?}",
		);
	}

	// The launch prefixes are transparent. Guarded on the first token that is not an
	// environment assignment not being an option, because a prefix legitimately consumes
	// one: `env FOO=1 -i git` gives `env` its own `-i`, and `PATH=/usr/bin -i env` on its
	// own detects the program `-i`. Skipping the assignments is what makes the guard match
	// the stripper, which also skips them before it looks at the token.
	let first_real = tokens.iter().find(|token| !is_env_assignment(token));
	if first_real.is_some_and(|token| !token.starts_with('-')) {
		for prefix in ["env", "sudo", "command", "builtin", "noglob"] {
			let prefixed = format!("{prefix} {command}");
			assert_eq!(
				detect(&prefixed),
				from_command,
				"the {prefix:?} launch prefix changed the answer for {command:?}",
			);
		}
	}
});
