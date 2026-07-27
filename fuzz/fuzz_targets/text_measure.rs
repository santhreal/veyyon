#![no_main]

//! Fuzzes ANSI-aware measurement and slicing in `veyyon-text`.
//!
//! WHAT IS UNDER TEST. Every row the TUI draws goes through these five
//! functions, and their input is bytes a terminal wrote: escape sequences from
//! a program the agent ran, wide graphemes, joiners, and whatever a corrupted
//! stream left behind. The code is hand-written index arithmetic over UTF-16
//! with an ASCII fast path, an escape-sequence scanner, and a separate
//! grapheme-segmentation path, so the branch a given byte takes is decided
//! several times per line.
//!
//! THE PROPERTY THAT MATTERS MOST IS NOT "IT DID NOT PANIC". It is that the
//! width each function REPORTS is the width the text it returned actually has.
//! `slice_with_width` and `extract_segments` accumulate a running total while
//! they copy, rather than measuring the result, so a branch that copies a
//! grapheme without adding its width (or adds it without copying) hands the
//! caller a number that disagrees with the string beside it. Nothing downstream
//! notices: the layout reserves the wrong number of cells and the row is drawn
//! one column off, or a background fill stops short. Re-measuring the output
//! with `visible_width` is the only way that class of bug is visible at all.
//!
//! THE SECOND PROPERTY IS THE TRUNCATION BOUND, which is what callers actually
//! rely on. `truncate_to_width` promises a result that fits in `max_width`, and
//! promises exactly `max_width` when padding was asked for, because the caller
//! then writes it into a fixed-width column without checking. An off-by-one
//! there is a wrapped line or a smeared row rather than a crash.
//!
//! The `None` answer is checked too. It means "the input already fits", so the
//! N-API wrapper hands the caller's original string straight back; if it were
//! ever returned for input that does NOT fit, the untouched over-long string
//! would go to the terminal and nothing in the process would have measured it.

use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::AnsiLike;
use veyyon_text::{Ellipsis, extract_segments, slice_with_width, truncate_to_width, visible_width, wrap_text_with_ansi};

/// Cell width the host reports for Hangul compatibility jamo. Fixed rather than
/// fuzzed: it is process-global state, and a fuzzer flipping it between
/// executions would make every failure depend on the order inputs happened to
/// run in, which is the one thing a crash artifact must not do.
const TAB_WIDTH: u32 = 8;

/// Bound on the widths tried, so an execution stays inside libFuzzer's budget.
/// Small values are the interesting ones anyway: they are where an ellipsis
/// stops fitting and where a two-cell grapheme cannot be placed at all.
const MAX_DIMENSION: u32 = 40;

fuzz_target!(|input: (AnsiLike, u8, u8, u8, bool, bool)| {
	let (AnsiLike(text), width, start, length, pad, strict) = input;
	let utf16: Vec<u16> = text.encode_utf16().collect();

	let width = u32::from(width) % MAX_DIMENSION;
	let start = usize::from(start) % MAX_DIMENSION as usize;
	let length = usize::from(length) % MAX_DIMENSION as usize;

	// Measurement is a pure function of the bytes, and the renderer calls it
	// repeatedly on the same row while laying a frame out.
	let measured = visible_width(&utf16, TAB_WIDTH);
	assert_eq!(visible_width(&utf16, TAB_WIDTH), measured, "visible_width is not deterministic for {text:?}");

	// ---- wrapping ----------------------------------------------------------

	let wrapped = wrap_text_with_ansi(&utf16, width as usize, TAB_WIDTH);

	// Wrapping always produces a row. An empty vector would be rendered as no
	// line at all, which silently drops the content rather than showing it
	// badly.
	assert!(!wrapped.is_empty(), "wrapping {text:?} to width {width} produced no lines");

	for line in &wrapped {
		// A row may exceed the target only when a single grapheme cannot fit in
		// it, which is the documented behaviour for a two-cell character at
		// width one. Anything else means the break decision and the width
		// accounting disagree.
		let line_width = visible_width(line, TAB_WIDTH);
		if line_width > width as usize {
			let graphemes = wrap_text_with_ansi(line, 1, TAB_WIDTH);
			assert_eq!(
				graphemes.len(),
				1,
				"wrapping {text:?} to width {width} emitted a {line_width}-cell row that is not a \
				 single oversized grapheme: {:?} splits into {:?}",
				String::from_utf16_lossy(line),
				graphemes.iter().map(|g| String::from_utf16_lossy(g)).collect::<Vec<_>>(),
			);
		}
	}

	// ---- truncation --------------------------------------------------------

	for ellipsis in [Ellipsis::Unicode, Ellipsis::Ascii, Ellipsis::Omit] {
		let truncated = truncate_to_width(&utf16, width as usize, ellipsis, pad, TAB_WIDTH);

		let effective_width = match &truncated {
			Some(out) => visible_width(out, TAB_WIDTH),
			// `None` claims the input needs no rewriting, so the input is what the
			// caller renders and the input is what has to be measured here.
			None => measured,
		};

		assert!(
			effective_width <= width as usize,
			"truncating {text:?} to width {width} yielded {effective_width} cells \
			 (ellipsis {ellipsis:?}, pad {pad}); input measures {measured}, output is {:?}",
			truncated.as_ref().map(|out| String::from_utf16_lossy(out)),
		);

		// Padding exists so the caller can write the result into a fixed-width
		// column without measuring it, so a short result is as wrong as a long one.
		if pad && width > 0 {
			assert_eq!(
				effective_width, width as usize,
				"padding {text:?} to width {width} yielded {effective_width} cells \
				 (ellipsis {ellipsis:?})",
			);
		}
	}

	// ---- column slicing ----------------------------------------------------

	let sliced = slice_with_width(&utf16, start, length, strict, TAB_WIDTH);

	// The reported width is accumulated while copying rather than measured
	// afterwards, so it is checked against the text it was reported with.
	assert_eq!(
		sliced.width,
		visible_width(&sliced.text, TAB_WIDTH),
		"slicing {text:?} at {start}..+{length} (strict {strict}) reported {} cells for a slice \
		 that measures differently",
		sliced.width,
	);

	// Strict slicing promises never to overrun the requested span; that is the
	// whole difference between the two modes, and the caller picks strict
	// precisely when it has no room to spare.
	if strict {
		assert!(
			sliced.width <= length,
			"strict slicing {text:?} at {start}..+{length} returned {} cells",
			sliced.width,
		);
	}

	// ---- overlay segments --------------------------------------------------

	let segments = extract_segments(&utf16, start, start.saturating_add(length), length, strict, TAB_WIDTH);

	assert_eq!(
		segments.before_width,
		visible_width(&segments.before, TAB_WIDTH),
		"extracting from {text:?} reported a before-width of {} for a segment that measures \
		 differently",
		segments.before_width,
	);
	assert_eq!(
		segments.after_width,
		visible_width(&segments.after, TAB_WIDTH),
		"extracting from {text:?} reported an after-width of {} for a segment that measures \
		 differently",
		segments.after_width,
	);

	// The before segment stops at the overlay, which is what reserves the cells
	// the overlay is then drawn into. A longer one is drawn over.
	assert!(
		segments.before_width <= start,
		"extracting from {text:?} produced a before segment of {} cells for an overlay starting \
		 at column {start}",
		segments.before_width,
	);
});
