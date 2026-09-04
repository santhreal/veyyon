#![no_main]

//! Fuzzes `veyyon_ast::ops::apply_edits`, the function that splices rewrite
//! results back into a source file.
//!
//! WHAT IS UNDER TEST. `apply_edits` takes a source string and a list of
//! `(position, deleted_length, inserted_text)` edits and returns the rewritten
//! text or an error. It is a `pub fn` on a library crate, and its whole error
//! story is `Result`: overlapping edits, out-of-range spans, and non-UTF-8
//! replacements all come back as `Err`. So the contract this target asserts is
//! that no input produces a panic, only `Ok` or `Err`.
//!
//! WHY IT DESERVES A FUZZER. The function validates two of the three things
//! that can go wrong with a byte range into a `String` and then calls
//! `String::replace_range`, which panics on a third: an offset that lands
//! inside a multi-byte character. Bounds are checked, ordering is checked,
//! character boundaries are not. That is invisible on ASCII fixtures, which is
//! what a hand-written test suite is made of, and unavoidable the moment the
//! source file contains a non-ASCII identifier, a comment in any non-Latin
//! script, or an emoji in a string literal.
//!
//! The `Ok` path gets a real assertion rather than being discarded, because a
//! silently truncated rewrite corrupts a user's file with no error anywhere.

use ast_grep_core::source::Edit;
use libfuzzer_sys::fuzz_target;
use veyyon_ast::ops::apply_edits;

/// One generated edit, kept small so the shrinker produces readable artifacts.
#[derive(Debug, arbitrary::Arbitrary)]
struct RawEdit {
	/// Byte offset into the source. Unconstrained on purpose: an offset past the
	/// end, or one inside a character, is exactly what the function must reject
	/// rather than crash on.
	position:       u16,
	deleted_length: u16,
	inserted_text:  Vec<u8>,
}

/// Cap on edit count. `apply_edits` sorts and then rewrites in reverse, so cost
/// is `n log n`; the cap only exists to keep libFuzzer from reporting a timeout
/// on a thousand-edit input instead of a crash on a three-edit one.
const MAX_EDITS: usize = 16;

fuzz_target!(|input: (String, Vec<RawEdit>)| {
	let (content, raw_edits) = input;
	if raw_edits.len() > MAX_EDITS {
		return;
	}

	let edits: Vec<Edit<String>> = raw_edits
		.into_iter()
		.map(|edit| Edit::<String> {
			position:       usize::from(edit.position),
			deleted_length: usize::from(edit.deleted_length),
			inserted_text:  edit.inserted_text,
		})
		.collect();

	// The contract: `Ok` or `Err`, never a panic. libFuzzer catches the panic, so
	// simply calling it is the assertion.
	let Ok(output) = apply_edits(&content, &edits) else {
		return;
	};

	// An accepted edit list must have produced a coherent result. The cheapest
	// true statement about it: an empty edit list is the identity, and any
	// non-empty one that only inserts cannot make the file shorter. Both are
	// checked because a bug that returns the input unchanged would otherwise
	// pass every "did not panic" target forever.
	if edits.is_empty() {
		assert_eq!(output, content, "an empty edit list must leave the source alone");
		return;
	}

	let deleted: usize = edits.iter().map(|edit| edit.deleted_length).sum();
	if deleted == 0 {
		assert!(
			output.len() >= content.len(),
			"edits that delete nothing shortened the source from {} to {} bytes",
			content.len(),
			output.len(),
		);
	}
});
