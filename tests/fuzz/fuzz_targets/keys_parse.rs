#![no_main]

//! Fuzzes terminal key sequence parsing in `veyyon-keys`.
//!
//! WHAT IS UNDER TEST. `parse_key`, `parse_kitty_sequence`, `matches_key`, and
//! `matches_legacy_sequence` turn the bytes a terminal wrote into a key
//! identifier. Underneath them is hand-written index arithmetic over a byte
//! slice: `parse_digits(bytes, idx, end)`, `parse_csi_u`, `parse_csi_1_letter`,
//! `parse_functional`, `parse_modify_other_keys`, each walking a buffer looking
//! for semicolons and terminators at particular offsets.
//!
//! WHY THIS IS THE HIGHEST-RISK PARSER IN THE PROJECT. The input is not a file
//! or a config, it is whatever the terminal emulator writes to the pty, and it
//! arrives a chunk at a time. So every sequence can be truncated anywhere,
//! interleaved with paste content, or simply be an escape sequence from a
//! terminal nobody tested against. A panic here is the whole editor going down
//! on a keystroke.
//!
//! WHY IT COULD NOT BE FUZZED BEFORE. This code lived inside `veyyon-natives`,
//! which is `crate-type = ["cdylib"]` with `#[napi]` entry points, so nothing
//! could link it. It was moved to `veyyon-keys` for exactly this target.
//!
//! THE PROPERTIES BEYOND "IT DID NOT PANIC". A parser that agrees with itself
//! matters as much as one that does not crash: `matches_key` and `parse_key`
//! are two views of the same decision and the input layer trusts both, so if
//! `parse_key` says a sequence is `ctrl+a` then `matches_key(.., "ctrl+a")` has
//! to agree. Silent disagreement is a key that reports as pressed and does not
//! fire, which nobody would ever trace back to here.

use libfuzzer_sys::fuzz_target;
use veyyon_keys::{
	matches_key, matches_kitty_sequence, matches_legacy_sequence, parse_key, parse_kitty_sequence,
};

/// Key identifiers to match against, covering each branch of the id parser:
/// named keys, modifier combinations, the collision cases where a control byte
/// and a named key are the same byte, and a couple that should never match.
const KEY_IDS: &[&str] = &[
	"escape",
	"enter",
	"tab",
	"backspace",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"delete",
	"insert",
	"f1",
	"f12",
	"ctrl+a",
	"ctrl+c",
	"ctrl+m",
	"ctrl+i",
	"ctrl+[",
	"shift+tab",
	"alt+enter",
	"ctrl+shift+a",
	"super+k",
	"a",
	"",
	"not-a-key",
];

/// Cap on input length. These sequences are a handful of bytes; a long input is
/// a slow execution rather than a new code path.
const MAX_INPUT: usize = 64;

fuzz_target!(|input: (bool, u8, Vec<u8>)| {
	let (kitty_active, selector, data) = input;
	if data.len() > MAX_INPUT {
		return;
	}

	// The four entry points, on raw bytes. None may panic for any input,
	// including empty, truncated mid-sequence, and non-UTF-8.
	let parsed = parse_key(&data, kitty_active);
	let kitty = parse_kitty_sequence(&data);
	let key_id = KEY_IDS[usize::from(selector) % KEY_IDS.len()];
	let matched = matches_key(&data, key_id, kitty_active);
	let _ = matches_legacy_sequence(&data, key_id);

	// Parsing is a pure function of its inputs, and the input layer caches on
	// that assumption.
	assert_eq!(parse_key(&data, kitty_active), parsed, "parse_key is not deterministic");
	assert_eq!(parse_kitty_sequence(&data), kitty, "parse_kitty_sequence is not deterministic");

	// The two views must agree. `matches_key` answering "no" for the very id
	// `parse_key` just produced is a key that reads as pressed and does not fire.
	if let Some(identifier) = parsed.as_deref() {
		assert!(!identifier.is_empty(), "parse_key returned an empty key id for {data:?}",);
		assert!(
			matches_key(&data, identifier, kitty_active),
			"parse_key said {data:?} is {identifier:?}, but matches_key disagrees",
		);
	}

	// A match against an id that parsing rejected outright is the same
	// disagreement from the other side.
	if matched && !key_id.is_empty() {
		assert!(
			parsed.is_some(),
			"matches_key accepted {data:?} as {key_id:?}, but parse_key found no key at all",
		);
	}

	// A Kitty sequence that parsed must match its own codepoint and modifier.
	// This is the round trip through the third entry point, and it is what the
	// keybinding layer relies on when it compares a binding to a keypress.
	if let Some(sequence) = kitty {
		assert!(
			matches_kitty_sequence(&data, sequence.codepoint, sequence.modifier),
			"a parsed Kitty sequence {sequence:?} does not match its own codepoint and modifier",
		);
	}

	// The legacy table is exact: a sequence it recognizes matches that name and
	// no other. Checked against every id so a table entry cannot answer for two.
	let recognized: Vec<&str> = KEY_IDS
		.iter()
		.copied()
		.filter(|id| matches_legacy_sequence(&data, id))
		.collect();
	assert!(recognized.len() <= 1, "{data:?} matched more than one legacy key name: {recognized:?}",);
});
