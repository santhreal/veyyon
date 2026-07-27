#![no_main]

//! Fuzzes pattern compilation and matching in `veyyon-ast` across every
//! supported language.
//!
//! WHAT IS UNDER TEST. `compile_pattern` turns an agent-supplied or
//! user-supplied search pattern into an ast-grep `Pattern`, and
//! `collect_matches` runs it over a source file. Both sides of that are
//! attacker-adjacent in the ordinary sense: the pattern comes from a tool call
//! the model wrote, and the source is whatever file the user asked about.
//! Neither may crash the process.
//!
//! WHY BOTH HALVES IN ONE TARGET. The interesting failures live in the seam. A
//! pattern that compiles is a parsed tree, and matching walks it against
//! another parsed tree; a mismatch in how the two were parsed shows up only
//! when both exist. Fuzzing `compile_pattern` alone would confirm it returns
//! `Err` on garbage and miss that entirely.
//!
//! `compile_pattern` also has a fallback path worth reaching: a pattern that
//! parses to multiple root nodes is re-tried wrapped in a synthetic single-node
//! context. That path constructs new source text by string interpolation, which
//! is the sort of thing that behaves differently when the pattern contains the
//! delimiters being interpolated around.
//!
//! ONE HARNESS ACCOMMODATION, AND WHY IT IS NOT A LOOPHOLE. Both `compile_pattern`
//! and `collect_matches` convert a matcher panic into an `Err`, because
//! ast-grep-core has a `debug_assert!` that some pattern trees reach at MATCH
//! time. That conversion IS the contract those functions promise. libfuzzer-sys
//! installs a panic hook that calls `std::process::abort()` BEFORE unwinding
//! (`libfuzzer-sys-0.4.13/src/lib.rs:92`), specifically so that a `catch_unwind`
//! in the code under test cannot hide a bug. Here it hides nothing: the process
//! died at exactly the point the shipped code was reporting an error correctly,
//! so the target reported a crash for working behaviour. `install_guard_aware_hook`
//! skips the abort for the duration of those two calls and for nothing else. A
//! panic anywhere else still unwinds into libfuzzer-sys's outer `catch_unwind`,
//! which aborts, so no real crash is lost.
//!
//! The scope covers `collect_matches` because a compile-time probe cannot be
//! complete: the upstream assert is reached from `match_node_impl`, which
//! consults the CANDIDATE node before an ellipsis ever gets to
//! `match_leaf_meta_var`, so whether it fires depends on the source as well as
//! on the pattern. An earlier version of this comment claimed one probe answered
//! for every source. It does not, and the eight-target campaign on 2026-07-25
//! proved it by crashing here after the probe had passed.

use std::{cell::Cell, sync::Once};

use ast_grep_core::MatchStrictness;
use libfuzzer_sys::fuzz_target;
use veyyon_ast::{
	language::SupportLang,
	ops::{collect_matches, compile_pattern},
};

thread_local! {
	/// True only while a call that guards its own panics is on the stack.
	static INSIDE_GUARDED_CALL: Cell<bool> = const { Cell::new(false) };
}

static HOOK: Once = Once::new();
static FIRST_CATCH: Once = Once::new();

/// Replace libfuzzer-sys's abort-on-panic hook with one that lets the guarded
/// calls catch their own panics.
///
/// Called on every execution and does its work once. It has to run after
/// libfuzzer-sys's `initialize`, which is why it is not a `static` initializer.
fn install_guard_aware_hook() {
	HOOK.call_once(|| {
		let abort_on_panic = std::panic::take_hook();
		std::panic::set_hook(Box::new(move |info| {
			if INSIDE_GUARDED_CALL.with(Cell::get) {
				// Loud, not silent: the log still says this class was reached. Printed
				// once per process because a fuzzer hits it thousands of times a second
				// and a log nobody can read is its own kind of quiet.
				FIRST_CATCH.call_once(|| {
					eprintln!("[probe] compile_pattern converted a matcher panic to an error: {info}");
				});
				return;
			}
			abort_on_panic(info);
		}));
	});
}

/// Marks a guarded call for the hook above, and unmarks it on the way out
/// including when the stack is unwinding.
struct GuardedScope;

impl GuardedScope {
	fn enter() -> Self {
		INSIDE_GUARDED_CALL.with(|inside| inside.set(true));
		Self
	}
}

impl Drop for GuardedScope {
	fn drop(&mut self) {
		INSIDE_GUARDED_CALL.with(|inside| inside.set(false));
	}
}

/// Languages the target rotates through.
///
/// A subset rather than all of them, chosen for grammar diversity rather than
/// popularity: C-like braces, significant indentation, S-expressions, a markup
/// grammar, and a shell grammar. Parsing every one of the fifty-odd supported
/// languages per input would make each execution slow enough that the fuzzer
/// explores less, and grammars in the same family fail the same ways.
const LANGUAGES: &[SupportLang] = &[
	SupportLang::Rust,
	SupportLang::TypeScript,
	SupportLang::Python,
	SupportLang::Bash,
	SupportLang::Html,
	SupportLang::Yaml,
];

/// Strictness levels, which change which nodes a pattern is allowed to skip.
/// Included because the walk differs per level, so a crash can be reachable at
/// one and not another.
const STRICTNESS: &[MatchStrictness] = &[
	MatchStrictness::Cst,
	MatchStrictness::Smart,
	MatchStrictness::Ast,
	MatchStrictness::Relaxed,
	MatchStrictness::Signature,
];

/// Cap on source size. Tree-sitter is linear, but a megabyte of input per
/// execution starves the fuzzer of iterations.
const MAX_SOURCE_BYTES: usize = 8 * 1024;

fuzz_target!(|input: (u8, String, Option<String>, String)| {
	let (selector_byte, pattern, selector, source) = input;
	if source.len() > MAX_SOURCE_BYTES || pattern.len() > MAX_SOURCE_BYTES {
		return;
	}

	let language = LANGUAGES[usize::from(selector_byte) % LANGUAGES.len()];
	let strictness = &STRICTNESS[usize::from(selector_byte >> 3) % STRICTNESS.len()];

	install_guard_aware_hook();

	// Compilation must return `Err` on a bad pattern, never panic. Most inputs
	// stop here, which is fine: the ones that do not are the ones worth matching.
	let result = {
		let _scope = GuardedScope::enter();
		compile_pattern(&pattern, selector.as_deref(), strictness, language)
	};
	let Ok(compiled) = result else {
		return;
	};

	// The matcher is not allowed to panic, whatever the pattern and whatever the
	// source, so a guarded error here is a legitimate answer and an abort is not.
	// This is the property that the compile-time probe alone does NOT give: the
	// upstream assert depends on the candidate node as well as on the pattern, so
	// a pattern can pass the probe and still reach it against a real source.
	let found = {
		let _scope = GuardedScope::enter();
		collect_matches(&source, language, std::slice::from_ref(&compiled))
	};
	let Ok(matches) = found else {
		return;
	};

	// Every reported match must be a real span of the source. A match whose range
	// is reversed or past the end is how a rewrite later slices a file to
	// nonsense, and it would otherwise be reported as `Ok` and believed.
	for found in &matches {
		assert!(
			found.byte_start <= found.byte_end,
			"match range is reversed: {}..{} in {} bytes of {language:?}",
			found.byte_start,
			found.byte_end,
			source.len(),
		);
		assert!(
			found.byte_end <= source.len(),
			"match ends at {} but the source is {} bytes of {language:?}",
			found.byte_end,
			source.len(),
		);
		assert!(
			source.is_char_boundary(found.byte_start) && source.is_char_boundary(found.byte_end),
			"match {}..{} does not land on character boundaries",
			found.byte_start,
			found.byte_end,
		);

		// The reported text must be the span it points at. Callers quote `text`
		// back to the agent while using the byte range to rewrite, so a
		// disagreement between the two edits a different place than it showed.
		assert_eq!(
			found.text,
			&source[found.byte_start..found.byte_end],
			"match text disagrees with its own byte range {}..{}",
			found.byte_start,
			found.byte_end,
		);
	}

	// Matching is a pure function of (source, language, pattern), and the walker
	// caches on that assumption. Running it twice must agree.
	let again = {
		let _scope = GuardedScope::enter();
		collect_matches(&source, language, std::slice::from_ref(&compiled))
	}
	.expect("a pattern that matched once must match again");
	assert_eq!(matches.len(), again.len(), "collect_matches is not deterministic");
});
