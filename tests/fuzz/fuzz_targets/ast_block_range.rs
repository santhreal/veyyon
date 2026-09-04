#![no_main]

//! Fuzzes the block resolver in `veyyon-ast`.
//!
//! WHAT IS UNDER TEST. `block_range_at` powers the hashline `replace block N:`
//! operator: you point at a line and it returns the line span of the construct
//! that begins there, and the editor then REPLACES those lines. So a wrong span
//! is not a wrong answer on screen, it is the wrong part of a file overwritten.
//! `enclosing_block_boundaries` is the same tree walk used to show which
//! construct a scrolled-off window belongs to.
//!
//! THE PROPERTIES, AND WHY EACH ONE IS A REAL FAILURE. A resolver that returns
//! `None` is fine, that is "no block here". What must never happen:
//!
//! - A span outside the file. `end_line` past the last line means the editor
//!   replaces up to a line that does not exist.
//! - An INVERTED span, `end_line < start_line`. That is reachable in principle:
//!   `node_content_end_line` subtracts a row when a node's end position lands at
//!   column 0, so a zero-width node at the start of a line answers one line
//!   before its own start. A caller computing `end - start` would underflow.
//! - A span that does not begin on the line you asked about. The whole contract
//!   of `replace block N` is that N is the opening line, and the walk enforces
//!   it by climbing only while the parent starts on the same row. If that ever
//!   stops holding, the operator silently edits a different construct.
//! - Boundary lines inside the visible window. `enclosing_block_boundaries`
//!   exists to name the endpoint you CANNOT see; one inside the window is noise
//!   at best and a wrong jump target at worst.

use libfuzzer_sys::fuzz_target;
use veyyon_ast::block::{
	BlockRangeOptions, EnclosingBoundaryOptions, LineRange, block_range_at,
	enclosing_block_boundaries,
};
use veyyon_fuzz::CodeLike;

/// Language aliases, passed explicitly rather than inferred from a path so the
/// fuzzer spends its budget on source shapes instead of on filename mutations.
///
/// Brace languages, an indentation language, a markup grammar, and a shell
/// grammar: the resolver's answer depends on how a grammar delimits a block, and
/// those four delimit them in four different ways.
const LANGUAGES: &[&str] = &["rust", "typescript", "python", "html", "bash", "yaml"];

/// Cap on how many visible ranges one input may carry. The boundary walk is
/// linear in the tree and the ranges are binary-searched, so this only keeps a
/// pathological input from being reported as a timeout.
const MAX_RANGES: usize = 8;

fuzz_target!(|input: (u8, CodeLike, u32, Vec<(u32, u32)>)| {
	let (selector, CodeLike(code), line, ranges) = input;
	if ranges.len() > MAX_RANGES {
		return;
	}

	let lang = LANGUAGES[usize::from(selector) % LANGUAGES.len()];
	// `str::lines` is what the resolver's own helpers count with, so the bound has
	// to be computed the same way or the assertions below would be comparing two
	// different notions of "last line".
	let total_lines = u32::try_from(code.lines().count()).unwrap_or(u32::MAX);

	let resolved = block_range_at(BlockRangeOptions {
		code: code.clone(),
		lang: Some(lang.to_string()),
		path: None,
		line,
	})
	.expect("resolving a block must not fail for well-formed options");

	if let Some(range) = resolved {
		assert!(
			range.start_line >= 1,
			"{lang}: resolved a block starting at line {} for line {line}",
			range.start_line,
		);
		assert!(
			range.end_line >= range.start_line,
			"{lang}: resolved an inverted span {}..{} for line {line}",
			range.start_line,
			range.end_line,
		);
		assert!(
			range.end_line <= total_lines,
			"{lang}: resolved {}..{} but the source has {total_lines} lines",
			range.start_line,
			range.end_line,
		);
		// The contract `replace block N` is built on: the span begins on the line
		// that was asked about. Without this, the operator edits a construct the
		// caller did not name.
		assert_eq!(
			range.start_line, line,
			"{lang}: asked for a block beginning on line {line} and got one beginning on {}",
			range.start_line,
		);
	}

	// Resolving is a pure function of its options, and the editor resolves the
	// same line more than once while a replace is being composed.
	let again = block_range_at(BlockRangeOptions {
		code: code.clone(),
		lang: Some(lang.to_string()),
		path: None,
		line,
	})
	.expect("resolving must not fail");
	assert_eq!(again, resolved, "{lang}: block_range_at is not deterministic for line {line}");

	let visible: Vec<LineRange> = ranges
		.iter()
		.map(|&(start_line, end_line)| LineRange { start_line, end_line })
		.collect();

	// The ranges the function will actually honour. `normalize_ranges` retains
	// only `start_line > 0 && end_line >= start_line`, because line 0 does not
	// exist and a reversed range describes nothing, so a boundary can legitimately
	// land inside a range that was DROPPED. The visibility assertion below has to
	// compare against this set rather than the raw input, or it reports the
	// function for honouring its own documented filter. Stated at this precision
	// rather than dropped: the property is still exactly "never name a line the
	// reader can see".
	let honoured: Vec<&LineRange> = visible
		.iter()
		.filter(|range| range.start_line > 0 && range.end_line >= range.start_line)
		.collect();

	let boundaries = enclosing_block_boundaries(EnclosingBoundaryOptions {
		code: code.clone(),
		lang: Some(lang.to_string()),
		path: None,
		ranges: visible.clone(),
	})
	.expect("collecting boundaries must not fail for well-formed options");

	let Some(boundaries) = boundaries else {
		return;
	};

	// Callers binary-search this, which is only valid on a sorted list, and they
	// render it as a set, so a duplicate would be a repeated line in the gutter.
	assert!(
		boundaries.windows(2).all(|pair| pair[0] < pair[1]),
		"{lang}: boundaries are not strictly increasing: {boundaries:?}",
	);

	for boundary in &boundaries {
		assert!(
			*boundary >= 1 && *boundary <= total_lines,
			"{lang}: boundary line {boundary} is outside a {total_lines}-line source",
		);
		// The point of the function: report the endpoint you cannot see. One inside
		// the window is a jump target that goes nowhere.
		assert!(
			!honoured
				.iter()
				.any(|range| range.start_line <= *boundary && *boundary <= range.end_line),
			"{lang}: boundary line {boundary} is inside the visible ranges {honoured:?}",
		);
	}
});
