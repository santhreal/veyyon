//! WHY: a terminal emulator is a table of sequences, and the way it rots is
//! one row of that table. A class is added to the parser and nothing drives
//! it; a class is routed but its arm was never reached; a refactor changes
//! the final byte one class answers to and the sweep that named its bytes by
//! hand keeps passing. This sweep reads the classes out of the emulator at
//! run time, drives each one through the real parser as bytes, and asserts
//! the grid moved in the way that class is for.
//!
//! CLASS CLOSED: any sequence class the emulator declares that
//! 1. no byte reaches, because the classifier does not map its selector,
//! 2. reaches its arm and changes nothing observable,
//! 3. is declared in one introducer's table and missing from the union the
//!    sweep reads, or
//! 4. is added to the table with no case recorded here -- the match below is
//!    exhaustive over the class, so a new variant fails to compile.
//!
//! WHAT THIS DOES NOT CATCH: whether a class's behaviour is the one the
//! standard states -- that a cursor moved is asserted here, that it moved to
//! the right cell for every parameter is the parser suite's. Nor the bytes a
//! host actually sends, which is the backtest's corpus.

use veyyon_desktop_model::text::terminal::{
	ControlChar, CsiSeq, EscapeSeq, OscSeq, SequenceClass, TerminalEmulator,
};

/// The grid facts a case is judged on, read before and after the bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Observed {
	cursor:     (usize, usize),
	remembered: (usize, usize),
	visible:    Vec<String>,
	title:      String,
	scroll:     (usize, usize),
	styled:     bool,
	auto_wrap:  bool,
	cursor_lit: bool,
	alternate:  bool,
}

fn observe(emu: &TerminalEmulator) -> Observed {
	let grid = emu.grid();
	Observed {
		cursor:     (grid.cursor_col, grid.cursor_row),
		remembered: (grid.saved_cursor_primary.col, grid.saved_cursor_primary.row),
		visible:    (0..grid.rows)
			.filter_map(|row| grid.visible_row(row))
			.map(|row| row.iter().map(|cell| cell.c).collect())
			.collect(),
		title:      grid.title.clone(),
		scroll:     (grid.scroll_top, grid.scroll_bottom),
		styled:     grid.style != veyyon_desktop_model::text::terminal::CellStyle::new(),
		auto_wrap:  grid.auto_wrap,
		cursor_lit: grid.cursor_visible,
		alternate:  grid.alternate_screen,
	}
}

/// What a class is driven with, and what the drive has to leave behind.
struct Case {
	/// Bytes that put the grid in the state the class acts on.
	seed:  &'static [u8],
	/// The bytes that select the class.
	drive: &'static [u8],
}

/// The case for one class. Exhaustive: a class added to the emulator's table
/// has no arm here and this file stops compiling, which is the point.
const fn case(class: SequenceClass) -> Case {
	match class {
		SequenceClass::Control(control) => match control {
			// A bell changes nothing by design, so it is driven with a seed
			// that would be disturbed by anything else and asserted unchanged.
			ControlChar::Bell => Case { seed: b"abc", drive: b"\x07" },
			ControlChar::Backspace => Case { seed: b"abc", drive: b"\x08" },
			ControlChar::Tab => Case { seed: b"", drive: b"\t" },
			ControlChar::LineFeed => Case { seed: b"", drive: b"\n" },
			ControlChar::CarriageReturn => Case { seed: b"abc", drive: b"\r" },
		},
		SequenceClass::Escape(escape) => match escape {
			EscapeSeq::Index => Case { seed: b"", drive: b"\x1bD" },
			EscapeSeq::ReverseIndex => Case { seed: b"\n\n", drive: b"\x1bM" },
			EscapeSeq::NextLine => Case { seed: b"abc", drive: b"\x1bE" },
			// A save is observable through the restore that follows it: the
			// cursor is moved between the two, so a save that recorded
			// nothing leaves the cursor where the move put it.
			// A save writes nowhere on screen, so it is read off the cursor the
			// grid remembers: the seed moves the cursor, the drive records it.
			EscapeSeq::SaveCursor => Case { seed: b"abc", drive: b"\x1b7" },
			EscapeSeq::RestoreCursor => Case { seed: b"abc\x1b7\r\n", drive: b"\x1b8" },
			EscapeSeq::Reset => Case { seed: b"abc", drive: b"\x1bc" },
		},
		SequenceClass::Csi(csi) => match csi {
			CsiSeq::InsertCharacters => Case { seed: b"abc\r", drive: b"\x1b[2@" },
			CsiSeq::CursorUp => Case { seed: b"\n\n", drive: b"\x1b[1A" },
			CsiSeq::CursorDown => Case { seed: b"", drive: b"\x1b[2B" },
			CsiSeq::CursorForward => Case { seed: b"", drive: b"\x1b[5C" },
			CsiSeq::CursorBack => Case { seed: b"abcde", drive: b"\x1b[3D" },
			CsiSeq::CursorNextLine => Case { seed: b"abc", drive: b"\x1b[2E" },
			CsiSeq::CursorPreviousLine => Case { seed: b"\n\n\n", drive: b"\x1b[2F" },
			CsiSeq::CursorColumn => Case { seed: b"", drive: b"\x1b[10G" },
			CsiSeq::CursorPosition => Case { seed: b"", drive: b"\x1b[5;7H" },
			CsiSeq::EraseInDisplay => Case { seed: b"abc\r\ndef", drive: b"\x1b[2J" },
			CsiSeq::EraseInLine => Case { seed: b"abc\r", drive: b"\x1b[0K" },
			CsiSeq::InsertLines => Case { seed: b"abc", drive: b"\x1b[2L" },
			CsiSeq::DeleteLines => Case { seed: b"abc\r\ndef\x1b[1;1H", drive: b"\x1b[1M" },
			CsiSeq::DeleteCharacters => Case { seed: b"abcdef\r", drive: b"\x1b[2P" },
			CsiSeq::ScrollUp => Case { seed: b"abc", drive: b"\x1b[1S" },
			CsiSeq::ScrollDown => Case { seed: b"abc", drive: b"\x1b[1T" },
			CsiSeq::EraseCharacters => Case { seed: b"abcdef\r", drive: b"\x1b[3X" },
			CsiSeq::LinePosition => Case { seed: b"", drive: b"\x1b[4d" },
			CsiSeq::SelectGraphicRendition => Case { seed: b"", drive: b"\x1b[1m" },
			CsiSeq::SetScrollRegion => Case { seed: b"\n\n", drive: b"\x1b[2;5r" },
			CsiSeq::SaveCursor => Case { seed: b"abc", drive: b"\x1b[s" },
			CsiSeq::RestoreCursor => Case { seed: b"abc\x1b[s\r\n", drive: b"\x1b[u" },
			CsiSeq::SetPrivateMode => Case { seed: b"\x1b[?25l", drive: b"\x1b[?25h" },
			CsiSeq::ResetPrivateMode => Case { seed: b"", drive: b"\x1b[?7l" },
		},
		SequenceClass::Osc(osc) => match osc {
			OscSeq::WindowTitle => Case { seed: b"", drive: b"\x1b]0;a build\x07" },
		},
	}
}

/// Every class in the table is reached by its own bytes and moves the grid.
///
/// The bell is the one class whose whole behaviour is to leave the grid
/// alone, and it is asserted that way rather than left out: a bell that
/// started printing a glyph would fail here.
#[test]
fn every_class_the_emulator_declares_is_driven_by_bytes_and_changes_the_grid() {
	let classes = SequenceClass::all();
	assert!(!classes.is_empty(), "the emulator declares no sequence class at all");

	let mut unmoved = Vec::new();
	for class in classes {
		let case = case(class);
		let mut emu = TerminalEmulator::new(20, 6);
		emu.feed(case.seed);
		let before = observe(&emu);
		emu.feed(case.drive);
		let after = observe(&emu);

		let quiet = before == after;
		let expected_quiet = class == SequenceClass::Control(ControlChar::Bell);
		if quiet != expected_quiet {
			unmoved.push(format!("{class:?}: quiet={quiet}, expected quiet={expected_quiet}"));
		}
	}
	assert!(unmoved.is_empty(), "every class moves the grid it is for: {unmoved:?}");
}

/// A class is reached through the classifier, not through a byte the parser
/// happens to match: every selector maps back to the class the sweep drove.
#[test]
fn every_selector_the_sweep_drives_maps_back_to_the_class_it_names() {
	for control in ControlChar::ALL {
		let case = case(SequenceClass::Control(*control));
		let byte = case.drive.first().copied().unwrap_or(0);
		assert_eq!(ControlChar::of(byte), Some(*control), "control {control:?}");
	}
	for escape in EscapeSeq::ALL {
		let case = case(SequenceClass::Escape(*escape));
		let byte = case.drive.get(1).copied().unwrap_or(0);
		assert_eq!(EscapeSeq::of(byte), Some(*escape), "escape {escape:?}");
	}
	for csi in CsiSeq::ALL {
		let case = case(SequenceClass::Csi(*csi));
		let private = case.drive.contains(&b'?');
		let final_byte = case
			.drive
			.iter()
			.copied()
			.find(|byte| (0x40..=0x7e).contains(byte) && *byte != b'[')
			.unwrap_or(0);
		assert_eq!(CsiSeq::of(final_byte, private), Some(*csi), "csi {csi:?}");
	}
	for osc in OscSeq::ALL {
		assert_eq!(OscSeq::of("0"), Some(*osc), "osc {osc:?}");
	}
}

/// The union the sweep reads holds every class each introducer declares, so a
/// class added to one table cannot be swept by neither.
#[test]
fn the_union_holds_every_class_each_introducer_declares() {
	let all = SequenceClass::all();
	assert_eq!(
		all.len(),
		ControlChar::ALL.len() + EscapeSeq::ALL.len() + CsiSeq::ALL.len() + OscSeq::ALL.len(),
		"the union is the four tables and nothing else"
	);
	for control in ControlChar::ALL {
		assert!(all.contains(&SequenceClass::Control(*control)), "{control:?} is in the union");
	}
	for escape in EscapeSeq::ALL {
		assert!(all.contains(&SequenceClass::Escape(*escape)), "{escape:?} is in the union");
	}
	for csi in CsiSeq::ALL {
		assert!(all.contains(&SequenceClass::Csi(*csi)), "{csi:?} is in the union");
	}
	for osc in OscSeq::ALL {
		assert!(all.contains(&SequenceClass::Osc(*osc)), "{osc:?} is in the union");
	}
}

/// A final byte no class claims leaves the grid alone rather than falling
/// into the arm of whatever class sorts next to it.
///
/// The seed puts the cursor off the origin, in a scroll region, with a style
/// set and a cursor of its own saved: a class an unclaimed byte fell into
/// would move something here, where at the top left corner with one word on
/// screen half of them move nothing.
#[test]
fn a_final_byte_no_class_claims_changes_nothing() {
	for sequence in [
		b"\x1b[5n".as_slice(),
		b"\x1b[>0c",
		b"\x1b[2 q",
		b"\x1b[?1000h",
		b"\x1b[999Z",
		b"\x1b]777;notify\x07",
	] {
		let mut emu = TerminalEmulator::new(20, 6);
		emu.feed(b"\x1b[2;5r\x1b[1;31mfirst line\r\nsecond line\x1b7\x1b[4;8H");
		let before = observe(&emu);
		assert_ne!(before.cursor, (0, 0), "the seed leaves the cursor off the origin");
		emu.feed(sequence);
		assert_eq!(observe(&emu), before, "unclaimed sequence {sequence:?} changed the grid");
	}
}
