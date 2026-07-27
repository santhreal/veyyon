//! ANSI-aware text measurement and slicing over UTF-16.
//!
//! The whole engine, with no FFI in it. It used to live inside
//! `veyyon-natives`, which is `crate-type = ["cdylib"]` and whose functions are
//! `#[napi]` entry points, so none of this was reachable from `cargo test` or
//! from a fuzz target: a two-thousand-line ANSI parser doing hand-written index
//! arithmetic over bytes a terminal wrote had coverage only through JavaScript.
//! `veyyon-natives/src/text.rs` is now the napi wrapper over this crate.
//!
//! Everything here works in UTF-16 because the caller is JavaScript.
//! - Single-pass ANSI scanning (no O(n²) `next_ansi` rescans)
//! - ASCII fast-path (no grapheme segmentation, no UTF-8 conversion)
//! - Non-ASCII uses a reused scratch String for grapheme segmentation
//! - Width checks early-exit
//! - Ellipsis decoded lazily
//! - [`truncate_to_width`] answers `None` when the input already fits, so the
//!   wrapper can hand the original JS string back without allocating

use std::{
	borrow::Cow,
	cell::RefCell,
	sync::atomic::{AtomicU8, Ordering},
};

use smallvec::{SmallVec, smallvec};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MIN_TAB_WIDTH: u32 = 1;
const MAX_TAB_WIDTH: u32 = 16;
pub const DEFAULT_TAB_WIDTH: usize = 3;
const ESC: u16 = 0x1b;

#[inline]
fn clamp_tab_width_for_ops(width: u32) -> usize {
	width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH) as usize
}

/// Ellipsis strategy for [`truncate_to_width`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ellipsis {
	/// Use a single Unicode ellipsis character ("…").
	Unicode = 0,
	/// Use three ASCII dots ("...").
	Ascii   = 1,
	/// Omit ellipsis entirely.
	Omit    = 2,
}

/// The content of a napi UTF-16 buffer, with its NUL terminator removed.
///
/// `JsString::into_utf16` hands back a buffer that ends in a NUL, and to every
/// scan in this module that NUL is content. It is a zero-width grapheme
/// arriving after the last real one, which is enough to trip a "does not fit"
/// break: wrapping the two characters "漢漢" to width 1 returned three rows,
/// the last one empty, because the terminator was pushed onto a line of its
/// own.
///
/// Call this on every buffer that comes in from JavaScript. `truncate_to_width`
/// used to strip the terminator with a loop written inline, which left one
/// entry point that knew about the NUL and four that did not, and the four were
/// the ones with the bug. `build_utf16_string` performs the mirror step on the
/// way back out, over [`utf16_content_len`], so both directions read the same
/// rule.
fn utf16_content(buffer: &[u16]) -> &[u16] {
	&buffer[..utf16_content_len(buffer)]
}

/// Length of `buffer` with any trailing NUL terminator excluded.
///
/// The one owner of "where does the content end", so that the inbound direction
/// ([`utf16_content`]) and the outbound direction (`build_utf16_string` in
/// `veyyon-natives`) cannot disagree. They did disagree: the outbound side was
/// written believing napi wanted a NUL-terminated buffer and so it APPENDED a
/// terminator, but napi passes the vector to `napi_create_string_utf16` with an
/// explicit length, so the terminator arrived in JavaScript as a character.
/// Every string the text layer returned then carried a trailing NUL, so
/// `truncateToWidth("hello world", 5, Omit)` answered six code units from a
/// five-cell budget, and wrapped rows carried a NUL a terminal cannot store,
/// which broke the renderer's viewport-fidelity oracle.
///
/// This paragraph deliberately spells the byte as "NUL". Writing it as itself
/// put two raw 0x00 bytes in this file, and `rg`/`grep` classify a file
/// containing one as BINARY and skip it, so a 2679-line source file dropped out
/// of every repo-wide text scan without a word. See
/// `veyyon-shell/tests/a_source_file_that_reads_as_binary_is_invisible.rs`.
///
/// A NUL occupies no cell in any terminal, so trimming it costs no content.
pub fn utf16_content_len(buffer: &[u16]) -> usize {
	let mut end = buffer.len();
	while end > 0 && buffer[end - 1] == 0 {
		end -= 1;
	}
	end
}

// ============================================================================
// Results
// ============================================================================

/// Visible slice of a line after ANSI-aware column selection
/// (`sliceWithWidth`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SliceResult {
	/// UTF-16 slice containing the selected text.
	pub text:  Vec<u16>,
	/// Visible width of the slice in terminal cells.
	pub width: usize,
}

/// Before/after UTF-16 segments around an overlay region, with measured widths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractSegmentsResult {
	/// UTF-16 content before the overlay region.
	pub before:       Vec<u16>,
	/// Visible width of the `before` segment.
	pub before_width: usize,
	/// UTF-16 content after the overlay region.
	pub after:        Vec<u16>,
	/// Visible width of the `after` segment.
	pub after_width:  usize,
}

// ============================================================================
// ANSI State Tracking - Zero Allocation
// ============================================================================

const ATTR_BOLD: u16 = 1 << 0;
const ATTR_DIM: u16 = 1 << 1;
const ATTR_ITALIC: u16 = 1 << 2;
const ATTR_UNDERLINE: u16 = 1 << 3;
const ATTR_BLINK: u16 = 1 << 4;
const ATTR_INVERSE: u16 = 1 << 6;
const ATTR_HIDDEN: u16 = 1 << 7;
const ATTR_STRIKE: u16 = 1 << 8;

type ColorVal = u32;
const COLOR_NONE: ColorVal = 0;

#[derive(Clone, Copy, Default)]
struct AnsiState {
	attrs: u16,
	fg:    ColorVal,
	bg:    ColorVal,
}

impl AnsiState {
	#[inline]
	const fn new() -> Self {
		Self { attrs: 0, fg: COLOR_NONE, bg: COLOR_NONE }
	}

	#[inline]
	const fn is_empty(&self) -> bool {
		self.attrs == 0 && self.fg == COLOR_NONE && self.bg == COLOR_NONE
	}

	#[inline]
	const fn reset(&mut self) {
		*self = Self::new();
	}

	fn apply_sgr_u16(&mut self, params: &[u16]) {
		if params.is_empty() {
			self.reset();
			return;
		}

		let mut i = 0;
		while i < params.len() {
			let (code, next_i) = parse_sgr_num_u16(params, i);
			i = next_i;

			match code {
				0 => self.reset(),
				1 => self.attrs |= ATTR_BOLD,
				2 => self.attrs |= ATTR_DIM,
				3 => self.attrs |= ATTR_ITALIC,
				4 => self.attrs |= ATTR_UNDERLINE,
				5 => self.attrs |= ATTR_BLINK,
				7 => self.attrs |= ATTR_INVERSE,
				8 => self.attrs |= ATTR_HIDDEN,
				9 => self.attrs |= ATTR_STRIKE,

				21 => self.attrs &= !ATTR_BOLD,
				22 => self.attrs &= !(ATTR_BOLD | ATTR_DIM),
				23 => self.attrs &= !ATTR_ITALIC,
				24 => self.attrs &= !ATTR_UNDERLINE,
				25 => self.attrs &= !ATTR_BLINK,
				27 => self.attrs &= !ATTR_INVERSE,
				28 => self.attrs &= !ATTR_HIDDEN,
				29 => self.attrs &= !ATTR_STRIKE,

				30..=37 => self.fg = (code - 29) as ColorVal,
				39 => self.fg = COLOR_NONE,
				40..=47 => self.bg = (code - 39) as ColorVal,
				49 => self.bg = COLOR_NONE,
				90..=97 => self.fg = (code - 81) as ColorVal,
				100..=107 => self.bg = (code - 91) as ColorVal,

				38 | 48 => {
					let (mode, ni) = parse_sgr_num_u16(params, i);
					i = ni;

					let color = match mode {
						5 => {
							let (idx, ni) = parse_sgr_num_u16(params, i);
							i = ni;
							0x100 | (idx as ColorVal & 0xff)
						},
						2 => {
							let (r, ni) = parse_sgr_num_u16(params, i);
							let (g, ni) = parse_sgr_num_u16(params, ni);
							let (b, ni) = parse_sgr_num_u16(params, ni);
							i = ni;
							0x1000000
								| ((r as ColorVal & 0xff) << 16)
								| ((g as ColorVal & 0xff) << 8)
								| (b as ColorVal & 0xff)
						},
						_ => continue,
					};

					if code == 38 {
						self.fg = color;
					} else {
						self.bg = color;
					}
				},

				_ => {},
			}
		}
	}

	fn write_restore_u16(&self, out: &mut Vec<u16>) {
		if self.is_empty() {
			return;
		}

		out.extend_from_slice(&[ESC, b'[' as u16]);
		let mut first = true;

		macro_rules! push_code {
			($code:expr) => {{
				if !first {
					out.push(b';' as u16);
				}
				first = false;
				write_u32_u16(out, $code);
			}};
		}

		if self.attrs & ATTR_BOLD != 0 {
			push_code!(1);
		}
		if self.attrs & ATTR_DIM != 0 {
			push_code!(2);
		}
		if self.attrs & ATTR_ITALIC != 0 {
			push_code!(3);
		}
		if self.attrs & ATTR_UNDERLINE != 0 {
			push_code!(4);
		}
		if self.attrs & ATTR_BLINK != 0 {
			push_code!(5);
		}
		if self.attrs & ATTR_INVERSE != 0 {
			push_code!(7);
		}
		if self.attrs & ATTR_HIDDEN != 0 {
			push_code!(8);
		}
		if self.attrs & ATTR_STRIKE != 0 {
			push_code!(9);
		}

		write_color_u16(out, self.fg, 38, &mut first);
		write_color_u16(out, self.bg, 48, &mut first);

		out.push(b'm' as u16);
	}
}

#[inline]
fn write_color_u16(out: &mut Vec<u16>, color: ColorVal, base: u32, first: &mut bool) {
	if color == COLOR_NONE {
		return;
	}

	if !*first {
		out.push(b';' as u16);
	}
	*first = false;

	if color < 0x100 {
		let code = if color <= 8 { color + 29 } else { color + 81 };
		let code = if base == 48 { code + 10 } else { code };
		write_u32_u16(out, code);
	} else if color < 0x1000000 {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'5' as u16, b';' as u16]);
		write_u32_u16(out, color & 0xff);
	} else {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'2' as u16, b';' as u16]);
		write_u32_u16(out, (color >> 16) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, (color >> 8) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, color & 0xff);
	}
}

#[inline]
fn parse_sgr_num_u16(params: &[u16], mut i: usize) -> (u32, usize) {
	while i < params.len() && params[i] == b';' as u16 {
		i += 1;
	}

	let mut val: u32 = 0;
	while i < params.len() {
		let b = params[i];
		if b == b';' as u16 {
			i += 1;
			break;
		}
		if (b'0' as u16..=b'9' as u16).contains(&b) {
			val = val
				.saturating_mul(10)
				.saturating_add((b - b'0' as u16) as u32);
		}
		i += 1;
	}
	(val, i)
}

#[inline]
fn write_u32_u16(out: &mut Vec<u16>, mut val: u32) {
	if val == 0 {
		out.push(b'0' as u16);
		return;
	}
	let start = out.len();
	while val > 0 {
		out.push(b'0' as u16 + (val % 10) as u16);
		val /= 10;
	}
	out[start..].reverse();
}

// ============================================================================
// ANSI Sequence Detection - UTF-16
// ============================================================================

/// The length of the escape sequence beginning at `pos`, or `None` if none
/// does.
///
/// THE INVARIANT THAT MATTERS: what this answers for the ESC at `pos` depends
/// only on the bytes of the sequence ITSELF, not on unrelated bytes further
/// along the line. Every branch below therefore walks the grammar ECMA-48
/// defines and STOPS at the first byte the grammar does not allow, rather
/// than scanning ahead for something that looks like a terminator.
///
/// It used to scan ahead. A CSI searched the whole rest of the buffer for any
/// byte in `0x40..=0x7e` and claimed everything up to it, so a stray `ESC [` in
/// a program's output made every character up to the next punctuation mark
/// measure as zero width and render as nothing. It also made the answer depend
/// on bytes that a truncation or a slice might remove, which is how the same
/// text measured one way while being cut and another way afterwards:
/// `fuzz/fuzz_targets/text_measure.rs` produced a wrapped row of `ESC [ 9 m`,
/// `ESC SP`, `ESC [ 2 9 m` that was built as zero cells and measured as three,
/// because `ESC SP` was a complete sequence in the source line (a `9` followed
/// somewhere later) and an unclassifiable one in the row.
///
/// The grammars, in the order they are matched:
/// - `ESC [` CSI: parameter bytes `0x30..=0x3f`, then intermediates
///   `0x20..=0x2f`, then one final byte `0x40..=0x7e`. Anything else aborts the
///   sequence.
/// - `ESC ]` OSC and `ESC P`/`X`/`^`/`_` string sequences: a string terminated
///   by ST (`ESC \`) or, as terminals also accept and the TUI's own cursor
///   marker relies on, BEL. A bare ESC that is not the start of ST cancels,
///   which is what a terminal does with one.
/// - `ESC` plus an intermediate `0x20..=0x2f`: further intermediates, then one
///   final `0x30..=0x7e`.
/// - `ESC` plus a single byte `0x40..=0x7e`: a two-byte sequence, complete on
///   its own.
#[inline]
fn ansi_seq_len_u16(data: &[u16], pos: usize) -> Option<usize> {
	if pos >= data.len() || data[pos] != ESC {
		return None;
	}

	match *data.get(pos + 1)? {
		0x5b => {
			// '[' CSI: parameters, then intermediates, then exactly one final byte.
			let mut i = pos + 2;
			while matches!(data.get(i), Some(0x30..=0x3f)) {
				i += 1;
			}
			while matches!(data.get(i), Some(0x20..=0x2f)) {
				i += 1;
			}
			matches!(data.get(i), Some(0x40..=0x7e)).then(|| i - pos + 1)
		},
		// ']' OSC, 'P' DCS, 'X' SOS, '^' PM, '_' APC: a string closed by ST or BEL.
		0x50 | 0x58 | 0x5d | 0x5e | 0x5f => string_sequence_len_u16(data, pos),
		0x20..=0x2f => {
			// ESC + intermediates + one final byte.
			let mut i = pos + 2;
			while matches!(data.get(i), Some(0x20..=0x2f)) {
				i += 1;
			}
			matches!(data.get(i), Some(0x30..=0x7e)).then(|| i - pos + 1)
		},
		0x40..=0x7e => Some(2),
		_ => None,
	}
}

/// The length of an OSC or other string sequence starting at `pos`, terminator
/// included.
///
/// Split out because five introducers share it and a second copy would be a
/// second answer to "where does this string end". A bare ESC that is not the
/// start of ST cancels the string rather than being absorbed into it, so an
/// escape cut mid-write cannot swallow the sequence that follows it.
fn string_sequence_len_u16(data: &[u16], pos: usize) -> Option<usize> {
	let mut i = pos + 2;
	while i < data.len() {
		match data[i] {
			0x07 => return Some(i - pos + 1),
			ESC if data.get(i + 1) == Some(&0x5c) => return Some(i - pos + 2),
			ESC => return None,
			_ => i += 1,
		}
	}
	None
}

#[inline]
fn is_sgr_u16(seq: &[u16]) -> bool {
	seq.len() >= 3 && seq[1] == b'[' as u16 && *seq.last().unwrap() == b'm' as u16
}

struct Osc66Info<'a> {
	payload: &'a [u16],
	scale:   usize,
	width:   usize,
}

#[inline]
fn parse_ascii_usize_u16(data: &[u16]) -> Option<usize> {
	if data.is_empty() {
		return None;
	}

	let mut value = 0usize;
	for &u in data {
		if !(b'0' as u16..=b'9' as u16).contains(&u) {
			return None;
		}
		value = value
			.saturating_mul(10)
			.saturating_add((u - b'0' as u16) as usize);
	}
	Some(value)
}

#[inline]
fn osc66_meta_payload_u16(seq: &[u16]) -> Option<(&[u16], &[u16])> {
	if seq.len() < 7
		|| seq[0] != ESC
		|| seq[1] != b']' as u16
		|| seq[2] != b'6' as u16
		|| seq[3] != b'6' as u16
		|| seq[4] != b';' as u16
	{
		return None;
	}

	let payload_end = if *seq.last()? == 0x07 {
		seq.len() - 1
	} else if seq.len() >= 8 && seq[seq.len() - 2] == ESC && seq[seq.len() - 1] == b'\\' as u16 {
		seq.len() - 2
	} else {
		return None;
	};

	let mut sep = 5usize;
	while sep < payload_end {
		if seq[sep] == b';' as u16 {
			return Some((&seq[5..sep], &seq[sep + 1..payload_end]));
		}
		sep += 1;
	}

	None
}

#[inline]
fn parse_osc66_meta_u16(meta: &[u16]) -> (usize, Option<usize>) {
	let mut scale = 1usize;
	let mut explicit_width = None;
	let mut part_start = 0usize;
	let mut i = 0usize;

	while i <= meta.len() {
		if i == meta.len() || meta[i] == b':' as u16 {
			let part = &meta[part_start..i];
			if let Some(eq) = part.iter().position(|&u| u == b'=' as u16) {
				let key = &part[..eq];
				let value = &part[eq + 1..];
				if key.len() == 1 {
					match key[0] {
						0x73 => {
							if let Some(parsed) = parse_ascii_usize_u16(value)
								&& (1..=7).contains(&parsed)
							{
								scale = parsed;
							}
						},
						0x77 => {
							if let Some(parsed) = parse_ascii_usize_u16(value) {
								explicit_width = Some(parsed);
							}
						},
						_ => {},
					}
				}
			}
			part_start = i + 1;
		}
		i += 1;
	}

	(scale, explicit_width.filter(|&width| width > 0))
}

#[inline]
fn osc66_info_u16(seq: &[u16], tab_width: usize) -> Option<Osc66Info<'_>> {
	let (meta, payload) = osc66_meta_payload_u16(seq)?;
	let (scale, explicit_width) = parse_osc66_meta_u16(meta);
	let base_width = explicit_width.unwrap_or_else(|| visible_width_u16(payload, tab_width));
	Some(Osc66Info { payload, scale, width: scale.saturating_mul(base_width) })
}

#[inline]
fn osc66_visible_width_u16(seq: &[u16], tab_width: usize) -> Option<usize> {
	Some(osc66_info_u16(seq, tab_width)?.width)
}

#[inline]
const fn div_ceil_usize(n: usize, d: usize) -> usize {
	if n == 0 { 0 } else { 1 + (n - 1) / d }
}

#[inline]
const fn osc66_payload_range(
	visual_start: usize,
	visual_len: usize,
	scale: usize,
	strict: bool,
) -> (usize, usize) {
	let visual_end = visual_start.saturating_add(visual_len);
	let payload_start = if strict {
		div_ceil_usize(visual_start, scale)
	} else {
		visual_start / scale
	};
	let payload_end = if strict {
		visual_end / scale
	} else {
		div_ceil_usize(visual_end, scale)
	};
	(payload_start, payload_end.saturating_sub(payload_start))
}

#[inline]
const fn is_ascii_grapheme_extender_u16(u: u16) -> bool {
	matches!(
		u,
		0x0300..=0x036f
			| 0x1ab0..=0x1aff
			| 0x1dc0..=0x1dff
			| 0x200d
			| 0x20d0..=0x20ff
			| 0xfe00..=0xfe0f
	)
}

// ============================================================================
// Grapheme / Width
// ============================================================================

#[inline]
const fn ascii_cell_width_u16(u: u16, tab_width: usize) -> usize {
	let b = u as u8;
	match b {
		b'\t' => tab_width,
		0x20..=0x7e => 1,
		_ => 0,
	}
}

const HANGUL_COMPAT_JAMO_NARROW_WIDTH: usize = 1;

/// Runtime override for Hangul Compatibility Jamo (U+3131..=U+318E) cell width.
///   0 = unset → platform default (macOS: narrow 1 cell; otherwise UAX#11)
///   1 = force narrow (1 cell)
///   2 = force wide (2 cells)
///   3 = force Unicode width (no correction)
/// The actual width is decided by the *client* terminal, not the host OS, so it
/// is resolved at runtime from the terminal identity (see packages/tui
/// terminal.ts) and pushed here through
/// `set_hangul_compat_jamo_width_override`.
static HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE: AtomicU8 = AtomicU8::new(0);

pub fn set_hangul_compat_jamo_width_override(value: u8) {
	HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE.store(value, Ordering::Relaxed);
}

#[inline]
const fn is_hangul_compat_jamo(c: char) -> bool {
	let cp = c as u32;
	cp >= 0x3131 && cp <= 0x318e
}

/// Effective target cell width for Compatibility Jamo, or `None` to follow the
/// Unicode width (no correction). Reads the runtime override, falling back to
/// the compile-time platform default when unset.
#[inline]
fn hangul_compat_jamo_target_width() -> Option<usize> {
	match HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE.load(Ordering::Relaxed) {
		1 => Some(1),
		2 => Some(2),
		3 => None,
		_ => {
			if cfg!(target_os = "macos") {
				Some(HANGUL_COMPAT_JAMO_NARROW_WIDTH)
			} else {
				None
			}
		},
	}
}

#[inline]
fn apply_hangul_compat_jamo_delta(width: usize, c: char) -> usize {
	if !is_hangul_compat_jamo(c) {
		return width;
	}
	let Some(target) = hangul_compat_jamo_target_width() else {
		return width;
	};
	let unicode_width = UnicodeWidthChar::width(c).unwrap_or(0);
	// The zero-width filler (U+3164 HANGUL FILLER) is an invisible placeholder.
	// The target is set for *visible* jamo, so only the narrow correction
	// (target 1) applies to the filler; a wide terminal renders it at its
	// Unicode width (0), not the wide target. Never widen a
	// zero-width jamo past the narrow correction.
	if unicode_width == 0 && target > 1 {
		return width;
	}
	if unicode_width > target {
		width.saturating_sub(unicode_width - target)
	} else {
		width.saturating_add(target - unicode_width)
	}
}

#[inline]
fn char_width_corrected(c: char) -> Option<usize> {
	// Hangul Compatibility Jamo U+3131..=U+318E render as 1 cell on some
	// terminals (Terminal.app, iTerm2) but follow UAX#11 at 2 cells on others
	// (Ghostty, most Linux terminals). The width is resolved at runtime from the
	// terminal identity and applied through the override; absent an override we
	// fall back to the compile-time platform default.
	if is_hangul_compat_jamo(c)
		&& let Some(target) = hangul_compat_jamo_target_width()
	{
		// Zero-width filler (U+3164): only the narrow correction applies — a
		// wide terminal renders it at its Unicode width (0), not the effective
		// wide target set for visible jamo. See apply_hangul_compat_jamo_delta.
		let unicode_width = UnicodeWidthChar::width(c).unwrap_or(0);
		if unicode_width == 0 && target > 1 {
			return Some(unicode_width);
		}
		return Some(target);
	}
	UnicodeWidthChar::width(c)
}

#[inline]
fn grapheme_width_str(g: &str, tab_width: usize) -> usize {
	if g == "\t" {
		return tab_width;
	}
	let mut it = g.chars();
	let Some(c0) = it.next() else {
		return 0;
	};
	if it.next().is_none() {
		return char_width_corrected(c0).unwrap_or(0);
	}
	// Multi-char grapheme: keep UnicodeWidthStr as the source of truth for
	// sequence-level width rules (VS16 emoji presentation, keycaps, ZWJ emoji,
	// CRLF, script ligatures). A per-char sum is not equivalent. Apply only the
	// same local Compatibility Jamo delta that char_width_corrected applies to
	// standalone code points; the delta is a no-op when no correction is active.
	let mut width = UnicodeWidthStr::width(g);
	for c in g.chars() {
		width = apply_hangul_compat_jamo_delta(width, c);
	}
	width
}

thread_local! {
  static SCRATCH: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Iterate graphemes in a non-ASCII UTF-16 segment.
///
/// Callback returns `true` to continue, `false` to stop early.
#[inline]
fn for_each_grapheme_u16_slow<F>(segment: &[u16], tab_width: usize, mut f: F) -> bool
where
	F: FnMut(&[u16], usize) -> bool,
{
	if segment.is_empty() {
		return true;
	}

	SCRATCH.with_borrow_mut(|scratch| {
		scratch.clear();
		scratch.reserve(segment.len());

		for r in std::char::decode_utf16(segment.iter().copied()) {
			scratch.push(r.unwrap_or('\u{FFFD}'));
		}

		let mut utf16_pos = 0usize;
		for g in scratch.graphemes(true) {
			let w = grapheme_width_str(g, tab_width);

			let g_u16_len: usize = g.chars().map(|c| c.len_utf16()).sum();
			let u16_slice = &segment[utf16_pos..utf16_pos + g_u16_len];
			utf16_pos += g_u16_len;

			if !f(u16_slice, w) {
				return false;
			}
		}

		true
	})
}

/// Visible width, with early-exit if width exceeds `limit`.
fn visible_width_u16_up_to(data: &[u16], limit: usize, tab_width: usize) -> (usize, bool) {
	let mut width = 0usize;
	let mut i = 0usize;
	let len = data.len();

	while i < len {
		if data[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(data, i) {
				let seq = &data[i..i + seq_len];
				if let Some(seq_width) = osc66_visible_width_u16(seq, tab_width) {
					width = width.saturating_add(seq_width);
					if width > limit {
						return (width, true);
					}
				}
				i += seq_len;
				continue;
			}
			i = skip_unrecognized_escape(i);
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < len && data[i] != ESC {
			if data[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				width += ascii_cell_width_u16(u, tab_width);
				if width > limit {
					return (width, true);
				}
			}
		} else {
			let ok = for_each_grapheme_u16_slow(seg, tab_width, |_, w| {
				width += w;
				width <= limit
			});
			if !ok {
				return (width, true);
			}
		}
	}

	(width, width > limit)
}

fn visible_width_u16(data: &[u16], tab_width: usize) -> usize {
	visible_width_u16_up_to(data, usize::MAX, tab_width).0
}

fn append_visible_range_plain_u16<F>(
	out: &mut Vec<u16>,
	data: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
	mut before_first_write: F,
) -> (usize, bool)
where
	F: FnMut(&mut Vec<u16>),
{
	if length == 0 {
		return (0, false);
	}

	let end_col = start_col.saturating_add(length);
	let mut out_w = 0usize;
	let mut wrote = false;
	let mut current_col = 0usize;
	let mut i = 0usize;

	while i < data.len() && current_col < end_col {
		let start = i;
		let mut is_ascii = data[i] <= 0x7f;
		i += 1;
		if is_ascii {
			while i < data.len() && data[i] <= 0x7f {
				i += 1;
			}
			if i < data.len() && is_ascii_grapheme_extender_u16(data[i]) {
				let safe_end = i.saturating_sub(1);
				if safe_end > start {
					i = safe_end;
				} else {
					is_ascii = false;
					i += 1;
				}
			}
		}
		if !is_ascii {
			while i < data.len() && data[i] > 0x7f {
				i += 1;
			}
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;
				if in_range && fits {
					if !wrote {
						before_first_write(out);
						wrote = true;
					}
					out.push(u);
					out_w += gw;
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= end_col {
					return false;
				}
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;
				if in_range && fits {
					if !wrote {
						before_first_write(out);
						wrote = true;
					}
					out.extend_from_slice(gu16);
					out_w += gw;
				}
				current_col += gw;
				current_col < end_col
			});
		}
	}

	(out_w, wrote)
}

fn flush_pending_ansi(
	out: &mut Vec<u16>,
	source: &[u16],
	pending: &mut SmallVec<[(usize, usize); 4]>,
) {
	if pending.is_empty() {
		return;
	}
	for &(p, l) in pending.iter() {
		out.extend_from_slice(&source[p..p + l]);
	}
	pending.clear();
}

// ============================================================================
// wrapTextWithAnsi
// ============================================================================

#[inline]
fn write_active_codes(state: &AnsiState, out: &mut Vec<u16>) {
	if !state.is_empty() {
		state.write_restore_u16(out);
	}
}

#[inline]
fn write_line_end_reset(state: &AnsiState, out: &mut Vec<u16>) {
	let has_underline = state.attrs & ATTR_UNDERLINE != 0;
	let has_strike = state.attrs & ATTR_STRIKE != 0;
	if !has_underline && !has_strike {
		return;
	}

	out.extend_from_slice(&[ESC, b'[' as u16]);
	if has_underline {
		out.extend_from_slice(&[b'2' as u16, b'4' as u16]);
		if has_strike {
			out.push(b';' as u16);
		}
	}
	if has_strike {
		out.extend_from_slice(&[b'2' as u16, b'9' as u16]);
	}
	out.push(b'm' as u16);
}

fn update_state_from_text(data: &[u16], state: &mut AnsiState) {
	let mut i = 0usize;
	while i < data.len() {
		if data[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(data, i)
		{
			let seq = &data[i..i + seq_len];
			if is_sgr_u16(seq) {
				state.apply_sgr_u16(&seq[2..seq_len - 1]);
			}
			i += seq_len;
			continue;
		}
		i += 1;
	}
}

fn token_is_whitespace(token: &[u16]) -> bool {
	let mut i = 0usize;
	while i < token.len() {
		if token[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(token, i)
		{
			let seq = &token[i..i + seq_len];
			if let Some((_, payload)) = osc66_meta_payload_u16(seq)
				&& payload.iter().any(|&u| u != b' ' as u16)
			{
				return false;
			}
			i += seq_len;
			continue;
		}
		if token[i] != b' ' as u16 {
			return false;
		}
		i += 1;
	}
	true
}

fn trim_end_spaces_in_place(line: &mut Vec<u16>) {
	while let Some(&last) = line.last() {
		if last == b' ' as u16 {
			line.pop();
		} else {
			break;
		}
	}
}

fn split_into_tokens_with_ansi(line: &[u16]) -> SmallVec<[Vec<u16>; 4]> {
	let mut tokens = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current = Vec::<u16>::new();
	let mut pending_ansi = SmallVec::<[u16; 32]>::new();
	let mut in_whitespace = false;
	let mut i = 0usize;

	while i < line.len() {
		if line[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(line, i)
		{
			pending_ansi.extend_from_slice(&line[i..i + seq_len]);
			i += seq_len;
			continue;
		}

		let ch = line[i];
		let char_is_space = ch == b' ' as u16;
		if char_is_space != in_whitespace && !current.is_empty() {
			tokens.push(current);
			current = Vec::new();
		}

		if !pending_ansi.is_empty() {
			current.extend_from_slice(&pending_ansi);
			pending_ansi.clear();
		}

		in_whitespace = char_is_space;
		current.push(ch);
		i += 1;
	}

	if !pending_ansi.is_empty() {
		current.extend_from_slice(&pending_ansi);
	}

	if !current.is_empty() {
		tokens.push(current);
	}

	tokens
}

/// Break a single token that is wider than the target width across lines.
///
/// Every break site is gated on `current_width > 0`, meaning the line already
/// holds visible content. Without that guard a grapheme wider than the target
/// (any double-width character at width 1, and everything at width 0) makes
/// `current_width + gw > width` true on a line that is still empty, so the
/// empty line is emitted and the grapheme is then placed anyway. Wrapping the
/// two characters "漢漢" to width 1 produced four lines, two of them blank.
///
/// A grapheme that cannot fit has to overflow: it is indivisible, so the only
/// choice is which line it overflows on. Putting it alone on its own line is
/// the least surprising answer, and it keeps the line count equal to the number
/// of graphemes. Emitting a blank line first does not reduce the overflow by a
/// single cell, and it shifts every row below it. `wrap_single_line` already
/// gates its own break the same way; this function was the one that did not.
///
/// Every break site also requires `gw > 0`. A grapheme that occupies no cells
/// cannot make a line too long, so breaking before one only moves it away from
/// the text it belongs to: a combining mark, a zero-width joiner, or a
/// variation selector would land alone on the next row, detached from its base.
fn break_long_word(
	word: &[u16],
	width: usize,
	tab_width: usize,
	state: &mut AnsiState,
) -> SmallVec<[Vec<u16>; 4]> {
	let mut lines = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	write_active_codes(state, &mut current_line);
	let mut current_width = 0usize;
	let mut i = 0usize;

	while i < word.len() {
		if word[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(word, i)
		{
			let seq = &word[i..i + seq_len];
			if let Some(seq_width) = osc66_visible_width_u16(seq, tab_width) {
				if seq_width > 0 && current_width > 0 && current_width.saturating_add(seq_width) > width
				{
					write_line_end_reset(state, &mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.extend_from_slice(seq);
				current_width = current_width.saturating_add(seq_width);
				i += seq_len;
				continue;
			}
			current_line.extend_from_slice(seq);
			if is_sgr_u16(seq) {
				state.apply_sgr_u16(&seq[2..seq_len - 1]);
			}
			i += seq_len;
			continue;
		}

		if word[i] == ESC {
			// An ESC that ansi_seq_len_u16 could not classify (truncated or unknown
			// sequence). Dropped rather than emitted, and the index still advances so
			// the non-ESC scan below cannot spin on it. Emitting it would leave a
			// dangling introducer at the end of the row, and the very next thing
			// written is the carried-over SGR prefix of the following row, which the
			// introducer would then swallow. See skip_unrecognized_escape.
			i = skip_unrecognized_escape(i);
			continue;
		}
		let start = i;
		let mut is_ascii = true;
		while i < word.len() && word[i] != ESC {
			if word[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &word[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if gw > 0 && current_width > 0 && current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.push(u);
				current_width += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if gw > 0 && current_width > 0 && current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(std::mem::take(&mut current_line));
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.extend_from_slice(gu16);
				current_width += gw;
				true
			});
		}
	}

	if !current_line.is_empty() {
		lines.push(current_line);
	}

	lines
}

fn wrap_single_line(line: &[u16], width: usize, tab_width: usize) -> SmallVec<[Vec<u16>; 4]> {
	if line.is_empty() {
		return smallvec![Vec::new()];
	}

	if visible_width_u16(line, tab_width) <= width {
		return smallvec![line.to_vec()];
	}

	let tokens = split_into_tokens_with_ansi(line);
	let mut wrapped = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	let mut current_width = 0usize;
	let mut state = AnsiState::new();

	for token in tokens {
		let token_width = visible_width_u16(&token, tab_width);
		let is_whitespace = token_is_whitespace(&token);

		if token_width > width && !is_whitespace {
			if !current_line.is_empty() {
				write_line_end_reset(&state, &mut current_line);
				wrapped.push(current_line);
				current_line = Vec::new();
				current_width = 0;
			}

			let mut broken = break_long_word(&token, width, tab_width, &mut state);
			if let Some(last) = broken.pop() {
				wrapped.extend(broken);
				current_line = last;
				current_width = visible_width_u16(&current_line, tab_width);
			}
			continue;
		}

		let total_needed = current_width + token_width;
		if token_width > 0 && total_needed > width && current_width > 0 {
			let mut line_to_wrap = current_line;
			trim_end_spaces_in_place(&mut line_to_wrap);
			write_line_end_reset(&state, &mut line_to_wrap);
			wrapped.push(line_to_wrap);

			current_line = Vec::new();
			write_active_codes(&state, &mut current_line);
			if is_whitespace {
				current_width = 0;
			} else {
				current_line.extend_from_slice(&token);
				current_width = token_width;
			}
		} else {
			current_line.extend_from_slice(&token);
			current_width += token_width;
		}

		update_state_from_text(&token, &mut state);
	}

	if !current_line.is_empty() {
		wrapped.push(current_line);
	}

	for line in &mut wrapped {
		trim_end_spaces_in_place(line);
	}

	if wrapped.is_empty() {
		wrapped.push(Vec::new());
	}

	wrapped
}

/// The rows [`wrap_text_with_ansi`] produces.
///
/// Inline up to four, because the overwhelmingly common call is a status line
/// or a message row that wraps to one or two rows and the allocation would be
/// pure overhead.
pub type WrappedLines = SmallVec<[Vec<u16>; 4]>;

fn wrap_text_with_ansi_impl(text: &[u16], width: usize, tab_width: usize) -> WrappedLines {
	if text.is_empty() {
		return smallvec![Vec::new()];
	}

	let mut result = SmallVec::<[Vec<u16>; 4]>::new();
	let mut state = AnsiState::new();
	let mut line_start = 0usize;

	for i in 0..=text.len() {
		if i == text.len() || text[i] == b'\n' as u16 {
			let line = &text[line_start..i];
			let mut line_with_prefix: Vec<u16> = Vec::new();
			if !result.is_empty() {
				write_active_codes(&state, &mut line_with_prefix);
			}
			line_with_prefix.extend_from_slice(line);

			let wrapped = wrap_single_line(&line_with_prefix, width, tab_width);
			result.extend(wrapped);
			update_state_from_text(line, &mut state);
			line_start = i + 1;
		}
	}

	if result.is_empty() {
		result.push(Vec::new());
	}

	result
}

/// Wrap text to a visible width, preserving ANSI escape codes across line
/// breaks.
///
/// `text` is UTF-16 as JavaScript hands it over, trailing NUL and all; the NUL
/// is stripped here so every entry point strips it in exactly one place.
/// Returns one UTF-16 line per row, with the SGR codes active at each break
/// re-emitted at the start of the next row.
pub fn wrap_text_with_ansi(text: &[u16], width: usize, tab_width: u32) -> WrappedLines {
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let text = strip_unrecognized_escapes(utf16_content(text));
	wrap_text_with_ansi_impl(&text, width, tab_width)
}

// ============================================================================
// truncateToWidth
// ============================================================================

/// Truncate text to a visible width, preserving ANSI codes.
///
/// Pads with spaces when requested.
///
/// Answers `None` when the input is already correct and needs no rewriting,
/// which is the common case for a line that already fits. The napi wrapper
/// turns that into the caller's ORIGINAL `JsString` handle, so a fitting line
/// costs zero output allocation and zero copying; returning a freshly built
/// copy instead would allocate on every render of every unchanged row.
pub fn truncate_to_width(
	text: &[u16],
	max_width: usize,
	ellipsis_kind: Ellipsis,
	pad: bool,
	tab_width: u32,
) -> Option<Vec<u16>> {
	let tab_width = clamp_tab_width_for_ops(tab_width);

	// The pad branch below appends spaces, which would bury the incoming buffer's
	// NUL terminator mid-string where a trailing-NUL pop cannot reach it.
	let text = strip_unrecognized_escapes(utf16_content(text));
	// An input that carried a dangling escape is NOT unchanged, whatever its width,
	// so `None` is not available for it: answering `None` would hand the caller
	// back the original bytes with the escape still in them, which is the thing
	// this function just removed.
	let was_normalized = matches!(text, Cow::Owned(_));
	let text: &[u16] = &text;

	// Fast path: early-exit width check
	let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
	if !exceeded {
		if !pad {
			return was_normalized.then(|| text.to_vec());
		}

		if text_w < max_width {
			let mut out = Vec::with_capacity(text.len() + (max_width - text_w));
			out.extend_from_slice(text);
			out.resize(out.len() + (max_width - text_w), b' ' as u16);
			return Some(out);
		}

		// Exactly fits and padding requested: the input is already correct.
		return was_normalized.then(|| text.to_vec());
	}

	// Map ellipsis kind to UTF-16 data and width
	const ELLIPSIS_UNICODE: &[u16] = &[0x2026]; // "…"
	const ELLIPSIS_ASCII: &[u16] = &[0x2e, 0x2e, 0x2e]; // "..."
	const ELLIPSIS_OMIT: &[u16] = &[];

	let (ellipsis, ellipsis_w): (&[u16], usize) = match ellipsis_kind {
		Ellipsis::Unicode => (ELLIPSIS_UNICODE, 1),
		Ellipsis::Ascii => (ELLIPSIS_ASCII, 3),
		Ellipsis::Omit => (ELLIPSIS_OMIT, 0),
	};

	let target_w = max_width.saturating_sub(ellipsis_w);

	// If ellipsis alone doesn't fit, return ellipsis cut to max_width
	if target_w == 0 {
		let mut out = Vec::with_capacity(ellipsis.len().min(max_width * 2));
		let mut w = 0usize;
		let _ = for_each_grapheme_u16_slow(ellipsis, tab_width, |gu16, gw| {
			if w + gw > max_width {
				return false;
			}
			out.extend_from_slice(gu16);
			w += gw;
			true
		});

		if pad && w < max_width {
			out.resize(out.len() + (max_width - w), b' ' as u16);
		}
		return Some(out);
	}

	// Main truncation
	let mut out = Vec::with_capacity(text.len().min(max_width * 2) + ellipsis.len() + 8);
	let mut w = 0usize;
	let mut i = 0usize;
	let text_len = text.len();

	let mut saw_sgr = false;

	while i < text_len {
		if text[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(text, i) {
				let seq = &text[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_end = w.saturating_add(osc66.width);
					if span_end <= target_w {
						out.extend_from_slice(seq);
						w = span_end;
						i += seq_len;
						if w >= target_w {
							break;
						}
						continue;
					}

					if w < target_w {
						let remaining = target_w - w;
						let (payload_w, _) = append_visible_range_plain_u16(
							&mut out,
							osc66.payload,
							0,
							remaining,
							true,
							tab_width,
							|_| {},
						);
						w = w.saturating_add(payload_w);
					}
					break;
				}
				out.extend_from_slice(seq);
				if is_sgr_u16(seq) {
					saw_sgr = true;
				}
				i += seq_len;
				continue;
			}
			i = skip_unrecognized_escape(i);
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < text_len && text[i] != ESC {
			if text[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &text[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if w + gw > target_w {
					break;
				}
				out.push(u);
				w += gw;
			}
			if w >= target_w {
				break;
			}
		} else {
			let keep_going = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if w + gw > target_w {
					return false;
				}
				out.extend_from_slice(gu16);
				w += gw;
				true
			});
			if !keep_going {
				break;
			}
		}
	}

	// Only reset if we actually copied SGR codes into the output.
	if saw_sgr {
		out.extend_from_slice(&[ESC, b'[' as u16, b'0' as u16, b'm' as u16]);
	}
	out.extend_from_slice(ellipsis);

	if pad {
		let out_w = w + ellipsis_w;
		if out_w < max_width {
			out.resize(out.len() + (max_width - out_w), b' ' as u16);
		}
	}

	Some(out)
}

// ============================================================================
// sliceWithWidth
// ============================================================================

fn slice_with_width_impl(
	line: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
) -> (Vec<u16>, usize) {
	let end_col = start_col.saturating_add(length);

	let mut out = Vec::with_capacity(length * 2);
	let mut out_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	// Store pending ANSI ranges (pos, len) to avoid copying until needed
	let mut pending_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	while i < line_len && current_col < end_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				let seq = &line[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_start = current_col;
					let span_end = current_col.saturating_add(osc66.width);
					if span_start >= start_col && span_end <= end_col {
						flush_pending_ansi(&mut out, line, &mut pending_ansi);
						out.extend_from_slice(seq);
						out_w = out_w.saturating_add(osc66.width);
					} else if span_start < end_col && span_end > start_col {
						let overlap_start = start_col.saturating_sub(span_start);
						let overlap_end = span_end.min(end_col) - span_start;
						let overlap_len = overlap_end.saturating_sub(overlap_start);
						let (payload_start, payload_len) =
							osc66_payload_range(overlap_start, overlap_len, osc66.scale, strict);
						let (payload_w, _) = append_visible_range_plain_u16(
							&mut out,
							osc66.payload,
							payload_start,
							payload_len,
							strict,
							tab_width,
							|out| flush_pending_ansi(out, line, &mut pending_ansi),
						);
						out_w = out_w.saturating_add(payload_w);
					}
					current_col = span_end;
					i += seq_len;
					continue;
				}

				if current_col >= start_col {
					out.extend_from_slice(&line[i..i + seq_len]);
				} else {
					pending_ansi.push((i, seq_len));
				}
				i += seq_len;
				continue;
			}
			i = skip_unrecognized_escape(i);
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					flush_pending_ansi(&mut out, line, &mut pending_ansi);
					out.push(u);
					out_w += gw;
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= end_col {
					return false;
				}

				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					flush_pending_ansi(&mut out, line, &mut pending_ansi);
					out.extend_from_slice(gu16);
					out_w += gw;
				}

				current_col += gw;
				current_col < end_col
			});
		}
	}

	// Include trailing ANSI sequences (e.g., reset codes) that immediately follow
	while i < line.len() {
		if line[i] == ESC
			&& let Some(len) = ansi_seq_len_u16(line, i)
		{
			let seq = &line[i..i + len];
			if osc66_visible_width_u16(seq, tab_width).is_none() {
				out.extend_from_slice(seq);
			}
			i += len;
			continue;
		}
		break;
	}

	(out, out_w)
}

/// Slice a range of visible columns from a line.
///
/// Counts terminal cells, skipping ANSI escapes, and optionally enforces strict
/// width.
pub fn slice_with_width(
	line: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: u32,
) -> SliceResult {
	if length == 0 {
		return SliceResult { text: Vec::new(), width: 0 };
	}

	let line = strip_unrecognized_escapes(utf16_content(line));
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let (text, width) = slice_with_width_impl(&line, start_col, length, strict, tab_width);

	SliceResult { text, width }
}

// ============================================================================
// extractSegments
// ============================================================================

/// Step past an ESC at `i` that begins no sequence this scanner recognizes,
/// without copying it.
///
/// WHY DROPPING IS THE ONLY SAFE ANSWER. `ansi_seq_len_u16` reads the whole
/// input, so a sequence that is complete anywhere in the line is recognized and
/// copied whole. What reaches this point is an ESC that is genuinely
/// incomplete: a line cut mid-escape by a pipe buffer, or a corrupted
/// stream. Copying it into the output leaves a dangling introducer that goes on
/// to eat whatever is appended after it.
///
/// That is not theoretical. `truncate_to_width` appends `ESC [ 0 m` when it
/// copied any SGR, and `fuzz/fuzz_targets/text_measure.rs` found a line whose
/// output ended in a dangling `ESC` and a space: the scanner ran forward from
/// that ESC, found the `m` of the reset, and read the whole run
/// as one sequence. The reset's own `0m` was then left over as ordinary text --
/// two visible characters the caller never asked for, printed on the user's
/// screen, with the reset itself gone so the colour bled into the next row. The
/// truncated line measured seven cells against a six-cell limit for exactly
/// that reason.
///
/// Dropping costs nothing: an unrecognized ESC has zero visible width, so no
/// measurement changes, and it removes a whole class of "the parse depends on
/// what happens to follow" from every function here. All four copy sites go
/// through this so the three entry points cannot drift apart.
const fn skip_unrecognized_escape(i: usize) -> usize {
	i + 1
}

/// Remove every ESC that begins no classifiable sequence, once, before anything
/// else runs.
///
/// WHY THIS IS A SEPARATE PASS AND NOT A CHECK INSIDE EACH LOOP. Dropping the
/// byte at each copy site fixes the swallowed reset, but it introduces a
/// subtler disagreement, which the fuzzer found immediately: every loop here
/// treats an ESC as a SEGMENT BOUNDARY and segments graphemes within a segment.
/// Remove the ESC from the output only, and text that was two segments while
/// being measured becomes one segment when the result is measured again. `1`,
/// an unclassifiable ESC, and U+FE0F measure as one cell while separated (`1`
/// is one cell, the variation selector zero) and as TWO once the ESC is gone,
/// because the selector now attaches to the digit and promotes it to
/// emoji presentation. The row was built to a two-cell target and measured
/// three.
///
/// Normalizing first makes that impossible rather than unlikely: after this
/// pass no loop can see an unclassifiable ESC, so measuring and copying segment
/// identically by construction. It is also what the terminal does, which is the
/// answer that matters -- a terminal discards an escape it cannot parse and
/// then applies the selector to the digit, exactly as the merged reading says.
///
/// Borrowed when there is nothing to remove, which is every ordinary line, so
/// the common path costs one scan and no allocation. The scan is not extra
/// work: it is the same escape classification the caller was about to do
/// anyway.
fn strip_unrecognized_escapes(data: &[u16]) -> Cow<'_, [u16]> {
	let mut i = 0usize;
	let first_dangling = loop {
		if i >= data.len() {
			return Cow::Borrowed(data);
		}
		if data[i] == ESC {
			match ansi_seq_len_u16(data, i) {
				Some(seq_len) => i += seq_len,
				None => break i,
			}
		} else {
			i += 1;
		}
	};

	let mut cleaned = Vec::with_capacity(data.len() - 1);
	cleaned.extend_from_slice(&data[..first_dangling]);
	let mut i = skip_unrecognized_escape(first_dangling);
	while i < data.len() {
		if data[i] == ESC {
			match ansi_seq_len_u16(data, i) {
				Some(seq_len) => {
					cleaned.extend_from_slice(&data[i..i + seq_len]);
					i += seq_len;
				},
				None => i = skip_unrecognized_escape(i),
			}
			continue;
		}
		cleaned.push(data[i]);
		i += 1;
	}
	Cow::Owned(cleaned)
}

/// Whether a `gw`-cell grapheme starting at `current_col` belongs to the
/// "before" segment.
///
/// It has to END at or before the boundary, not merely start before it. A
/// caller composites the overlay at exactly `before_end`, so a grapheme that
/// straddles the boundary cannot be drawn: half a two-cell character does not
/// exist, and emitting the whole thing pushes the overlay to the right by the
/// overrun. That is what `#compositeLineAt` in `packages/tui/src/tui.ts` then
/// absorbs with `Math.max(startCol, base.beforeWidth)`, which keeps the line
/// the right total length while putting the overlay in the wrong column and
/// eating a cell of the segment after it. A scrollbar beside CJK text, or any
/// base line containing a tab, hits this.
///
/// Dropping the grapheme leaves a gap that the caller already pads with spaces,
/// which is the same answer `strict` gives in [`slice_with_width`] and the same
/// answer the OSC 66 branch of [`extract_segments`] has always given: it clips
/// its span to `before_end` rather than overrunning it. This makes the ordinary
/// path agree with the one beside it.
const fn fits_before(current_col: usize, gw: usize, before_end: usize) -> bool {
	current_col < before_end && current_col + gw <= before_end
}

fn extract_segments_impl(
	line: &[u16],
	before_end: usize,
	after_start: usize,
	after_len: usize,
	strict_after: bool,
	tab_width: usize,
) -> (Vec<u16>, usize, Vec<u16>, usize) {
	let after_end = after_start.saturating_add(after_len);

	let mut before = Vec::with_capacity(before_end * 2);
	let mut before_w = 0usize;

	let mut after = Vec::with_capacity(after_len * 2);
	let mut after_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	// Store pending ANSI ranges for "before"
	let mut pending_before_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	let mut after_started = false;
	let mut state = AnsiState::new();

	let done_col = if after_len == 0 {
		before_end
	} else {
		after_end
	};

	while i < line_len && current_col < done_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				let seq = &line[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_start = current_col;
					let span_end = current_col.saturating_add(osc66.width);

					if span_start < before_end {
						if span_end <= before_end {
							flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
							before.extend_from_slice(seq);
							before_w = before_w.saturating_add(osc66.width);
						} else {
							let overlap_len = before_end - span_start;
							let (payload_start, payload_len) =
								osc66_payload_range(0, overlap_len, osc66.scale, true);
							let (payload_w, _) = append_visible_range_plain_u16(
								&mut before,
								osc66.payload,
								payload_start,
								payload_len,
								true,
								tab_width,
								|out| flush_pending_ansi(out, line, &mut pending_before_ansi),
							);
							before_w = before_w.saturating_add(payload_w);
						}
					}

					if after_len != 0 && span_start < after_end && span_end > after_start {
						let overlap_start = after_start.saturating_sub(span_start);
						let overlap_end = span_end.min(after_end) - span_start;
						let overlap_len = overlap_end.saturating_sub(overlap_start);

						if span_start >= after_start && span_end <= after_end {
							if !after_started {
								state.write_restore_u16(&mut after);
								after_started = true;
							}
							after.extend_from_slice(seq);
							after_w = after_w.saturating_add(osc66.width);
						} else {
							let (payload_start, payload_len) =
								osc66_payload_range(overlap_start, overlap_len, osc66.scale, strict_after);
							let (payload_w, wrote_payload) = append_visible_range_plain_u16(
								&mut after,
								osc66.payload,
								payload_start,
								payload_len,
								strict_after,
								tab_width,
								|out| {
									if !after_started {
										state.write_restore_u16(out);
										after_started = true;
									}
								},
							);
							if wrote_payload {
								after_w = after_w.saturating_add(payload_w);
							}
						}
					}

					current_col = span_end;
					i += seq_len;
					continue;
				}

				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				}

				if current_col < before_end {
					pending_before_ansi.push((i, seq_len));
				} else if current_col >= after_start && current_col < after_end && after_started {
					after.extend_from_slice(seq);
				}

				i += seq_len;
				continue;
			}

			i = skip_unrecognized_escape(i);
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= done_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);

				if fits_before(current_col, gw, before_end) {
					flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
					before.push(u);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.push(u);
						after_w += gw;
					}
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= done_col {
					return false;
				}

				if fits_before(current_col, gw, before_end) {
					flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
					before.extend_from_slice(gu16);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.extend_from_slice(gu16);
						after_w += gw;
					}
				}

				current_col += gw;
				true
			});
		}
	}

	(before, before_w, after, after_w)
}

/// Extract the before/after slices around an overlay region.
///
/// Preserves ANSI state so the `after` segment renders correctly after
/// truncation.
pub fn extract_segments(
	line: &[u16],
	before_end: usize,
	after_start: usize,
	after_len: usize,
	strict_after: bool,
	tab_width: u32,
) -> ExtractSegmentsResult {
	let line = strip_unrecognized_escapes(utf16_content(line));
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let (before, before_width, after, after_width) =
		extract_segments_impl(&line, before_end, after_start, after_len, strict_after, tab_width);

	ExtractSegmentsResult { before, before_width, after, after_width }
}

// ============================================================================
// visibleWidth
// ============================================================================

/// Calculate visible width of text, excluding ANSI escape sequences.
///
/// Tabs count as a fixed-width cell.
pub fn visible_width(text: &[u16], tab_width: u32) -> usize {
	let tab_width = clamp_tab_width_for_ops(tab_width);
	visible_width_u16(&strip_unrecognized_escapes(utf16_content(text)), tab_width)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn to_u16(s: &str) -> Vec<u16> {
		s.encode_utf16().collect()
	}

	/// Turn a segment back into a `String` so a failure prints the text rather
	/// than code units.
	fn from_u16(units: &[u16]) -> String {
		String::from_utf16_lossy(units)
	}

	/// Classifying an escape sequence depends only on the sequence itself.
	///
	/// WHY THIS SUITE EXISTS. `ansi_seq_len_u16` used to answer a CSI by
	/// searching the whole rest of the buffer for any byte in `0x40..=0x7e` and
	/// claiming everything up to it. Two things follow from that, and the
	/// fuzzer found both.
	///
	/// The first is a plain rendering bug with no fuzzing required: a stray `ESC
	/// [` in a program's output made every character up to the next punctuation
	/// mark measure as zero width, so the text was there in the buffer and
	/// drawn as nothing.
	///
	/// The second is subtler and is why three earlier fixes each uncovered
	/// another failure. If the answer depends on bytes far ahead, then cutting
	/// the line changes the answer, so the same text measures one way while it
	/// is being truncated and another way afterwards. The last reproducer was a
	/// wrapped row of `ESC [ 9 m`, `ESC SP`, `ESC [ 2 9 m` built as zero cells
	/// and measured as three: `ESC SP` was a complete sequence in the source
	/// line, where a `9` happened to follow it eventually, and an
	/// unclassifiable one in the row. Walking the ECMA-48 grammar and stopping
	/// at the first byte it does not allow removes the whole class rather than
	/// another instance of it.
	mod escape_classification_is_self_contained {
		use super::*;

		const TAB_WIDTH: u32 = 8;

		/// The plain bug: a stray introducer must not consume the text after it.
		///
		/// `ESC [` followed by a character above `0x7e` is not a CSI: that byte
		/// is neither a parameter (`0x30..=0x3f`), an intermediate
		/// (`0x20..=0x2f`), nor a final (`0x40..=0x7e`), so the sequence aborts
		/// there. The old scanner kept looking and found the `m` in "muffled",
		/// swallowing the ideograph and the six letters before it.
		///
		/// Note that `ESC [ h` IS a valid CSI (set mode), which is why the
		/// reproducer needs a byte the grammar genuinely rejects rather than
		/// any old letter.
		#[test]
		fn a_stray_csi_introducer_does_not_swallow_the_line() {
			// The unclassifiable ESC is dropped, leaving `[` (1) + the ideograph (2) + 7
			// letters.
			assert_eq!(visible_width(&to_u16("\u{1b}[\u{6f22}muffled"), TAB_WIDTH), 10);
		}

		/// A real CSI is still one sequence of zero width, parameters,
		/// intermediates and all.
		#[test]
		fn a_well_formed_csi_is_still_zero_width() {
			assert_eq!(visible_width(&to_u16("\u{1b}[38;5;196mred\u{1b}[0m"), TAB_WIDTH), 3);
			assert_eq!(visible_width(&to_u16("\u{1b}[?25l"), TAB_WIDTH), 0);
			assert_eq!(visible_width(&to_u16("\u{1b}[1 q"), TAB_WIDTH), 0);
		}

		/// The determinism property itself, stated directly: appending unrelated
		/// bytes cannot change how the bytes already present are classified.
		/// This is what every earlier failure violated.
		#[test]
		fn appending_bytes_never_changes_how_earlier_ones_classify() {
			for prefix in ["\u{1b} ", "\u{1b}[", "\u{1b}[38;", "\u{1b}]66;s=2", "\u{1b}", "\u{1b}P"] {
				let alone = to_u16(prefix);
				let alone_len = ansi_seq_len_u16(&alone, 0);
				for suffix in ["m", "9m", "\u{1b}[0m", "text", "\u{7}"] {
					let joined = to_u16(&format!("{prefix}{suffix}"));
					if let Some(len) = alone_len {
						assert_eq!(
							ansi_seq_len_u16(&joined, 0),
							Some(len),
							"{prefix:?} classified as {len} alone but differently before {suffix:?}",
						);
					}
				}
			}
		}

		/// An `ESC SP` with nothing valid after it is not a sequence, which is
		/// the exact pair the last reproducer turned on.
		#[test]
		fn an_escape_with_an_intermediate_and_no_final_is_not_a_sequence() {
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b} "), 0), None);
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b} \u{1b}[0m"), 0), None);
			// With a real final byte it is a three-byte sequence and nothing more.
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b} 9text"), 0), Some(3));
		}

		/// A string sequence still closes on ST or BEL, and a bare ESC cancels it
		/// rather than being absorbed. The TUI's own cursor marker is a
		/// BEL-terminated APC, so BEL has to keep working.
		#[test]
		fn string_sequences_close_on_st_or_bel_and_cancel_on_a_bare_escape() {
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b}]66;s=2;Hi\u{1b}\\rest"), 0), Some(13));
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b}_marker\u{7}rest"), 0), Some(9));
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b}]66;s=2\u{1b}[0m"), 0), None);
			assert_eq!(ansi_seq_len_u16(&to_u16("\u{1b}]unterminated"), 0), None);
		}
	}

	/// A dangling escape introducer never reaches the output, so nothing can be
	/// swallowed by it.
	///
	/// WHY THIS SUITE EXISTS. `fuzz/fuzz_targets/text_measure.rs` found a line
	/// that truncated to SEVEN cells against a six-cell limit. The cause was
	/// not the width arithmetic: the copy loop wrote through an ESC that began
	/// no sequence it could classify, so the truncated line ended in a dangling
	/// introducer, and `truncate_to_width` then appended its `ESC [ 0 m` reset
	/// right after it. Re-scanning that output ran forward from the dangling
	/// ESC, found the `m` of the reset, and read the whole run as one escape
	/// sequence -- which left the reset's own `0m` as ordinary text. Two
	/// characters the caller never wrote, printed on the user's screen, with the
	/// reset itself consumed so the colour bled into the next row.
	///
	/// A line cut mid-escape is ordinary, not exotic: any pipe buffer or ring
	/// buffer that splits a program's output produces one. The fix drops the
	/// unclassifiable ESC at every copy site
	/// through `skip_unrecognized_escape`, which costs no width because such an
	/// ESC has none.
	mod unrecognized_escapes_are_dropped {
		use super::*;

		const TAB_WIDTH: u32 = 8;

		/// The reproducer's shape, reduced to the part that matters: content, an
		/// ESC that begins no classifiable sequence, then enough visible text
		/// and colour that truncation has to cut and to append a reset.
		///
		/// The ESC is followed by a non-ASCII character on purpose.
		/// `ansi_seq_len_u16` classifies `ESC` plus an intermediate plus any
		/// ASCII final byte, so `ESC` followed by a letter is a
		/// COMPLETE sequence and not this bug at all; it takes a byte above 0x7E
		/// to leave the introducer genuinely dangling, which is exactly what
		/// the fuzzer found.
		#[test]
		fn a_truncated_line_never_ends_in_a_dangling_introducer() {
			let text = to_u16("\u{1b}[31mabc\u{1b}\u{fffd}defghij");
			let out =
				truncate_to_width(&text, 6, Ellipsis::Omit, false, TAB_WIDTH).expect("must truncate");
			let rendered = from_u16(&out);

			assert!(!rendered.contains("\u{1b}\u{fffd}"), "a dangling ESC survived into {rendered:?}");
			assert!(rendered.ends_with("\u{1b}[0m"), "the reset was swallowed in {rendered:?}");
			assert_eq!(visible_width(&out, TAB_WIDTH), 6);
		}

		/// The bound itself, stated as the caller relies on it: whatever the
		/// escapes in the input, the result fits. This is the assertion the
		/// fuzzer failed.
		#[test]
		fn truncation_fits_its_limit_whatever_the_escapes() {
			for text in [
				"\u{1b}[31mabc\u{1b}\u{fffd}defghij",
				"\u{1b}\u{1b}\u{1b}[31mxy\u{1b}\u{fffd}zwvut",
				"a\u{1b}\u{fffd}b\u{1b}\u{fffd}c\u{1b}\u{fffd}d\u{1b}\u{fffd}e",
				"\u{1b}[1m\u{1b}[4mheading\u{1b}",
			] {
				let units = to_u16(text);
				for limit in 0..10 {
					for ellipsis in [Ellipsis::Unicode, Ellipsis::Ascii, Ellipsis::Omit] {
						let width = match truncate_to_width(&units, limit, ellipsis, false, TAB_WIDTH) {
							Some(out) => visible_width(&out, TAB_WIDTH),
							None => visible_width(&units, TAB_WIDTH),
						};
						assert!(
							width <= limit,
							"{text:?} truncated to {limit} yielded {width} cells ({ellipsis:?})",
						);
					}
				}
			}
		}

		/// A COMPLETE sequence is still copied whole. The fix drops only what
		/// cannot be classified, and a version that dropped every ESC would
		/// strip all colour from every rendered row.
		#[test]
		fn a_complete_sequence_is_still_copied() {
			let text = to_u16("\u{1b}[31mabcdefgh");
			let out =
				truncate_to_width(&text, 4, Ellipsis::Omit, false, TAB_WIDTH).expect("must truncate");
			let rendered = from_u16(&out);

			assert!(rendered.starts_with("\u{1b}[31m"), "colour was stripped from {rendered:?}");
			assert_eq!(visible_width(&out, TAB_WIDTH), 4);
		}

		/// Wrapping has the same hazard and the same fix: the next row opens with
		/// the SGR codes carried across the break, and a dangling introducer
		/// left at the end of this row would swallow them, so the following row
		/// would lose its colour and print the codes as text.
		#[test]
		fn a_wrapped_row_never_ends_in_a_dangling_introducer() {
			let text = to_u16("\u{1b}[31mabc\u{1b}\u{fffd}defghijkl");
			let rows = wrap_text_with_ansi(&text, 4, TAB_WIDTH);

			assert!(rows.len() > 1, "the input must actually wrap");
			for row in &rows {
				let rendered = from_u16(row);
				// The only ESC that may appear is the start of a sequence the scanner
				// classifies. A dangling one would sit at the end of the row with nothing
				// to complete it.
				let mut position = 0usize;
				while position < row.len() {
					if row[position] == ESC {
						assert!(
							ansi_seq_len_u16(row, position).is_some(),
							"{rendered:?} carries an unclassifiable ESC at {position}",
						);
					}
					position += 1;
				}
				assert!(visible_width(row, TAB_WIDTH) <= 4, "{rendered:?} is wider than the target");
			}
		}

		/// The pass runs before anything else, so measuring and copying can never
		/// segment differently.
		///
		/// THE SECOND BUG, which the first fix caused. Every loop here treats an
		/// ESC as a segment boundary and segments graphemes within a segment.
		/// Dropping the ESC from the OUTPUT only meant text that was two
		/// segments while being measured became one segment when the result was
		/// measured again: `1`, a dangling ESC, and U+FE0F measure as one cell
		/// apart (a digit plus a zero-width selector) and as two once the ESC
		/// is gone, because the selector now attaches to the digit and promotes
		/// it to emoji presentation. The fuzzer built a row to a
		/// two-cell target and measured three.
		///
		/// Normalizing at the entry point makes it impossible instead of
		/// unlikely, and it is what the terminal does: it discards an escape it
		/// cannot parse and then applies the selector to the digit.
		#[test]
		fn a_selector_separated_by_a_dangling_escape_attaches_to_what_precedes_it() {
			let separated = to_u16("1\u{1b}\u{fffd}\u{fe0f}");

			// One cell if the escape split them, two once it is gone. Two is the terminal's
			// answer.
			assert_eq!(visible_width(&separated, TAB_WIDTH), 2);

			// And the row a wrap produces measures what the wrap thought it measured.
			for row in &wrap_text_with_ansi(&separated, 2, TAB_WIDTH) {
				assert!(visible_width(row, TAB_WIDTH) <= 2, "{:?} exceeds the target", from_u16(row));
			}
		}

		/// Every row of a wrap fits the target, whatever the escapes. This is the
		/// assertion the fuzzer failed after the first fix, so it is pinned
		/// directly rather than inferred.
		#[test]
		fn wrapped_rows_fit_the_target_whatever_the_escapes() {
			for text in [
				"1\u{1b}\u{fffd}\u{fe0f} a1\u{1b}\u{1b}\u{fe0f}",
				"\u{1b}[31ma\u{1b}\u{fffd}\u{6f22}bcd",
				"\u{fffd}\u{1b}\u{fffd}\u{200d}\u{fffd}ab",
			] {
				let units = to_u16(text);
				for width in 1..6 {
					for row in &wrap_text_with_ansi(&units, width, TAB_WIDTH) {
						let row_width = visible_width(row, TAB_WIDTH);
						// A row may exceed the target only when one grapheme cannot fit in it.
						if row_width > width {
							assert_eq!(
								wrap_text_with_ansi(row, 1, TAB_WIDTH).len(),
								1,
								"{text:?} at width {width} emitted {:?}, {row_width} cells, which is not \
								 a single oversized grapheme",
								from_u16(row),
							);
						}
					}
				}
			}
		}

		/// A line with nothing to strip is borrowed rather than copied, because
		/// every ordinary line is that line and this runs on every rendered
		/// row.
		#[test]
		fn a_clean_line_is_not_copied() {
			let clean = to_u16("\u{1b}[31mhello \u{6f22}\u{1b}[0m");

			assert!(matches!(strip_unrecognized_escapes(&clean), Cow::Borrowed(_)));
			assert!(matches!(strip_unrecognized_escapes(&to_u16("a\u{1b}\u{fffd}b")), Cow::Owned(_)));
		}

		/// `None` from `truncate_to_width` means "the input needs no rewriting",
		/// so a line that DID need an escape removed can never answer it -- the
		/// caller would render the original bytes with the dangling escape
		/// still in them.
		#[test]
		fn truncation_never_answers_unchanged_for_a_line_it_had_to_clean() {
			let dirty = to_u16("ab\u{1b}\u{fffd}c");

			// Only the ESC goes. The character after it is ordinary content, not part of a
			// sequence.
			let short_enough = truncate_to_width(&dirty, 40, Ellipsis::Omit, false, TAB_WIDTH);
			assert_eq!(
				from_u16(&short_enough.expect("a cleaned line is not unchanged")),
				"ab\u{fffd}c"
			);

			// A genuinely untouched line still answers None, which is the zero-allocation
			// path.
			assert!(truncate_to_width(&to_u16("abc"), 40, Ellipsis::Omit, false, TAB_WIDTH).is_none());
		}

		/// Slicing and segment extraction share the copy loop, so they share the
		/// guarantee.
		#[test]
		fn slicing_and_extraction_drop_it_too() {
			let text = to_u16("abc\u{1b}\u{fffd}defghij");

			let sliced = slice_with_width(&text, 0, 6, false, TAB_WIDTH);
			assert!(!from_u16(&sliced.text).contains('\u{1b}'), "a dangling ESC survived a slice");
			assert_eq!(sliced.width, visible_width(&sliced.text, TAB_WIDTH));

			let segments = extract_segments(&text, 3, 5, 3, false, TAB_WIDTH);
			assert!(!from_u16(&segments.before).contains('\u{1b}'), "a dangling ESC survived before");
			assert!(!from_u16(&segments.after).contains('\u{1b}'), "a dangling ESC survived after");
		}
	}

	/// The before segment stops AT the overlay column, never past it.
	///
	/// WHY THIS SUITE EXISTS. `fuzz/fuzz_targets/text_measure.rs` found this on
	/// its first run, from the input `"3\t"` with an overlay starting at column
	/// 6: the before segment came back nine cells wide. The branch asked only
	/// whether a grapheme STARTED before the boundary, so a tab or any two-cell
	/// character straddling it was emitted whole.
	///
	/// It is not a cosmetic overrun. `#compositeLineAt` in
	/// `packages/tui/src/tui.ts` absorbs the extra with `Math.max(startCol,
	/// base.beforeWidth)`, so the composed line keeps its total
	/// width and nothing errors, while the overlay lands to the right of the
	/// column it was asked for and a cell of the segment after it is dropped to
	/// make room. A scrollbar drawn beside CJK text, or any base line
	/// containing a tab, moves.
	///
	/// The OSC 66 branch of the same function always clipped its span to
	/// `before_end`. These cases pin that the ordinary path now agrees with the
	/// one beside it.
	mod extract_segments_before_boundary {
		use super::*;

		/// The width the fuzzer ran with, and the one every terminal defaults to.
		/// Named rather than reusing `DEFAULT_TAB_WIDTH`, which is 3: at three
		/// cells the reproducing tab happens to fit and the case proves
		/// nothing.
		const TAB_WIDTH: u32 = 8;

		/// The exact fuzzer reproducer, byte for byte.
		#[test]
		fn a_tab_straddling_the_boundary_is_dropped_rather_than_emitted_whole() {
			let result = extract_segments(&to_u16("3\t"), 6, 12, 6, false, TAB_WIDTH);

			// The tab starts at column 1 and is eight cells wide, so it cannot end by
			// column 6.
			assert_eq!(from_u16(&result.before), "3");
			assert_eq!(result.before_width, 1);
		}

		/// The same shape with a two-cell character, which is how a user meets
		/// this.
		///
		/// A CJK ideograph at columns 4-5 fits; the one at 5-6 does not, and
		/// drawing half of it is not a thing a terminal can do.
		#[test]
		fn a_wide_grapheme_that_would_cross_the_boundary_is_dropped() {
			let fits = extract_segments(&to_u16("ab\u{6f22}"), 4, 8, 4, false, TAB_WIDTH);
			assert_eq!(from_u16(&fits.before), "ab\u{6f22}");
			assert_eq!(fits.before_width, 4);

			let straddles = extract_segments(&to_u16("abc\u{6f22}"), 4, 8, 4, false, TAB_WIDTH);
			assert_eq!(from_u16(&straddles.before), "abc");
			assert_eq!(straddles.before_width, 3);
		}

		/// A grapheme ENDING exactly on the boundary is kept. The fix is a clip,
		/// not an off-by-one: dropping this one would leave a blank column on
		/// every composite with wide text in it.
		#[test]
		fn a_grapheme_ending_exactly_on_the_boundary_is_kept() {
			let result = extract_segments(&to_u16("a\u{6f22}b"), 3, 6, 3, false, TAB_WIDTH);

			assert_eq!(from_u16(&result.before), "a\u{6f22}");
			assert_eq!(result.before_width, 3);
		}

		/// Narrow text is untouched, which is the overwhelmingly common case and
		/// the one a too-eager clip would silently shorten by a column.
		#[test]
		fn narrow_text_still_fills_the_boundary_exactly() {
			let result = extract_segments(&to_u16("abcdef"), 3, 6, 3, false, TAB_WIDTH);

			assert_eq!(from_u16(&result.before), "abc");
			assert_eq!(result.before_width, 3);
		}

		/// The reported width is the width of the returned text, which is what
		/// the caller pads against. A clip that dropped the text but kept the
		/// count would pad short and shift the overlay the other way.
		#[test]
		fn the_reported_before_width_matches_the_returned_text() {
			for line in ["3\t", "abc\u{6f22}", "\u{1b}[31m\u{6f22}\u{6f22}\u{1b}[0m", "a\tb\tc"] {
				let units = to_u16(line);
				for boundary in 0..12 {
					let result = extract_segments(&units, boundary, boundary + 4, 4, false, TAB_WIDTH);
					assert_eq!(
						result.before_width,
						visible_width(&result.before, TAB_WIDTH),
						"{line:?} at boundary {boundary} reported {} for {:?}",
						result.before_width,
						from_u16(&result.before),
					);
					assert!(
						result.before_width <= boundary,
						"{line:?} at boundary {boundary} produced {} cells",
						result.before_width,
					);
				}
			}
		}
	}

	#[test]
	fn test_visible_width() {
		assert_eq!(visible_width_u16(&to_u16("hello"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b[31mhello\x1b[0m"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b[38;5;196mred\x1b[0m"), DEFAULT_TAB_WIDTH), 3);
		assert_eq!(visible_width_u16(&to_u16("a\tb"), DEFAULT_TAB_WIDTH), 1 + DEFAULT_TAB_WIDTH + 1);
	}

	#[test]
	fn test_visible_width_vs16_emoji_presentation() {
		// Variation-selector-16 (U+FE0F) promotes a default-text-presentation
		// symbol to emoji presentation, which renders as 2 cells. A naive
		// per-char sum would count U+26A0 (1) + U+FE0F (0) = 1 and shift table
		// borders one column. Guards the regression where ⚠️ measured as 1.
		assert_eq!(visible_width_u16(&to_u16("\u{26A0}\u{FE0F}"), DEFAULT_TAB_WIDTH), 2); // ⚠️
		assert_eq!(visible_width_u16(&to_u16("\u{2139}\u{FE0F}"), DEFAULT_TAB_WIDTH), 2); // ℹ️
		assert_eq!(visible_width_u16(&to_u16("\u{2764}\u{FE0F}"), DEFAULT_TAB_WIDTH), 2); // ❤️
		assert_eq!(visible_width_u16(&to_u16("0\u{FE0F}\u{20E3}"), DEFAULT_TAB_WIDTH), 2); // 0️⃣ keycap
		// Bare symbol without VS16 keeps text-presentation width (1 cell).
		assert_eq!(visible_width_u16(&to_u16("\u{26A0}"), DEFAULT_TAB_WIDTH), 1);
		// Intrinsically wide emoji are unaffected.
		assert_eq!(visible_width_u16(&to_u16("\u{2705}"), DEFAULT_TAB_WIDTH), 2); // ✅
		assert_eq!(visible_width_u16(&to_u16("\u{274C}"), DEFAULT_TAB_WIDTH), 2); // ❌
	}

	#[test]
	fn test_visible_width_jamo_correction_inside_combining_cluster() {
		let jamo_cells = if cfg!(target_os = "macos") { 1 } else { 2 };
		let filler_cells = usize::from(cfg!(target_os = "macos"));
		assert_eq!(visible_width_u16(&to_u16("\u{3141}\u{0301}"), DEFAULT_TAB_WIDTH), jamo_cells);
		assert_eq!(visible_width_u16(&to_u16("\u{3164}\u{0301}"), DEFAULT_TAB_WIDTH), filler_cells);
	}

	#[test]
	fn test_osc66_visible_width_helper() {
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;s=2;Hi\x1b\\"), DEFAULT_TAB_WIDTH),
			Some(4)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;w=5;Hi\x07"), DEFAULT_TAB_WIDTH),
			Some(5)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;s=3:w=4;X\x1b\\"), DEFAULT_TAB_WIDTH),
			Some(12)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;;a\t界\x1b\\"), DEFAULT_TAB_WIDTH),
			Some(1 + DEFAULT_TAB_WIDTH + 2)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]8;;https://example.com\x07"), DEFAULT_TAB_WIDTH),
			None
		);
	}

	#[test]
	fn test_visible_width_counts_osc66_lines() {
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;s=2;Hi\x1b\\"), DEFAULT_TAB_WIDTH), 4);
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;w=5;Hi\x1b\\"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;s=3:w=4;X\x1b\\"), DEFAULT_TAB_WIDTH), 12);
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;;abc\x1b\\"), DEFAULT_TAB_WIDTH), 3);
		assert_eq!(
			visible_width_u16(&to_u16("A\x1b]66;s=2;Hi\x1b\\Z"), DEFAULT_TAB_WIDTH),
			1 + 4 + 1
		);
		assert_eq!(
			visible_width_u16(&to_u16("\x1b[31m\x1b]66;s=2;Hi\x1b\\\x1b[0m"), DEFAULT_TAB_WIDTH),
			4
		);
	}

	#[test]
	fn test_osc66_scaled_partial_slices_map_to_payload_cells() {
		let data = to_u16("\x1b]66;s=2;Hi\x1b\\");

		let (head, head_w) = slice_with_width_impl(&data, 0, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&head), "H");
		assert_eq!(head_w, 1);

		let (tail, tail_w) = slice_with_width_impl(&data, 2, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&tail), "i");
		assert_eq!(tail_w, 1);

		let (before, before_w, after, after_w) =
			extract_segments_impl(&to_u16("A\x1b]66;s=2;Hi\x1b\\Z"), 1, 3, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&before), "A");
		assert_eq!(before_w, 1);
		assert_eq!(String::from_utf16_lossy(&after), "i");
		assert_eq!(after_w, 1);
	}

	#[test]
	fn test_plain_range_keeps_ascii_base_with_combining_mark() {
		let mut out = Vec::new();
		let data = to_u16("ab\u{0301}c界");
		let (width, wrote) =
			append_visible_range_plain_u16(&mut out, &data, 1, 1, true, DEFAULT_TAB_WIDTH, |_| {});
		assert!(wrote);
		assert_eq!(width, 1);
		assert_eq!(String::from_utf16_lossy(&out), "b\u{0301}");
	}

	#[test]
	fn test_ansi_detection() {
		let data = to_u16("\x1b[31mred\x1b[0m");
		assert_eq!(ansi_seq_len_u16(&data, 0), Some(5)); // \x1b[31m
		assert_eq!(ansi_seq_len_u16(&data, 8), Some(4)); // \x1b[0m
	}

	#[test]
	fn test_slice_basic() {
		let data = to_u16("hello world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "hello");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_slice_with_ansi() {
		let data = to_u16("\x1b[31mhello\x1b[0m world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "\x1b[31mhello\x1b[0m");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_ascii_fast_path() {
		fn is_ascii(seg: &[u16]) -> bool {
			seg.iter().all(|&u| u <= 0x7f)
		}

		let ascii = to_u16("hello world 12345");
		assert!(is_ascii(&ascii));

		let non_ascii = to_u16("hello 世界");
		assert!(!is_ascii(&non_ascii));
	}

	#[test]
	fn test_early_exit() {
		let data = to_u16(&"a]b".repeat(1000));
		let (w, exceeded) = visible_width_u16_up_to(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(exceeded);
		assert!(w > 10);
	}

	/// Collect a wrap as owned `String`s so assertions read as the rendered
	/// rows.
	fn wrap_to_strings(text: &str, width: usize) -> Vec<String> {
		wrap_text_with_ansi_impl(&to_u16(text), width, DEFAULT_TAB_WIDTH)
			.into_iter()
			.map(|line| String::from_utf16_lossy(&line))
			.collect()
	}

	/// THE REGRESSION. A grapheme wider than the target used to emit a blank
	/// line before itself, because `current_width + gw > width` is true on an
	/// empty line when `gw > width`. Two characters wrapped to four rows.
	#[test]
	fn test_wrap_oversized_grapheme_does_not_emit_a_leading_blank_line() {
		assert_eq!(wrap_to_strings("漢漢", 1), vec!["漢", "漢"]);
	}

	/// The line count must equal the grapheme count. A caller sizing a viewport
	/// from `lines.len()` reserved rows for content that does not exist, and
	/// every row below the blank shifted down by one.
	#[test]
	fn test_wrap_oversized_graphemes_produce_one_line_each() {
		assert_eq!(wrap_to_strings("漢漢漢", 1), vec!["漢", "漢", "漢"]);
	}

	/// Width 0 is a real state, not a contract violation: a pane collapsed to
	/// nothing still gets asked to render. Every grapheme is oversized there, so
	/// this is the case that used to blank-line between all of them.
	#[test]
	fn test_wrap_at_width_zero_still_emits_one_line_per_grapheme() {
		assert_eq!(wrap_to_strings("ab", 0), vec!["a", "b"]);
	}

	/// A ZWJ emoji sequence is one indivisible grapheme of width 2. It must
	/// overflow a width-1 column whole, never be split at a joiner and never be
	/// preceded by a blank row.
	#[test]
	fn test_wrap_keeps_a_zwj_sequence_intact_when_it_cannot_fit() {
		let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
		assert_eq!(wrap_to_strings(family, 1), vec![family]);
	}

	/// A regional-indicator pair is likewise one grapheme. Splitting it turns a
	/// flag into two letter boxes, which is a visible corruption rather than a
	/// layout nit.
	#[test]
	fn test_wrap_keeps_a_flag_sequence_intact_when_it_cannot_fit() {
		let flag = "\u{1F1EF}\u{1F1F5}";
		assert_eq!(wrap_to_strings(flag, 1), vec![flag]);
	}

	/// The overflow is confined to the oversized grapheme. A narrow character
	/// that follows it must start a new line rather than ride along on the row
	/// that is already over budget.
	#[test]
	fn test_wrap_does_not_pack_a_narrow_char_onto_an_overflowed_line() {
		assert_eq!(wrap_to_strings("漢a", 1), vec!["漢", "a"]);
	}

	/// The mirror case: a narrow character first, then one that cannot fit. The
	/// break belongs between them, and nothing blank belongs anywhere.
	#[test]
	fn test_wrap_breaks_between_a_narrow_char_and_an_oversized_one() {
		assert_eq!(wrap_to_strings("a漢", 1), vec!["a", "漢"]);
	}

	/// THE NECESSARY TWIN. The guard must not suppress a legitimate break. When
	/// the grapheme does fit, the wrap still happens exactly where it did, so a
	/// fix that simply stopped breaking would fail here.
	#[test]
	fn test_wrap_still_breaks_when_the_grapheme_fits_the_width() {
		assert_eq!(wrap_to_strings("漢漢漢", 2), vec!["漢", "漢", "漢"]);
		assert_eq!(wrap_to_strings("漢漢漢", 4), vec!["漢漢", "漢"]);
	}

	/// ASCII takes a separate branch in `break_long_word` from the grapheme
	/// path, so it gets its own proof that ordinary long-word breaking is
	/// unchanged.
	#[test]
	fn test_wrap_ascii_long_word_breaking_is_unchanged() {
		assert_eq!(wrap_to_strings("abcdefgh", 3), vec!["abc", "def", "gh"]);
	}

	/// Empty input still yields one empty line. That is what a renderer expects
	/// for a blank row, and the guard must not turn it into zero lines.
	#[test]
	fn test_wrap_empty_text_still_yields_a_single_empty_line() {
		assert_eq!(wrap_to_strings("", 4), vec![""]);
	}

	/// THE SECOND HALF OF THE REGRESSION. The napi buffer that arrives from
	/// JavaScript ends in a NUL, and that NUL is a zero-width grapheme sitting
	/// after the last real one. On a line already at or over the width it
	/// tripped the "does not fit" break and was pushed onto a row of its own,
	/// which came back to JavaScript as a phantom empty row:
	/// `wrapTextWithAnsi("漢漢", 1)` returned three rows. The slice is built
	/// with the terminator here so the guard is proved on its own, independent
	/// of the strip at the boundary.
	#[test]
	fn test_wrap_zero_width_grapheme_does_not_open_a_new_line() {
		let mut data = to_u16("漢漢");
		data.push(0);
		let lines = wrap_text_with_ansi_impl(&data, 1, DEFAULT_TAB_WIDTH);

		assert_eq!(lines.len(), 2);
		assert_eq!(String::from_utf16_lossy(&lines[0]), "漢");
	}

	/// The same guard on the ASCII branch, which is a separate loop.
	#[test]
	fn test_wrap_zero_width_grapheme_after_ascii_does_not_open_a_new_line() {
		let mut data = to_u16("abc");
		data.push(0);
		let lines = wrap_text_with_ansi_impl(&data, 2, DEFAULT_TAB_WIDTH);

		assert_eq!(lines.len(), 2);
		assert_eq!(String::from_utf16_lossy(&lines[0]), "ab");
	}

	/// `utf16_content` is the one owner of "where does the napi buffer end".
	/// Before it existed, `truncate_to_width` stripped the terminator with an
	/// inline loop and the other four entry points did not strip it at all.
	#[test]
	fn test_utf16_content_removes_the_napi_terminator() {
		let mut data = to_u16("hello");
		data.push(0);

		assert_eq!(utf16_content(&data), to_u16("hello").as_slice());
	}

	/// A buffer that is already clean must come back unchanged, so the helper is
	/// safe to apply at every entry point rather than only the ones known to
	/// carry a terminator.
	#[test]
	fn test_utf16_content_leaves_a_clean_buffer_alone() {
		let data = to_u16("hello");

		assert_eq!(utf16_content(&data), data.as_slice());
	}

	/// An all-NUL buffer reduces to nothing rather than underflowing the index.
	#[test]
	fn test_utf16_content_handles_an_all_nul_buffer() {
		assert_eq!(utf16_content(&[0, 0, 0]), &[] as &[u16]);
		assert_eq!(utf16_content(&[]), &[] as &[u16]);
	}

	#[test]
	fn test_wrap_text_with_ansi_preserves_color() {
		let data = to_u16("\x1b[38;2;156;163;176mhello world\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 5, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		let first = String::from_utf16_lossy(&lines[0]);
		let second = String::from_utf16_lossy(&lines[1]);
		assert!(first.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.contains("world"));
	}

	#[test]
	fn test_wrap_text_with_ansi_resets_strike_without_resetting_colors() {
		let data =
			to_u16("\x1b[38;5;196m\x1b[48;5;236m\x1b[9mstrikethrough content wraps\x1b[29m\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 12, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);

		for line in &lines[..lines.len() - 1] {
			let line_text = String::from_utf16_lossy(line);
			if line_text.contains("\x1b[9m") {
				assert!(line_text.ends_with("\x1b[29m"));
				assert!(!line_text.ends_with("\x1b[0m"));
			}
		}

		for line in &lines[1..] {
			let line_text = String::from_utf16_lossy(line);
			assert!(line_text.contains("38;5;196"));
			assert!(line_text.contains("48;5;236"));
		}
	}

	#[test]
	fn test_wrap_text_with_ansi_bel_terminated_apc_is_zero_width() {
		// The TUI cursor marker is a BEL-terminated APC. A prior bug left it
		// unrecognized, so it was counted as visible width and `break_long_word`
		// spun forever on the ESC. The APC must measure zero width: a line whose
		// visible content fits the target stays on a single row.
		let data = to_u16("\x1b_pi:c\x07root-overflowx1界🙂한");
		let lines = wrap_text_with_ansi_impl(&data, 24, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 1);
		let only = String::from_utf16_lossy(&lines[0]);
		assert!(only.contains("\x1b_pi:c\x07"));
		assert!(only.contains("root-overflowx1界🙂한"));
	}

	#[test]
	fn test_wrap_text_with_ansi_apc_in_overflowing_word_terminates() {
		// Same BEL-APC embedded in content that overflows, forcing break_long_word:
		// it must terminate (keeping the zero-width marker) and every wrapped row
		// must stay within the target width.
		let data = to_u16("\x1b_pi:c\x07abcdefghijklmnopqrstuvwxyz0123456789");
		let lines = wrap_text_with_ansi_impl(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);
		let joined: String = lines.iter().map(|l| String::from_utf16_lossy(l)).collect();
		assert!(joined.contains("\x1b_pi:c\x07"));
		for line in &lines {
			assert!(visible_width_u16(line, DEFAULT_TAB_WIDTH) <= 10);
		}
	}

	#[test]
	fn test_wrap_text_with_ansi_unclassified_escape_in_long_word_terminates() {
		// Defensive: an ESC `ansi_seq_len_u16` cannot classify (here `ESC 0x01`)
		// inside an overflowing word must not spin the break loop.
		let data = to_u16("aaaaaaaaaa\x1b\u{1}bbbbbbbbbb");
		let lines = wrap_text_with_ansi_impl(&data, 4, DEFAULT_TAB_WIDTH);
		assert!(!lines.is_empty());
	}
}
