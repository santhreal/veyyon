//! The last source this thread parsed keeps its syntax tree.
//!
//! A bounded range read parses the whole file to answer a twenty-line window,
//! and that parse is the whole cost of the call: 222ms of a 224ms
//! `enclosing_block_boundaries` on a 3.5MB source. Reading a second window of
//! the same file, or resolving a block in a file just read, paid it again.
//!
//! One entry per thread, matched on the exact bytes.
//!
//! - Per thread, because the callers are synchronous napi entry points: the
//!   thread that asks is the thread that would wait, so a shared slot would add
//!   a lock and cross-thread invalidation to buy nothing. A worker keeps its
//!   own entry and its own ceiling.
//! - Exact bytes, because a hash answers wrongly on a collision. A `memcmp` of
//!   the source costs 0.2ms against a 222ms parse, so the cache compares what
//!   it holds rather than a digest of it.
//! - One entry, because the access pattern is windows of the file in hand. A
//!   source above [`MAX_CACHED_BYTES`] is parsed and dropped, and dropping it
//!   also clears the slot, so a large file cannot be resident after the call
//!   that read it.

use std::cell::RefCell;

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use tree_sitter::{Parser, Tree};

use crate::SupportLang;

/// A source larger than this is parsed without being retained. Its tree is
/// several times its size and the slot lives as long as the thread, so past
/// this point the win from a repeat read stops paying for the residency.
const MAX_CACHED_BYTES: usize = 4 * 1024 * 1024;

struct Cached {
	lang: SupportLang,
	code: String,
	tree: Tree,
}

thread_local! {
	static CACHE: RefCell<Option<Cached>> = const { RefCell::new(None) };
}

/// Hand `f` a tree for `code` in `lang`, parsing only when the retained entry
/// is not this exact source.
///
/// Returns `Ok(None)` when tree-sitter declines the source, which is the
/// caller's signal to fall back.
pub fn with_parsed_tree<T>(
	code: String,
	lang: SupportLang,
	f: impl FnOnce(&Tree, &str) -> T,
) -> Result<Option<T>> {
	CACHE.with(|cache| {
		let mut slot = cache.borrow_mut();
		if let Some(entry) = slot.as_ref()
			&& entry.lang == lang
			&& entry.code == code
		{
			return Ok(Some(f(&entry.tree, &entry.code)));
		}
		let mut parser = Parser::new();
		parser
			.set_language(&lang.get_ts_language())
			.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
		let Some(tree) = parser.parse(&code, None) else {
			return Ok(None);
		};
		if code.len() > MAX_CACHED_BYTES {
			*slot = None;
			return Ok(Some(f(&tree, &code)));
		}
		let entry = slot.insert(Cached { lang, code, tree });
		Ok(Some(f(&entry.tree, &entry.code)))
	})
}

/// Byte length of the retained source, or `None` when nothing is retained.
/// Neither the cap nor the one-entry ceiling shows up in an answer the callers
/// return, so the tests read the slot.
#[cfg(test)]
pub fn cached_source_len() -> Option<usize> {
	CACHE.with(|cache| cache.borrow().as_ref().map(|entry| entry.code.len()))
}

/// Drop the retained entry. Production has no reason to call this — the slot
/// holds one bounded source and the next miss replaces it — but a measurement
/// of what a parse costs has to start from a miss.
#[cfg(test)]
pub fn clear() {
	CACHE.with(|cache| *cache.borrow_mut() = None);
}

#[cfg(test)]
mod tests {
	// WHY: the parse was 222ms of a 224ms bracket-context call on a 3.5MB
	// source, and every window of the same file paid it again. The class this
	// closes is a cache that answers from the wrong entry: a source that
	// changed, a source read as another language, or a source held past the
	// ceiling. Each thread owns its slot, which is also why these cases can
	// assert on it — the test harness gives every test its own thread.
	//
	// What it does not catch: a grammar whose parse is not deterministic for
	// identical bytes, which would make any parse cache wrong and is not a
	// property tree-sitter leaves open.
	use super::*;
	use crate::block::{EnclosingBoundaryOptions, LineRange, enclosing_block_boundaries};

	const FN_A: &str = "function outer() {\n  const a = 1;\n  return a;\n}\n";
	const FN_B: &str = "function outer() {\n  const b = 1;\n  return b;\n}\n";
	/// `FN_A` with the closing brace pulled up to line 2, byte count unchanged.
	const FN_CLOSED_EARLY: &str = "function outer() {\n  const a = 1; }\n  outer();\n\n";

	fn boundaries(code: &str, lang: &str, window: (u32, u32)) -> Option<Vec<u32>> {
		enclosing_block_boundaries(EnclosingBoundaryOptions {
			code:   code.to_string(),
			lang:   Some(lang.to_string()),
			path:   None,
			ranges: vec![LineRange { start_line: window.0, end_line: window.1 }],
		})
		.expect("boundary resolution succeeds")
	}

	#[test]
	fn a_second_window_of_the_same_source_skips_the_parse() {
		let unit = "export function unit$N() {\n  const a = $N;\n  return a;\n}\n";
		let mut code = String::with_capacity(400_000);
		for index in 0..4_000 {
			code.push_str(&unit.replace("$N", &index.to_string()));
		}
		let lines = code.lines().count() as u32;

		clear();
		let miss_start = std::time::Instant::now();
		let first = boundaries(&code, "typescript", (lines / 2, lines / 2 + 19));
		let miss = miss_start.elapsed();

		let hit_start = std::time::Instant::now();
		let second = boundaries(&code, "typescript", (lines / 2, lines / 2 + 19));
		let hit = hit_start.elapsed();

		assert_eq!(first, second);
		assert!(first.is_some_and(|lines| !lines.is_empty()), "the window straddles a block");
		assert!(
			hit.as_secs_f64() < miss.as_secs_f64() / 4.0,
			"second window {hit:?} did not skip the parse the first paid for ({miss:?})"
		);
	}

	#[test]
	fn an_edited_source_is_parsed_again() {
		// The edit keeps the byte count and moves the closing brace, so the
		// boundary a window on line 1 surfaces changes from line 4 to line 2.
		// Length is what a cheaper key would compare, and it cannot tell these
		// two apart.
		assert_eq!(FN_A.len(), FN_CLOSED_EARLY.len());
		clear();
		assert_eq!(boundaries(FN_A, "typescript", (1, 1)), Some(vec![4]));
		assert_eq!(cached_source_len(), Some(FN_A.len()));

		assert_eq!(boundaries(FN_CLOSED_EARLY, "typescript", (1, 1)), Some(vec![2]));
		assert_eq!(cached_source_len(), Some(FN_CLOSED_EARLY.len()));

		// And a source of a different length is a miss too, not only the equal
		// one the key is chosen for.
		let shorter = "function outer() {\n  const a = 1;\n}\nafter();\n";
		assert_eq!(boundaries(shorter, "typescript", (1, 1)), Some(vec![3]));
		assert_eq!(cached_source_len(), Some(shorter.len()));
	}

	#[test]
	fn the_same_bytes_read_as_another_language_are_parsed_again() {
		clear();
		assert_eq!(boundaries(FN_A, "typescript", (1, 1)), Some(vec![4]));
		// Python cannot parse it: the answer is the fallback signal, not the
		// TypeScript tree's boundaries.
		assert_eq!(boundaries(FN_A, "python", (1, 1)), None);
		// And the language is part of the key in both directions.
		assert_eq!(boundaries(FN_A, "typescript", (1, 1)), Some(vec![4]));
	}

	#[test]
	fn a_source_above_the_cap_is_not_retained() {
		let unit = "export function unit$N() {\n  const a = $N;\n  return a;\n}\n";
		let mut code = String::with_capacity(MAX_CACHED_BYTES + unit.len() * 64);
		let mut index = 0;
		while code.len() <= MAX_CACHED_BYTES {
			code.push_str(&unit.replace("$N", &index.to_string()));
			index += 1;
		}
		clear();
		assert!(boundaries(&code, "typescript", (1, 1)).is_some());
		assert_eq!(cached_source_len(), None, "a source past the cap stayed resident");

		// The slot still works for the next source that fits.
		assert_eq!(boundaries(FN_A, "typescript", (1, 1)), Some(vec![4]));
		assert_eq!(cached_source_len(), Some(FN_A.len()));

		// And an over-cap source evicts the entry that was there rather than
		// leaving a stale one behind.
		assert!(boundaries(&code, "typescript", (1, 1)).is_some());
		assert_eq!(cached_source_len(), None);
	}

	#[test]
	fn the_slot_holds_the_last_source_only() {
		clear();
		assert_eq!(boundaries(FN_A, "typescript", (1, 1)), Some(vec![4]));
		assert_eq!(boundaries(FN_B, "typescript", (1, 1)), Some(vec![4]));
		assert_eq!(cached_source_len(), Some(FN_B.len()));
		// Coming back to the first source is a miss, not a second entry.
		assert_eq!(boundaries(FN_A, "typescript", (1, 1)), Some(vec![4]));
		assert_eq!(cached_source_len(), Some(FN_A.len()));
	}
}
