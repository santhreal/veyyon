//! WHY: raw terminal bytes from command executions and shells must be decoded
//! into styled grid cells without visual corruption or control byte leakage.
//! The defect classes closed here are:
//! 1. Control sequences (CSI/OSC/DCS/escape) leaking raw ASCII into the visible
//!    cells.
//! 2. Multi-byte UTF-8 sequences split across network chunks failing to decode.
//! 3. Scrollback growing unboundedly and exhausting memory past the 10,000 row
//!    bound.
//! 4. Unrecognized or malformed sequences causing panics or corrupting the
//!    cursor.
//!
//! WHAT THIS DOES NOT CATCH: renderer-level font shaping or GPU quad
//! rasterization, which are defended in the frame verification suites.

use veyyon_desktop_surface::terminal::{
	Ink, MAX_SCROLLBACK_ROWS, TerminalEmulator,
};

#[test]
fn the_terminal_parser_handles_sgr_cursor_erase_scroll_and_osc() {
	let mut emu = TerminalEmulator::new(80, 24);

	// 1. Text printing and cursor positioning
	emu.feed(b"Hello, World!\r\nLine 2");
	assert_eq!(emu.grid().cursor_col, 6);
	assert_eq!(emu.grid().cursor_row, 1);
	let row0 = emu.grid().visible_row(0).expect("row 0 exists");
	let text0: String = row0[..13].iter().map(|c| c.c).collect();
	assert_eq!(text0, "Hello, World!");

	// 2. Clear screen and cursor home: \x1b[2J\x1b[H
	emu.feed(b"\x1b[2J\x1b[H");
	assert_eq!(emu.grid().cursor_col, 0);
	assert_eq!(emu.grid().cursor_row, 0);
	let row0_cleared = emu.grid().visible_row(0).expect("row 0 exists");
	assert!(row0_cleared.iter().all(|c| c.c == ' '));

	// 3. SGR formatting: bold, underline, 256-color, truecolor
	emu.feed(b"\x1b[1;4;38;5;196;48;2;10;20;30mStyled\x1b[0m");
	let row0_styled = emu.grid().visible_row(0).expect("row 0 exists");
	let cell0 = row0_styled[0];
	assert_eq!(cell0.c, 'S');
	assert!(cell0.style.bold);
	assert!(cell0.style.underline);
	assert_eq!(cell0.ink, Ink::Indexed(196));
	assert_eq!(cell0.bg_ink, Ink::Rgb(10, 20, 30));

	// 4. Cursor save and restore: DECSC (\x1b7) and DECRC (\x1b8)
	emu.feed(b"\x1b[10;20H\x1b7\x1b[1;1H\x1b8");
	assert_eq!(emu.grid().cursor_row, 9);
	assert_eq!(emu.grid().cursor_col, 19);

	// 5. OSC 2 window titles via BEL (\x07) and String Terminator (\x1b\\)
	emu.feed(b"\x1b]2;Build Output\x07");
	assert_eq!(emu.grid().title, "Build Output");
	emu.feed(b"\x1b]2;Tests Finished\x1b\\");
	assert_eq!(emu.grid().title, "Tests Finished");

	// 6. Unknown CSI sequences are silently consumed without printing bytes
	emu.feed(b"\x1b[?9999z\x1b[123;456$qClean");
	let row9 = emu.grid().visible_row(9).expect("row 9 exists");
	let written: String = row9[19..24].iter().map(|c| c.c).collect();
	assert_eq!(written, "Clean");
}

#[test]
fn the_terminal_handles_wide_cjk_glyphs_and_split_utf8_chunks() {
	let mut emu = TerminalEmulator::new(80, 24);

	// Wide CJK characters taking 2 columns each
	emu.feed("世界".as_bytes());
	assert_eq!(emu.grid().cursor_col, 4);
	let row0 = emu.grid().visible_row(0).expect("row 0 exists");
	assert_eq!(row0[0].c, '世');
	assert_eq!(row0[0].width, 2);
	assert_eq!(row0[1].c, ' ');
	assert_eq!(row0[1].width, 0);
	assert_eq!(row0[2].c, '界');
	assert_eq!(row0[2].width, 2);
	assert_eq!(row0[3].c, ' ');
	assert_eq!(row0[3].width, 0);

	// Multi-byte UTF-8 character split across two feed calls (crab: \u{1f980} =
	// [0xF0, 0x9F, 0xA6, 0x80])
	emu.feed(&[0xf0, 0x9f]);
	// Intermediate state has not placed the char yet
	assert_eq!(emu.grid().cursor_col, 4);
	emu.feed(&[0xa6, 0x80]);
	assert_eq!(emu.grid().cursor_col, 6);
	let row0_after = emu.grid().visible_row(0).expect("row 0 exists");
	assert_eq!(row0_after[4].c, '🦀');
	assert_eq!(row0_after[4].width, 2);
	assert_eq!(row0_after[5].width, 0);
}

#[test]
fn scroll_regions_and_scrollback_capacity_are_strictly_bounded() {
	let mut emu = TerminalEmulator::new(80, 24);

	// Set scroll region from line 2 to 5 (1-indexed: \x1b[2;5r)
	emu.feed(b"\x1b[2;5r");
	assert_eq!(emu.grid().scroll_top, 1);
	assert_eq!(emu.grid().scroll_bottom, 4);

	// Scroll up 2 lines within the region
	emu.feed(b"\x1b[2S");
	assert_eq!(emu.grid().scroll_top, 1);
	assert_eq!(emu.grid().scroll_bottom, 4);

	// Reset scroll region and feed 15,000 lines
	emu.feed(b"\x1b[1;24r");
	for i in 0..15_000 {
		emu.feed(format!("Line {i}\r\n").as_bytes());
	}

	// Scrollback history is strictly capped at MAX_SCROLLBACK_ROWS (10,000)
	assert_eq!(emu.grid().scrollback_len(), MAX_SCROLLBACK_ROWS);
}

#[test]
fn random_byte_fuzzing_never_panics_and_never_leaks_escape_bytes() {
	let mut emu = TerminalEmulator::new(80, 24);

	// Deterministic pseudo-random byte generator (xorshift64)
	let mut seed: u64 = 0xdead_beef_cafe_babe;
	let mut rand_bytes = Vec::with_capacity(10_000);
	for _ in 0..10_000 {
		seed ^= seed << 13;
		seed ^= seed >> 7;
		seed ^= seed << 17;
		rand_bytes.push((seed & 0xff) as u8);
	}

	emu.feed(&rand_bytes);

	// Verify that no cell in the visible grid contains an ESC control byte
	for r in 0..emu.grid().rows {
		if let Some(row) = emu.grid().visible_row(r) {
			for cell in row {
				assert_ne!(cell.c, '\x1b', "escape character leaked into visible cell");
			}
		}
	}
}
