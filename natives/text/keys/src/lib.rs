//! Terminal key sequence parsing: the Kitty keyboard protocol, the legacy
//! escape sequences, and the mapping from either to a normalized key id.
//!
//! You give it the bytes a terminal wrote and it tells you which key that was:
//!
//! ```
//! use veyyon_keys::parse_key;
//!
//! // A legacy escape sequence, and a control byte.
//! assert_eq!(parse_key(b"\x1b[A", false).as_deref(), Some("up"));
//! assert_eq!(parse_key(b"\x7f", false).as_deref(), Some("backspace"));
//! assert_eq!(parse_key(b"\x03", false).as_deref(), Some("ctrl+c"));
//!
//! // The Kitty protocol carries the codepoint, so the case you get back is the
//! // case the terminal sent: 97 is `a` and 65 is `A`. The module doc used to
//! // claim the second of these was `ctrl+a`, and this example is why it no
//! // longer does.
//! assert_eq!(parse_key(b"\x1b[97;5u", true).as_deref(), Some("ctrl+a"));
//! assert_eq!(parse_key(b"\x1b[65;5u", true).as_deref(), Some("ctrl+A"));
//!
//! // Nothing recognizable, including a sequence cut off mid-way.
//! assert_eq!(parse_key(b"\x1b[65;5", true), None);
//! ```
//!
//! WHY THIS IS ITS OWN CRATE. It used to live inside `veyyon-natives`, which is
//! declared `crate-type = ["cdylib"]` and whose functions are `#[napi]` entry
//! points. Nothing could link it: not `cargo test`, not a benchmark, and not a
//! fuzz target. So the only coverage this parser had was through JavaScript,
//! and the code is byte-level index arithmetic over input written by a
//! terminal, which is the exact shape that wants a fuzzer pointed at it.
//!
//! Everything here is pure and takes borrowed bytes. `veyyon-natives` keeps a
//! thin `#[napi]` wrapper in `src/keys.rs` that converts to and from the JS
//! types, and `fuzz/fuzz_targets/keys_parse.rs` drives this crate directly.

use std::borrow::Cow;

use phf::phf_map;

const LOCK_MASK: u32 = 64 + 128;

// Internal sentinel codes for CSI 1;mod <letter> forms:
const ARROW_UP: i32 = -1;
const ARROW_DOWN: i32 = -2;
const ARROW_RIGHT: i32 = -3;
const ARROW_LEFT: i32 = -4;

const FUNC_DELETE: i32 = -10;
const FUNC_INSERT: i32 = -11;
const FUNC_PAGE_UP: i32 = -12;
const FUNC_PAGE_DOWN: i32 = -13;
const FUNC_HOME: i32 = -14;
const FUNC_END: i32 = -15;
const FUNC_CLEAR: i32 = -16;

const FUNC_F1: i32 = -20;
const FUNC_F2: i32 = -21;
const FUNC_F3: i32 = -22;
const FUNC_F4: i32 = -23;
const FUNC_F5: i32 = -24;
const FUNC_F6: i32 = -25;
const FUNC_F7: i32 = -26;
const FUNC_F8: i32 = -27;
const FUNC_F9: i32 = -28;
const FUNC_F10: i32 = -29;
const FUNC_F11: i32 = -30;
const FUNC_F12: i32 = -31;

const CP_ESCAPE: i32 = 27;
const CP_TAB: i32 = 9;
const CP_ENTER: i32 = 13;
const CP_SPACE: i32 = 32;
const CP_BACKSPACE: i32 = 127;
const CP_KP_0: i32 = 57399;
const CP_KP_1: i32 = 57400;
const CP_KP_2: i32 = 57401;
const CP_KP_3: i32 = 57402;
const CP_KP_4: i32 = 57403;
const CP_KP_5: i32 = 57404;
const CP_KP_6: i32 = 57405;
const CP_KP_7: i32 = 57406;
const CP_KP_8: i32 = 57407;
const CP_KP_9: i32 = 57408;
const CP_KP_DECIMAL: i32 = 57409;
const CP_KP_DIVIDE: i32 = 57410;
const CP_KP_MULTIPLY: i32 = 57411;
const CP_KP_SUBTRACT: i32 = 57412;
const CP_KP_ADD: i32 = 57413;
const CP_KP_ENTER: i32 = 57414;
const CP_KP_EQUALS: i32 = 57415;

const MOD_SHIFT: u32 = 1;
const MOD_ALT: u32 = 2;
const MOD_CTRL: u32 = 4;
const MOD_SUPER: u32 = 8;

/// The modifier bits this crate can name in a key id.
///
/// The enhanced encodings also define hyper (16) and meta (32). Nothing binds
/// them, and `format_with_mods` has no spelling for them, so a sequence
/// carrying one cannot be turned into an id that would match it again.
const NAMEABLE_MODS: u32 = MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_SUPER;

/// True when two modifier sets describe the same keypress.
///
/// Caps Lock (64) and Num Lock (128) are STATE, not modifiers a binding names,
/// and `parse_key` strips them before it spells an id. A comparison that did
/// not strip them therefore refused ids parsing had just produced:
/// `\x1b[27;78;88` carries wire modifier 77, which is Shift+Ctrl+Super with
/// Caps Lock on, and parsing spelled it `shift+ctrl+super+X` while the
/// modifyOtherKeys comparator tested the raw 77 against the 13 that id parses
/// back to. The kitty comparator had always stripped the mask and the
/// modifyOtherKeys one had not, which is the whole bug. Found by
/// `fuzz/fuzz_targets/keys_parse.rs`.
#[inline]
const fn modifiers_match(actual: u32, expected: u32) -> bool {
	actual & !LOCK_MASK == expected & !LOCK_MASK
}

/// True when every modifier bit in `modifier` has a spelling.
///
/// Parsing REFUSES a sequence that fails this rather than dropping the bit it
/// cannot spell, because dropping it produces an id for a key the user did not
/// press: `\x1b[27;27;89` is Hyper+Alt+Super+Y, and formatting it while
/// ignoring hyper answered `alt+super+Y`, which `matches_key` then refused
/// because the wire modifier was still 26. The key read as pressed and no
/// binding could fire on it, and had one fired it would have been the wrong
/// binding. Found by `fuzz/fuzz_targets/keys_parse.rs`.
///
/// The kitty path had this rule inline and the modifyOtherKeys path did not,
/// which is why it is a named predicate now: two encodings of the same idea
/// have to answer the same way.
#[inline]
const fn modifiers_are_nameable(modifier: u32) -> bool {
	modifier & !LOCK_MASK & !NAMEABLE_MODS == 0
}
const MOD_NUM_LOCK: u32 = 128;

/// Event types from Kitty keyboard protocol (flag 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyEventType {
	/// Key press event.
	Press   = 1,
	/// Key repeat event.
	Repeat  = 2,
	/// Key release event.
	Release = 3,
}

#[inline]
fn optional_kitty_event_type(event: Option<u32>) -> Option<KeyEventType> {
	event.and_then(|ev| match ev {
		1 => Some(KeyEventType::Press),
		2 => Some(KeyEventType::Repeat),
		3 => Some(KeyEventType::Release),
		_ => None,
	})
}

#[inline]
const fn map_keypad_nav(codepoint: i32) -> Option<i32> {
	match codepoint {
		CP_KP_0 => Some(FUNC_INSERT),
		CP_KP_1 => Some(FUNC_END),
		CP_KP_2 => Some(ARROW_DOWN),
		CP_KP_3 => Some(FUNC_PAGE_DOWN),
		CP_KP_4 => Some(ARROW_LEFT),
		CP_KP_5 => Some(FUNC_CLEAR),
		CP_KP_6 => Some(ARROW_RIGHT),
		CP_KP_7 => Some(FUNC_HOME),
		CP_KP_8 => Some(ARROW_UP),
		CP_KP_9 => Some(FUNC_PAGE_UP),
		CP_KP_DECIMAL => Some(FUNC_DELETE),
		_ => None,
	}
}

#[inline]
const fn keypad_num_lock_text_codepoint(codepoint: i32) -> Option<i32> {
	match codepoint {
		CP_KP_0 => Some(48),
		CP_KP_1 => Some(49),
		CP_KP_2 => Some(50),
		CP_KP_3 => Some(51),
		CP_KP_4 => Some(52),
		CP_KP_5 => Some(53),
		CP_KP_6 => Some(54),
		CP_KP_7 => Some(55),
		CP_KP_8 => Some(56),
		CP_KP_9 => Some(57),
		CP_KP_DECIMAL => Some(46),
		_ => None,
	}
}

#[inline]
const fn keypad_operator_text_codepoint(codepoint: i32) -> Option<i32> {
	match codepoint {
		CP_KP_DIVIDE => Some(47),
		CP_KP_MULTIPLY => Some(42),
		CP_KP_SUBTRACT => Some(45),
		CP_KP_ADD => Some(43),
		CP_KP_EQUALS => Some(61),
		_ => None,
	}
}

/// Parsed Kitty keyboard protocol sequence (subset we care about).
struct ParsedKittySequence {
	codepoint:       i32,
	shifted_key:     Option<i32>,
	base_layout_key: Option<i32>,
	text_codepoint:  Option<i32>,
	modifier:        u32,
	event_type:      Option<u32>,
}

/// Parsed Kitty keyboard protocol sequence result for a Kitty input sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Perfect hash map for legacy sequences - O(1) lookup
static LEGACY_SEQUENCES: phf::Map<&'static [u8], &'static str> = phf_map! {
	// Arrow keys (SS3 and CSI)
	b"\x1bOA" => "up", b"\x1bOB" => "down", b"\x1bOC" => "right", b"\x1bOD" => "left",
	b"\x1b[A" => "up", b"\x1b[B" => "down", b"\x1b[C" => "right", b"\x1b[D" => "left",
	// Home/End (multiple terminal variants)
	b"\x1bOH" => "home", b"\x1bOF" => "end",
	b"\x1b[H" => "home", b"\x1b[F" => "end",
	b"\x1b[1~" => "home", b"\x1b[7~" => "home",
	b"\x1b[4~" => "end", b"\x1b[8~" => "end",
	// Clear
	b"\x1b[E" => "clear", b"\x1bOE" => "clear", b"\x1bOe" => "ctrl+clear", b"\x1b[e" => "shift+clear",
	// Insert/Delete
	b"\x1b[2~" => "insert", b"\x1b[2$" => "shift+insert", b"\x1b[2^" => "ctrl+insert",
	b"\x1b[3~" => "delete", b"\x1b[3$" => "shift+delete", b"\x1b[3^" => "ctrl+delete",
	// Page Up/Down
	b"\x1b[5~" => "pageUp", b"\x1b[6~" => "pageDown",
	b"\x1b[[5~" => "pageUp", b"\x1b[[6~" => "pageDown",
	// Shift+arrow
	b"\x1b[a" => "shift+up", b"\x1b[b" => "shift+down", b"\x1b[c" => "shift+right", b"\x1b[d" => "shift+left",
	// Ctrl+arrow
	b"\x1bOa" => "ctrl+up", b"\x1bOb" => "ctrl+down", b"\x1bOc" => "ctrl+right", b"\x1bOd" => "ctrl+left",
	// Shift+page/home/end
	b"\x1b[5$" => "shift+pageUp", b"\x1b[6$" => "shift+pageDown",
	b"\x1b[7$" => "shift+home", b"\x1b[8$" => "shift+end",
	// Ctrl+page/home/end
	b"\x1b[5^" => "ctrl+pageUp", b"\x1b[6^" => "ctrl+pageDown",
	b"\x1b[7^" => "ctrl+home", b"\x1b[8^" => "ctrl+end",
	// Function keys (SS3, CSI tilde, Linux console)
	b"\x1bOP" => "f1", b"\x1bOQ" => "f2", b"\x1bOR" => "f3", b"\x1bOS" => "f4",
	b"\x1b[11~" => "f1", b"\x1b[12~" => "f2", b"\x1b[13~" => "f3", b"\x1b[14~" => "f4",
	b"\x1b[[A" => "f1", b"\x1b[[B" => "f2", b"\x1b[[C" => "f3", b"\x1b[[D" => "f4", b"\x1b[[E" => "f5",
	b"\x1b[15~" => "f5", b"\x1b[17~" => "f6", b"\x1b[18~" => "f7", b"\x1b[19~" => "f8",
	b"\x1b[20~" => "f9", b"\x1b[21~" => "f10", b"\x1b[23~" => "f11", b"\x1b[24~" => "f12",
};

/// Pre-allocated single ASCII printable characters (33-126)
static ASCII_PRINTABLE: [&str; 94] = [
	"!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/", "0", "1", "2", "3",
	"4", "5", "6", "7", "8", "9", ":", ";", "<", "=", ">", "?", "@", "A", "B", "C", "D", "E", "F",
	"G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y",
	"Z", "[", "\\", "]", "^", "_", "`", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l",
	"m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "{", "|", "}", "~",
];

/// Pre-allocated modifier+letter combinations
static CTRL_LETTERS: [&str; 26] = [
	"ctrl+a", "ctrl+b", "ctrl+c", "ctrl+d", "ctrl+e", "ctrl+f", "ctrl+g", "ctrl+h", "ctrl+i",
	"ctrl+j", "ctrl+k", "ctrl+l", "ctrl+m", "ctrl+n", "ctrl+o", "ctrl+p", "ctrl+q", "ctrl+r",
	"ctrl+s", "ctrl+t", "ctrl+u", "ctrl+v", "ctrl+w", "ctrl+x", "ctrl+y", "ctrl+z",
];

static ALT_LETTERS: [&str; 26] = [
	"alt+a", "alt+b", "alt+c", "alt+d", "alt+e", "alt+f", "alt+g", "alt+h", "alt+i", "alt+j",
	"alt+k", "alt+l", "alt+m", "alt+n", "alt+o", "alt+p", "alt+q", "alt+r", "alt+s", "alt+t",
	"alt+u", "alt+v", "alt+w", "alt+x", "alt+y", "alt+z",
];

static CTRL_ALT_LETTERS: [&str; 26] = [
	"ctrl+alt+a",
	"ctrl+alt+b",
	"ctrl+alt+c",
	"ctrl+alt+d",
	"ctrl+alt+e",
	"ctrl+alt+f",
	"ctrl+alt+g",
	"ctrl+alt+h",
	"ctrl+alt+i",
	"ctrl+alt+j",
	"ctrl+alt+k",
	"ctrl+alt+l",
	"ctrl+alt+m",
	"ctrl+alt+n",
	"ctrl+alt+o",
	"ctrl+alt+p",
	"ctrl+alt+q",
	"ctrl+alt+r",
	"ctrl+alt+s",
	"ctrl+alt+t",
	"ctrl+alt+u",
	"ctrl+alt+v",
	"ctrl+alt+w",
	"ctrl+alt+x",
	"ctrl+alt+y",
	"ctrl+alt+z",
];

static ALT_SHIFT_LETTERS: [&str; 26] = [
	"alt+shift+a",
	"alt+shift+b",
	"alt+shift+c",
	"alt+shift+d",
	"alt+shift+e",
	"alt+shift+f",
	"alt+shift+g",
	"alt+shift+h",
	"alt+shift+i",
	"alt+shift+j",
	"alt+shift+k",
	"alt+shift+l",
	"alt+shift+m",
	"alt+shift+n",
	"alt+shift+o",
	"alt+shift+p",
	"alt+shift+q",
	"alt+shift+r",
	"alt+shift+s",
	"alt+shift+t",
	"alt+shift+u",
	"alt+shift+v",
	"alt+shift+w",
	"alt+shift+x",
	"alt+shift+y",
	"alt+shift+z",
];

static LETTERS: [&str; 26] = [
	"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s",
	"t", "u", "v", "w", "x", "y", "z",
];

// =============================================================================
// Public API
// =============================================================================

/// Match Kitty protocol input against a codepoint and modifier mask.
///
/// Returns true when the parsed sequence matches the expected codepoint (or
/// base layout key) and modifier bits.
#[must_use]
pub fn matches_kitty_sequence(
	data: &[u8],
	expected_codepoint: i32,
	expected_modifier: u32,
) -> bool {
	let Some(parsed) = parse_kitty_sequence_bytes(data) else {
		return false;
	};

	if !modifiers_match(parsed.modifier, expected_modifier) {
		return false;
	}

	if parsed.codepoint == expected_codepoint {
		return true;
	}

	// Only fall back to base layout key when the codepoint is NOT already a
	// recognized ASCII letter (A-Z / a-z) or symbol. This prevents remapped layouts
	// (Dvorak, Colemak) from causing false matches.
	if let Some(base) = parsed.base_layout_key
		&& base == expected_codepoint
	{
		let cp = parsed.codepoint;
		let is_ascii_letter = u8::try_from(cp)
			.ok()
			.is_some_and(|b| b.is_ascii_alphabetic());
		let is_known_symbol = is_symbol_key(cp);
		if !is_ascii_letter && !is_known_symbol {
			return true;
		}
	}

	false
}

/// Check if a codepoint corresponds to a known symbol key.
#[inline]
const fn is_symbol_key(cp: i32) -> bool {
	matches!(
		cp,
		96  | // `
			34  | // "
			45  | // -
		61  | // =
		91  | // [
		93  | // ]
		92  | // \
		59  | // ;
		39  | // '
		44  | // ,
		46  | // .
		47  | // /
		33  | // !
		64  | // @
		35  | // #
		36  | // $
		37  | // %
		94  | // ^
		38  | // &
		42  | // *
		40  | // (
		41  | // )
		95  | // _
		43  | // +
		124 | // |
		126 | // ~
		123 | // {
		125 | // }
		58  | // :
		60  | // <
		62  | // >
		63 // ?
	)
}

/// Parse terminal input and return a normalized key identifier.
///
/// Returns a key id like "escape" or "ctrl+c", or None if unrecognized.
#[must_use]
pub fn parse_key(data: &[u8], kitty_protocol_active: bool) -> Option<Cow<'static, str>> {
	parse_key_inner(data, kitty_protocol_active)
}

/// Check if input matches a legacy escape sequence for the given key name.
///
/// Returns true only when the byte sequence maps to the exact key identifier.
#[must_use]
pub fn matches_legacy_sequence(data: &[u8], key_name: &str) -> bool {
	LEGACY_SEQUENCES.get(data).is_some_and(|&id| id == key_name)
}

/// Match input data against a key identifier string.
///
/// Returns true when the bytes represent the specified key with modifiers.
#[must_use]
pub fn matches_key(data: &[u8], key_id: &str, kitty_protocol_active: bool) -> bool {
	matches_key_inner(data, key_id, kitty_protocol_active)
}

/// Parse a Kitty keyboard protocol sequence.
///
/// Returns a structured parse result when the input is a valid Kitty sequence.
#[must_use]
pub fn parse_kitty_sequence(data: &[u8]) -> Option<ParsedKittyResult> {
	parse_kitty_sequence_bytes(data).map(|p| ParsedKittyResult {
		codepoint:       p.codepoint,
		shifted_key:     p.shifted_key,
		base_layout_key: p.base_layout_key,
		modifier:        p.modifier,
		event_type:      optional_kitty_event_type(p.event_type),
	})
}

// =============================================================================
// Key Matching
// =============================================================================

struct ParsedKeyId<'a> {
	key:      &'a str,
	modifier: u32,
}

fn parse_key_id(key_id: &str) -> Option<ParsedKeyId<'_>> {
	let s = key_id.trim();
	if s.is_empty() {
		return None;
	}

	// Support plus key as "++" or "ctrl++" etc.
	// In this case the trailing "++" means: delimiter '+' + key '+'
	let (prefix, forced_key_plus): (&str, bool) = if s == "+" {
		("", true)
	} else if let Some(stripped) = s.strip_suffix("++") {
		(stripped, true)
	} else {
		(s, false)
	};

	let mut modifier = 0;
	let mut key: Option<&str> = if forced_key_plus { Some("+") } else { None };

	for part in prefix.split('+') {
		let p = part.trim();
		let [c0, ..] = p.as_bytes() else {
			continue;
		};

		match c0 {
			b'c' | b'C' if p.eq_ignore_ascii_case("ctrl") => {
				modifier |= MOD_CTRL;
				continue;
			},
			b's' | b'S' if p.eq_ignore_ascii_case("shift") => {
				modifier |= MOD_SHIFT;
				continue;
			},
			b's' | b'S' if p.eq_ignore_ascii_case("super") => {
				modifier |= MOD_SUPER;
				continue;
			},
			b'a' | b'A' if p.eq_ignore_ascii_case("alt") => {
				modifier |= MOD_ALT;
				continue;
			},
			_ => {},
		}

		// Treat this as the key token (last non-modifier wins)
		key = Some(p);
	}

	let mut key = key?;
	// Optional aliases
	if key.eq_ignore_ascii_case("plus") {
		key = "+";
	} else if key.eq_ignore_ascii_case("esc") {
		key = "esc";
	}

	Some(ParsedKeyId { key, modifier })
}

#[inline]
const fn raw_ctrl_char(letter: u8) -> u8 {
	(letter.to_ascii_lowercase() - b'a') + 1
}

/// Control bytes that legacy terminals send for named keys (Backspace, Tab,
/// LF, CR/Enter, Escape, DEL).
///
/// In legacy encoding (no Kitty protocol, no `modifyOtherKeys`), pressing
/// Ctrl+H/I/J/M/[ produces the same single byte the terminal also sends for
/// Backspace/Tab/Enter/Escape. Without an enhanced encoding the two are
/// physically indistinguishable, so we resolve them to the named key — that's
/// what every user expects when they press Enter — and require the enhanced
/// encoding to match `ctrl+<letter>` separately.
#[inline]
const fn is_named_key_legacy_byte(b: u8) -> bool {
	matches!(b, 0x08 | 0x09 | 0x0a | 0x0d | 0x1b | 0x7f)
}

/// CTRL+symbol legacy mappings
const fn ctrl_symbol_to_byte(symbol: u8) -> Option<u8> {
	match symbol {
		// 0x40 -> 0, 0x5b|0x5c|..-> 0x1b|0x1c|..
		b'@' | b'[' | b'\\' | b']' | b'^' | b'_' => Some(symbol - 0x40),
		b'-' => Some(0x1f),
		_ => None,
	}
}

/// Parse xterm "modifyOtherKeys" format:
///   CSI 27 ; modifiers ; keycode ~
/// Some implementations omit the trailing '~':
///   CSI 27 ; modifiers ; keycode
#[inline]
fn parse_modify_other_keys(bytes: &[u8]) -> Option<(u32, i32)> {
	if bytes.len() < 7 || !bytes.starts_with(b"\x1b[27;") {
		return None;
	}

	let mut end = bytes.len();
	if bytes.last() == Some(&b'~') {
		end -= 1;
	}
	if end <= 5 {
		return None;
	}

	let mut idx = 5; // after "\x1b[27;"
	let (mod_value, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	if idx >= end || bytes[idx] != b';' {
		return None;
	}
	idx += 1;

	let (keycode_u32, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	if idx != end || mod_value == 0 {
		return None;
	}

	let modifier = mod_value - 1;
	let keycode = i32::try_from(keycode_u32).ok()?;
	Some((modifier, keycode))
}

fn matches_key_inner(bytes: &[u8], key_id: &str, kitty_protocol_active: bool) -> bool {
	let Some(ParsedKeyId { key, modifier }) = parse_key_id(key_id) else {
		return false;
	};

	// ESC-prefixed sequences (terminals with metaSendsEscape / "Use Option as
	// Meta"): \x1b\x1b[...] = Alt + inner-key. Strip the ESC prefix and match the
	// inner sequence against the base key (without alt modifier).
	// Example: \x1b\x1b[A matches "alt+up" because \x1b[A matches "up".
	// Active in BOTH legacy and kitty mode (mixed mode) because terminals like
	// Zellij in mixed mode may send legacy Alt sequences alongside Kitty ones.
	//
	// Counted rather than testing the first two bytes, so this stays the mirror of
	// the parse side. `parse_key` folds any number of leading ESC bytes into a
	// single `alt+` (a modifier set either contains alt or it does not), so
	// `\x1b\x1b\x1b[A` parses as `alt+up`; a matcher that stripped exactly one ESC
	// then looked for `up` in what remained answered false for the very id parsing
	// had just produced. `len > escapes + 1` refuses a truncated introducer with
	// nothing after it, which is the same rule the parse side applies.
	let escapes = bytes.iter().take_while(|&&byte| byte == 0x1b).count();
	if modifier & MOD_ALT != 0
		&& escapes >= 2
		&& bytes.len() > escapes + 1
		&& (bytes[escapes] == b'[' || bytes[escapes] == b'O')
	{
		// Down to a single ESC, which is the form the inner sequence's own rules
		// know: every ESC beyond the first carries the same alt.
		let inner_bytes = &bytes[escapes - 1..];
		// `format_with_mods` rather than a second copy of it written inline: the
		// two spelled the same rule and a change to one would have silently
		// stopped matching ids the other still produced.
		let build = |inner_modifier: u32| -> String { format_with_mods(inner_modifier, key) };
		// Two readings of the alt, and both are legitimate, so both are tried.
		// EITHER the ESC prefix supplied it and the inner sequence carries none
		// (`\x1b\x1b[A` is alt+up over a plain `\x1b[A`), OR the inner sequence
		// carries its own and the prefix is redundant (`\x1b\x1b[9;3u` is a CSI-u
		// tab that already says alt). `parse_key` folds those two into the same id
		// because a modifier set either contains alt or it does not, so a matcher
		// that only ever removed the alt answered false for the very id parsing had
		// just produced. Found by `fuzz/fuzz_targets/keys_parse.rs`.
		if matches_key_inner(inner_bytes, &build(modifier & !MOD_ALT), true) {
			return true;
		}
		return matches_key_inner(inner_bytes, &build(modifier), true);
	}

	// Parse Kitty once (avoid repeated parsing in branches).
	let kitty_parsed = parse_kitty_sequence_bytes(bytes);
	let kitty_matches = |codepoint: i32, m: u32| -> bool {
		let Some(p) = kitty_parsed.as_ref() else {
			return false;
		};
		if p.event_type == Some(3) {
			return false;
		}
		let actual_mod = p.modifier & !LOCK_MASK;
		if !modifiers_match(p.modifier, m) {
			return false;
		}
		// The text the key produced wins when nothing is held down, exactly as it does
		// in `format_kitty_key`. The two must agree: `parse_key` NAMES a sequence and
		// this DECIDES whether a binding fires, so a rule applied in one and not the
		// other means a binding the UI displays can never be triggered.
		// `\x1b[91;1;99u` reports key `[` with text `c`, and parsing answered "c"
		// while matching compared against `[`. Found by `fuzz/fuzz_targets/
		// keys_parse.rs`.
		//
		// Gated on the name resolving for the same reason parsing gates on it: a text
		// codepoint with no name is not something a binding can spell, and parsing
		// falls through to the key codepoint in that case rather than giving up.
		if actual_mod == 0
			&& let Some(text_codepoint) = p.text_codepoint
			&& format_key_name(text_codepoint).is_some()
		{
			return text_codepoint == codepoint;
		}
		let mut parsed_codepoint = p.codepoint;
		let mut parsed_base = p.base_layout_key;
		if p.text_codepoint.is_none() {
			if let Some(text_codepoint) = keypad_operator_text_codepoint(parsed_codepoint) {
				parsed_codepoint = text_codepoint;
				parsed_base = None;
			} else if actual_mod == 0 {
				if let Some(text_codepoint) = keypad_num_lock_text_codepoint(parsed_codepoint) {
					parsed_codepoint = text_codepoint;
					parsed_base = None;
				} else if p.modifier & MOD_NUM_LOCK != 0 {
					if let Some(mapped) = map_keypad_nav(parsed_codepoint) {
						parsed_codepoint = mapped;
					}
					if let Some(base) = parsed_base
						&& let Some(mapped) = map_keypad_nav(base)
					{
						parsed_base = Some(mapped);
					}
				}
			} else {
				if let Some(mapped) = map_keypad_nav(parsed_codepoint) {
					parsed_codepoint = mapped;
				}
				if let Some(base) = parsed_base
					&& let Some(mapped) = map_keypad_nav(base)
				{
					parsed_base = Some(mapped);
				}
			}
		}
		if parsed_codepoint == codepoint {
			return true;
		}
		if let Some(base) = parsed_base
			&& base == codepoint
		{
			let is_ascii_letter = u8::try_from(parsed_codepoint)
				.ok()
				.is_some_and(|b| b.is_ascii_alphabetic());
			let is_known_symbol = is_symbol_key(parsed_codepoint);
			if !is_ascii_letter && !is_known_symbol {
				return true;
			}
		}
		false
	};

	// Parse modifyOtherKeys once.
	let mok = parse_modify_other_keys(bytes);
	let mok_matches = |keycode: i32, m: u32| -> bool {
		mok.is_some_and(|(mm, kk)| kk == keycode && modifiers_match(mm, m))
	};

	// The two enhanced encodings are alternatives, never alternatives to each
	// other's key set: a terminal that reports Tab as `\x1b[27;1;9` is reporting
	// the same keypress a kitty terminal reports as `\x1b[9u`, so accepting one
	// and refusing the other is arbitrary. Every arm below used to spell out
	// `kitty_matches(cp, m) || mok_matches(cp, m)` for a MODIFIED key and then
	// drop the second half for the UNMODIFIED one, so `\x1b[27;1;9` (Tab, with
	// the modifier field explicitly saying none held) parsed as `tab` and matched
	// nothing. Found by `fuzz/fuzz_targets/keys_parse.rs`. The sentinel codes for
	// arrows and function keys are negative and a wire keycode never is, so
	// routing those arms through here too costs nothing and keeps one rule.
	let enhanced_matches =
		|codepoint: i32, m: u32| -> bool { kitty_matches(codepoint, m) || mok_matches(codepoint, m) };

	// Named keys (case-insensitive)
	if key.eq_ignore_ascii_case("escape") || key.eq_ignore_ascii_case("esc") {
		// Modified escape used to return false unconditionally, on the reasonable
		// legacy assumption that a bare 0x1b cannot carry modifiers. The enhanced
		// encodings can and do: `\x1b[27;8u` is Shift+Ctrl+Alt+Escape, and
		// `parse_key` names it, so refusing it here meant the key read as pressed
		// and no binding could fire on it. Same shape as the `space` arm below,
		// which had already learned this. Found by
		// `fuzz/fuzz_targets/keys_parse.rs`.
		if modifier == 0 {
			return bytes == b"\x1b" || enhanced_matches(CP_ESCAPE, 0);
		}
		return enhanced_matches(CP_ESCAPE, modifier);
	}

	if key.eq_ignore_ascii_case("space") {
		// legacy ctrl+space
		if modifier == MOD_CTRL && bytes == b"\x00" {
			return true;
		}
		// legacy alt+space (only reliable when not disambiguated)
		if modifier == MOD_ALT && !kitty_protocol_active && bytes == b"\x1b " {
			return true;
		}

		if modifier == 0 {
			return bytes == b" " || enhanced_matches(CP_SPACE, 0);
		}
		return enhanced_matches(CP_SPACE, modifier);
	}

	if key.eq_ignore_ascii_case("tab") {
		// shift+tab classic
		if modifier == MOD_SHIFT {
			return bytes == b"\x1b[Z" || enhanced_matches(CP_TAB, MOD_SHIFT);
		}

		// alt+tab stays ESC+TAB in many legacy/kitty-disambiguate scenarios (Tab is an
		// exception).
		if modifier == MOD_ALT && bytes == b"\x1b\t" {
			return true;
		}

		// plain tab (treat LF/CR elsewhere)
		if modifier == 0 {
			return bytes == b"\t" || enhanced_matches(CP_TAB, 0);
		}

		// ctrl+tab etc are only distinguishable in enhanced modes (CSI-u /
		// modifyOtherKeys)
		return enhanced_matches(CP_TAB, modifier);
	}

	if key.eq_ignore_ascii_case("enter") || key.eq_ignore_ascii_case("return") {
		// alt+enter is commonly ESC + CR/LF even when kitty disambiguation is on
		// (Enter is an exception).
		if modifier == MOD_ALT && (bytes == b"\x1b\r" || bytes == b"\x1b\n") {
			return true;
		}

		// unmodified enter
		if modifier == 0 {
			return bytes == b"\r"
				|| bytes == b"\n"
				|| bytes == b"\x1bOM"
				|| enhanced_matches(CP_ENTER, 0)
				|| enhanced_matches(CP_KP_ENTER, 0);
		}

		// modified enter is only reliably representable when encoded (CSI-u /
		// modifyOtherKeys)
		return enhanced_matches(CP_ENTER, modifier) || enhanced_matches(CP_KP_ENTER, modifier);
	}

	if key.eq_ignore_ascii_case("backspace") {
		// alt+backspace is commonly ESC + (DEL or BS) even in kitty disambiguate mode
		// (Backspace is an exception).
		if modifier == MOD_ALT {
			return bytes == b"\x1b\x7f"
				|| bytes == b"\x1b\x08"
				|| enhanced_matches(CP_BACKSPACE, MOD_ALT);
		}

		if modifier == 0 {
			return bytes == b"\x7f" || bytes == b"\x08" || enhanced_matches(CP_BACKSPACE, 0);
		}

		return enhanced_matches(CP_BACKSPACE, modifier);
	}

	if key.eq_ignore_ascii_case("insert") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "insert") || enhanced_matches(FUNC_INSERT, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "insert", modifier)
			|| enhanced_matches(FUNC_INSERT, modifier);
	}

	if key.eq_ignore_ascii_case("delete") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "delete") || enhanced_matches(FUNC_DELETE, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "delete", modifier)
			|| enhanced_matches(FUNC_DELETE, modifier);
	}

	if key.eq_ignore_ascii_case("clear") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "clear") || enhanced_matches(FUNC_CLEAR, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "clear", modifier)
			|| enhanced_matches(FUNC_CLEAR, modifier);
	}

	if key.eq_ignore_ascii_case("home") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "home") || enhanced_matches(FUNC_HOME, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "home", modifier)
			|| enhanced_matches(FUNC_HOME, modifier);
	}

	if key.eq_ignore_ascii_case("end") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "end") || enhanced_matches(FUNC_END, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "end", modifier)
			|| enhanced_matches(FUNC_END, modifier);
	}

	if key.eq_ignore_ascii_case("pageup") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "pageUp") || enhanced_matches(FUNC_PAGE_UP, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "pageUp", modifier)
			|| enhanced_matches(FUNC_PAGE_UP, modifier);
	}

	if key.eq_ignore_ascii_case("pagedown") {
		if modifier == 0 {
			return matches_legacy_key(bytes, "pageDown") || enhanced_matches(FUNC_PAGE_DOWN, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "pageDown", modifier)
			|| enhanced_matches(FUNC_PAGE_DOWN, modifier);
	}

	if key.eq_ignore_ascii_case("up") {
		if modifier == MOD_ALT {
			return enhanced_matches(ARROW_UP, MOD_ALT);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "up") || enhanced_matches(ARROW_UP, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "up", modifier)
			|| enhanced_matches(ARROW_UP, modifier);
	}

	if key.eq_ignore_ascii_case("down") {
		if modifier == MOD_ALT {
			return enhanced_matches(ARROW_DOWN, MOD_ALT);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "down") || enhanced_matches(ARROW_DOWN, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "down", modifier)
			|| enhanced_matches(ARROW_DOWN, modifier);
	}

	if key.eq_ignore_ascii_case("left") {
		if modifier == MOD_ALT {
			return bytes == b"\x1b[1;3D"
				|| (!kitty_protocol_active && bytes == b"\x1bB")
				|| enhanced_matches(ARROW_LEFT, MOD_ALT);
		}
		if modifier == MOD_CTRL {
			return bytes == b"\x1b[1;5D"
				|| matches_legacy_modifier_sequence(bytes, "left", MOD_CTRL)
				|| enhanced_matches(ARROW_LEFT, MOD_CTRL);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "left") || enhanced_matches(ARROW_LEFT, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "left", modifier)
			|| enhanced_matches(ARROW_LEFT, modifier);
	}

	if key.eq_ignore_ascii_case("right") {
		if modifier == MOD_ALT {
			return bytes == b"\x1b[1;3C"
				|| (!kitty_protocol_active && bytes == b"\x1bF")
				|| enhanced_matches(ARROW_RIGHT, MOD_ALT);
		}
		if modifier == MOD_CTRL {
			return bytes == b"\x1b[1;5C"
				|| matches_legacy_modifier_sequence(bytes, "right", MOD_CTRL)
				|| enhanced_matches(ARROW_RIGHT, MOD_CTRL);
		}
		if modifier == 0 {
			return matches_legacy_key(bytes, "right") || enhanced_matches(ARROW_RIGHT, 0);
		}
		return matches_legacy_modifier_sequence(bytes, "right", modifier)
			|| enhanced_matches(ARROW_RIGHT, modifier);
	}

	// Function keys (now allow modifiers via CSI forms too)
	let f_code = match key.as_bytes() {
		// MINUS, because the sentinels descend: F1 is -20 and F12 is -31. This
		// read `FUNC_F1 + (n - b'1')` and so walked UP from -20 into the block of
		// codes just above it, which is not empty: f5 computed -16 (clear), f6
		// -15 (end), f7 -14 (home), f8 -13 (pageDown), and f9 -12 (pageUp). So a
		// `ctrl+f6` binding fired when the user pressed Ctrl+End, and `ctrl+f5`
		// on Ctrl+Clear, while the function keys themselves matched nothing.
		// f1 was right by coincidence (offset zero), which is why every test of
		// the arm passed.
		[b'f' | b'F', n @ b'1'..=b'9'] => Some(FUNC_F1 - (n - b'1') as i32),
		[b'f' | b'F', b'1', b'0'] => Some(FUNC_F10),
		[b'f' | b'F', b'1', b'1'] => Some(FUNC_F11),
		[b'f' | b'F', b'1', b'2'] => Some(FUNC_F12),
		_ => None,
	};

	if let Some(cp) = f_code {
		if modifier == 0 {
			// `|| enhanced_matches(cp, 0)` rather than the legacy table alone, which
			// is the same shape every arm above uses. Without it a function key
			// sent in the CSI form with an explicit "no modifiers" parameter,
			// `\x1b[11;1~`, was named `f1` by `parse_key` and refused by this
			// function: the key read as pressed and no binding could fire on it.
			// xterm and Ghostty both emit that form, and `;1` is exactly what a
			// terminal sends when it reports the modifier field unconditionally.
			// Found by `fuzz/fuzz_targets/keys_parse.rs`, which asserts that
			// whatever id `parse_key` produces, `matches_key` accepts.
			return matches_legacy_key(bytes, key) || enhanced_matches(cp, 0);
		}
		return enhanced_matches(cp, modifier);
	}

	// Single-character keys: accept any ASCII graphic char (0x21..=0x7E).
	if let [ch] = key.as_bytes() {
		if !ch.is_ascii_graphic() {
			return false;
		}

		// The character exactly as the binding spells it. Case is meaningful:
		// `parse_key` reports the character the terminal sent, so it answers `E` for
		// `0x45` and `e` for `0x65`, and a matcher that lowercased the binding would
		// answer for the wrong one of the two.
		let literal = *ch;
		// The base letter, for the legacy encodings that derive their byte from it.
		// ctrl+letter is computed from the lowercase letter and shift+letter compares
		// against its uppercase form, so those paths want the base rather than the
		// spelling.
		let ch = literal.to_ascii_lowercase();
		let codepoint = i32::from(literal);
		let is_letter = ch.is_ascii_lowercase();
		// The same letter in the other case. A binding that already names shift
		// carries the case twice, so `shift+e` and `shift+E` are the same key.
		let swapped_codepoint = i32::from(if literal.is_ascii_uppercase() {
			ch
		} else {
			literal.to_ascii_uppercase()
		});

		// Enhanced encodings (Kitty CSI-u, xterm modifyOtherKeys) report a codepoint,
		// so they are compared against the character the binding names. The shift
		// spelling is folded because the modifier already says it; every other
		// modifier leaves the case as the distinction it is.
		let enhanced_matches = |m: u32| -> bool {
			if enhanced_matches(codepoint, m) {
				return true;
			}
			m & MOD_SHIFT != 0 && is_letter && (enhanced_matches(swapped_codepoint, m))
		};

		// Legacy ctrl+alt+letter is ESC followed by the control character.
		// tmux extkeys/CSI-u and Kitty mixed modes can still pass these legacy Meta
		// pairs through, so accept them even when enhanced keyboard reporting is
		// active. If that legacy form does not match, continue so CSI-u and
		// modifyOtherKeys sequences from tmux can still be recognized.
		// Legacy ESC+ctrl-char would also match Alt+Enter/Alt+Backspace/etc;
		// skip the legacy fast-path for those bytes and let kitty/modifyOtherKeys
		// disambiguate.
		if modifier == (MOD_CTRL | MOD_ALT) && is_letter {
			let ctrl_char = raw_ctrl_char(ch);
			if bytes.len() == 2
				&& bytes[0] == 0x1b
				&& bytes[1] == ctrl_char
				&& !is_named_key_legacy_byte(ctrl_char)
			{
				return true;
			}
		}

		// alt+letter can remain ESC+letter inside tmux/Kitty mixed modes. If that
		// legacy form does not match, fall through so CSI-u and modifyOtherKeys
		// encodings still match.
		if modifier == MOD_ALT && is_letter && bytes.len() == 2 && bytes[0] == 0x1b && bytes[1] == ch
		{
			return true;
		}

		// alt+shift+letter can remain ESC+UPPERCASE inside tmux/Kitty mixed modes.
		if modifier == (MOD_ALT | MOD_SHIFT)
			&& is_letter
			&& bytes.len() == 2
			&& bytes[0] == 0x1b
			&& bytes[1] == ch.to_ascii_uppercase()
		{
			return true;
		}

		// ctrl+key
		if modifier == MOD_CTRL {
			if is_letter {
				let raw = raw_ctrl_char(ch);
				// `\r`/`\t`/`\x08`/`\x1b`/`\n` are physically the same byte the terminal
				// sends for Enter/Tab/Backspace/Escape, so the legacy fast-path can only
				// claim them when the byte is not a named key. Enhanced encodings still
				// match below via kitty_matches/mok_matches.
				if bytes.len() == 1 && bytes[0] == raw && !is_named_key_legacy_byte(raw) {
					return true;
				}
				return enhanced_matches(MOD_CTRL);
			}

			// ctrl+symbol legacy mapping (layout dependent). Same caveat as above: skip
			// the fast-path when the produced byte coincides with a named key (e.g.
			// ctrl+[ → ESC).
			if let Some(legacy_ctrl) = ctrl_symbol_to_byte(ch)
				&& bytes == [legacy_ctrl]
				&& !is_named_key_legacy_byte(legacy_ctrl)
			{
				return true;
			}

			return enhanced_matches(MOD_CTRL);
		}

		// ctrl+shift
		if modifier == (MOD_CTRL | MOD_SHIFT) {
			return enhanced_matches(MOD_SHIFT | MOD_CTRL);
		}

		// shift+key (letters can match uppercase in plain legacy mode)
		if modifier == MOD_SHIFT {
			if is_letter && bytes.len() == 1 && bytes[0] == ch.to_ascii_uppercase() {
				return true;
			}
			return enhanced_matches(MOD_SHIFT);
		}

		// other modifier combinations
		if modifier != 0 {
			return enhanced_matches(modifier);
		}

		// plain key
		return (bytes.len() == 1 && bytes[0] == literal) || enhanced_matches(0);
	}

	false
}

/// Check if bytes match a legacy key sequence
fn matches_legacy_key(bytes: &[u8], key: &str) -> bool {
	LEGACY_SEQUENCES.get(bytes).is_some_and(|&id| id == key)
}

/// Check if bytes match a legacy modifier sequence (shift/ctrl variants)
fn matches_legacy_modifier_sequence(bytes: &[u8], key: &str, modifier: u32) -> bool {
	if modifier == MOD_SHIFT {
		let expected = match key {
			"up" => Some("shift+up"),
			"down" => Some("shift+down"),
			"right" => Some("shift+right"),
			"left" => Some("shift+left"),
			"clear" => Some("shift+clear"),
			"insert" => Some("shift+insert"),
			"delete" => Some("shift+delete"),
			"pageUp" => Some("shift+pageUp"),
			"pageDown" => Some("shift+pageDown"),
			"home" => Some("shift+home"),
			"end" => Some("shift+end"),
			_ => None,
		};
		if let Some(expected_key) = expected {
			return LEGACY_SEQUENCES
				.get(bytes)
				.is_some_and(|&id| id == expected_key);
		}
	} else if modifier == MOD_CTRL {
		let expected = match key {
			"up" => Some("ctrl+up"),
			"down" => Some("ctrl+down"),
			"right" => Some("ctrl+right"),
			"left" => Some("ctrl+left"),
			"clear" => Some("ctrl+clear"),
			"insert" => Some("ctrl+insert"),
			"delete" => Some("ctrl+delete"),
			"pageUp" => Some("ctrl+pageUp"),
			"pageDown" => Some("ctrl+pageDown"),
			"home" => Some("ctrl+home"),
			"end" => Some("ctrl+end"),
			_ => None,
		};
		if let Some(expected_key) = expected {
			return LEGACY_SEQUENCES
				.get(bytes)
				.is_some_and(|&id| id == expected_key);
		}
	}
	false
}

// =============================================================================
// Core Parsing
// =============================================================================

#[inline]
fn parse_key_inner(bytes: &[u8], kitty_protocol_active: bool) -> Option<Cow<'static, str>> {
	// Fast path: single byte (most common for typing)
	if bytes.len() == 1 {
		return parse_single_byte(bytes[0]);
	}

	// All escape sequences start with ESC
	if bytes.first() != Some(&0x1b) {
		return None;
	}

	// Two-byte ESC sequences are legacy Meta/Alt keypresses. Handle them before
	// the legacy table so ESC+p from Ghostty/tmux is parsed as Alt+P rather than
	// the historical ESC+p Alt+Up compatibility alias.
	if bytes.len() == 2
		&& let Some(key) = parse_esc_pair(bytes[1], kitty_protocol_active)
	{
		return Some(key);
	}

	// O(1) lookup in perfect hash map for legacy sequences
	if let Some(&key_id) = LEGACY_SEQUENCES.get(bytes) {
		return Some(Cow::Borrowed(key_id));
	}

	// xterm modifyOtherKeys (CSI 27;...;...~)
	if let Some((mods, keycode)) = parse_modify_other_keys(bytes) {
		if !modifiers_are_nameable(mods) {
			return None;
		}
		let key_name = format_key_name(keycode)?;
		if mods == 0 {
			return Some(Cow::Borrowed(key_name));
		}
		return Some(Cow::Owned(format_with_mods(mods & !LOCK_MASK, key_name)));
	}

	// Try Kitty protocol sequences (including enhanced CSI-u with optional text
	// field)
	if let Some(parsed) = parse_kitty_sequence_bytes(bytes) {
		if parsed.event_type == Some(3) {
			return None;
		}
		return format_kitty_key(&parsed);
	}

	// ESC-prefixed sequences (terminals with metaSendsEscape / "Use Option as
	// Meta"): \x1b + inner-sequence = Alt modifier on that key.
	// Example: iTerm2 "Use Option as Meta" sends \x1b\x1b[A for Alt+Up.
	// Active in BOTH legacy and kitty mode (mixed mode) because terminals like
	// Zellij in mixed mode may send legacy Alt sequences alongside Kitty ones.
	//
	// `bytes.len() > 3` rather than `> 2`: a CSI or SS3 introducer needs at least
	// one byte after it, so `\x1b\x1bO` is a TRUNCATED sequence and not a
	// keypress. Read as `ESC` + `ESC O`, the inner two bytes fall through to the
	// ESC-pair rule and come back as `alt+shift+o`, which this arm then turned
	// into `alt+alt+shift+o`: an id `parse_key_id` cannot parse, so the key
	// reported as pressed and no binding could ever fire on it. Found by
	// `fuzz/fuzz_targets/keys_parse.rs`, which asserts that whatever id
	// `parse_key` produces, `matches_key` accepts.
	//
	// The ESC run is counted rather than tested two bytes at a time, so three or
	// more ESC bytes reach this arm at all. `bytes[2] == b'['` is false for
	// `\x1b\x1b\x1b[A`, which used to fall through to the end and parse as
	// nothing, and `matches_key` has the mirror of this rule.
	let escapes = bytes.iter().take_while(|&&byte| byte == 0x1b).count();
	if escapes >= 2
		&& bytes.len() > escapes + 1
		&& (bytes[escapes] == b'[' || bytes[escapes] == b'O')
		&& let Some(inner_key) = parse_key_inner(&bytes[escapes - 1..], true)
	{
		// The ESC prefix ADDS alt to a modifier SET, so the id is taken apart and
		// rebuilt through the same pair that produced it rather than having
		// `"alt+"` pasted on the front. Two things go wrong with the paste. It
		// duplicates: `\x1b\x1b[27;8u` parses inside as `shift+ctrl+alt+escape`,
		// which carries alt without STARTING with it, so a prefix guard let it
		// through and the answer was `alt+shift+ctrl+alt+escape`, an id
		// `parse_key_id` cannot round-trip, so the key read as pressed and no
		// binding could fire. And it disorders: `format_with_mods` writes shift,
		// ctrl, alt, super in that order, which a prefix breaks even when alt is
		// absent. Rebuilding is right for both, and for the three-or-more-ESC
		// case that recurses back through here.
		let Some(parsed) = parse_key_id(&inner_key) else {
			return Some(inner_key);
		};
		return Some(Cow::Owned(format_with_mods(parsed.modifier | MOD_ALT, parsed.key)));
	}

	// Fixed CSI / SS3 sequences not covered by LEGACY_SEQUENCES
	match bytes {
		b"\x1b[Z" => Some(Cow::Borrowed("shift+tab")),
		b"\x1bOM" => Some(Cow::Borrowed("enter")), // keypad enter (SS3 M)
		_ => None,
	}
}

#[inline]
fn parse_single_byte(code: u8) -> Option<Cow<'static, str>> {
	match code {
		0x1b => Some(Cow::Borrowed("escape")),
		b'\t' => Some(Cow::Borrowed("tab")),
		b'\r' | b'\n' => Some(Cow::Borrowed("enter")),
		0x00 => Some(Cow::Borrowed("ctrl+space")),
		b' ' => Some(Cow::Borrowed("space")),
		0x7f | 0x08 => Some(Cow::Borrowed("backspace")),
		28 => Some(Cow::Borrowed("ctrl+\\")),
		29 => Some(Cow::Borrowed("ctrl+]")),
		30 => Some(Cow::Borrowed("ctrl+^")),
		31 => Some(Cow::Borrowed("ctrl+_")),
		1..=26 => Some(Cow::Borrowed(CTRL_LETTERS[(code - 1) as usize])),
		b'a'..=b'z' => Some(Cow::Borrowed(LETTERS[(code - b'a') as usize])),
		33..=126 => Some(Cow::Borrowed(ASCII_PRINTABLE[(code - 33) as usize])),
		_ => None,
	}
}

#[inline]
fn parse_esc_pair(code: u8, kitty_protocol_active: bool) -> Option<Cow<'static, str>> {
	// These remain ESC-prefixed even in kitty "disambiguate" mode in many
	// terminals.
	match code {
		0x7f | 0x08 => return Some(Cow::Borrowed("alt+backspace")),
		b'\r' | b'\n' => return Some(Cow::Borrowed("alt+enter")),
		b'\t' => return Some(Cow::Borrowed("alt+tab")),
		_ => {},
	}

	// Historical cursor-key aliases used by some legacy terminals. Keep them in
	// legacy mode only; in mixed modes (tmux extkeys/CSI-u, Kitty, etc.) ESC+B/F
	// are real Alt+Shift+B/F keypresses.
	if !kitty_protocol_active {
		match code {
			b' ' => return Some(Cow::Borrowed("alt+space")),
			b'B' => return Some(Cow::Borrowed("alt+left")),
			b'F' => return Some(Cow::Borrowed("alt+right")),
			_ => {},
		}
	}

	match code {
		1..=26 => Some(Cow::Borrowed(CTRL_ALT_LETTERS[(code - 1) as usize])),
		b'a'..=b'z' => Some(Cow::Borrowed(ALT_LETTERS[(code - b'a') as usize])),
		b'A'..=b'Z' => Some(Cow::Borrowed(ALT_SHIFT_LETTERS[(code - b'A') as usize])),
		_ => None,
	}
}

// =============================================================================
// Kitty Protocol Parsing
// =============================================================================

fn parse_kitty_sequence_bytes(bytes: &[u8]) -> Option<ParsedKittySequence> {
	if bytes.len() < 4 || bytes[0] != 0x1b || bytes[1] != b'[' {
		return None;
	}

	match *bytes.last()? {
		b'u' => parse_csi_u(bytes),
		b'~' => parse_functional(bytes),
		// CSI 1;mod <letter>
		b'A' | b'B' | b'C' | b'D' | b'E' | b'F' | b'H' | b'P' | b'Q' | b'R' | b'S' => {
			parse_csi_1_letter(bytes)
		},
		_ => None,
	}
}

fn parse_csi_u(bytes: &[u8]) -> Option<ParsedKittySequence> {
	let end = bytes.len() - 1; // index of 'u'
	let mut idx = 2;

	// unicode-key-code
	let (codepoint_u32, next_idx) = parse_digits(bytes, idx, end)?;
	let codepoint = i32::try_from(codepoint_u32).ok()?;
	idx = next_idx;

	// :alternate-key-codes (shifted[:base_layout])
	let mut shifted_key = None;
	let mut base_layout_key = None;
	if idx < end && bytes[idx] == b':' {
		idx += 1;

		let (shifted_value, next_idx) = parse_optional_digits(bytes, idx, end);
		shifted_key = shifted_value.and_then(|v| i32::try_from(v).ok());
		idx = next_idx;

		if idx < end && bytes[idx] == b':' {
			idx += 1;
			let (base_value, next_idx) = parse_digits(bytes, idx, end)?;
			base_layout_key = Some(i32::try_from(base_value).ok()?);
			idx = next_idx;
		}
	}

	// ;modifiers:event-type   (modifiers field may be omitted OR empty if followed
	// by ;text)
	let mut mod_value: u32 = 1;
	let mut event_type: Option<u32> = None;

	if idx < end && bytes[idx] == b';' {
		idx += 1;

		// modifiers digits may be absent (e.g. CSI 0;;229u)
		if idx < end && bytes[idx].is_ascii_digit() {
			let (v, next_idx) = parse_digits(bytes, idx, end)?;
			mod_value = v;
			idx = next_idx;
		} else {
			mod_value = 1;
		}

		// :event-type (allow even if modifiers were empty -> treat as modifiers=1)
		if idx < end && bytes[idx] == b':' {
			idx += 1;
			let (ev, next_idx) = parse_digits(bytes, idx, end)?;
			event_type = Some(ev);
			idx = next_idx;
		}
	}

	// ;text-as-codepoints (optional, may be empty)
	let mut text_codepoint: Option<i32> = None;
	let mut text_count: u32 = 0;
	if idx < end && bytes[idx] == b';' {
		idx += 1;
		// validate "digits(:digits)*" but allow empty and ignore values
		while idx < end {
			if bytes[idx] == b':' {
				idx += 1;
				continue;
			}
			let (cp, next_idx) = parse_digits(bytes, idx, end)?;
			text_count += 1;
			if text_count == 1 {
				if cp >= 32 {
					let cp_i32 = i32::try_from(cp).ok();
					if let Some(value) = cp_i32
						&& char::from_u32(cp).is_some()
					{
						text_codepoint = Some(value);
					}
				}
			} else {
				text_codepoint = None;
			}
			idx = next_idx;
			if idx < end && bytes[idx] == b':' {
				idx += 1;
			}
		}
	}

	if idx != end || mod_value == 0 {
		return None;
	}

	Some(ParsedKittySequence {
		codepoint,
		shifted_key,
		base_layout_key,
		text_codepoint,
		modifier: mod_value - 1,
		event_type,
	})
}

fn parse_csi_1_letter(bytes: &[u8]) -> Option<ParsedKittySequence> {
	if !bytes.starts_with(b"\x1b[1;") {
		return None;
	}

	let end = bytes.len();
	let mut idx = 4;
	let (mod_value, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	let mut event_type = None;
	if idx < end && bytes[idx] == b':' {
		idx += 1;
		let (ev, next_idx) = parse_digits(bytes, idx, end)?;
		event_type = Some(ev);
		idx = next_idx;
	}

	if idx + 1 != end || mod_value == 0 {
		return None;
	}

	let codepoint = match bytes[idx] {
		b'A' => ARROW_UP,
		b'B' => ARROW_DOWN,
		b'C' => ARROW_RIGHT,
		b'D' => ARROW_LEFT,
		b'H' => FUNC_HOME,
		b'F' => FUNC_END,
		b'E' => FUNC_CLEAR,
		b'P' => FUNC_F1,
		b'Q' => FUNC_F2,
		b'R' => FUNC_F3,
		b'S' => FUNC_F4,
		_ => return None,
	};

	Some(ParsedKittySequence {
		codepoint,
		shifted_key: None,
		base_layout_key: None,
		text_codepoint: None,
		modifier: mod_value - 1,
		event_type,
	})
}

fn parse_functional(bytes: &[u8]) -> Option<ParsedKittySequence> {
	let end = bytes.len() - 1; // index of '~'
	let mut idx = 2;
	let (key_num, next_idx) = parse_digits(bytes, idx, end)?;
	idx = next_idx;

	let mod_value = if idx < end && bytes[idx] == b';' {
		idx += 1;
		let (v, next_idx) = parse_digits(bytes, idx, end)?;
		idx = next_idx;
		v
	} else {
		1
	};

	let mut event_type = None;
	if idx < end && bytes[idx] == b':' {
		idx += 1;
		let (ev, next_idx) = parse_digits(bytes, idx, end)?;
		event_type = Some(ev);
		idx = next_idx;
	}

	if idx != end || mod_value == 0 {
		return None;
	}

	let codepoint = match key_num {
		// Common functional keys
		2 => FUNC_INSERT,
		3 => FUNC_DELETE,
		5 => FUNC_PAGE_UP,
		6 => FUNC_PAGE_DOWN,

		// Home/End variants
		1 | 7 => FUNC_HOME,
		4 | 8 => FUNC_END,

		// Function keys (terminfo-style)
		11 => FUNC_F1,
		12 => FUNC_F2,
		13 => FUNC_F3,
		14 => FUNC_F4,
		15 => FUNC_F5,
		17 => FUNC_F6,
		18 => FUNC_F7,
		19 => FUNC_F8,
		20 => FUNC_F9,
		21 => FUNC_F10,
		23 => FUNC_F11,
		24 => FUNC_F12,

		_ => return None,
	};

	Some(ParsedKittySequence {
		codepoint,
		shifted_key: None,
		base_layout_key: None,
		text_codepoint: None,
		modifier: mod_value - 1,
		event_type,
	})
}

// =============================================================================
// Formatting
// =============================================================================

fn format_kitty_key(parsed: &ParsedKittySequence) -> Option<Cow<'static, str>> {
	let effective_mod = parsed.modifier & !LOCK_MASK;
	if !modifiers_are_nameable(parsed.modifier) {
		return None;
	}
	let effective_codepoint =
		if let Some(text_codepoint) = keypad_operator_text_codepoint(parsed.codepoint) {
			text_codepoint
		} else {
			let cp = parsed.codepoint;
			let is_ascii_letter = u8::try_from(cp)
				.ok()
				.is_some_and(|b| b.is_ascii_alphabetic());
			let is_known_symbol = is_symbol_key(cp);
			if is_ascii_letter || is_known_symbol {
				cp
			} else {
				// Prefer the base-layout key, but only when it NAMES something.
				// `matches_kitty_sequence` accepts either reading of these bytes,
				// and this committed to one: `\x1b[9:1:8u` is Tab reporting base
				// layout 8, and 8 has no key name, so parsing answered "no key at
				// all" for a sequence matching happily accepted as `tab`. Nothing
				// is lost by falling back, because a base layout that names
				// nothing cannot be spelled in a binding either. Found by
				// `fuzz/fuzz_targets/keys_parse.rs`.
				parsed
					.base_layout_key
					.filter(|&base| format_key_name(base).is_some())
					.unwrap_or(cp)
			}
		};

	if effective_mod == 0 {
		if let Some(text_codepoint) = parsed.text_codepoint
			&& let Some(key_name) = format_key_name(text_codepoint)
		{
			return Some(Cow::Borrowed(key_name));
		}
		if let Some(text_codepoint) = keypad_num_lock_text_codepoint(parsed.codepoint)
			&& let Some(key_name) = format_key_name(text_codepoint)
		{
			return Some(Cow::Borrowed(key_name));
		}
		return format_key_name(effective_codepoint).map(Cow::Borrowed);
	}

	let key_name = format_key_name(effective_codepoint)?;
	Some(Cow::Owned(format_with_mods(effective_mod, key_name)))
}

#[inline]
fn format_key_name(codepoint: i32) -> Option<&'static str> {
	match codepoint {
		CP_ESCAPE => Some("escape"),
		CP_TAB => Some("tab"),
		CP_ENTER | CP_KP_ENTER => Some("enter"),
		CP_SPACE => Some("space"),
		CP_BACKSPACE => Some("backspace"),
		CP_KP_0 => Some("insert"),
		CP_KP_1 => Some("end"),
		CP_KP_2 => Some("down"),
		CP_KP_3 => Some("pageDown"),
		CP_KP_4 => Some("left"),
		CP_KP_5 => Some("clear"),
		CP_KP_6 => Some("right"),
		CP_KP_7 => Some("home"),
		CP_KP_8 => Some("up"),
		CP_KP_9 => Some("pageUp"),
		CP_KP_DECIMAL => Some("delete"),

		FUNC_DELETE => Some("delete"),
		FUNC_INSERT => Some("insert"),
		FUNC_HOME => Some("home"),
		FUNC_END => Some("end"),
		FUNC_PAGE_UP => Some("pageUp"),
		FUNC_PAGE_DOWN => Some("pageDown"),
		FUNC_CLEAR => Some("clear"),

		ARROW_UP => Some("up"),
		ARROW_DOWN => Some("down"),
		ARROW_LEFT => Some("left"),
		ARROW_RIGHT => Some("right"),

		FUNC_F1 => Some("f1"),
		FUNC_F2 => Some("f2"),
		FUNC_F3 => Some("f3"),
		FUNC_F4 => Some("f4"),
		FUNC_F5 => Some("f5"),
		FUNC_F6 => Some("f6"),
		FUNC_F7 => Some("f7"),
		FUNC_F8 => Some("f8"),
		FUNC_F9 => Some("f9"),
		FUNC_F10 => Some("f10"),
		FUNC_F11 => Some("f11"),
		FUNC_F12 => Some("f12"),

		// Any printable ASCII can be represented without allocation via the static table.
		33..=126 => Some(ASCII_PRINTABLE[(codepoint - 33) as usize]),
		_ => None,
	}
}

#[inline]
fn format_with_mods(mods: u32, key_name: &str) -> String {
	let mut result = String::with_capacity(16);
	if mods & MOD_SHIFT != 0 {
		result.push_str("shift+");
	}
	if mods & MOD_CTRL != 0 {
		result.push_str("ctrl+");
	}
	if mods & MOD_ALT != 0 {
		result.push_str("alt+");
	}
	if mods & MOD_SUPER != 0 {
		result.push_str("super+");
	}
	result.push_str(key_name);
	result
}

// =============================================================================
// Digit Parsing Helpers
// =============================================================================

#[inline]
fn parse_digits(bytes: &[u8], mut idx: usize, end: usize) -> Option<(u32, usize)> {
	if idx >= end || !bytes[idx].is_ascii_digit() {
		return None;
	}

	let mut value: u32 = 0;
	while idx < end && bytes[idx].is_ascii_digit() {
		value = value
			.checked_mul(10)?
			.checked_add(u32::from(bytes[idx] - b'0'))?;
		idx += 1;
	}

	Some((value, idx))
}

#[inline]
fn parse_optional_digits(bytes: &[u8], idx: usize, end: usize) -> (Option<u32>, usize) {
	if idx >= end || !bytes[idx].is_ascii_digit() {
		return (None, idx);
	}
	parse_digits(bytes, idx, end).map_or((None, idx), |(v, i)| (Some(v), i))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn esc_prefix_alt_arrows_mixed_mode() {
		// Mixed mode: legacy Alt sequences must parse even when kitty is active
		assert!(matches_key_inner(b"\x1b\x1b[A", "alt+up", true));
		assert!(matches_key_inner(b"\x1b\x1b[B", "alt+down", true));
		assert!(matches_key_inner(b"\x1b\x1b[C", "alt+right", true));
		assert!(matches_key_inner(b"\x1b\x1b[D", "alt+left", true));
		assert_eq!(parse_key_inner(b"\x1b\x1b[A", true).as_deref(), Some("alt+up"));
		assert_eq!(parse_key_inner(b"\x1b\x1b[B", true).as_deref(), Some("alt+down"));
		// Bare double ESC should NOT be parsed as alt
		assert_eq!(parse_key_inner(b"\x1b\x1b", true).as_deref(), None);
	}

	#[test]
	fn esc_pair_alt_letters_mixed_mode() {
		// tmux 3.6 with `extended-keys-format csi-u` can enable enhanced keyboard
		// handling while still forwarding Alt+letter as the legacy ESC+letter form.
		for active in [false, true] {
			assert_eq!(parse_key_inner(b"\x1bp", active).as_deref(), Some("alt+p"));
			assert_eq!(parse_key_inner(b"\x1bh", active).as_deref(), Some("alt+h"));
			assert_eq!(parse_key_inner(b"\x1bP", active).as_deref(), Some("alt+shift+p"));
			assert_eq!(parse_key_inner(b"\x1b\x10", active).as_deref(), Some("ctrl+alt+p"));
			assert!(matches_key_inner(b"\x1bp", "alt+p", active));
			assert!(matches_key_inner(b"\x1bh", "alt+h", active));
			assert!(matches_key_inner(b"\x1bP", "alt+shift+p", active));
			assert!(matches_key_inner(b"\x1b\x10", "ctrl+alt+p", active));
			assert!(!matches_key_inner(b"\x1bp", "alt+up", active));
			assert!(!matches_key_inner(b"\x1bn", "alt+down", active));
			assert!(!matches_key_inner(b"\x1bb", "alt+left", active));
			assert!(!matches_key_inner(b"\x1bf", "alt+right", active));
		}
		assert!(matches_key_inner(b"\x1b[1;3A", "alt+up", true));
		assert!(matches_key_inner(b"\x1b[112;3u", "alt+p", true));
		assert!(matches_key_inner(b"\x1b[27;3;112~", "alt+p", false));
		for active in [false, true] {
			assert_eq!(parse_key_inner(b"\x1b\n", active).as_deref(), Some("alt+enter"));
			assert!(matches_key_inner(b"\x1b\n", "alt+enter", active));
		}
	}

	#[test]
	fn uppercase_meta_b_f_stay_legacy_arrow_aliases_only_without_kitty() {
		assert_eq!(parse_key_inner(b"\x1bB", false).as_deref(), Some("alt+left"));
		assert_eq!(parse_key_inner(b"\x1bF", false).as_deref(), Some("alt+right"));
		assert_eq!(parse_key_inner(b"\x1bB", true).as_deref(), Some("alt+shift+b"));
		assert_eq!(parse_key_inner(b"\x1bF", true).as_deref(), Some("alt+shift+f"));
		assert!(matches_key_inner(b"\x1bB", "alt+left", false));
		assert!(matches_key_inner(b"\x1bF", "alt+right", false));
		assert!(!matches_key_inner(b"\x1bB", "alt+left", true));
		assert!(!matches_key_inner(b"\x1bF", "alt+right", true));
	}

	#[test]
	fn esc_prefix_csi_only() {
		// Only CSI and SS3 inner sequences parse as Alt; other double-ESC does not
		assert_eq!(parse_key_inner(b"\x1b\x1bX", true).as_deref(), None);
		assert_eq!(parse_key_inner(b"\x1b\x1bX", false).as_deref(), None);
	}

	#[test]
	fn matches_key_ignores_kitty_release_events() {
		assert!(matches_key_inner(b"\x1b[127u", "backspace", true));
		assert!(matches_key_inner(b"\x1b[127;1:2u", "backspace", true));
		assert!(!matches_key_inner(b"\x1b[127;1:3u", "backspace", true));
	}

	#[test]
	fn parse_key_ignores_kitty_sequences_with_unsupported_modifiers() {
		// Hyper (16) and meta (32) are kitty modifier bits we do not surface
		// because nothing in the editor binds them. Wire mod 17 = mask 16 = hyper.
		assert_eq!(parse_key_inner(b"\x1b[99;17u", true).as_deref(), None);
		// Wire mod 33 = mask 32 = meta.
		assert_eq!(parse_key_inner(b"\x1b[99;33u", true).as_deref(), None);
	}

	#[test]
	fn parse_key_ignores_kitty_release_events() {
		assert_eq!(parse_key_inner(b"\x1b[127u", true).as_deref(), Some("backspace"));
		assert_eq!(parse_key_inner(b"\x1b[127;1:2u", true).as_deref(), Some("backspace"));
		assert_eq!(parse_key_inner(b"\x1b[127;1:3u", true).as_deref(), None);
	}

	#[test]
	fn keypad_digits_stay_text_with_or_without_num_lock_modifier() {
		for bytes in [b"\x1b[57400u".as_slice(), b"\x1b[57400;129u".as_slice()] {
			assert_eq!(parse_key_inner(bytes, true).as_deref(), Some("1"));
			assert!(matches_key_inner(bytes, "1", true));
			assert!(!matches_key_inner(bytes, "end", true));
		}
		assert_eq!(parse_key_inner(b"\x1b[57404u", true).as_deref(), Some("5"));
		assert!(matches_key_inner(b"\x1b[57404u", "5", true));
		assert!(!matches_key_inner(b"\x1b[57404u", "clear", true));
	}

	#[test]
	fn keypad_operators_stay_text() {
		assert_eq!(parse_key_inner(b"\x1b[57410u", true).as_deref(), Some("/"));
		assert!(matches_key_inner(b"\x1b[57410u", "/", true));
		assert_eq!(parse_key_inner(b"\x1b[57413;5u", true).as_deref(), Some("ctrl++"));
		assert!(matches_key_inner(b"\x1b[57413;5u", "ctrl++", true));
	}

	#[test]
	fn modified_num_lock_keypad_keys_still_match_navigation() {
		assert_eq!(parse_key_inner(b"\x1b[57400;133u", true).as_deref(), Some("ctrl+end"));
		assert!(matches_key_inner(b"\x1b[57400;133u", "ctrl+end", true));
		assert!(!matches_key_inner(b"\x1b[57400;133u", "1", true));
	}

	#[test]
	fn ctrl_alt_letter_falls_through_to_csi_u_and_mok() {
		// Legacy ESC+ctrl-char form (tmux without modifyOtherKeys) keeps matching.
		assert!(matches_key_inner(b"\x1b\x01", "ctrl+alt+a", false));
		// CSI-u form: \x1b[<codepoint>;<mod>u, mod = (ctrl|alt)+1 = 7.
		assert!(matches_key_inner(b"\x1b[97;7u", "ctrl+alt+a", false));
		// modifyOtherKeys form: \x1b[27;<mod>;<codepoint>~, mod = 7.
		assert!(matches_key_inner(b"\x1b[27;7;97~", "ctrl+alt+a", false));
		// Unrelated bytes still do not match.
		assert!(!matches_key_inner(b"\x1b[97;7u", "ctrl+alt+b", false));
	}

	#[test]
	fn ctrl_letter_does_not_steal_named_key_legacy_bytes() {
		// Issue #1354: pressing Enter sends `\r` (0x0d) and that byte is also
		// the legacy encoding of Ctrl+M. In legacy mode the two are physically
		// indistinguishable, so `\r` MUST resolve to Enter and MUST NOT match
		// ctrl+m. Same goes for the other named-key collisions.
		assert!(matches_key_inner(b"\r", "enter", false));
		assert!(!matches_key_inner(b"\r", "ctrl+m", false));

		assert!(matches_key_inner(b"\n", "enter", false));
		assert!(!matches_key_inner(b"\n", "ctrl+j", false));

		assert!(matches_key_inner(b"\t", "tab", false));
		assert!(!matches_key_inner(b"\t", "ctrl+i", false));

		assert!(matches_key_inner(b"\x08", "backspace", false));
		assert!(!matches_key_inner(b"\x08", "ctrl+h", false));

		assert!(matches_key_inner(b"\x1b", "escape", false));
		assert!(!matches_key_inner(b"\x1b", "ctrl+[", false));

		// Non-colliding ctrl+letter still works through the legacy fast-path.
		assert!(matches_key_inner(b"\x03", "ctrl+c", false));
		assert!(matches_key_inner(b"\x18", "ctrl+x", false));

		// Enhanced encodings still let ctrl+<colliding-letter> match — that's
		// the whole point of the protocol upgrade.
		assert!(matches_key_inner(b"\x1b[109;5u", "ctrl+m", true));
		assert!(matches_key_inner(b"\x1b[27;5;109~", "ctrl+m", false));
		assert!(matches_key_inner(b"\x1b[105;5u", "ctrl+i", true));
		assert!(matches_key_inner(b"\x1b[27;5;91~", "ctrl+[", false));
	}

	#[test]
	fn ctrl_alt_letter_does_not_steal_alt_enter() {
		// `\x1b\r` is Alt+Enter in legacy mode; it must not also satisfy
		// ctrl+alt+m. Enhanced encodings still match.
		assert!(matches_key_inner(b"\x1b\r", "alt+enter", false));
		assert!(!matches_key_inner(b"\x1b\r", "ctrl+alt+m", false));
		assert!(!matches_key_inner(b"\x1b\t", "ctrl+alt+i", false));
		assert!(!matches_key_inner(b"\x1b\x08", "ctrl+alt+h", false));

		// CSI-u / modifyOtherKeys forms still resolve ctrl+alt+<colliding>.
		assert!(matches_key_inner(b"\x1b[109;7u", "ctrl+alt+m", true));
		assert!(matches_key_inner(b"\x1b[27;7;109~", "ctrl+alt+m", false));
	}

	#[test]
	fn super_alt_backspace_matches_ghostty_default() {
		// Issue #2064: Ghostty on macOS reports Option+Backspace as kitty
		// modifier 11 (wire) = 10 (mask) = super(8)|alt(2). Before super
		// support landed, the matcher rejected this entirely.
		assert!(matches_key_inner(b"\x1b[127;11u", "super+alt+backspace", true));
		assert!(matches_key_inner(b"\x1b[127;11u", "alt+super+backspace", true));
		assert_eq!(parse_key_inner(b"\x1b[127;11u", true).as_deref(), Some("alt+super+backspace"));
		// Plain alt+backspace must still NOT match — the modifier really is super|alt.
		assert!(!matches_key_inner(b"\x1b[127;11u", "alt+backspace", true));
		// And plain backspace (mod 0) must still not match a super+alt-modified press.
		assert!(!matches_key_inner(b"\x1b[127;11u", "backspace", true));
		// Release events stay ignored: super+alt+backspace release must not match a
		// press.
		assert!(!matches_key_inner(b"\x1b[127;11:3u", "super+alt+backspace", true));
		assert_eq!(parse_key_inner(b"\x1b[127;11:3u", true).as_deref(), None);
	}

	#[test]
	fn super_modifier_parses_for_arbitrary_keys() {
		// Cmd+letter on macOS under kitty flag=1+: super(8)+'a'(97) → wire mod 9.
		assert!(matches_key_inner(b"\x1b[97;9u", "super+a", true));
		assert_eq!(parse_key_inner(b"\x1b[97;9u", true).as_deref(), Some("super+a"));
		// Cmd+Shift+letter: super(8)|shift(1) = 9 mask, wire 10.
		assert!(matches_key_inner(b"\x1b[97;10u", "super+shift+a", true));
		assert!(matches_key_inner(b"\x1b[97;10u", "shift+super+a", true));
		assert_eq!(parse_key_inner(b"\x1b[97;10u", true).as_deref(), Some("shift+super+a"));
	}
}
