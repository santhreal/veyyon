//! The last source this thread parsed keeps its syntax tree.
//!
//! A bounded range read parses the whole file to answer a twenty-line window,
//! and that parse is the whole cost of the call: 222ms of a 224ms
//! `enclosing_block_boundaries` on a 3.5MB source. Reading a second window of
//! the same file, or resolving a block in a file just read, paid it again.
//!
//! One entry per thread, matched on the exact bytes, and reused across a single
//! edit.
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
//! - Across one edit, because the caller that asks twice is usually asking
//!   about a source that changed a little. A streamed edit preview computes the
//!   diff of the file on disk against the file the edit would produce, once per
//!   arrival of new arguments: two whole-file parses per pass, and the two
//!   sources differ by the edit being typed. Byte equality answers no to both
//!   halves, so the slot alternated and every pass paid full price. Tree-sitter
//!   reparses from an [`InputEdit`] in time proportional to the edit, and the
//!   result is the tree a fresh parse produces, so a near miss is served by
//!   editing the retained tree and reparsing against it.

use std::cell::RefCell;

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use tree_sitter::{InputEdit, Parser, Point, Tree};

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

/// One contiguous run of bytes that turns the retained source into the
/// requested one.
struct SingleEdit {
	/// First byte the two sources disagree on.
	start:   usize,
	/// One past the last byte the retained source contributes.
	old_end: usize,
	/// One past the last byte the requested source contributes.
	new_end: usize,
}

/// The edit between two sources, as a common byte prefix and a common byte
/// suffix around one changed run.
///
/// `None` means there is nothing to reuse: the sources are equal, or they share
/// neither end, in which case an incremental reparse is the work of a fresh one
/// plus the walk that finds that out.
fn single_edit(old: &str, new: &str) -> Option<SingleEdit> {
	let (old_bytes, new_bytes) = (old.as_bytes(), new.as_bytes());
	let limit = old_bytes.len().min(new_bytes.len());
	let mut start = 0;
	while start < limit && old_bytes[start] == new_bytes[start] {
		start += 1;
	}
	// The two runs may not overlap: a suffix that reaches back past `start`
	// would describe bytes the prefix already claimed.
	let mut tail = 0;
	while tail < limit - start
		&& old_bytes[old_bytes.len() - 1 - tail] == new_bytes[new_bytes.len() - 1 - tail]
	{
		tail += 1;
	}
	// A run of equal bytes can end inside a character. Widen the edit to the
	// enclosing boundaries rather than hand tree-sitter half of one.
	while start > 0 && !(old.is_char_boundary(start) && new.is_char_boundary(start)) {
		start -= 1;
	}
	let mut old_end = old_bytes.len() - tail;
	let mut new_end = new_bytes.len() - tail;
	while !(old.is_char_boundary(old_end) && new.is_char_boundary(new_end)) {
		if old_end == old_bytes.len() || new_end == new_bytes.len() {
			return None;
		}
		old_end += 1;
		new_end += 1;
	}
	if start == old_end && start == new_end {
		return None;
	}
	if start == 0 && old_end == old_bytes.len() && new_end == new_bytes.len() {
		return None;
	}
	Some(SingleEdit { start, old_end, new_end })
}

/// Row and column of a byte offset. Column is in bytes, which is what
/// tree-sitter's [`Point`] carries.
fn point_at(text: &str, byte: usize) -> Point {
	let prefix = &text.as_bytes()[..byte];
	let row = memchr::memchr_iter(b'\n', prefix).count();
	let column = match memchr::memrchr(b'\n', prefix) {
		Some(index) => byte - index - 1,
		None => byte,
	};
	Point::new(row, column)
}

/// The point `segment` bytes past `base`, so the ends of an edit cost a scan of
/// the edit rather than a second scan of the file.
fn advance(base: Point, segment: &str) -> Point {
	let bytes = segment.as_bytes();
	match memchr::memrchr(b'\n', bytes) {
		Some(last) => {
			let rows = memchr::memchr_iter(b'\n', bytes).count();
			Point::new(base.row + rows, bytes.len() - last - 1)
		},
		None => Point::new(base.row, base.column + bytes.len()),
	}
}

/// The retained tree, edited to describe `code`, when `code` is one edit away
/// from the source that produced it.
fn edited_tree(entry: &Cached, code: &str) -> Option<Tree> {
	let edit = single_edit(&entry.code, code)?;
	let start_position = point_at(&entry.code, edit.start);
	let mut tree = entry.tree.clone();
	tree.edit(&InputEdit {
		start_byte: edit.start,
		old_end_byte: edit.old_end,
		new_end_byte: edit.new_end,
		start_position,
		old_end_position: advance(start_position, &entry.code[edit.start..edit.old_end]),
		new_end_position: advance(start_position, &code[edit.start..edit.new_end]),
	});
	Some(tree)
}

/// Hand `f` a tree for `code` in `lang`, parsing only what the retained entry
/// cannot answer: nothing when it holds this exact source, the edit between
/// them when it holds one edit away, the whole source otherwise.
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
		let reusable = match slot.as_ref() {
			Some(entry) if entry.lang == lang && entry.code == code => {
				return Ok(Some(f(&entry.tree, &entry.code)));
			},
			Some(entry) if entry.lang == lang => edited_tree(entry, &code),
			_ => None,
		};
		let mut parser = Parser::new();
		parser
			.set_language(&lang.get_ts_language())
			.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
		let Some(tree) = parser.parse(&code, reusable.as_ref()) else {
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

		// An edited source is where the language matters most: the reuse path
		// hands the parser a tree to build on, and a tree another grammar
		// produced describes nodes this one does not have.
		let javascript = "function outer() {\n  const a = 1;\n  return a;\n}\nouter();\n";
		let edited = "function outer() {\n  const a = 1;\n  return a + 1;\n}\nouter();\n";
		clear();
		let fresh = boundaries(edited, "python", (2, 2));
		clear();
		assert!(boundaries(javascript, "javascript", (2, 2)).is_some());
		assert_eq!(boundaries(edited, "python", (2, 2)), fresh);
		clear();
		let fresh_typescript = boundaries(edited, "typescript", (2, 2));
		clear();
		assert!(boundaries(javascript, "javascript", (2, 2)).is_some());
		assert_eq!(boundaries(edited, "typescript", (2, 2)), fresh_typescript);
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

	/// The edit shapes a caller produces: a replacement in place, an insertion,
	/// a deletion, a change at either end, a multi-line change, and a change in
	/// a source whose bytes are not all one per character.
	fn edit_shapes(source: &str) -> Vec<(&'static str, String)> {
		let mid = source.len() / 2;
		let mid = (mid..source.len())
			.find(|index| source.is_char_boundary(*index))
			.unwrap_or(source.len());
		vec![
			("replaced in place", source.replacen("const", "const/**/", 1)),
			(
				"line inserted in the middle",
				format!("{}\n// inserted\n{}", &source[..mid], &source[mid..]),
			),
			("line deleted", source.lines().skip(1).collect::<Vec<_>>().join("\n")),
			("prepended", format!("// leading\n{source}")),
			("appended", format!("{source}\n// trailing\n")),
			(
				"multi-line block inserted",
				format!("{}\nfunction added() {{\n  return 1;\n}}\n{}", &source[..mid], &source[mid..]),
			),
			("non-ascii inserted", format!("{}// ✂ プレビュー\n{}", &source[..mid], &source[mid..])),
			("truncated to nothing", String::new()),
			("replaced wholesale", "let unrelated = 1;\n".to_string()),
		]
	}

	#[test]
	fn an_edit_of_the_retained_source_answers_what_a_fresh_parse_answers() {
		// WHY: the reuse path hands tree-sitter an InputEdit built from a byte
		// prefix and suffix. Every field of it can be wrong in a way that still
		// parses, so each shape is compared against the answer the same source
		// gets from an empty slot.
		let unit = "export function unit$N() {\n  const a = $N;\n  return a;\n}\n";
		let mut source = String::new();
		for index in 0..40 {
			source.push_str(&unit.replace("$N", &index.to_string()));
		}

		for (label, edited) in edit_shapes(&source) {
			let lines = edited.lines().count().max(1) as u32;
			for window in [(1, 1), (lines / 2, lines / 2 + 2), (lines, lines)] {
				clear();
				let fresh = boundaries(&edited, "typescript", window);

				clear();
				assert!(boundaries(&source, "typescript", window).is_some() || source.is_empty());
				let reused = boundaries(&edited, "typescript", window);
				assert_eq!(reused, fresh, "{label} at {window:?} disagreed with a fresh parse");
			}
		}
	}

	#[test]
	fn the_two_sides_of_a_streamed_preview_alternate_without_losing_the_answer() {
		// WHY: a preview asks about the file on disk and the file the edit would
		// produce, in that order, once per arrival of arguments. With one slot
		// every question is a near miss of the previous one, so the reuse path
		// runs on every call and a stale tree would surface here first.
		let unit = "export function unit$N() {\n  const a = $N;\n  return a;\n}\n";
		let mut disk = String::new();
		for index in 0..40 {
			disk.push_str(&unit.replace("$N", &index.to_string()));
		}
		let window = (2, 2);
		clear();
		let disk_fresh = boundaries(&disk, "typescript", window);

		for typed in
			["  const a = 0", "  const a = 0 + ", "  const a = 0 + 1;", "  const a = 0 + 1; //"]
		{
			let pending = disk.replacen("  const a = 0;", typed, 1);
			clear();
			let pending_fresh = boundaries(&pending, "typescript", window);

			clear();
			assert_eq!(boundaries(&disk, "typescript", window), disk_fresh);
			assert_eq!(boundaries(&pending, "typescript", window), pending_fresh, "pending `{typed}`");
			assert_eq!(
				boundaries(&disk, "typescript", window),
				disk_fresh,
				"back to disk after `{typed}`"
			);
		}
	}

	#[test]
	fn an_edit_costs_the_edit_and_not_the_file() {
		let unit = "export function unit$N() {\n  const a = $N;\n  return a;\n}\n";
		let mut source = String::with_capacity(400_000);
		for index in 0..4_000 {
			source.push_str(&unit.replace("$N", &index.to_string()));
		}
		let lines = source.lines().count() as u32;
		let window = (lines - 2, lines);
		let edited = format!("{source}\nexport const tail = 1;\n");

		clear();
		let fresh_start = std::time::Instant::now();
		let fresh = boundaries(&edited, "typescript", window);
		let fresh_cost = fresh_start.elapsed();

		clear();
		boundaries(&source, "typescript", window);
		let reuse_start = std::time::Instant::now();
		let reused = boundaries(&edited, "typescript", window);
		let reuse_cost = reuse_start.elapsed();

		assert_eq!(reused, fresh);
		assert!(
			reuse_cost.as_secs_f64() < fresh_cost.as_secs_f64() / 4.0,
			"an edited source cost {reuse_cost:?} against a fresh parse of {fresh_cost:?}"
		);
	}

	#[test]
	fn the_edit_between_two_sources_is_the_run_between_their_common_ends() {
		let shape = |old: &str, new: &str| {
			single_edit(old, new).map(|edit| (edit.start, edit.old_end, edit.new_end))
		};
		// Equal sources have nothing to edit, and sources sharing neither end
		// are a fresh parse.
		assert_eq!(shape("abc\n", "abc\n"), None);
		assert_eq!(shape("abc\n", "xyz"), None);
		// One changed run, found from both ends.
		assert_eq!(shape("ab\ncd\n", "ab\nXcd\n"), Some((3, 3, 4)));
		assert_eq!(shape("ab\ncd\n", "ab\n"), Some((3, 6, 3)));
		assert_eq!(shape("ab\ncd\n", "Zb\ncd\n"), Some((0, 1, 1)));
		// The runs may not overlap: an insertion of bytes that already repeat
		// still reports one run inside the shorter source.
		assert_eq!(shape("aa\n", "aaa\n"), Some((2, 2, 3)));
		// A run that ends inside a character widens to the boundary rather than
		// splitting it.
		let edit = single_edit("// ✂ a\n", "// ✂ b\n").expect("one changed run");
		assert!("// ✂ a\n".is_char_boundary(edit.start));
		assert!("// ✂ a\n".is_char_boundary(edit.old_end));
		assert!("// ✂ b\n".is_char_boundary(edit.new_end));
		let widened = single_edit("// ✂\n", "// ✁\n").expect("one changed run");
		assert_eq!((widened.start, widened.old_end, widened.new_end), (3, 6, 6));
	}

	#[test]
	fn a_point_and_its_advance_agree_with_a_scan_from_the_start() {
		let text = "one\ntwo\nthree\n\nfive";
		for byte in 0..=text.len() {
			let scanned = point_at(text, byte);
			assert_eq!(advance(point_at(text, 0), &text[..byte]), scanned, "advance to byte {byte}");
		}
		assert_eq!(point_at(text, 0), Point::new(0, 0));
		assert_eq!(point_at(text, 4), Point::new(1, 0));
		assert_eq!(point_at(text, 6), Point::new(1, 2));
		assert_eq!(point_at(text, text.len()), Point::new(4, 4));
	}
}
