//! Comprehensive tests for the `vpty` terminal emulator subsystem.
//!
//! WHY: Virtual terminal emulation is the foundation for 20,000 rendering
//! conformance cases. A parser defect (such as printing malformed escape
//! sequences as visible text, failing to track deferred wrap, misinterpreting
//! wide/combining characters, or corrupting scroll regions) causes silent
//! cascade rendering failures across all TUI assertions.
//!
//! WHAT THIS DOES NOT CATCH:
//! - Kernel PTY OS driver bugs or `ConPTY` Windows console host handle bugs
//!   (virtual PTY operates in-memory).
//! - Font rasterizer rendering variations (dual-ground rasterization is tested
//!   in the `render` module).

use super::*;
use crate::vpty::{
	cell::ColorRgb,
	grid::{DimensionError, Grid, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS},
	input::{Input, Key, Modifiers, MouseButton, MouseEvent, MouseEventKind},
	parser::{CsiAction, SgrEffect, color_256_to_rgb, csi_action, sgr_effect},
};

#[test]
fn a_dimension_outside_20x5_to_400x120_is_refused_with_typed_error() {
	// Below minimum columns
	assert_eq!(Grid::new(19, 20), Err(DimensionError { cols: 19, rows: 20 }));
	// Below minimum rows
	assert_eq!(Grid::new(20, 4), Err(DimensionError { cols: 20, rows: 4 }));
	// Above maximum columns
	assert_eq!(Grid::new(401, 20), Err(DimensionError { cols: 401, rows: 20 }));
	// Above maximum rows
	assert_eq!(Grid::new(80, 121), Err(DimensionError { cols: 80, rows: 121 }));

	// Boundary valid dimensions
	assert!(Grid::new(MIN_COLS, MIN_ROWS).is_ok());
	assert!(Grid::new(MAX_COLS, MAX_ROWS).is_ok());
	assert!(Grid::new(80, 24).is_ok());

	// Terminal::new checks
	assert!(Terminal::new(10, 10).is_err());
	assert!(Terminal::new(80, 24).is_ok());
}

#[test]
fn a_wide_east_asian_character_occupies_two_cells_with_content_in_first_and_continuation_in_second()
{
	let mut term = Terminal::new(80, 24).expect("valid terminal");
	// Chinese character '中' (width 2) followed by ASCII 'A'
	term.write_str("中A");

	let grid = term.grid();
	// Cell 0 should contain "中" and is_continuation == false
	let cell0 = grid.cell(0, 0).expect("cell 0 exists");
	assert_eq!(cell0.content, "中");
	assert!(!cell0.is_continuation);

	// Cell 1 should be continuation with empty content and is_continuation == true
	let cell1 = grid.cell(1, 0).expect("cell 1 exists");
	assert_eq!(cell1.content, "");
	assert!(cell1.is_continuation);

	// Cell 2 should contain "A"
	let cell2 = grid.cell(2, 0).expect("cell 2 exists");
	assert_eq!(cell2.content, "A");
	assert!(!cell2.is_continuation);

	// Displayed row text should show "中A"
	assert_eq!(term.row_text(0), "中A");
}

#[test]
fn a_multi_codepoint_grapheme_cluster_occupies_one_cell() {
	let mut term = Terminal::new(80, 24).expect("valid terminal");
	// 'e' + combining acute accent '\u{0301}' (é as 2 codepoints)
	let cluster = "e\u{0301}";
	term.write_str(cluster);
	term.write_str("B");

	let grid = term.grid();
	let cell0 = grid.cell(0, 0).expect("cell 0");
	assert_eq!(cell0.content, "e\u{0301}");
	assert!(!cell0.is_continuation);

	let cell1 = grid.cell(1, 0).expect("cell 1");
	assert_eq!(cell1.content, "B");
	assert!(!cell1.is_continuation);

	assert_eq!(term.row_text(0), "e\u{0301}B");
}

#[test]
fn truecolour_and_256_colour_sgr_land_exact_rgb() {
	let mut term = Terminal::new(80, 24).expect("valid terminal");

	// 24-bit Truecolor FG (250, 128, 64) and BG (10, 20, 30)
	term.write_str("\x1b[38;2;250;128;64;48;2;10;20;30mX\x1b[0m");

	{
		let grid = term.grid();
		let cell0 = grid.cell(0, 0).expect("cell 0");
		assert_eq!(cell0.content, "X");
		assert_eq!(cell0.fg, Some(ColorRgb::new(250, 128, 64)));
		assert_eq!(cell0.bg, Some(ColorRgb::new(10, 20, 30)));
	}

	// 256-color FG (index 196: red in 6x6x6 cube) and BG (index 235: gray ramp)
	term.write_str("\x1b[38;5;196;48;5;235mY\x1b[0m");
	{
		let grid = term.grid();
		let cell1 = grid.cell(1, 0).expect("cell 1");
		assert_eq!(cell1.content, "Y");
		assert_eq!(cell1.fg, Some(color_256_to_rgb(196)));
		assert_eq!(cell1.bg, Some(color_256_to_rgb(235)));
	}
}

#[test]
fn every_attribute_set_and_reset_independently() {
	let mut term = Terminal::new(80, 24).expect("valid terminal");

	// Test bold set (1) and reset (22)
	term.write_str("\x1b[1mB\x1b[22mN");
	assert!(term.grid().cell(0, 0).unwrap().attrs.bold);
	assert!(!term.grid().cell(1, 0).unwrap().attrs.bold);

	// Test dim set (2) and reset (22)
	term.write_str("\x1b[2mD\x1b[22mN");
	assert!(term.grid().cell(2, 0).unwrap().attrs.dim);
	assert!(!term.grid().cell(3, 0).unwrap().attrs.dim);

	// Test italic set (3) and reset (23)
	term.write_str("\x1b[3mI\x1b[23mN");
	assert!(term.grid().cell(4, 0).unwrap().attrs.italic);
	assert!(!term.grid().cell(5, 0).unwrap().attrs.italic);

	// Test underline set (4) and reset (24)
	term.write_str("\x1b[4mU\x1b[24mN");
	assert!(term.grid().cell(6, 0).unwrap().attrs.underline);
	assert!(!term.grid().cell(7, 0).unwrap().attrs.underline);

	// Test inverse set (7) and reset (27)
	term.write_str("\x1b[7mR\x1b[27mN");
	assert!(term.grid().cell(8, 0).unwrap().attrs.inverse);
	assert!(!term.grid().cell(9, 0).unwrap().attrs.inverse);

	// Test strikethrough set (9) and reset (29)
	term.write_str("\x1b[9mS\x1b[29mN");
	assert!(term.grid().cell(10, 0).unwrap().attrs.strikethrough);
	assert!(!term.grid().cell(11, 0).unwrap().attrs.strikethrough);
}

#[test]
fn wrap_at_right_margin_honours_deferred_wrap_state() {
	let mut term = Terminal::new(20, 5).expect("valid terminal");

	// Fill exactly 20 characters in row 0
	term.write_str("12345678901234567890");

	// Cursor should still be at (col 19, row 0) with wrap_pending true
	assert_eq!(term.grid().cursor().col, 19);
	assert_eq!(term.grid().cursor().row, 0);
	assert!(term.grid().wrap_pending());
	assert_eq!(term.row_text(0), "12345678901234567890");
	assert_eq!(term.row_text(1), "");

	// Writing the 21st character triggers wrap to row 1 col 0
	term.write_str("A");
	assert_eq!(term.grid().cursor().col, 1);
	assert_eq!(term.grid().cursor().row, 1);
	assert!(!term.grid().wrap_pending());
	assert_eq!(term.row_text(1), "A");
}

#[test]
fn scroll_region_honoured_by_su_sd_and_newline_at_bottom_margin() {
	let mut term = Terminal::new(20, 6).expect("valid terminal");

	// Set scroll region rows 2 to 4 (1-indexed: 2..=4 -> 0-indexed: 1..=3)
	// DECSTBM: CSI 2;4 r
	term.write_str("\x1b[2;4r");
	assert_eq!(term.grid().scroll_region().top, 1);
	assert_eq!(term.grid().scroll_region().bottom, 3);

	// Populate lines
	term.write_str("\x1b[1;1HRow0");
	term.write_str("\x1b[2;1HRow1");
	term.write_str("\x1b[3;1HRow2");
	term.write_str("\x1b[4;1HRow3");
	term.write_str("\x1b[5;1HRow4");
	term.write_str("\x1b[6;1HRow5");

	// Move cursor to bottom of scroll region (row index 3) and emit newline
	term.write_str("\x1b[4;1H\n");

	// Row 0 and Row 4, 5 (outside scroll region) must remain unchanged
	assert_eq!(term.row_text(0), "Row0");
	assert_eq!(term.row_text(4), "Row4");
	assert_eq!(term.row_text(5), "Row5");

	// Inside scroll region: Row1 scrolled out, Row2 moved to row index 1, Row3 to
	// row index 2, new line blank at 3
	assert_eq!(term.row_text(1), "Row2");
	assert_eq!(term.row_text(2), "Row3");
	assert_eq!(term.row_text(3), "");

	// Test SU (Scroll Up 1)
	term.write_str("\x1b[1S");
	assert_eq!(term.row_text(1), "Row3");
	assert_eq!(term.row_text(2), "");

	// Test SD (Scroll Down 1)
	term.write_str("\x1b[1T");
	assert_eq!(term.row_text(1), "");
	assert_eq!(term.row_text(2), "Row3");

	// Outside still unchanged
	assert_eq!(term.row_text(0), "Row0");
	assert_eq!(term.row_text(4), "Row4");
	assert_eq!(term.row_text(5), "Row5");
}

#[test]
fn a_malformed_escape_consumed_without_printing_and_without_corrupting_next_sequence() {
	let mut term = Terminal::new(80, 24).expect("valid terminal");

	// Feed unknown escape sequence \x1b[999z followed by normal text "HELLO"
	term.write_str("\x1b[999zHELLO");

	// "999z" must NOT be printed as text
	assert_eq!(term.row_text(0), "HELLO");
	assert_eq!(term.parser().malformed_sequences().len(), 1);

	// Malformed OSC sequence \x1b]9999;bad\x07 followed by "WORLD"
	term.write_str("\x1b]9999;bad\x07 WORLD");
	assert_eq!(term.row_text(0), "HELLO WORLD");
	assert_eq!(term.parser().malformed_sequences().len(), 2);
}

#[test]
fn bracketed_paste_not_interpreting_its_body() {
	let payload = "Hello\x1b[31mRed\x1b[0mWorld\r\n";
	let encoded = Input::bracketed_paste(payload);

	assert!(encoded.starts_with(b"\x1b[200~"));
	assert!(encoded.ends_with(b"\x1b[201~"));

	// Body inside wrapper is exact literal bytes
	let body = &encoded[6..encoded.len() - 6];
	assert_eq!(body, payload.as_bytes());
}

#[test]
fn input_injection_encodes_named_keys_modifiers_mouse_and_signals() {
	// Ctrl+C and Ctrl+D
	assert_eq!(Input::ctrl_c(), b"\x03");
	assert_eq!(Input::ctrl_d(), b"\x04");

	// Named keys
	assert_eq!(Input::key(Key::Enter, Modifiers::none()), b"\r");
	assert_eq!(Input::key(Key::Tab, Modifiers::none()), b"\t");
	assert_eq!(Input::key(Key::Tab, Modifiers::shift()), b"\x1b[Z");
	assert_eq!(Input::key(Key::Backspace, Modifiers::none()), b"\x7f");
	assert_eq!(Input::key(Key::Up, Modifiers::none()), b"\x1b[A");
	assert_eq!(Input::key(Key::Up, Modifiers::ctrl()), b"\x1b[1;5A");

	// Character with Ctrl: Ctrl+A -> \x01
	assert_eq!(Input::key(Key::Char('a'), Modifiers::ctrl()), b"\x01");
	assert_eq!(Input::key(Key::Char('c'), Modifiers::ctrl()), b"\x03");

	// SGR 1006 Mouse Event (Left press at col 10, row 5 -> 1-indexed 11, 6)
	let mouse_press = MouseEvent {
		kind:      MouseEventKind::Press(MouseButton::Left),
		col:       10,
		row:       5,
		modifiers: Modifiers::none(),
	};
	assert_eq!(Input::mouse(mouse_press), b"\x1b[<0;11;6M");

	let mouse_release = MouseEvent {
		kind:      MouseEventKind::Release(MouseButton::Left),
		col:       10,
		row:       5,
		modifiers: Modifiers::none(),
	};
	assert_eq!(Input::mouse(mouse_release), b"\x1b[<0;11;6m");
}

#[test]
fn grid_resize_truncates_and_pads_cleanly() {
	let mut term = Terminal::new(40, 10).expect("valid terminal");
	term.write_str("Line 1: 01234567890123456789\nLine 2");

	// Shrink columns to 20
	term.resize(20, 10).expect("resize ok");
	assert_eq!(term.grid().cols(), 20);
	assert_eq!(term.row_text(0), "Line 1: 012345678901");

	// Expand columns to 50
	term.resize(50, 10).expect("resize ok");
	assert_eq!(term.grid().cols(), 50);
	assert_eq!(term.row_text(0), "Line 1: 012345678901");

	// Refuse invalid resize
	assert_eq!(term.resize(10, 10), Err(DimensionError { cols: 10, rows: 10 }));
}

#[test]
fn assertion_helpers_extract_regions_styles_and_stable_snapshot() {
	let mut term = Terminal::new(30, 5).expect("valid terminal");
	term.write_str("\x1b[1;31mHeader\x1b[0m\r\n\x1b[32mContent\x1b[0m");

	let region = Region::new(0, 0, 10, 1);
	let text = Assert::region_text(term.grid(), region);
	assert_eq!(text, vec!["Header", "Content"]);

	let styles = Assert::styles_in_region(term.grid(), region);
	// Should have at least header style (bold, red) and content style (green)
	assert!(styles.iter().any(|s| s.attrs.bold && s.fg.is_some()));
	assert!(styles.iter().any(|s| s.fg.is_some() && !s.attrs.bold));

	let snapshot = term.snapshot();
	assert!(snapshot.contains("000: |Header"));
	assert!(snapshot.contains("001: |Content"));
}

/// Standard expected 16-color ANSI palette for testing palette mapping.
const TEST_BASIC_16_PALETTE: [ColorRgb; 16] = [
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

/// Dynamic source enumeration and dispatch sweep.
///
/// Sweep the SGR parameter table and CSI dispatch table from source so a
/// sequence the parser handles without a test turns the suite RED.
#[test]
fn sgr_parameter_table_and_csi_dispatch_table_sweep() {
	let handled_sgr_params: Vec<u32> = (0u32..=255).filter(|p| sgr_effect(*p).is_some()).collect();

	// Pin the exact set of handled SGR parameters. If a parameter is added to
	// sgr_effect without updating this exact-equality assertion, the test turns
	// RED.
	let expected_sgr_params: Vec<u32> = vec![
		0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
		43, 44, 45, 46, 47, 48, 49, 90, 91, 92, 93, 94, 95, 96, 97, 100, 101, 102, 103, 104, 105,
		106, 107,
	];
	assert_eq!(
		handled_sgr_params, expected_sgr_params,
		"handled SGR parameter set diverged from expected registration"
	);

	// Verify the concrete EFFECT of every swept SGR parameter through
	// Terminal::write_str
	for &param in &handled_sgr_params {
		let effect = sgr_effect(param).unwrap();
		let mut term = Terminal::new(80, 24).unwrap();
		match effect {
			SgrEffect::Reset => {
				term.write_str("\x1b[1;31;42m\x1b[0mX");
				let cell = term.grid().cell(0, 0).unwrap();
				assert!(cell.attrs.is_empty(), "param 0 should reset attrs");
				assert_eq!(cell.fg, None, "param 0 should reset fg");
				assert_eq!(cell.bg, None, "param 0 should reset bg");
			},
			SgrEffect::Bold(v) => {
				term.write_str(&format!("\x1b[{param}mX"));
				assert_eq!(
					term.grid().cell(0, 0).unwrap().attrs.bold,
					v,
					"param {param} bold effect mismatch"
				);
			},
			SgrEffect::Dim(v) => {
				term.write_str(&format!("\x1b[{param}mX"));
				assert_eq!(
					term.grid().cell(0, 0).unwrap().attrs.dim,
					v,
					"param {param} dim effect mismatch"
				);
			},
			SgrEffect::Italic(v) => {
				term.write_str(&format!("\x1b[{param}mX"));
				assert_eq!(
					term.grid().cell(0, 0).unwrap().attrs.italic,
					v,
					"param {param} italic effect mismatch"
				);
			},
			SgrEffect::Underline(v) => {
				term.write_str(&format!("\x1b[{param}mX"));
				assert_eq!(
					term.grid().cell(0, 0).unwrap().attrs.underline,
					v,
					"param {param} underline effect mismatch"
				);
			},
			SgrEffect::Inverse(v) => {
				term.write_str(&format!("\x1b[{param}mX"));
				assert_eq!(
					term.grid().cell(0, 0).unwrap().attrs.inverse,
					v,
					"param {param} inverse effect mismatch"
				);
			},
			SgrEffect::Strikethrough(v) => {
				term.write_str(&format!("\x1b[{param}mX"));
				assert_eq!(
					term.grid().cell(0, 0).unwrap().attrs.strikethrough,
					v,
					"param {param} strikethrough effect mismatch"
				);
			},
			SgrEffect::Fg(color) => {
				term.write_str(&format!("\x1b[{param}mX"));
				let expected_color = if (30..=37).contains(&param) {
					TEST_BASIC_16_PALETTE[(param - 30) as usize]
				} else if (90..=97).contains(&param) {
					TEST_BASIC_16_PALETTE[(param - 90 + 8) as usize]
				} else {
					color
				};
				assert_eq!(
					term.grid().cell(0, 0).unwrap().fg,
					Some(expected_color),
					"param {param} fg color mismatch against expected palette"
				);
			},
			SgrEffect::Bg(color) => {
				term.write_str(&format!("\x1b[{param}mX"));
				let expected_color = if (40..=47).contains(&param) {
					TEST_BASIC_16_PALETTE[(param - 40) as usize]
				} else if (100..=107).contains(&param) {
					TEST_BASIC_16_PALETTE[(param - 100 + 8) as usize]
				} else {
					color
				};
				assert_eq!(
					term.grid().cell(0, 0).unwrap().bg,
					Some(expected_color),
					"param {param} bg color mismatch against expected palette"
				);
			},
			SgrEffect::DefaultFg => {
				term.write_str("\x1b[31m\x1b[39mX");
				assert_eq!(
					term.grid().cell(0, 0).unwrap().fg,
					None,
					"param 39 should reset fg to default"
				);
			},
			SgrEffect::DefaultBg => {
				term.write_str("\x1b[41m\x1b[49mX");
				assert_eq!(
					term.grid().cell(0, 0).unwrap().bg,
					None,
					"param 49 should reset bg to default"
				);
			},
			SgrEffect::ExtendedFg => {
				term.write_str("\x1b[38;2;12;34;56mX");
				assert_eq!(
					term.grid().cell(0, 0).unwrap().fg,
					Some(ColorRgb::new(12, 34, 56)),
					"param 38 extended fg mismatch"
				);
			},
			SgrEffect::ExtendedBg => {
				term.write_str("\x1b[48;2;65;43;21mX");
				assert_eq!(
					term.grid().cell(0, 0).unwrap().bg,
					Some(ColorRgb::new(65, 43, 21)),
					"param 48 extended bg mismatch"
				);
			},
		}
	}

	// CSI command sweep
	let handled_csi_bytes: Vec<u8> = (0x20u8..=0x7eu8)
		.filter(|b| csi_action(*b).is_some())
		.collect();

	// Pin the exact set of handled CSI commands
	let expected_csi_bytes: Vec<u8> = vec![
		b'A', b'B', b'C', b'D', b'E', b'F', b'G', b'H', b'J', b'K', b'S', b'T', b'X', b'd', b'f',
		b'm', b'n', b'r', b's', b'u',
	];
	assert_eq!(
		handled_csi_bytes, expected_csi_bytes,
		"handled CSI final byte set diverged from expected registration"
	);

	// Verify concrete EFFECT of every swept CSI command through Terminal::write_str
	for &byte in &handled_csi_bytes {
		let action = csi_action(byte).unwrap();
		let mut term = Terminal::new(80, 24).unwrap();
		let ch = byte as char;
		match action {
			CsiAction::CursorUp => {
				term.grid_mut().set_cursor(0, 5);
				term.write_str(&format!("\x1b[2{ch}"));
				assert_eq!(term.grid().cursor().row, 3);
			},
			CsiAction::CursorDown => {
				term.write_str(&format!("\x1b[3{ch}"));
				assert_eq!(term.grid().cursor().row, 3);
			},
			CsiAction::CursorForward => {
				term.write_str(&format!("\x1b[5{ch}"));
				assert_eq!(term.grid().cursor().col, 5);
			},
			CsiAction::CursorBackward => {
				term.grid_mut().set_cursor(10, 0);
				term.write_str(&format!("\x1b[4{ch}"));
				assert_eq!(term.grid().cursor().col, 6);
			},
			CsiAction::CursorNextLine => {
				term.grid_mut().set_cursor(10, 2);
				term.write_str(&format!("\x1b[2{ch}"));
				assert_eq!(term.grid().cursor().row, 4);
				assert_eq!(term.grid().cursor().col, 0);
			},
			CsiAction::CursorPreviousLine => {
				term.grid_mut().set_cursor(10, 5);
				term.write_str(&format!("\x1b[2{ch}"));
				assert_eq!(term.grid().cursor().row, 3);
				assert_eq!(term.grid().cursor().col, 0);
			},
			CsiAction::CursorHorizontalAbsolute => {
				term.grid_mut().set_cursor(0, 5);
				term.write_str(&format!("\x1b[12{ch}"));
				assert_eq!(term.grid().cursor().col, 11);
				assert_eq!(term.grid().cursor().row, 5);
			},
			CsiAction::CursorPosition | CsiAction::HorizontalVerticalPosition => {
				term.write_str(&format!("\x1b[4;7{ch}"));
				assert_eq!(term.grid().cursor().row, 3);
				assert_eq!(term.grid().cursor().col, 6);
			},
			CsiAction::LinePositionAbsolute => {
				term.grid_mut().set_cursor(5, 0);
				term.write_str(&format!("\x1b[8{ch}"));
				assert_eq!(term.grid().cursor().row, 7);
				assert_eq!(term.grid().cursor().col, 5);
			},
			CsiAction::EraseInDisplay => {
				term.write_str("Hello\x1b[2J");
				assert_eq!(term.row_text(0), "");
			},
			CsiAction::EraseInLine => {
				term.write_str("Hello\x1b[1;1H\x1b[2K");
				assert_eq!(term.row_text(0), "");
			},
			CsiAction::EraseCharacters => {
				term.write_str("ABCDE\x1b[1;2H\x1b[2X");
				assert_eq!(term.row_text(0), "A  DE");
			},
			CsiAction::ScrollUp => {
				term.write_str("Line1\r\nLine2\x1b[1S");
				assert_eq!(term.row_text(0), "Line2");
			},
			CsiAction::ScrollDown => {
				term.write_str("Line1\r\nLine2\x1b[1T");
				assert_eq!(term.row_text(0), "");
				assert_eq!(term.row_text(1), "Line1");
			},
			CsiAction::SetScrollRegion => {
				term.write_str(&format!("\x1b[3;8{ch}"));
				assert_eq!(term.grid().scroll_region().top, 2);
				assert_eq!(term.grid().scroll_region().bottom, 7);
			},
			CsiAction::SaveCursor => {
				term.grid_mut().set_cursor(14, 8);
				term.write_str(&format!("\x1b[{ch}"));
				term.grid_mut().set_cursor(0, 0);
				term.write_str("\x1b[u");
				assert_eq!(term.grid().cursor().col, 14);
				assert_eq!(term.grid().cursor().row, 8);
			},
			CsiAction::RestoreCursor => {
				term.grid_mut().set_cursor(12, 6);
				term.write_str("\x1b[s");
				term.grid_mut().set_cursor(0, 0);
				term.write_str(&format!("\x1b[{ch}"));
				assert_eq!(term.grid().cursor().col, 12);
				assert_eq!(term.grid().cursor().row, 6);
			},
			CsiAction::SelectGraphicRendition => {
				term.write_str(&format!("\x1b[1{ch}X"));
				assert!(term.grid().cell(0, 0).unwrap().attrs.bold);
			},
			CsiAction::DeviceStatusReport => {
				// Status report query: CSI 5 n -> ESC [ 0 n
				term.write_str(&format!("\x1b[5{ch}"));
				assert_eq!(term.responses(), &["\x1b[0n".to_string()]);
				term.take_responses();

				// Cursor position report query: CSI 6 n -> ESC [ <row> ; <col> R (1-based)
				// Cursor at 0-based (row 3, col 7) -> 1-based (4, 8) -> "\x1b[4;8R"
				term.grid_mut().set_cursor(7, 3);
				term.write_str(&format!("\x1b[6{ch}"));
				assert_eq!(
					term.responses(),
					&["\x1b[4;8R".to_string()],
					"CPR response for cursor (3, 7) must be exact 1-based \\x1b[4;8R"
				);
				term.take_responses();

				// Move cursor and query again: prove reply tracks cursor dynamically
				term.grid_mut().set_cursor(19, 9);
				term.write_str(&format!("\x1b[6{ch}"));
				assert_eq!(
					term.responses(),
					&["\x1b[10;20R".to_string()],
					"CPR response for cursor (9, 19) must track to \\x1b[10;20R"
				);
				assert!(term.parser().malformed_sequences().is_empty());
			},
		}
	}

	// Inverse arm: unhandled SGR parameters and unhandled CSI final bytes from the
	// complement of the swept sets MUST be recorded as malformed and must NOT
	// print as text.
	let unhandled_sgr_params: Vec<u32> = (0u32..=255).filter(|p| sgr_effect(*p).is_none()).collect();
	assert!(!unhandled_sgr_params.is_empty(), "complement of SGR set must not be empty");
	for &param in &unhandled_sgr_params {
		let mut term = Terminal::new(80, 24).unwrap();
		term.write_str(&format!("\x1b[{param}m"));
		assert_eq!(term.row_text(0), "", "unhandled SGR param {param} printed as text");
		assert_eq!(
			term.parser().malformed_sequences().len(),
			1,
			"unhandled SGR param {param} was not recorded as malformed"
		);
	}

	let unhandled_csi_bytes: Vec<u8> = (0x20u8..=0x7eu8)
		.filter(|b| csi_action(*b).is_none())
		.collect();
	assert!(!unhandled_csi_bytes.is_empty(), "complement of CSI set must not be empty");
	for &byte in &unhandled_csi_bytes {
		let ch = byte as char;
		let mut term = Terminal::new(80, 24).unwrap();
		// Send the unhandled byte followed by ESC to ensure state resets if byte was
		// treated as parameter
		term.write_str(&format!("\x1b[99{ch}\x1b"));
		assert_eq!(term.row_text(0), "", "unhandled CSI command '{ch}' printed as text");
		assert!(
			!term.parser().malformed_sequences().is_empty(),
			"unhandled CSI command '{ch}' was not recorded as malformed"
		);
	}
}
