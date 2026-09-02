//! ECMA-48 CSI control sequence execution.

use super::{grid::TerminalGrid, sgr::apply_sgr};

/// Dispatches a completed CSI sequence to the terminal grid.
pub fn dispatch_csi(cmd: u8, params: &[u16], private_flag: bool, grid: &mut TerminalGrid) {
	let param = |idx: usize, default: u16| -> u16 {
		match params.get(idx).copied() {
			Some(v) if v != 0 => v,
			_ => default,
		}
	};

	match cmd {
		b'@' => grid.insert_characters(param(0, 1) as usize),
		b'A' => {
			let n = param(0, 1) as usize;
			grid.cursor_row = grid.cursor_row.saturating_sub(n).max(grid.scroll_top);
			grid.wrap_next = false;
		},
		b'B' => {
			let n = param(0, 1) as usize;
			grid.cursor_row = (grid.cursor_row + n).min(grid.scroll_bottom);
			grid.wrap_next = false;
		},
		b'C' => {
			let n = param(0, 1) as usize;
			grid.cursor_col = (grid.cursor_col + n).min(grid.cols.saturating_sub(1));
			grid.wrap_next = false;
		},
		b'D' => {
			let n = param(0, 1) as usize;
			grid.cursor_col = grid.cursor_col.saturating_sub(n);
			grid.wrap_next = false;
		},
		b'E' => {
			let n = param(0, 1) as usize;
			grid.cursor_col = 0;
			grid.cursor_row = (grid.cursor_row + n).min(grid.rows.saturating_sub(1));
			grid.wrap_next = false;
		},
		b'F' => {
			let n = param(0, 1) as usize;
			grid.cursor_col = 0;
			grid.cursor_row = grid.cursor_row.saturating_sub(n);
			grid.wrap_next = false;
		},
		b'G' => {
			let col = param(0, 1).saturating_sub(1) as usize;
			grid.cursor_col = col.min(grid.cols.saturating_sub(1));
			grid.wrap_next = false;
		},
		b'H' | b'f' => {
			let row = param(0, 1).saturating_sub(1) as usize;
			let col = param(1, 1).saturating_sub(1) as usize;
			grid.cursor_row = row.min(grid.rows.saturating_sub(1));
			grid.cursor_col = col.min(grid.cols.saturating_sub(1));
			grid.wrap_next = false;
		},
		b'J' => grid.erase_in_display(params.first().copied().unwrap_or(0)),
		b'K' => grid.erase_in_line(params.first().copied().unwrap_or(0)),
		b'L' => grid.insert_lines(param(0, 1) as usize),
		b'M' => grid.delete_lines(param(0, 1) as usize),
		b'P' => grid.delete_characters(param(0, 1) as usize),
		b'S' => grid.scroll_up_region(param(0, 1) as usize),
		b'T' => grid.scroll_down_region(param(0, 1) as usize),
		b'X' => grid.erase_characters(param(0, 1) as usize),
		b'd' => {
			let row = param(0, 1).saturating_sub(1) as usize;
			grid.cursor_row = row.min(grid.rows.saturating_sub(1));
			grid.wrap_next = false;
		},
		b'm' => {
			apply_sgr(params, &mut grid.style, &mut grid.fg, &mut grid.bg);
		},
		b'r' => {
			let top = param(0, 1).saturating_sub(1) as usize;
			let bottom = param(1, grid.rows as u16).saturating_sub(1) as usize;
			if top < bottom && bottom < grid.rows {
				grid.scroll_top = top;
				grid.scroll_bottom = bottom;
				grid.cursor_row = 0;
				grid.cursor_col = 0;
				grid.wrap_next = false;
			}
		},
		b's' => grid.save_cursor(),
		b'u' => grid.restore_cursor(),
		b'h' if private_flag => set_private_mode(params, grid, true),
		b'l' if private_flag => set_private_mode(params, grid, false),
		_ => {},
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
