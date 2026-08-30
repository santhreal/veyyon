//! Fixture helpers shared by the minimizer's integration tests.
//!
//! WHY THIS MODULE EXISTS. Nineteen test files in this directory built the same
//! two values, and eighteen of them did it with a byte-identical copy of the
//! same function. `enabled()` -- a `MinimizerConfig` with the minimizer turned
//! on -- appeared 18 times, and `context(program, subcommand, command, config)`
//! 9 times, plus two near-copies that hardcoded a program. So the shape of a
//! `MinimizerCtx` was declared in eleven places, and adding a field to it meant
//! finding all of them; clippy noticing that each copy could be `const` in each
//! file is what finally made the duplication loud.
//!
//! Each integration test file is its own binary, so a shared helper has to be a
//! module every file declares (`mod common;`). That is the standard Rust shape
//! for this and the reason the directory is `common/`: a directory under
//! `tests/` is not compiled as a test binary of its own, so nothing here has to
//! pretend to be a test.
#![allow(
	dead_code,
	reason = "each test binary includes the whole module and uses the part it needs; an unused \
	          helper here is a helper another binary uses"
)]

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx};

/// A config with the minimizer on and everything else at its default.
///
/// The default is OFF, so a test that forgets this measures a passthrough and
/// asserts nothing about any filter.
pub fn enabled() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

/// The context a filter reads: which program ran, which subcommand, the command
/// line as typed, and the config.
///
/// All four matter to routing, which is why none of them is defaulted here. A
/// helper that filled in the program would hide the field the router keys on.
pub const fn context<'a>(
	program: &'a str,
	subcommand: Option<&'a str>,
	command: &'a str,
	config: &'a MinimizerConfig,
) -> MinimizerCtx<'a> {
	MinimizerCtx { program, subcommand, command, config }
}

/// `count` lines, each rendered from its 1-based index.
///
/// The fixture every capping and listing test needs: enough lines that the
/// filter under test has something to elide. Written as a loop that appends,
/// because `(1..=n).map(format!).collect()` is a lint here and four copies of
/// the loop would be four places to read.
pub fn lines(count: usize, render: impl Fn(usize) -> String) -> String {
	let mut built = String::new();
	for index in 1..=count {
		built.push_str(&render(index));
	}
	built
}
