//! WHY. Raw terminal byte streams carry control characters, ANSI escape codes,
//! multi-byte UTF-8, and cursor positioning commands. Missing sequence
//! dispatch, splitting a multi-byte character across chunks, or unbounded
//! scrollback growth results in corrupted rendering or runaway allocations.
//!
//! THE CLASS. Terminal escape sequences and byte chunks failing to update the
//! emulator grid deterministically. This suite sweeps every sequence variant in
//! [`SequenceKind::ALL`], exercises chunk splits down to 1 byte, and verifies
//! bounds against malformed sequences and massive streams.
//!
//! WHAT IT DOES NOT CATCH. Physical glyph rasterization, font shaping, and host
//! PTY I/O, which belong to the OS and window renderer.

use std::collections::BTreeSet;

use super::{
	emulator::TerminalEmulator,
	sequences::SequenceKind,
	types::{CellAttributes, CellColor},
};

#[test]
fn every_sequence_kind_has_a_unique_name() {
	let names: BTreeSet<&'static str> = SequenceKind::ALL.iter().map(|kind| kind.name()).collect();
	assert_eq!(names.len(), SequenceKind::ALL.len(), "duplicate sequence name");
}

#[test]
fn sequence_table_sweep_dispatches_every_sequence() {
	for &kind in SequenceKind::ALL {
		let mut em = TerminalEmulator::new(10, 10);
		em.feed(b"HELLO\r\nWORLD");
		em.feed(kind.sample_bytes());

		match kind {
			SequenceKind::Bell => assert!(em.take_bell(), "bell flag was not set"),
			SequenceKind::Backspace => assert_eq!(em.cursor().col, 4, "backspace did not move col"),
			SequenceKind::HorizontalTab => {
				assert_eq!(em.cursor().col, 8, "horizontal tab did not advance to tabstop")
			},
			SequenceKind::LineFeed => assert_eq!(em.cursor().row, 2, "line feed did not advance row"),
			SequenceKind::CarriageReturn => {
				assert_eq!(em.cursor().col, 0, "carriage return did not return col to 0")
			},
			SequenceKind::CursorUp => assert_eq!(em.cursor().row, 0, "cursor up failed"),
			SequenceKind::CursorDown => assert_eq!(em.cursor().row, 3, "cursor down failed"),
			SequenceKind::CursorForward => assert_eq!(em.cursor().col, 8, "cursor forward failed"),
			SequenceKind::CursorBack => assert_eq!(em.cursor().col, 3, "cursor back failed"),
			SequenceKind::CursorNextLine => {
				assert_eq!(em.cursor().row, 3, "cursor next line row mismatch");
				assert_eq!(em.cursor().col, 0, "cursor next line col mismatch");
			},
			SequenceKind::CursorPreviousLine => {
				assert_eq!(em.cursor().row, 0, "cursor prev line row mismatch");
				assert_eq!(em.cursor().col, 0, "cursor prev line col mismatch");
			},
			SequenceKind::CursorHorizontalAbsolute => {
				assert_eq!(em.cursor().col, 4, "cursor horizontal absolute failed")
			},
			SequenceKind::CursorPosition => {
				assert_eq!(em.cursor().row, 2, "cursor position row mismatch");
				assert_eq!(em.cursor().col, 3, "cursor position col mismatch");
			},
			SequenceKind::HorizontalVerticalPosition => {
				assert_eq!(em.cursor().row, 1, "hvp row mismatch");
				assert_eq!(em.cursor().col, 5, "hvp col mismatch");
			},
			SequenceKind::VerticalPositionAbsolute => {
				assert_eq!(em.cursor().row, 3, "vpa row mismatch")
			},
			SequenceKind::EraseInDisplay => {
				let cell = em.cell(1, 0).expect("cell exists");
				assert!(cell.is_blank(), "erase in display did not clear grid");
			},
			SequenceKind::EraseInLine => {
				let cell = em.cell(1, 0).expect("cell exists");
				assert!(cell.is_blank(), "erase in line did not clear line");
			},
			SequenceKind::EraseCharacter => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"ABCDEFG\x1b[3G\x1b[2X");
				assert_eq!(em2.cell(0, 2).expect("cell").grapheme, " ");
				assert_eq!(em2.cell(0, 3).expect("cell").grapheme, " ");
				assert_eq!(em2.cell(0, 4).expect("cell").grapheme, "E");
			},
			SequenceKind::InsertLine => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"AAA\r\nBBB\r\nCCC\x1b[2;1H\x1b[1L");
				assert_eq!(em2.cell(1, 0).expect("cell").grapheme, " ");
				assert_eq!(em2.cell(2, 0).expect("cell").grapheme, "B");
			},
			SequenceKind::DeleteLine => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"AAA\r\nBBB\r\nCCC\x1b[1;1H\x1b[1M");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, "B");
			},
			SequenceKind::InsertCharacter => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"ABC\x1b[1;2H\x1b[1@");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, "A");
				assert_eq!(em2.cell(0, 1).expect("cell").grapheme, " ");
				assert_eq!(em2.cell(0, 2).expect("cell").grapheme, "B");
			},
			SequenceKind::DeleteCharacter => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"ABC\x1b[1;1H\x1b[1P");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, "B");
			},
			SequenceKind::ScrollUp => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"AAA\r\nBBB\r\nCCC\x1b[1S");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, "B");
			},
			SequenceKind::ScrollDown => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"AAA\r\nBBB\r\nCCC\x1b[1T");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, " ");
				assert_eq!(em2.cell(1, 0).expect("cell").grapheme, "A");
			},
			SequenceKind::SetScrollRegion => {
				assert_eq!(em.cursor().row, 0, "scroll region did not reset cursor to 0");
			},
			SequenceKind::SgrReset => {
				em.feed(b"X");
				let cell = em.cell(1, 5).expect("cell");
				assert_eq!(cell.attrs, CellAttributes::default());
				assert_eq!(cell.fg, CellColor::Default);
				assert_eq!(cell.bg, CellColor::Default);
			},
			SequenceKind::SgrBold => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.bold);
			},
			SequenceKind::SgrDim => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.dim);
			},
			SequenceKind::SgrItalic => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.italic);
			},
			SequenceKind::SgrUnderline => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.underline);
			},
			SequenceKind::SgrReverse => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.reverse);
			},
			SequenceKind::SgrHidden => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.hidden);
			},
			SequenceKind::SgrStrikethrough => {
				em.feed(b"X");
				assert!(em.cell(1, 5).expect("cell").attrs.strikethrough);
			},
			SequenceKind::SgrForegroundIndexed => {
				em.feed(b"X");
				assert_eq!(em.cell(1, 5).expect("cell").fg, CellColor::Indexed(196));
			},
			SequenceKind::SgrBackgroundIndexed => {
				em.feed(b"X");
				assert_eq!(em.cell(1, 5).expect("cell").bg, CellColor::Indexed(22));
			},
			SequenceKind::SgrForegroundRgb => {
				em.feed(b"X");
				assert_eq!(em.cell(1, 5).expect("cell").fg, CellColor::Rgb(100, 150, 200));
			},
			SequenceKind::SgrBackgroundRgb => {
				em.feed(b"X");
				assert_eq!(em.cell(1, 5).expect("cell").bg, CellColor::Rgb(50, 60, 70));
			},
			SequenceKind::SgrForegroundDefault => {
				em.feed(b"X");
				assert_eq!(em.cell(1, 5).expect("cell").fg, CellColor::Default);
			},
			SequenceKind::SgrBackgroundDefault => {
				em.feed(b"X");
				assert_eq!(em.cell(1, 5).expect("cell").bg, CellColor::Default);
			},
			SequenceKind::DecSetCursorVisible => assert!(em.cursor().visible),
			SequenceKind::DecResetCursorVisible => assert!(!em.cursor().visible),
			SequenceKind::DecSetAlternateScreen => assert!(em.is_alt_screen()),
			SequenceKind::DecResetAlternateScreen => assert!(!em.is_alt_screen()),
			SequenceKind::DecSetAutoWrap => {
				let mut em2 = TerminalEmulator::new(3, 2);
				em2.feed(b"\x1b[?7hABCD");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, "A");
				assert_eq!(em2.cell(1, 0).expect("cell").grapheme, "D");
			},
			SequenceKind::DecResetAutoWrap => {
				let mut em2 = TerminalEmulator::new(3, 2);
				em2.feed(b"\x1b[?7lABCD");
				assert_eq!(em2.cell(0, 0).expect("cell").grapheme, "A");
				assert_eq!(em2.cell(0, 2).expect("cell").grapheme, "D");
			},
			SequenceKind::SaveCursorEsc | SequenceKind::SaveCursorCsi => {
				assert_eq!(em.cursor().row, 1);
			},
			SequenceKind::RestoreCursorEsc | SequenceKind::RestoreCursorCsi => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"\x1b[3;5H\x1b7\x1b[1;1H\x1b8");
				assert_eq!(em2.cursor().row, 2);
				assert_eq!(em2.cursor().col, 4);
			},
			SequenceKind::ReverseIndex => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"\x1b[2;1H\x1bM");
				assert_eq!(em2.cursor().row, 0);
			},
			SequenceKind::NextLine => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"ABC\x1bE");
				assert_eq!(em2.cursor().row, 1);
				assert_eq!(em2.cursor().col, 0);
			},
			SequenceKind::HorizontalTabSet => {
				let mut em2 = TerminalEmulator::new(10, 10);
				em2.feed(b"\x1b[1;3H\x1bH\x1b[1;1H\t");
				assert_eq!(em2.cursor().col, 2);
			},
			SequenceKind::TabClear => {
				let mut em2 = TerminalEmulator::new(20, 10);
				em2.feed(b"\x1b[3g\t");
				assert_eq!(em2.cursor().col, 19);
			},
			SequenceKind::DecScreenAlignment => {
				assert_eq!(em.cell(0, 0).expect("cell").grapheme, "E");
				assert_eq!(em.cell(9, 9).expect("cell").grapheme, "E");
			},
			SequenceKind::ResetToInitialState => {
				assert_eq!(em.cursor().row, 0);
				assert_eq!(em.cursor().col, 0);
			},
		}
	}
}

#[test]
fn chunk_boundary_split_property() {
	let fixture = b"Hello, World!\n\x1b[1;31mRed Bold Text\x1b[0m\nLine 3 \xE4\xB8\xAD\xE6\x96\x87\n\x1b[2;2H\x1b[1K";
	let mut baseline = TerminalEmulator::new(20, 10);
	baseline.feed(fixture);

	for chunk_size in [1, 2, 7] {
		let mut em = TerminalEmulator::new(20, 10);
		for chunk in fixture.chunks(chunk_size) {
			em.feed(chunk);
		}
		for r in 0..10 {
			for c in 0..20 {
				assert_eq!(
					em.cell(r, c),
					baseline.cell(r, c),
					"mismatch at row {r}, col {c} with chunk size {chunk_size}"
				);
			}
		}
	}
}

#[test]
fn scrollback_bounds_and_memory_termination() {
	let ceiling = 100;
	let mut em = TerminalEmulator::with_ceiling(10, 5, ceiling);
	for i in 0..500 {
		em.feed(format!("Line {}\r\n", i).as_bytes());
	}
	assert_eq!(em.history_lines(), ceiling, "scrollback exceeded ceiling");
	assert_eq!(em.total_lines(), 501, "total lines count did not accumulate");

	// 10 MB stream of \x1b[H should terminate without allocating extra lines
	let cup_chunk = b"\x1b[H".repeat(1000);
	for _ in 0..3333 {
		em.feed(&cup_chunk);
	}
	assert_eq!(em.history_lines(), ceiling);

	// Malformed CSI with 300 parameters terminates without panic
	let mut malformed = vec![b'\x1b', b'['];
	for _ in 0..300 {
		malformed.extend_from_slice(b"12;");
	}
	malformed.push(b'm');
	em.feed(&malformed);
}

#[test]
fn wide_characters_and_zero_width_joiners() {
	let mut em = TerminalEmulator::new(10, 5);
	// Chinese character: width 2
	em.feed("\u{4E2D}A".as_bytes());
	let c0 = em.cell(0, 0).expect("c0");
	let c1 = em.cell(0, 1).expect("c1");
	let c2 = em.cell(0, 2).expect("c2");
	assert_eq!(c0.grapheme, "\u{4E2D}");
	assert!(c0.wide);
	assert!(!c0.wide_spacer);
	assert!(c1.wide_spacer);
	assert_eq!(c2.grapheme, "A");
	assert!(!c2.wide);

	// Zero-width joiner combining
	let mut em2 = TerminalEmulator::new(10, 5);
	em2.feed("A\u{200D}B".as_bytes());
	let cell0 = em2.cell(0, 0).expect("cell0");
	assert_eq!(cell0.grapheme, "A\u{200D}");
	let cell1 = em2.cell(0, 1).expect("cell1");
	assert_eq!(cell1.grapheme, "B");
}

#[test]
fn reflow_rewraps_logical_lines_on_width_change() {
	let mut em = TerminalEmulator::new(10, 5);
	em.feed(b"1234567890ABCDE");
	assert_eq!(em.line(0).expect("line 0").cells[0].grapheme, "1");
	assert_eq!(em.line(0).expect("line 0").cells[9].grapheme, "0");
	assert!(em.line(0).expect("line 0").wrapped);
	assert_eq!(em.line(1).expect("line 1").cells[0].grapheme, "A");

	em.resize(20, 5);
	assert_eq!(em.line(0).expect("line 0").cells[0].grapheme, "1");
	assert_eq!(em.line(0).expect("line 0").cells[14].grapheme, "E");
	assert!(!em.line(0).expect("line 0").wrapped);
}
