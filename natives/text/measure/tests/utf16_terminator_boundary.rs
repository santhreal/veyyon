//! The NUL terminator is a transport detail, never content.
//!
//! WHAT THE BOUNDARY IS. JavaScript hands this crate a UTF-16 buffer through
//! napi, and `JsString::into_utf16` ends that buffer with a NUL. On the way
//! back out, napi builds the JS string from the whole vector with an explicit
//! length, so anything left in it becomes a character the caller can see. The
//! two directions therefore need the same rule, applied in opposite order:
//! strip the terminator coming in, do not add one going out.
//!
//! THE BUG. The outbound half was written believing napi wanted a
//! NUL-terminated buffer, so it appended one. Every string the text layer
//! returned then carried a trailing NUL. `truncateToWidth("hello world", 5,
//! Omit)` answered six code units for a five-cell budget, `wrapTextWithAnsi`
//! returned rows a terminal cannot store, and the renderer's viewport-fidelity
//! oracle failed on the very first frame because the frame row held a character
//! the terminal had dropped. About 149 cases across the TUI suite failed at
//! once, all of them this.
//!
//! WHY THE RULE HAS ONE OWNER. The inbound side was already correct and had
//! been correct for a while; the two sides disagreed because each carried its
//! own idea of where the content ended. `utf16_content_len` is now that idea,
//! written once, and this file pins it. These tests sit in `tests/` rather than
//! in the crate's inline `mod tests` on purpose: an integration test can only
//! see the public surface, so it also proves the rule is reachable by the napi
//! wrapper that has to call it.

use veyyon_text::utf16_content_len;

/// A trailing NUL is not content, so the reported length excludes it.
///
/// This is the exact shape `JsString::into_utf16` produces, and the shape the
/// outbound wrapper must undo rather than reproduce.
#[test]
fn a_single_trailing_nul_is_excluded() {
	let buffer: Vec<u16> = "hi".encode_utf16().chain(std::iter::once(0)).collect();
	assert_eq!(utf16_content_len(&buffer), 2, "the NUL terminator is transport, not text");
	assert_eq!(&buffer[..utf16_content_len(&buffer)], &[b'h' as u16, b'i' as u16]);
}

/// Several trailing NULs are all excluded, not just the last one.
///
/// A single `pop` would have looked correct against every one-terminator case
/// and left a NUL behind the moment a buffer round-tripped twice, which is
/// precisely how the appended terminator survived review.
#[test]
fn a_run_of_trailing_nuls_is_excluded_entirely() {
	let buffer: Vec<u16> = "hi".encode_utf16().chain([0, 0, 0]).collect();
	assert_eq!(utf16_content_len(&buffer), 2, "every trailing NUL is transport");
}

/// A buffer that is nothing but NULs has no content at all.
#[test]
fn a_buffer_of_only_nuls_has_no_content() {
	assert_eq!(utf16_content_len(&[0, 0, 0]), 0);
}

/// An empty buffer is already content-length zero and must not underflow.
///
/// The scan walks backwards from the end, so the empty case is the one that
/// wraps a `usize` if the bound is written wrongly.
#[test]
fn an_empty_buffer_reports_zero_rather_than_underflowing() {
	assert_eq!(utf16_content_len(&[]), 0);
}

/// A buffer with no terminator is returned whole.
///
/// The outbound direction hands over engine output, which carries no terminator
/// of its own, so this is the case the wrapper hits on nearly every call. It
/// has to be a no-op there, or trimming would eat real text.
#[test]
fn a_buffer_without_a_terminator_keeps_every_code_unit() {
	let buffer: Vec<u16> = "hello".encode_utf16().collect();
	assert_eq!(utf16_content_len(&buffer), 5, "nothing to strip means nothing is stripped");
}

/// A NUL in the middle is content and stays.
///
/// The rule is about the terminator, which lives at the end. Stripping interior
/// NULs would silently shorten a string the caller deliberately built, and the
/// scan must stop at the first non-NUL from the right to guarantee that.
#[test]
fn an_interior_nul_is_left_alone() {
	let buffer: Vec<u16> = [b'a' as u16, 0, b'b' as u16].to_vec();
	assert_eq!(utf16_content_len(&buffer), 3, "only the tail is transport");
}

/// An interior NUL followed by a terminator loses only the terminator.
///
/// The adversarial twin of the two tests above: get the boundary wrong in
/// either direction and exactly one of them fails.
#[test]
fn an_interior_nul_survives_while_the_terminator_does_not() {
	let buffer: Vec<u16> = [b'a' as u16, 0, b'b' as u16, 0].to_vec();
	assert_eq!(utf16_content_len(&buffer), 3);
	assert_eq!(&buffer[..utf16_content_len(&buffer)], &[b'a' as u16, 0, b'b' as u16]);
}

/// Trimming twice gives the same answer as trimming once.
///
/// This is the property that makes the rule safe to apply at both ends of the
/// boundary. The old code was not idempotent in the other direction: appending
/// a terminator to an already-terminated buffer grew it every trip.
#[test]
fn trimming_is_idempotent() {
	let buffer: Vec<u16> = "hi".encode_utf16().chain([0, 0]).collect();
	let once = &buffer[..utf16_content_len(&buffer)];
	assert_eq!(utf16_content_len(once), once.len(), "a trimmed buffer is already trimmed");
}

/// A lone high surrogate at the end is text, not a terminator.
///
/// Unpaired surrogates are legal in a JavaScript string and reach this layer
/// intact. A rule written against "trailing code unit that looks unusual"
/// rather than against NUL specifically would truncate them.
#[test]
fn an_unpaired_surrogate_is_not_mistaken_for_a_terminator() {
	let buffer: Vec<u16> = [b'a' as u16, 0xd800].to_vec();
	assert_eq!(utf16_content_len(&buffer), 2, "only U+0000 terminates");
}
