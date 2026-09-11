//! ECMA-48 CSI control sequence execution.
//!
//! A final byte reaches behaviour only through `CsiSeq`, and the match below
//! is exhaustive over it, so a class added to the table has to be given an
//! arm here before this compiles.

use super::{grid::TerminalGrid, sequence::CsiSeq, sgr::apply_sgr};

/// Dispatches a completed CSI sequence to the terminal grid.
pub fn dispatch_csi(cmd: u8, params: &[u16], private_flag: bool, grid: &mut TerminalGrid) {
	let Some(class) = CsiSeq::of(cmd, private_flag) else {
		return;
	};
	run(class, params, grid);
}

/// Runs one CSI class against the grid.
pub fn run(class: CsiSeq, params: &[u16], grid: &mut TerminalGrid) {
	let param = |idx: usize, default: u16| -> u16 {
		match params.get(idx).copied() {
			Some(v) if v != 0 => v,
			_ => default,
		}
	};
	let count = |idx: usize| -> usize { usize::from(param(idx, 1)) };
	let index = |idx: usize| -> usize { usize::from(param(idx, 1).saturating_sub(1)) };

	match class {
		CsiSeq::InsertCharacters => grid.insert_characters(count(0)),
		CsiSeq::CursorUp => {
			grid.cursor_row = grid
				.cursor_row
				.saturating_sub(count(0))
				.max(grid.scroll_top);
			grid.wrap_next = false;
		},
		CsiSeq::CursorDown => {
			grid.cursor_row = (grid.cursor_row + count(0)).min(grid.scroll_bottom);
			grid.wrap_next = false;
		},
		CsiSeq::CursorForward => {
			grid.cursor_col = (grid.cursor_col + count(0)).min(grid.cols.saturating_sub(1));
			grid.wrap_next = false;
		},
		CsiSeq::CursorBack => {
			grid.cursor_col = grid.cursor_col.saturating_sub(count(0));
			grid.wrap_next = false;
		},
		CsiSeq::CursorNextLine => {
			grid.cursor_col = 0;
			grid.cursor_row = (grid.cursor_row + count(0)).min(grid.rows.saturating_sub(1));
			grid.wrap_next = false;
		},
		CsiSeq::CursorPreviousLine => {
			grid.cursor_col = 0;
			grid.cursor_row = grid.cursor_row.saturating_sub(count(0));
			grid.wrap_next = false;
		},
		CsiSeq::CursorColumn => {
			grid.cursor_col = index(0).min(grid.cols.saturating_sub(1));
			grid.wrap_next = false;
		},
		CsiSeq::CursorPosition => {
			grid.cursor_row = index(0).min(grid.rows.saturating_sub(1));
			grid.cursor_col = index(1).min(grid.cols.saturating_sub(1));
			grid.wrap_next = false;
		},
		CsiSeq::EraseInDisplay => grid.erase_in_display(params.first().copied().unwrap_or(0)),
		CsiSeq::EraseInLine => grid.erase_in_line(params.first().copied().unwrap_or(0)),
		CsiSeq::InsertLines => grid.insert_lines(count(0)),
		CsiSeq::DeleteLines => grid.delete_lines(count(0)),
		CsiSeq::DeleteCharacters => grid.delete_characters(count(0)),
		CsiSeq::ScrollUp => grid.scroll_up_region(count(0)),
		CsiSeq::ScrollDown => grid.scroll_down_region(count(0)),
		CsiSeq::EraseCharacters => grid.erase_characters(count(0)),
		CsiSeq::LinePosition => {
			grid.cursor_row = index(0).min(grid.rows.saturating_sub(1));
			grid.wrap_next = false;
		},
		CsiSeq::SelectGraphicRendition => {
			apply_sgr(params, &mut grid.style, &mut grid.fg, &mut grid.bg);
		},
		CsiSeq::SetScrollRegion => {
			let top = index(0);
			let bottom =
				usize::from(param(1, u16::try_from(grid.rows).unwrap_or(u16::MAX)).saturating_sub(1));
			if top < bottom && bottom < grid.rows {
				grid.scroll_top = top;
				grid.scroll_bottom = bottom;
				grid.cursor_row = 0;
				grid.cursor_col = 0;
				grid.wrap_next = false;
			}
		},
		CsiSeq::SaveCursor => grid.save_cursor(),
		CsiSeq::RestoreCursor => grid.restore_cursor(),
		CsiSeq::SetPrivateMode => set_private_mode(params, grid, true),
		CsiSeq::ResetPrivateMode => set_private_mode(params, grid, false),
	}
}

fn set_private_mode(params: &[u16], grid: &mut TerminalGrid, enable: bool) {
	for &code in params {
		match code {
			7 => grid.auto_wrap = enable,
			25 => grid.cursor_visible = enable,
			1049 => grid.set_alternate_screen(enable),
			2004 => grid.bracketed_paste = enable,
			_ => {},
		}
	}
}
