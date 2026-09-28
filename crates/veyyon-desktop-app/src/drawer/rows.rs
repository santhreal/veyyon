//! One terminal row as the text it draws and the runs that color it.
//!
//! A row is one line of the mono face: each column is one character, so the
//! glyphs fall on the cell grid the emulator keeps. Neighbouring columns
//! drawn alike share one run, and the blank columns after the last one that
//! draws anything are left off.

use veyyon_desktop_model::text::terminal::{Cell, TerminalSelection};
use veyyon_desktop_ui::theme::{Palette, size, text};
use veyyon_gpui::{
	FontStyle, FontWeight, Hsla, SharedString, StrikethroughStyle, TextRun, UnderlineStyle, font,
};

use super::ink::cell_colors;

/// One row's text and runs, the runs covering the text byte for byte.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowText {
	pub text: SharedString,
	pub runs: Vec<TextRun>,
}

/// How one column is drawn.
#[derive(Clone, Copy, PartialEq)]
struct Look {
	fg:        Hsla,
	bg:        Option<Hsla>,
	bold:      bool,
	italic:    bool,
	underline: bool,
	strike:    bool,
}

/// Row `row` of the screen: `cells` with the columns inside `selection`
/// filled, and a block caret at column `caret` when the terminal holds focus.
pub fn row_text(
	cells: &[Cell],
	row: usize,
	selection: Option<&TerminalSelection>,
	caret: Option<usize>,
	palette: &Palette,
) -> RowText {
	let selected = |col: usize| selection.is_some_and(|selection| selection.contains(col, row));
	let drawn = |col: usize| {
		caret == Some(col) || selected(col) || cells.get(col).is_some_and(|cell| !cell.is_blank())
	};
	let Some(last) = (0..cells.len()).rev().find(|&col| drawn(col)) else {
		return RowText::default();
	};
	let mut text = String::with_capacity(last + 1);
	let mut runs: Vec<TextRun> = Vec::new();
	let mut current: Option<(Look, usize)> = None;
	for (col, cell) in cells[..=last].iter().enumerate() {
		if cell.width == 0 && col > 0 && cells[col - 1].width == 2 {
			// The second column of a wide glyph, which the lead draws.
			continue;
		}
		let ch = if cell.width == 0 || cell.style.hidden {
			' '
		} else {
			cell.c
		};
		let look = look(cell, selected(col), caret == Some(col), palette);
		text.push(ch);
		match &mut current {
			Some((held, len)) if *held == look => *len += ch.len_utf8(),
			_ => {
				if let Some((held, len)) = current.take() {
					runs.push(run(held, len));
				}
				current = Some((look, ch.len_utf8()));
			},
		}
	}
	if let Some((held, len)) = current {
		runs.push(run(held, len));
	}
	RowText { text: text.into(), runs }
}

fn look(cell: &Cell, selected: bool, caret: bool, palette: &Palette) -> Look {
	let (mut fg, mut bg) =
		cell_colors(cell.ink, cell.bg_ink, cell.style.inverse, cell.style.dim, palette);
	if selected {
		bg = Some(palette.bg.selected);
	}
	if caret {
		fg = palette.bg.app;
		bg = Some(palette.text.primary);
	}
	Look {
		fg,
		bg,
		bold: cell.style.bold,
		italic: cell.style.italic,
		underline: cell.style.underline,
		strike: cell.style.strike,
	}
}

fn run(look: Look, len: usize) -> TextRun {
	let mut face = font(text::MONO.family);
	face.weight = if look.bold {
		FontWeight::SEMIBOLD
	} else {
		text::MONO.weight
	};
	face.style = if look.italic {
		FontStyle::Italic
	} else {
		FontStyle::Normal
	};
	TextRun {
		len,
		font: face,
		color: look.fg,
		background_color: look.bg,
		underline: look.underline.then_some(UnderlineStyle {
			thickness: size::HAIRLINE,
			color:     Some(look.fg),
			wavy:      false,
		}),
		strikethrough: look
			.strike
			.then_some(StrikethroughStyle { thickness: size::HAIRLINE, color: Some(look.fg) }),
		..TextRun::default()
	}
}
