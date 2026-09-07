//! Captured stream control sequence sanitization (§contracts/view).
//!
//! When tool spans are marked with `captured: true`, they contain raw output
//! from child processes or terminal sessions, including ANSI/ECMA-48 escape
//! codes (CSI, OSC, DCS, SGR, screen clearing, cursor repositioning) and
//! non-printable control bytes.
//!
//! Desktop surface renders native GPUI elements and must strip control
//! sequences so escape bytes never leak into text layout or corrupt rendering.

/// Parser state for ECMA-48 ANSI sequence stripping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum ParseState {
	#[default]
	Ground,
	Escape,
	Csi,
	Osc,
	OscEsc,
	Dcs,
	DcsEsc,
	SosPmApc,
	SosPmApcEsc,
}

/// Strips all ECMA-48 ANSI escape sequences, OSC strings, DCS payloads, and
/// unprintable control characters from `input`, returning clean printable
/// UTF-8.
///
/// Preserves standard whitespace (`\n`, `\t`) while scrubbing terminal control
/// noise like SGR colours, cursor motions, clearing codes, and window title
/// OSCs.
#[must_use]
pub fn sanitize_control_sequences(input: &str) -> String {
	if input.is_empty() {
		return String::new();
	}

	// Fast-path: if there are no escape bytes or dangerous C0 controls, return
	// early.
	let needs_sanitization = input.bytes().any(|b| {
		b == 0x1b
			|| (b < 0x20 && b != b'\n' && b != b'\t' && b != b'\r')
			|| b == 0x7f
			|| (0x80..=0x9f).contains(&b)
	});

	if !needs_sanitization {
		return input.to_string();
	}

	let mut output = String::with_capacity(input.len());
	let mut state = ParseState::Ground;
	let bytes = input.as_bytes();
	let mut i = 0;

	while i < bytes.len() {
		let byte = bytes[i];

		match state {
			ParseState::Ground => match byte {
				0x1b => state = ParseState::Escape,
				0x00..=0x08 | 0x0b..=0x0c | 0x0e..=0x1f | 0x7f => {
					// Drop unprintable C0 controls
				},
				b'\r' => {
					// If followed by newline, skip carriage return; else replace with newline
					if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
						// Let the subsequent \n be processed
					} else {
						output.push('\n');
					}
				},
				_ => {
					// Handle UTF-8 multi-byte sequences in Ground state
					if byte < 0x80 {
						output.push(byte as char);
					} else {
						// Decode valid UTF-8 character starting here
						let remaining = &input[i..];
						if let Some(c) = remaining.chars().next() {
							// Filter out C1 control characters (U+0080..=U+009F)
							if !('\u{0080}'..='\u{009F}').contains(&c) {
								output.push(c);
							}
							i += c.len_utf8();
							continue;
						}
					}
				},
			},
			ParseState::Escape => match byte {
				b'[' => state = ParseState::Csi,
				b']' => state = ParseState::Osc,
				b'P' => state = ParseState::Dcs,
				b'_' | b'^' | b'X' => state = ParseState::SosPmApc,
				b'(' | b')' | b'*' | b'+' => {
					// Character set selection (e.g. \e(B) - skip the next byte too
					if i + 1 < bytes.len() {
						i += 1;
					}
					state = ParseState::Ground;
				},
				0x30..=0x7e => {
					// 2-character escape sequences (e.g., \e=, \e>, \eM, \eE, \e7, \e8)
					state = ParseState::Ground;
				},
				_ => {
					state = ParseState::Ground;
				},
			},
			ParseState::Csi => match byte {
				0x40..=0x7e => {
					// Final byte for CSI sequence (e.g., 'm' for SGR, 'H' for cursor, 'J' for
					// erase)
					state = ParseState::Ground;
				},
				0x20..=0x3f => {
					// Parameter / intermediate bytes (0-9, ;, ?, etc.)
				},
				0x1b => {
					// Interrupting escape resets to Escape state
					state = ParseState::Escape;
				},
				_ => {
					state = ParseState::Ground;
				},
			},
			ParseState::Osc => match byte {
				0x07 => {
					// BEL terminates OSC
					state = ParseState::Ground;
				},
				0x1b => {
					state = ParseState::OscEsc;
				},
				_ => {},
			},
			ParseState::OscEsc => {
				if byte == b'\\' {
					// String Terminator (ST = \e\)
					state = ParseState::Ground;
				} else if byte == b'[' {
					state = ParseState::Csi;
				} else {
					state = ParseState::Ground;
				}
			},
			ParseState::Dcs => match byte {
				0x07 => state = ParseState::Ground,
				0x1b => state = ParseState::DcsEsc,
				_ => {},
			},
			ParseState::DcsEsc => {
				state = ParseState::Ground;
			},
			ParseState::SosPmApc => match byte {
				0x07 => state = ParseState::Ground,
				0x1b => state = ParseState::SosPmApcEsc,
				_ => {},
			},
			ParseState::SosPmApcEsc => {
				state = ParseState::Ground;
			},
		}

		i += 1;
	}

	output
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sanitizes_sgr_and_color_codes() {
		let input = "\x1b[31;1mError:\x1b[0m \x1b[32mFile created\x1b[0m";
		assert_eq!(sanitize_control_sequences(input), "Error: File created");
	}

	#[test]
	fn sanitizes_cursor_and_screen_clear_commands() {
		let input = "\x1b[2J\x1b[H\x1b[?25lLoading...\x1b[?25h\x1b[2K";
		assert_eq!(sanitize_control_sequences(input), "Loading...");
	}

	#[test]
	fn sanitizes_osc_window_titles_and_hyperlinks() {
		let input =
			"\x1b]0;Terminal Title\x07Hello \x1b]8;;https://example.com\x1b\\World\x1b]8;;\x1b\\";
		assert_eq!(sanitize_control_sequences(input), "Hello World");
	}

	#[test]
	fn removes_c0_c1_control_bytes_preserving_newlines_and_tabs() {
		let input = "Line 1\x00\x07\x08\n\tIndented\x1b\x7f";
		assert_eq!(sanitize_control_sequences(input), "Line 1\n\tIndented");
	}

	#[test]
	fn handles_unterminated_and_malformed_sequences_safely() {
		let input = "Normal \x1b[31";
		assert_eq!(sanitize_control_sequences(input), "Normal ");

		let input2 = "Test \x1b]unterminated";
		assert_eq!(sanitize_control_sequences(input2), "Test ");
	}
}
