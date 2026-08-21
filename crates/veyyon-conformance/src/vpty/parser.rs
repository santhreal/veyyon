//! ANSI/VT100/xterm escape-sequence and control character parser.
//!
//! Parses streaming bytes or UTF-8 text and updates a `Grid`.
//! Unknown or malformed sequences are recorded and cleanly consumed,
//! never printed as text and never allowed to corrupt subsequent bytes.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::vpty::{
	cell::{Attributes, ColorRgb},
	grid::Grid,
};

/// Standard 16-color ANSI palette mapping (approximate standard xterm colors).
const BASIC_16_PALETTE: [ColorRgb; 16] = [
	ColorRgb::new(0, 0, 0),       // 0: Black
	ColorRgb::new(205, 0, 0),     // 1: Red
	ColorRgb::new(0, 205, 0),     // 2: Green
	ColorRgb::new(205, 205, 0),   // 3: Yellow
	ColorRgb::new(0, 0, 238),     // 4: Blue
	ColorRgb::new(205, 0, 205),   // 5: Magenta
	ColorRgb::new(0, 205, 205),   // 6: Cyan
	ColorRgb::new(229, 229, 229), // 7: White
	ColorRgb::new(127, 127, 127), // 8: Bright Black (Grey)
	ColorRgb::new(255, 0, 0),     // 9: Bright Red
	ColorRgb::new(0, 255, 0),     // 10: Bright Green
	ColorRgb::new(255, 255, 0),   // 11: Bright Yellow
	ColorRgb::new(92, 92, 255),   // 12: Bright Blue
	ColorRgb::new(255, 0, 255),   // 13: Bright Magenta
	ColorRgb::new(0, 255, 255),   // 14: Bright Cyan
	ColorRgb::new(255, 255, 255), // 15: Bright White
];

/// Resolves an 8-bit ANSI 256-color index to 24-bit RGB.
#[must_use]
pub const fn color_256_to_rgb(index: u8) -> ColorRgb {
	if (index as usize) < 16 {
		BASIC_16_PALETTE[index as usize]
	} else if index <= 231 {
		// 6x6x6 color cube
		let idx = index - 16;
		let r = (idx / 36) % 6;
		let g = (idx / 6) % 6;
		let b = idx % 6;
		let r_val = if r == 0 { 0 } else { 55 + r * 40 };
		let g_val = if g == 0 { 0 } else { 55 + g * 40 };
		let b_val = if b == 0 { 0 } else { 55 + b * 40 };
		ColorRgb::new(r_val, g_val, b_val)
	} else {
		// 232..=255 grayscale ramp
		let gray = (index - 232) * 10 + 8;
		ColorRgb::new(gray, gray, gray)
	}
}

/// Dispatched SGR effect data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SgrEffect {
	/// Reset all attributes and colors to default (0).
	Reset,
	/// Bold on/off.
	Bold(bool),
	/// Dim on/off.
	Dim(bool),
	/// Italic on/off.
	Italic(bool),
	/// Underline on/off.
	Underline(bool),
	/// Inverse / reverse video on/off.
	Inverse(bool),
	/// Strikethrough on/off.
	Strikethrough(bool),
	/// Standard or bright foreground color.
	Fg(ColorRgb),
	/// Standard or bright background color.
	Bg(ColorRgb),
	/// Default foreground color (39).
	DefaultFg,
	/// Default background color (49).
	DefaultBg,
	/// Extended foreground color (38) - consumes subsequent sub-parameters.
	ExtendedFg,
	/// Extended background color (48) - consumes subsequent sub-parameters.
	ExtendedBg,
}

/// Maps an SGR parameter code to its corresponding effect.
#[must_use]
pub const fn sgr_effect(param: u32) -> Option<SgrEffect> {
	match param {
		0 => Some(SgrEffect::Reset),
		1 => Some(SgrEffect::Bold(true)),
		2 => Some(SgrEffect::Dim(true)),
		3 => Some(SgrEffect::Italic(true)),
		4 => Some(SgrEffect::Underline(true)),
		7 => Some(SgrEffect::Inverse(true)),
		9 => Some(SgrEffect::Strikethrough(true)),
		22 => Some(SgrEffect::Bold(false)), // Also turns dim off
		23 => Some(SgrEffect::Italic(false)),
		24 => Some(SgrEffect::Underline(false)),
		27 => Some(SgrEffect::Inverse(false)),
		29 => Some(SgrEffect::Strikethrough(false)),
		30..=37 => Some(SgrEffect::Fg(BASIC_16_PALETTE[(param - 30) as usize])),
		38 => Some(SgrEffect::ExtendedFg),
		39 => Some(SgrEffect::DefaultFg),
		40..=47 => Some(SgrEffect::Bg(BASIC_16_PALETTE[(param - 40) as usize])),
		48 => Some(SgrEffect::ExtendedBg),
		49 => Some(SgrEffect::DefaultBg),
		90..=97 => Some(SgrEffect::Fg(BASIC_16_PALETTE[(param - 90 + 8) as usize])),
		100..=107 => Some(SgrEffect::Bg(BASIC_16_PALETTE[(param - 100 + 8) as usize])),
		_ => None,
	}
}

/// Dispatched CSI standard action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CsiAction {
	/// Cursor Up (`CUU`).
	CursorUp,
	/// Cursor Down (`CUD`).
	CursorDown,
	/// Cursor Forward (`CUF`).
	CursorForward,
	/// Cursor Backward (`CUB`).
	CursorBackward,
	/// Cursor Next Line (`CNL`).
	CursorNextLine,
	/// Cursor Previous Line (`CPL`).
	CursorPreviousLine,
	/// Cursor Horizontal Absolute (`CHA`).
	CursorHorizontalAbsolute,
	/// Cursor Position (`CUP`).
	CursorPosition,
	/// Erase in Display (`ED`).
	EraseInDisplay,
	/// Erase in Line (`EL`).
	EraseInLine,
	/// Scroll Up (`SU`).
	ScrollUp,
	/// Scroll Down (`SD`).
	ScrollDown,
	/// Erase Characters (`ECH`).
	EraseCharacters,
	/// Line Position Absolute (`VPA`).
	LinePositionAbsolute,
	/// Horizontal and Vertical Position (`HVP`).
	HorizontalVerticalPosition,
	/// Select Graphic Rendition (`SGR`).
	SelectGraphicRendition,
	/// Device Status Report (`DSR`).
	DeviceStatusReport,
	/// Set Top and Bottom Margins (`DECSTBM`).
	SetScrollRegion,
	/// ANSI Save Cursor (`s`).
	SaveCursor,
	/// ANSI Restore Cursor (`u`).
	RestoreCursor,
}

/// Maps a CSI final command byte to its corresponding action.
#[must_use]
pub const fn csi_action(final_byte: u8) -> Option<CsiAction> {
	match final_byte {
		b'A' => Some(CsiAction::CursorUp),
		b'B' => Some(CsiAction::CursorDown),
		b'C' => Some(CsiAction::CursorForward),
		b'D' => Some(CsiAction::CursorBackward),
		b'E' => Some(CsiAction::CursorNextLine),
		b'F' => Some(CsiAction::CursorPreviousLine),
		b'G' => Some(CsiAction::CursorHorizontalAbsolute),
		b'H' => Some(CsiAction::CursorPosition),
		b'J' => Some(CsiAction::EraseInDisplay),
		b'K' => Some(CsiAction::EraseInLine),
		b'S' => Some(CsiAction::ScrollUp),
		b'T' => Some(CsiAction::ScrollDown),
		b'X' => Some(CsiAction::EraseCharacters),
		b'd' => Some(CsiAction::LinePositionAbsolute),
		b'f' => Some(CsiAction::HorizontalVerticalPosition),
		b'm' => Some(CsiAction::SelectGraphicRendition),
		b'n' => Some(CsiAction::DeviceStatusReport),
		b'r' => Some(CsiAction::SetScrollRegion),
		b's' => Some(CsiAction::SaveCursor),
		b'u' => Some(CsiAction::RestoreCursor),
		_ => None,
	}
}

/// Recorded malformed or unrecognized escape sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedSequence {
	/// Raw byte payload of the unrecognized sequence.
	pub sequence: Vec<u8>,
	/// Description or parser state where it occurred.
	pub reason:   String,
}

/// Parser internal state.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ParserState {
	/// Ground / normal text processing.
	Ground,
	/// Saw `\x1b` (ESC).
	Escape,
	/// Saw `\x1b[` (CSI).
	Csi,
	/// Saw `\x1b]` (OSC).
	Osc,
	/// Saw `\x1b]` followed by `\x1b` (potential ST termination `\x1b\`).
	OscEscape,
	/// Saw `\x1b(` or `\x1b)` (designate G0/G1 character set).
	Charset,
}

/// Terminal stream parser.
#[derive(Debug, Clone)]
pub struct Parser {
	state:               ParserState,
	csi_params:          String,
	osc_buffer:          String,
	current_attrs:       Attributes,
	current_fg:          Option<ColorRgb>,
	current_bg:          Option<ColorRgb>,
	window_title:        String,
	current_hyperlink:   Option<String>,
	cursor_visible:      bool,
	alternate_screen:    bool,
	malformed_sequences: Vec<MalformedSequence>,
}

impl Default for Parser {
	fn default() -> Self {
		Self::new()
	}
}

impl Parser {
	/// Creates a new parser with default attributes.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			state:               ParserState::Ground,
			csi_params:          String::new(),
			osc_buffer:          String::new(),
			current_attrs:       Attributes::none(),
			current_fg:          None,
			current_bg:          None,
			window_title:        String::new(),
			current_hyperlink:   None,
			cursor_visible:      true,
			alternate_screen:    false,
			malformed_sequences: Vec::new(),
		}
	}

	/// Returns the current text attributes.
	#[must_use]
	pub const fn current_attrs(&self) -> Attributes {
		self.current_attrs
	}

	/// Returns current foreground color.
	#[must_use]
	pub const fn current_fg(&self) -> Option<ColorRgb> {
		self.current_fg
	}

	/// Returns current background color.
	#[must_use]
	pub const fn current_bg(&self) -> Option<ColorRgb> {
		self.current_bg
	}

	/// Returns window title set via OSC 0 or OSC 2.
	#[must_use]
	pub fn window_title(&self) -> &str {
		&self.window_title
	}

	/// Returns current OSC 8 hyperlink URI, if active.
	#[must_use]
	pub fn current_hyperlink(&self) -> Option<&str> {
		self.current_hyperlink.as_deref()
	}

	/// Returns whether cursor is visible (DECTCEM).
	#[must_use]
	pub const fn cursor_visible(&self) -> bool {
		self.cursor_visible
	}

	/// Returns list of recorded malformed or unknown sequences.
	#[must_use]
	pub fn malformed_sequences(&self) -> &[MalformedSequence] {
		&self.malformed_sequences
	}

	/// Clears the recorded malformed sequences.
	pub fn clear_malformed_sequences(&mut self) {
		self.malformed_sequences.clear();
	}

	/// Feeds a string of terminal output into the parser and grid.
	pub fn parse_str(&mut self, input: &str, grid: &mut Grid) {
		for cluster in input.graphemes(true) {
			self.process_grapheme(cluster, grid);
		}
	}

	fn process_grapheme(&mut self, cluster: &str, grid: &mut Grid) {
		// If in Ground state and the cluster is not starting with ESC or C0 controls,
		// we can directly treat it as a printable grapheme cluster!
		if self.state == ParserState::Ground {
			let first_ch = cluster.chars().next().unwrap_or('\0');
			if first_ch == '\x1b'
				|| first_ch == '\r'
				|| first_ch == '\n'
				|| first_ch == '\x0b'
				|| first_ch == '\x0c'
				|| first_ch == '\t'
				|| first_ch == '\x08'
				|| first_ch == '\x07'
				|| first_ch == '\0'
				|| first_ch.is_control()
			{
				for ch in cluster.chars() {
					self.process_char(ch, grid);
				}
				return;
			}

			let width = UnicodeWidthStr::width(cluster);
			let (fg, bg) = if self.current_attrs.inverse {
				(self.current_bg, self.current_fg)
			} else {
				(self.current_fg, self.current_bg)
			};

			grid.write_grapheme(cluster, width, fg, bg, self.current_attrs);
		} else {
			for ch in cluster.chars() {
				self.process_char(ch, grid);
			}
		}
	}

	/// Feeds raw bytes into the parser and grid (decoding UTF-8 losslessly).
	pub fn parse_bytes(&mut self, input: &[u8], grid: &mut Grid) {
		let s = String::from_utf8_lossy(input);
		self.parse_str(&s, grid);
	}

	fn process_char(&mut self, ch: char, grid: &mut Grid) {
		match self.state {
			ParserState::Ground => match ch {
				'\x1b' => {
					self.state = ParserState::Escape;
				},
				'\r' => {
					grid.carriage_return();
				},
				'\n' | '\x0b' | '\x0c' => {
					// LF, VT, FF all perform line feed in standard TUI
					grid.line_feed();
				},
				'\t' => {
					grid.tab();
				},
				'\x08' => {
					// BS
					grid.backspace();
				},
				'\x07' => {
					// BEL - audible / visual bell, no grid change
				},
				'\0' => {
					// NUL - ignored
				},
				_ => {
					// Check C0 control characters 0x01..=0x1f
					if ch.is_control() {
						self.malformed_sequences.push(MalformedSequence {
							sequence: vec![ch as u8],
							reason:   format!("unhandled C0 control 0x{:02x}", ch as u32),
						});
						return;
					}

					// Printable character / grapheme cluster handling
					let mut cluster = String::new();
					cluster.push(ch);
					let width = UnicodeWidthStr::width(cluster.as_str());

					// Effective attributes accounting for inverse
					let (fg, bg) = if self.current_attrs.inverse {
						(self.current_bg, self.current_fg)
					} else {
						(self.current_fg, self.current_bg)
					};

					grid.write_grapheme(&cluster, width, fg, bg, self.current_attrs);
				},
			},
			ParserState::Escape => match ch {
				'[' => {
					self.csi_params.clear();
					self.state = ParserState::Csi;
				},
				']' => {
					self.osc_buffer.clear();
					self.state = ParserState::Osc;
				},
				'(' | ')' => {
					self.state = ParserState::Charset;
				},
				'7' => {
					// DECSC: Save cursor
					grid.save_cursor(self.current_attrs, self.current_fg, self.current_bg);
					self.state = ParserState::Ground;
				},
				'8' => {
					// DECRC: Restore cursor
					if let Some((attrs, fg, bg)) = grid.restore_cursor() {
						self.current_attrs = attrs;
						self.current_fg = fg;
						self.current_bg = bg;
					}
					self.state = ParserState::Ground;
				},
				'M' => {
					// RI: Reverse Index (move cursor up one line, scrolling if at top)
					grid.reverse_index();
					self.state = ParserState::Ground;
				},
				'c' => {
					// RIS: Reset to Initial State
					self.current_attrs = Attributes::none();
					self.current_fg = None;
					self.current_bg = None;
					grid.erase_in_display(2, None);
					grid.set_cursor_home();
					grid.reset_scroll_region();
					self.state = ParserState::Ground;
				},
				'\x1b' => {
					// Another escape, stay in escape
					self.malformed_sequences.push(MalformedSequence {
						sequence: vec![0x1b],
						reason:   "consecutive ESC".to_string(),
					});
				},
				_ => {
					self.malformed_sequences.push(MalformedSequence {
						sequence: format!("\x1b{ch}").into_bytes(),
						reason:   format!("unknown ESC sequence ESC {ch}"),
					});
					self.state = ParserState::Ground;
				},
			},
			ParserState::Charset => {
				// Character set designation (e.g. \x1b(B) - consume single character
				self.state = ParserState::Ground;
			},
			ParserState::Csi => {
				// Standard ECMA-48 CSI parameter bytes are 0x30..=0x3F ('0'..='9', ':', ';',
				// '<', '=', '>', '?')
				if matches!(ch, '0'..='9' | ':' | ';' | '<' | '=' | '>' | '?') {
					self.csi_params.push(ch);
				} else {
					// Final/intermediate character of CSI sequence
					self.execute_csi(ch, grid);
					self.state = ParserState::Ground;
				}
			},
			ParserState::Osc => match ch {
				'\x07' => {
					// BEL terminates OSC
					self.execute_osc();
					self.state = ParserState::Ground;
				},
				'\x1b' => {
					self.state = ParserState::OscEscape;
				},
				_ => {
					self.osc_buffer.push(ch);
				},
			},
			ParserState::OscEscape => {
				if ch == '\\' {
					// String Terminator (ST) `\x1b\` terminates OSC
					self.execute_osc();
				} else {
					// Malformed OSC sequence
					self.malformed_sequences.push(MalformedSequence {
						sequence: format!("\x1b]{}\x1b{ch}", self.osc_buffer).into_bytes(),
						reason:   "invalid OSC terminator".to_string(),
					});
				}
				self.state = ParserState::Ground;
			},
		}
	}

	fn execute_csi(&mut self, final_char: char, grid: &mut Grid) {
		let params_str = self.csi_params.trim();
		let is_private = params_str.starts_with('?');
		let clean_params = if is_private {
			&params_str[1..]
		} else {
			params_str
		};

		let params: Vec<u32> = if clean_params.is_empty() {
			Vec::new()
		} else {
			clean_params
				.split(';')
				.map(|s| s.parse::<u32>().unwrap_or(0))
				.collect()
		};

		if is_private {
			match final_char {
				// DECSET (Private mode set)
				'h' => {
					for &mode in &params {
						match mode {
							1 => {
								// Application Cursor Keys (DECCKM)
							},
							6 => {
								// Origin Mode (DECOM)
								grid.set_origin_mode(true);
							},
							7 => {
								// Autowrap (DECAWM)
								grid.set_autowrap(true);
							},
							25 => {
								// Cursor visible (DECTCEM)
								self.cursor_visible = true;
							},
							1049 | 47 | 1047 => {
								// Alternate Screen Buffer
								self.alternate_screen = true;
								grid.erase_in_display(2, None);
								grid.set_cursor_home();
							},
							2004 => {
								// Bracketed Paste Mode enable
							},
							1000 | 1002 | 1003 | 1006 | 1015 => {
								// Mouse tracking modes enable
							},
							_ => {
								self.malformed_sequences.push(MalformedSequence {
									sequence: format!("\x1b[?{mode}h").into_bytes(),
									reason:   format!("unknown DECSET mode {mode}"),
								});
							},
						}
					}
				},
				// DECRST (Private mode reset)
				'l' => {
					for &mode in &params {
						match mode {
							1 => {
								// Normal Cursor Keys
							},
							6 => {
								// Normal Origin Mode
								grid.set_origin_mode(false);
							},
							7 => {
								// No Autowrap
								grid.set_autowrap(false);
							},
							25 => {
								// Cursor hidden
								self.cursor_visible = false;
							},
							1049 | 47 | 1047 => {
								// Main Screen Buffer
								self.alternate_screen = false;
							},
							2004 => {
								// Bracketed Paste Mode disable
							},
							1000 | 1002 | 1003 | 1006 | 1015 => {
								// Mouse tracking modes disable
							},
							_ => {
								self.malformed_sequences.push(MalformedSequence {
									sequence: format!("\x1b[?{mode}l").into_bytes(),
									reason:   format!("unknown DECRST mode {mode}"),
								});
							},
						}
					}
				},
				_ => {
					self.malformed_sequences.push(MalformedSequence {
						sequence: format!("\x1b[?{params_str}{final_char}").into_bytes(),
						reason:   format!("unknown private CSI sequence CSI ?{params_str} {final_char}"),
					});
				},
			}
			return;
		}

		let action = if final_char.is_ascii() {
			csi_action(final_char as u8)
		} else {
			None
		};

		match action {
			Some(CsiAction::SelectGraphicRendition) => {
				self.execute_sgr(&params);
			},
			Some(CsiAction::CursorPosition | CsiAction::HorizontalVerticalPosition) => {
				let row = params.first().copied().unwrap_or(1).saturating_sub(1) as usize;
				let col = params.get(1).copied().unwrap_or(1).saturating_sub(1) as usize;
				grid.set_cursor(col, row);
			},
			Some(CsiAction::CursorUp) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.cursor_up(count);
			},
			Some(CsiAction::CursorDown) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.cursor_down(count);
			},
			Some(CsiAction::CursorForward) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.cursor_forward(count);
			},
			Some(CsiAction::CursorBackward) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.cursor_backward(count);
			},
			Some(CsiAction::CursorNextLine) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.cursor_down(count);
				grid.carriage_return();
			},
			Some(CsiAction::CursorPreviousLine) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.cursor_up(count);
				grid.carriage_return();
			},
			Some(CsiAction::CursorHorizontalAbsolute) => {
				let col = params.first().copied().unwrap_or(1).saturating_sub(1) as usize;
				grid.set_cursor(col, grid.cursor().row);
			},
			Some(CsiAction::LinePositionAbsolute) => {
				let row = params.first().copied().unwrap_or(1).saturating_sub(1) as usize;
				grid.set_cursor(grid.cursor().col, row);
			},
			Some(CsiAction::EraseInDisplay) => {
				let mode = params.first().copied().unwrap_or(0);
				grid.erase_in_display(mode, self.current_bg);
			},
			Some(CsiAction::EraseInLine) => {
				let mode = params.first().copied().unwrap_or(0);
				grid.erase_in_line(mode, self.current_bg);
			},
			Some(CsiAction::EraseCharacters) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.erase_characters(count, self.current_bg);
			},
			Some(CsiAction::ScrollUp) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.scroll_up(count);
			},
			Some(CsiAction::ScrollDown) => {
				let count = params.first().copied().unwrap_or(1).max(1) as usize;
				grid.scroll_down(count);
			},
			Some(CsiAction::SetScrollRegion) => {
				if params.is_empty() {
					grid.reset_scroll_region();
				} else {
					let top = params.first().copied().unwrap_or(1).saturating_sub(1) as usize;
					let bottom = params
						.get(1)
						.copied()
						.unwrap_or_else(|| grid.rows() as u32)
						.saturating_sub(1) as usize;
					grid.set_scroll_region(top, bottom);
				}
			},
			Some(CsiAction::SaveCursor) => {
				grid.save_cursor(self.current_attrs, self.current_fg, self.current_bg);
			},
			Some(CsiAction::RestoreCursor) => {
				if let Some((attrs, fg, bg)) = grid.restore_cursor() {
					self.current_attrs = attrs;
					self.current_fg = fg;
					self.current_bg = bg;
				}
			},
			Some(CsiAction::DeviceStatusReport) => {
				// No-op in headless consumer
			},
			None => {
				self.malformed_sequences.push(MalformedSequence {
					sequence: format!("\x1b[{params_str}{final_char}").into_bytes(),
					reason:   format!("unknown CSI sequence CSI {params_str} {final_char}"),
				});
			},
		}
	}

	fn execute_sgr(&mut self, params: &[u32]) {
		if params.is_empty() {
			// Reset all attributes and colors
			self.current_attrs = Attributes::none();
			self.current_fg = None;
			self.current_bg = None;
			return;
		}

		let mut idx = 0;
		while idx < params.len() {
			let param = params[idx];
			match sgr_effect(param) {
				Some(SgrEffect::Reset) => {
					self.current_attrs = Attributes::none();
					self.current_fg = None;
					self.current_bg = None;
				},
				Some(SgrEffect::Bold(v)) => {
					self.current_attrs.bold = v;
					if !v {
						self.current_attrs.dim = false;
					}
				},
				Some(SgrEffect::Dim(v)) => {
					self.current_attrs.dim = v;
				},
				Some(SgrEffect::Italic(v)) => {
					self.current_attrs.italic = v;
				},
				Some(SgrEffect::Underline(v)) => {
					self.current_attrs.underline = v;
				},
				Some(SgrEffect::Inverse(v)) => {
					self.current_attrs.inverse = v;
				},
				Some(SgrEffect::Strikethrough(v)) => {
					self.current_attrs.strikethrough = v;
				},
				Some(SgrEffect::Fg(color)) => {
					self.current_fg = Some(color);
				},
				Some(SgrEffect::Bg(color)) => {
					self.current_bg = Some(color);
				},
				Some(SgrEffect::DefaultFg) => {
					self.current_fg = None;
				},
				Some(SgrEffect::DefaultBg) => {
					self.current_bg = None;
				},
				Some(SgrEffect::ExtendedFg) => {
					if idx + 1 < params.len() {
						match params[idx + 1] {
							5 => {
								if idx + 2 < params.len() {
									let color_idx = params[idx + 2] as u8;
									self.current_fg = Some(color_256_to_rgb(color_idx));
									idx += 2;
								}
							},
							2 => {
								if idx + 4 < params.len() {
									let r = params[idx + 2] as u8;
									let g = params[idx + 3] as u8;
									let b = params[idx + 4] as u8;
									self.current_fg = Some(ColorRgb::new(r, g, b));
									idx += 4;
								}
							},
							_ => {
								self.malformed_sequences.push(MalformedSequence {
									sequence: format!("\x1b[38;{}m", params[idx + 1]).into_bytes(),
									reason:   "invalid SGR 38 color mode".to_string(),
								});
							},
						}
					}
				},
				Some(SgrEffect::ExtendedBg) => {
					if idx + 1 < params.len() {
						match params[idx + 1] {
							5 => {
								if idx + 2 < params.len() {
									let color_idx = params[idx + 2] as u8;
									self.current_bg = Some(color_256_to_rgb(color_idx));
									idx += 2;
								}
							},
							2 => {
								if idx + 4 < params.len() {
									let r = params[idx + 2] as u8;
									let g = params[idx + 3] as u8;
									let b = params[idx + 4] as u8;
									self.current_bg = Some(ColorRgb::new(r, g, b));
									idx += 4;
								}
							},
							_ => {
								self.malformed_sequences.push(MalformedSequence {
									sequence: format!("\x1b[48;{}m", params[idx + 1]).into_bytes(),
									reason:   "invalid SGR 48 color mode".to_string(),
								});
							},
						}
					}
				},
				None => {
					self.malformed_sequences.push(MalformedSequence {
						sequence: format!("\x1b[{param}m").into_bytes(),
						reason:   format!("unsupported SGR param {param}"),
					});
				},
			}
			idx += 1;
		}
	}

	fn execute_osc(&mut self) {
		let buffer = &self.osc_buffer;
		let mut parts = buffer.splitn(2, ';');
		let command = parts.next().unwrap_or("");
		let payload = parts.next().unwrap_or("");

		match command {
			"0" | "2" => {
				// Window title
				self.window_title = payload.to_string();
			},
			"8" => {
				// OSC 8 Hyperlink: `8;params;url` or `8;;` to clear
				let mut link_parts = payload.splitn(2, ';');
				let _link_params = link_parts.next().unwrap_or("");
				let url = link_parts.next().unwrap_or("");
				if url.is_empty() {
					self.current_hyperlink = None;
				} else {
					self.current_hyperlink = Some(url.to_string());
				}
			},
			_ => {
				self.malformed_sequences.push(MalformedSequence {
					sequence: format!("\x1b]{buffer}\x07").into_bytes(),
					reason:   format!("unknown OSC command {command}"),
				});
			},
		}
	}
}
