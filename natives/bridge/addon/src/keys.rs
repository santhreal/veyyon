//! N-API surface for terminal key sequence parsing.
//!
//! # Overview
//! Parses Kitty keyboard protocol sequences and matches codepoints plus
//! modifiers.
//!
//! # Example
//! ```ignore
//! // JS: native.matchesKittySequence("\x1b[65;5u", 65, 4) -> true
//! // JS: native.parseKey("\x1b[65;5u", false) -> "ctrl+a"
//! ```
//!
//! WHAT IS AND IS NOT HERE. The parsing lives in `veyyon-keys`, an ordinary
//! `rlib` this file wraps. Only the JS boundary is here: the `#[napi]` types,
//! and the conversion from the owned `String` that arrives from JS to the
//! borrowed bytes the parser takes.
//!
//! It was split because this crate is `crate-type = ["cdylib"]` and its
//! functions are `#[napi]` entry points, so nothing could link the parser: not
//! a benchmark, not a fuzz target. Its only real coverage was through
//! JavaScript, and it is byte-level index arithmetic over input written by a
//! terminal, which is the exact shape that wants a fuzzer pointed at it.
//! `fuzz/fuzz_targets/keys_parse.rs` now drives `veyyon-keys` directly.
//!
//! KEEP THIS FILE THIN. Anything that decides what a byte sequence means
//! belongs in `veyyon-keys`, where it can be tested and fuzzed. Logic added
//! here is logic no fuzzer can reach.

use napi_derive::napi;

/// Event types from Kitty keyboard protocol (flag 2).
#[napi]
pub enum KeyEventType {
	/// Key press event.
	Press   = 1,
	/// Key repeat event.
	Repeat  = 2,
	/// Key release event.
	Release = 3,
}

impl From<veyyon_keys::KeyEventType> for KeyEventType {
	fn from(value: veyyon_keys::KeyEventType) -> Self {
		match value {
			veyyon_keys::KeyEventType::Press => Self::Press,
			veyyon_keys::KeyEventType::Repeat => Self::Repeat,
			veyyon_keys::KeyEventType::Release => Self::Release,
		}
	}
}

/// Parsed Kitty keyboard protocol sequence result for a Kitty input sequence.
#[napi(object)]
pub struct ParsedKittyResult {
	/// Primary codepoint associated with the key.
	pub codepoint:       i32,
	/// Optional shifted key codepoint from the sequence.
	pub shifted_key:     Option<i32>,
	/// Optional base layout key codepoint from the sequence.
	pub base_layout_key: Option<i32>,
	/// Modifier bitmask (shift/alt/ctrl), excluding lock bits.
	pub modifier:        u32,
	/// Optional event type (1 = press, 2 = repeat, 3 = release).
	pub event_type:      Option<KeyEventType>,
}

impl From<veyyon_keys::ParsedKittyResult> for ParsedKittyResult {
	fn from(value: veyyon_keys::ParsedKittyResult) -> Self {
		Self {
			codepoint:       value.codepoint,
			shifted_key:     value.shifted_key,
			base_layout_key: value.base_layout_key,
			modifier:        value.modifier,
			event_type:      value.event_type.map(Into::into),
		}
	}
}

/// Match Kitty protocol input against a codepoint and modifier mask.
///
/// Returns true when the parsed sequence matches the expected codepoint (or
/// base layout key) and modifier bits.
#[napi]
pub fn matches_kitty_sequence(
	data: String,
	expected_codepoint: i32,
	expected_modifier: u32,
) -> bool {
	veyyon_keys::matches_kitty_sequence(data.as_bytes(), expected_codepoint, expected_modifier)
}

/// Parse terminal input and return a normalized key identifier.
///
/// Returns a key id like "escape" or "ctrl+c", or None if unrecognized.
#[napi]
pub fn parse_key(data: String, kitty_protocol_active: bool) -> Option<String> {
	veyyon_keys::parse_key(data.as_bytes(), kitty_protocol_active).map(std::borrow::Cow::into_owned)
}

/// Check if input matches a legacy escape sequence for the given key name.
///
/// Returns true only when the byte sequence maps to the exact key identifier.
#[napi]
pub fn matches_legacy_sequence(data: String, key_name: String) -> bool {
	veyyon_keys::matches_legacy_sequence(data.as_bytes(), &key_name)
}

/// Match input data against a key identifier string.
///
/// Returns true when the bytes represent the specified key with modifiers.
#[napi]
pub fn matches_key(data: String, key_id: String, kitty_protocol_active: bool) -> bool {
	veyyon_keys::matches_key(data.as_bytes(), &key_id, kitty_protocol_active)
}

/// Parse a Kitty keyboard protocol sequence.
///
/// Returns a structured parse result when the input is a valid Kitty sequence.
#[napi]
pub fn parse_kitty_sequence(data: String) -> Option<ParsedKittyResult> {
	veyyon_keys::parse_kitty_sequence(data.as_bytes()).map(Into::into)
}
