//! The boundary population every combinatorial family draws from.
//!
//! Boundaries are where the product's own arithmetic and its parsers stop
//! agreeing with each other: the empty input, the single-element input, the
//! last value that fits and the one that does not, and bytes that are not text.
//! They are declared once, here, because a family that writes its own list
//! picks the three it happened to think of, and the fourth is the one that
//! ships broken.
//!
//! These are values, not cases. A family maps them onto whichever axis it owns
//! — a row count, a column width, a token budget, a file body — and the name is
//! what lands in `dimensions`, so a failing case says `width=max` rather than
//! `width=4294967295`.

/// The numeric boundaries, with the names they occupy in a dimension map.
///
/// `u32` because the product's counted quantities are terminal columns, rows,
/// token counts and byte lengths, none of which is negative and all of which
/// are compared against 32-bit limits somewhere in the native layer. The pair
/// at the top of the range is what catches an off-by-one in a clamp: `MAX`
/// alone passes a `>= MAX` check that `MAX - 1` fails.
pub const NUMERIC: [(&str, u32); 4] =
	[("zero", 0), ("one", 1), ("max-minus-one", u32::MAX - 1), ("max", u32::MAX)];

/// How large a "large" text boundary is.
///
/// 64 KiB, because that is the size that crosses a pipe buffer, a terminal
/// scroll region and a provider chunk boundary at the same time. A smaller
/// payload fits in one write everywhere and proves nothing about reassembly.
pub const LARGE_TEXT_BYTES: usize = 64 * 1024;

/// A named byte payload a family can hand to a stimulus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextBoundary {
	pub name:  &'static str,
	pub bytes: Vec<u8>,
}

/// The text boundaries, in the order they are declared.
///
/// The non-UTF-8 member is deliberate and is not a curiosity: a lone
/// continuation byte is what a provider stream delivers when a multi-byte
/// character is split across two chunks, and a decoder that assumes valid text
/// panics on it rather than reassembling.
#[must_use]
pub fn text() -> Vec<TextBoundary> {
	vec![
		TextBoundary { name: "empty", bytes: Vec::new() },
		TextBoundary { name: "one-byte", bytes: b"a".to_vec() },
		TextBoundary { name: "large", bytes: vec![b'a'; LARGE_TEXT_BYTES] },
		// A truncated three-byte sequence: the first byte announces two
		// continuations and only one arrives.
		TextBoundary { name: "non-utf8-truncated", bytes: vec![0xe2, 0x82] },
		// A continuation byte with nothing to continue, which is the other half
		// of the same split.
		TextBoundary { name: "non-utf8-stray-continuation", bytes: vec![0xac] },
	]
}
