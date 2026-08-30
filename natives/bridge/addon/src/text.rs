//! N-API surface for ANSI-aware text measurement and slicing.
//!
//! # Overview
//! Measures visible width, wraps, truncates, slices by column, and extracts the
//! segments around an overlay, all while stepping over ANSI escape sequences.
//!
//! # Example
//! ```ignore
//! // JS: native.visibleWidth("\x1b[31mred\x1b[0m", 8) -> 3
//! // JS: native.truncateToWidth("hello world", 8, Ellipsis.Unicode, false, 8) -> "hello w…"
//! ```
//!
//! WHAT IS AND IS NOT HERE. The engine lives in `veyyon-text`, an ordinary
//! `rlib` this file wraps. Only the JS boundary is here: the `#[napi]` types,
//! the UTF-16 conversion in both directions, and the `usize` to `u32` clamp.
//!
//! It was split because this crate is `crate-type = ["cdylib"]` and its
//! functions are `#[napi]` entry points, so nothing could link the engine: not
//! a benchmark, not a fuzz target. Eighteen hundred lines of index arithmetic
//! over bytes a terminal wrote had coverage only through JavaScript, which is
//! the exact shape that wants a fuzzer pointed at it.
//! `fuzz/fuzz_targets/text_measure.rs` now drives `veyyon-text` directly.
//!
//! KEEP THIS FILE THIN. Anything that decides how wide a grapheme is or where a
//! line breaks belongs in `veyyon-text`, where it can be tested and fuzzed.
//! Logic added here is logic no fuzzer can reach.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

/// Ellipsis strategy for [`truncate_to_width`].
#[napi]
pub enum Ellipsis {
	/// Use a single Unicode ellipsis character ("…").
	Unicode = 0,
	/// Use three ASCII dots ("...").
	Ascii   = 1,
	/// Omit ellipsis entirely.
	Omit    = 2,
}

impl From<Ellipsis> for veyyon_text::Ellipsis {
	fn from(value: Ellipsis) -> Self {
		match value {
			Ellipsis::Unicode => Self::Unicode,
			Ellipsis::Ascii => Self::Ascii,
			Ellipsis::Omit => Self::Omit,
		}
	}
}

/// Wrap a UTF-16 buffer back into the shape napi hands to JavaScript.
///
/// napi builds the JS string from the whole vector with an explicit length, so
/// whatever is in it is content. That makes this the mirror of the terminator
/// strip `veyyon_text` performs on the way in: trim the NUL, never add one.
///
/// This once read `data.push(0)`, on the belief that `Utf16String` wanted a
/// NUL-terminated buffer. It does not, and the appended terminator reached
/// JavaScript as a character on every string the text layer returned. See
/// [`veyyon_text::utf16_content_len`], which owns the rule for both directions.
fn build_utf16_string(mut data: Vec<u16>) -> Utf16String {
	data.truncate(veyyon_text::utf16_content_len(&data));
	Utf16String::from(data)
}

/// Visible slice of a line after ANSI-aware column selection
/// (`sliceWithWidth`).
#[napi(object)]
pub struct SliceResult {
	/// UTF-16 slice containing the selected text.
	pub text:  Utf16String,
	/// Visible width of the slice in terminal cells.
	pub width: u32,
}

/// Before/after segments around an overlay region (`extractSegments`).
#[napi(object)]
pub struct ExtractSegmentsResult {
	/// UTF-16 content before the overlay region.
	pub before:       Utf16String,
	/// Visible width of the `before` segment.
	pub before_width: u32,
	/// UTF-16 content after the overlay region.
	pub after:        Utf16String,
	/// Visible width of the `after` segment.
	pub after_width:  u32,
}

/// Override the cell width reported for Hangul compatibility jamo.
///
/// Terminals disagree about these, so the host measures one and tells us.
#[napi]
pub fn set_hangul_compat_jamo_width_override(value: u8) {
	veyyon_text::set_hangul_compat_jamo_width_override(value);
}

/// Wrap text to a visible width, preserving ANSI escape codes across line
/// breaks.
///
/// Returns UTF-16 lines with active SGR codes carried across line boundaries.
#[napi]
pub fn wrap_text_with_ansi(text: JsString, width: u32, tab_width: u32) -> Result<Vec<Utf16String>> {
	let text_u16 = text.into_utf16()?;
	let lines = veyyon_text::wrap_text_with_ansi(text_u16.as_slice(), width as usize, tab_width);
	Ok(lines.into_iter().map(build_utf16_string).collect())
}

/// Truncate text to a visible width, preserving ANSI codes.
///
/// Pads with spaces when requested.
#[napi]
pub fn truncate_to_width(
	text: JsString<'_>,
	max_width: u32,
	ellipsis_kind: Option<Ellipsis>,
	pad: Option<bool>,
	tab_width: u32,
) -> Result<Either<JsString<'_>, Utf16String>> {
	// Keep the original handle so an unchanged line can be returned without
	// allocating.
	let original = text;
	let text_u16 = text.into_utf16()?;

	let truncated = veyyon_text::truncate_to_width(
		text_u16.as_slice(),
		max_width as usize,
		ellipsis_kind.unwrap_or(Ellipsis::Unicode).into(),
		pad.unwrap_or(false),
		tab_width,
	);

	// `None` means the input already fits, so the caller's own string is the
	// answer: zero output allocation on the common path, which is every row of the
	// screen that did not need cutting.
	Ok(match truncated {
		Some(out) => Either::B(build_utf16_string(out)),
		None => Either::A(original),
	})
}

/// Slice a range of visible columns from a line.
///
/// Counts terminal cells, skipping ANSI escapes, and optionally enforces strict
/// width.
#[napi]
pub fn slice_with_width(
	line: JsString,
	start_col: u32,
	length: u32,
	strict: Option<bool>,
	tab_width: u32,
) -> Result<SliceResult> {
	let line_u16 = line.into_utf16()?;
	let sliced = veyyon_text::slice_with_width(
		line_u16.as_slice(),
		start_col as usize,
		length as usize,
		strict.unwrap_or(false),
		tab_width,
	);

	Ok(SliceResult {
		text:  build_utf16_string(sliced.text),
		width: crate::utils::clamp_u32(sliced.width as u64),
	})
}

/// Extract the before/after slices around an overlay region.
///
/// Preserves ANSI state so the `after` segment renders correctly after
/// truncation.
#[napi]
pub fn extract_segments(
	line: JsString,
	before_end: u32,
	after_start: u32,
	after_len: u32,
	strict_after: bool,
	tab_width: u32,
) -> Result<ExtractSegmentsResult> {
	let line_u16 = line.into_utf16()?;
	let segments = veyyon_text::extract_segments(
		line_u16.as_slice(),
		before_end as usize,
		after_start as usize,
		after_len as usize,
		strict_after,
		tab_width,
	);

	Ok(ExtractSegmentsResult {
		before:       build_utf16_string(segments.before),
		before_width: crate::utils::clamp_u32(segments.before_width as u64),
		after:        build_utf16_string(segments.after),
		after_width:  crate::utils::clamp_u32(segments.after_width as u64),
	})
}

/// Calculate visible width of text, excluding ANSI escape sequences.
///
/// Tabs count as a fixed-width cell.
#[napi]
pub fn visible_width(text: JsString, tab_width: u32) -> Result<u32> {
	let text_u16 = text.into_utf16()?;
	Ok(crate::utils::clamp_u32(veyyon_text::visible_width(text_u16.as_slice(), tab_width) as u64))
}
