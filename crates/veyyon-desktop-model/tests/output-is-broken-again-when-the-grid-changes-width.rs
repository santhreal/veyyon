//! WHY: a line break a terminal made because the text reached the last
//! column belongs to the width it was made at. Resizing without re-breaking
//! keeps it, so a paragraph written at 80 columns stays 80 columns wide in a
//! 140-column window with the rest of the drawer blank, and narrowing leaves
//! half the text clipped off the right. The defect is invisible to a test
//! that only counts rows: the rows are there, the text in them is wrong.
//!
//! CLASS CLOSED:
//! 1. A wrapped run kept at the old width after a resize, in either direction,
//!    or re-broken into rows that do not hold the same text.
//! 2. A break the host wrote joined into its neighbour, which is what makes two
//!    commands' output one paragraph.
//! 3. Padding a row was squared off with treated as text, which breaks the next
//!    line early and grows a line every resize.
//! 4. A double-width glyph split across the new break, leaving a lead cell with
//!    no continuation.
//! 5. The cursor left on a row that no longer holds the text it was on.
//! 6. Scrollback growing past its bound through a resize, or the alternate
//!    screen -- which a full-screen program redraws itself -- being joined up
//!    as though its rows were one paragraph.
//!
//! WHAT THIS DOES NOT CATCH: the columns the window has room for, which is
//! measured from a drawn box in the surface suite, and the styling a cell
//! carries across a re-break, which the parser suite owns.

use veyyon_desktop_model::text::terminal::{MAX_SCROLLBACK_ROWS, TerminalEmulator};

/// The visible rows as text, trailing padding cut.
fn lines(emu: &TerminalEmulator) -> Vec<String> {
	let grid = emu.grid();
	(0..grid.rows)
		.filter_map(|row| grid.visible_row(row))
		.map(|row| {
			row.iter()
				.filter(|cell| cell.width > 0)
				.map(|cell| cell.c)
				.collect::<String>()
				.trim_end()
				.to_owned()
		})
		.collect()
}

/// Everything the grid holds, scrollback included, as one string per line the
/// host wrote.
fn paragraphs(emu: &TerminalEmulator) -> Vec<String> {
	let grid = emu.grid();
	let mut out: Vec<String> = Vec::new();
	let mut current = String::new();
	for row in &grid.primary_lines {
		// The cells a row was squared off with are padding, and the blank a
		// wide glyph left when it moved whole to the next row is padding too.
		// Either one read as text would show up here as a space inside a word.
		current.extend(
			row.cells
				.iter()
				.filter(|cell| cell.width > 0)
				.map(|cell| cell.c),
		);
		if !row.wrapped {
			// Only the last row of a line carries padding: a space at the end
			// of a wrapped row is the space between two words.
			out.push(current.trim_end().to_owned());
			current.clear();
		}
	}
	if !current.is_empty() {
		out.push(current.trim_end().to_owned());
	}
	while out.last().is_some_and(String::is_empty) {
		out.pop();
	}
	out
}

#[test]
fn a_line_wrapped_at_one_width_is_broken_again_at_the_next() {
	let mut emu = TerminalEmulator::new(20, 6);
	emu.feed(b"the quick brown fox jumps over the lazy dog");

	assert_eq!(
		lines(&emu)[..3],
		["the quick brown fox ".trim_end(), "jumps over the lazy", "dog"],
		"the line is broken at twenty columns"
	);

	emu.resize(43, 6);
	assert_eq!(
		lines(&emu)[0],
		"the quick brown fox jumps over the lazy dog",
		"the whole line fits on one row at forty-three columns"
	);

	emu.resize(10, 6);
	assert_eq!(
		paragraphs(&emu),
		vec!["the quick brown fox jumps over the lazy dog".to_owned()],
		"narrowing keeps the same text in one paragraph"
	);
}

#[test]
fn a_break_the_host_wrote_survives_every_width() {
	let mut emu = TerminalEmulator::new(30, 6);
	emu.feed(b"first command\r\nsecond command\r\n");

	for width in [12, 60, 7, 30] {
		emu.resize(width, 6);
		let held = paragraphs(&emu);
		assert!(
			held.contains(&"first command".to_owned()) && held.contains(&"second command".to_owned()),
			"at {width} columns the two commands are still two lines: {held:?}"
		);
		assert!(
			!held.iter().any(|line| line.contains("first commandsecond")),
			"at {width} columns the two commands were joined: {held:?}"
		);
	}
}

#[test]
fn a_line_does_not_grow_by_the_padding_of_the_row_it_was_squared_off_with() {
	let mut emu = TerminalEmulator::new(40, 6);
	emu.feed(b"short\r\nnext\r\n");

	for width in [80, 40, 120, 40] {
		emu.resize(width, 6);
	}

	let held = paragraphs(&emu);
	assert_eq!(held.first().map(String::as_str), Some("short"), "the line is still five cells");
	assert!(
		held.iter().all(|line| line.len() <= 40),
		"no line grew by the padding of a wider row: {held:?}"
	);

	// Padding kept as text is only a longer line until the line is narrower
	// than the padding it carries. Five cells squared off to forty break into
	// four rows at ten columns, three of them blank, and the line the host
	// wrote under it is pushed down the screen by rows it never had.
	emu.resize(10, 6);
	assert_eq!(
		lines(&emu)[..2],
		["short", "next"],
		"the two lines the host wrote are still the two rows on screen"
	);
}

/// Asserts no row holds a zero-width cell that is neither a wide glyph's
/// continuation nor the column one vacated at the row's own break.
///
/// A vacated column belongs to the break it was made at. Carried into the
/// joined line it becomes a hole that travels: the text after it shifts a
/// cell at every width, and a continuation cell ends up under something that
/// is not its lead.
fn no_stray_zero_width(emu: &TerminalEmulator, width: usize) {
	let grid = emu.grid();
	for row_index in 0..grid.rows {
		let Some(row) = grid.visible_row(row_index) else {
			continue;
		};
		for (index, cell) in row.iter().enumerate() {
			if cell.width != 0 || index + 1 == row.len() {
				continue;
			}
			assert!(
				index > 0 && row[index - 1].width == 2,
				"at {width} columns row {row_index} holds a zero-width cell at column {index} with no \
				 wide glyph before it"
			);
		}
	}
}

#[test]
fn a_wide_glyph_is_never_split_across_the_new_break() {
	let mut emu = TerminalEmulator::new(12, 4);
	emu.feed("ab日本語日本語".as_bytes());

	for width in [5, 6, 7, 9, 11] {
		emu.resize(width, 4);
		let grid = emu.grid();
		for row_index in 0..grid.rows {
			let Some(row) = grid.visible_row(row_index) else {
				continue;
			};
			for (index, cell) in row.iter().enumerate() {
				if cell.width == 2 {
					assert!(
						index + 1 < row.len(),
						"at {width} columns a wide glyph leads the last cell with no room for its \
						 continuation"
					);
					assert_eq!(
						row[index + 1].width,
						0,
						"at {width} columns a wide glyph lost its continuation cell"
					);
				}
			}
		}
		no_stray_zero_width(&emu, width);
		let held = paragraphs(&emu).join("");
		assert_eq!(held, "ab日本語日本語", "at {width} columns the text survived whole");
	}
}

#[test]
fn the_column_a_wide_glyph_vacated_is_not_a_space() {
	// Three narrow cells and a wide glyph at four columns: the pair does not
	// fit the last column, so the terminal leaves it and takes the whole
	// glyph to the next row. That column is the width of no character, and
	// reading it back as a blank puts a space inside the word -- one more
	// every time the window changes width.
	let mut emu = TerminalEmulator::new(4, 4);
	emu.feed("abc日本".as_bytes());

	for width in [12, 3, 7, 4, 20] {
		emu.resize(width, 4);
		no_stray_zero_width(&emu, width);
		assert_eq!(
			paragraphs(&emu),
			vec!["abc日本".to_owned()],
			"at {width} columns the vacated column is still not text"
		);
	}
}

#[test]
fn the_cursor_stays_on_the_text_it_was_on() {
	let mut emu = TerminalEmulator::new(20, 6);
	emu.feed(b"0123456789012345678901234");

	// Twenty-five printed cells at twenty columns: the cursor sits on the
	// sixth cell of the second row, which is the twenty-sixth of the line.
	assert_eq!((emu.grid().cursor_col, emu.grid().cursor_row), (5, 1));

	emu.resize(30, 6);
	assert_eq!(
		(emu.grid().cursor_col, emu.grid().cursor_row),
		(25, 0),
		"the cursor followed its text onto the single wider row"
	);

	emu.resize(10, 6);
	assert_eq!(
		(emu.grid().cursor_col, emu.grid().cursor_row),
		(5, 2),
		"and onto the third row when ten columns hold it"
	);
}

#[test]
fn a_resize_holds_the_scrollback_bound() {
	let mut emu = TerminalEmulator::new(20, 6);
	for _ in 0..(MAX_SCROLLBACK_ROWS + 500) {
		emu.feed(b"a line of output\r\n");
	}
	assert_eq!(emu.grid().scrollback_len(), MAX_SCROLLBACK_ROWS, "the bound holds before");

	emu.resize(8, 6);
	assert_eq!(
		emu.grid().scrollback_len(),
		MAX_SCROLLBACK_ROWS,
		"narrowing doubles the rows and the bound still holds"
	);
	assert_eq!(emu.grid().rows, 6, "the visible rows are what was asked for");

	// Widening joins rows back together, so the count falls: the bound is a
	// ceiling the resize may not cross, not a length it has to reach.
	emu.resize(60, 20);
	assert!(
		emu.grid().scrollback_len() <= MAX_SCROLLBACK_ROWS,
		"widening holds the bound too: {}",
		emu.grid().scrollback_len()
	);
	assert!(emu.grid().scrollback_len() > 0, "widening kept the output rather than dropping it");
}

#[test]
fn the_alternate_screen_is_resized_rather_than_re_broken() {
	let mut emu = TerminalEmulator::new(20, 6);
	emu.feed(b"\x1b[?1049h");
	// A status line the program drew past the last column, which the grid
	// wrapped: on the primary screen that is one line to be broken again, and
	// here it is two rows a redraw is about to overwrite.
	emu.feed(b"a status line the program drew");
	emu.feed(b"\r\ntail");

	emu.resize(40, 6);

	let held = lines(&emu);
	assert_eq!(held[0], "a status line the pr", "the first row keeps the split it was drawn with");
	assert_eq!(held[1], "ogram drew", "and the rest is still the row below it");
	assert_eq!(held[2], "tail", "the row after them is where the program put it");
}
