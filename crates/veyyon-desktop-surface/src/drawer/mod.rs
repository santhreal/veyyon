//! The terminal drawer surface (§5.6, §5.12).
//!
//! Provides a resizable docking drawer hosting terminal sessions and supervised
//! background processes with an 80-column monospace grid, 16 ANSI colours, SGR
//! styling, selection highlighting, and raw byte input forwarding.

mod chrome;
mod content;
mod process_list;

use veyyon_desktop_kit::{ColorRole, MonoSizeStep, SpacingStep, TextWeight, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Hsla, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Styled, div, px,
	rgb,
};

pub use self::{
	chrome::drawer_chrome,
	content::{DrawerContent, DrawerSearch, DrawerTab, ProcessRow},
	process_list::process_list,
};
use crate::{
	Intent, ShellView,
	terminal::{Ink, NamedColor},
};

/// Resolves a cell ink value into a GPUI HSLA color.
#[must_use]
pub fn resolve_ink(ink: &Ink, tokens: &TokenSet, _is_foreground: bool) -> Option<Hsla> {
	match ink {
		Ink::Default => None,
		Ink::Named(named) => Some(resolve_named_color(*named, tokens)),
		Ink::Indexed(idx) => Some(resolve_indexed_color(*idx, tokens)),
		Ink::Rgb(r, g, b) => {
			Some(rgb(((u32::from(*r)) << 16) | ((u32::from(*g)) << 8) | u32::from(*b)).into())
		},
	}
}

/// Resolves one of the 16 standard ANSI colours to token roles.
#[must_use]
pub const fn resolve_named_color(color: NamedColor, tokens: &TokenSet) -> Hsla {
	match color {
		NamedColor::Black => tokens.color(ColorRole::Ground),
		NamedColor::Red => tokens.color(ColorRole::ErrorFill),
		NamedColor::Green => tokens.color(ColorRole::WorkingFill),
		NamedColor::Yellow => tokens.color(ColorRole::AttentionFill),
		NamedColor::Blue => tokens.color(ColorRole::Accent),
		NamedColor::Magenta => tokens.color(ColorRole::PlanFill),
		NamedColor::Cyan => tokens.color(ColorRole::InputFill),
		NamedColor::White => tokens.color(ColorRole::Foreground),
		NamedColor::BrightBlack => tokens.color(ColorRole::Muted),
		NamedColor::BrightRed => tokens.color(ColorRole::ErrorFill),
		NamedColor::BrightGreen => tokens.color(ColorRole::WorkingFill),
		NamedColor::BrightYellow => tokens.color(ColorRole::AttentionFill),
		NamedColor::BrightBlue => tokens.color(ColorRole::Accent),
		NamedColor::BrightMagenta => tokens.color(ColorRole::PlanFill),
		NamedColor::BrightCyan => tokens.color(ColorRole::InputFill),
		NamedColor::BrightWhite => tokens.color(ColorRole::Foreground),
	}
}

/// Resolves an xterm 256-colour index to an HSLA colour.
#[must_use]
pub fn resolve_indexed_color(idx: u8, tokens: &TokenSet) -> Hsla {
	if idx < 16
		&& let Some(named) = NamedColor::from_index(idx)
	{
		return resolve_named_color(named, tokens);
	}

	if idx >= 232 {
		let gray = (idx - 232) * 10 + 8;
		return rgb(((u32::from(gray)) << 16) | ((u32::from(gray)) << 8) | u32::from(gray)).into();
	}

	let n = idx - 16;
	let r_idx = (n / 36) % 6;
	let g_idx = (n / 6) % 6;
	let b_idx = n % 6;
	let to_val = |c: u8| if c == 0 { 0u32 } else { u32::from(c) * 40 + 55 };
	let r = to_val(r_idx);
	let g = to_val(g_idx);
	let b = to_val(b_idx);
	rgb((r << 16) | (g << 8) | b).into()
}

/// Builds the terminal drawer component.
pub fn terminal_drawer(
	content: &DrawerContent,
	height: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let body = if content.is_processes_active() {
		div()
			.flex_1()
			.w_full()
			.overflow_hidden()
			.child(process_list(&content.processes, geometry, tokens, cx))
	} else {
		div()
			.flex_1()
			.w_full()
			.overflow_hidden()
			.child(render_terminal_grid(content, geometry, tokens, cx))
	};

	div()
		.w_full()
		.h(px(height))
		.flex_shrink_0()
		.flex()
		.flex_col()
		.bg(tokens.color(ColorRole::Canvas))
		.border_t(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden()
		.child(drawer_chrome(content, geometry, tokens, cx))
		.child(body)
}

/// Renders the monospace 80-column terminal cell grid.
fn render_terminal_grid(
	content: &DrawerContent,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let cell_width = geometry.terminal_cell_width_px;
	let cell_height = geometry.terminal_cell_height_px;
	let min_width = cell_width * geometry.terminal_min_columns as f32;

	let mut grid_el = div()
		.id("terminal-grid")
		.key_context("Terminal")
		.flex()
		.flex_col()
		.w_full()
		.min_w(px(min_width))
		.flex_1()
		.overflow_hidden()
		.px(tokens.spacing(SpacingStep::S3))
		.py(tokens.spacing(SpacingStep::S2))
		.on_key_down(cx.listener(|view, event: &KeyDownEvent, _window, _cx| {
			if let Some(bytes) =
				keystroke_to_terminal_bytes(&event.keystroke.key, event.keystroke.modifiers.control)
			{
				view.dispatch(Intent::TerminalInput(bytes));
			}
		}));

	for (r_idx, row) in content.grid_rows.iter().enumerate() {
		let mut row_el = div()
			.flex()
			.flex_row()
			.h(px(cell_height))
			.w_full()
			.items_center();

		for (c_idx, cell) in row.iter().enumerate() {
			if cell.width == 0 {
				continue;
			}
			let is_cursor =
				content.cursor_visible && r_idx == content.cursor_row && c_idx == content.cursor_col;
			let is_selected = content
				.selection
				.as_ref()
				.is_some_and(|sel| sel.contains(c_idx, r_idx));

			let mut cell_el = div()
				.flex_shrink_0()
				.w(px(cell_width * cell.width as f32))
				.h(px(cell_height))
				.flex()
				.items_center()
				.justify_center()
				.text_size(tokens.mono_font_size(MonoSizeStep::Small))
				.line_height(tokens.mono_line_height(MonoSizeStep::Small));

			let fg = resolve_ink(&cell.ink, tokens, true)
				.unwrap_or_else(|| tokens.color(ColorRole::Secondary));
			let bg = resolve_ink(&cell.bg_ink, tokens, false);

			if is_cursor {
				cell_el = cell_el
					.bg(tokens.color(ColorRole::Accent))
					.text_color(tokens.color(ColorRole::AccentForeground));
			} else if is_selected {
				cell_el = cell_el
					.bg(tokens.color(ColorRole::Focus))
					.text_color(tokens.color(ColorRole::Foreground));
			} else {
				if let Some(bg_color) = bg {
					cell_el = cell_el.bg(bg_color);
				}
				cell_el = cell_el.text_color(if cell.style.dim {
					tokens.color(ColorRole::Muted)
				} else {
					fg
				});
			}

			if cell.style.bold {
				cell_el = cell_el.font_weight(tokens.font_weight(TextWeight::Semibold));
			}

			if cell.c != ' ' {
				cell_el = cell_el.child(cell.c.to_string());
			}

			row_el = row_el.child(cell_el);
		}

		grid_el = grid_el.child(row_el);
	}

	grid_el
}

/// Converts a keystroke chord into raw terminal byte sequences.
#[must_use]
pub fn keystroke_to_terminal_bytes(key: &str, ctrl: bool) -> Option<Vec<u8>> {
	if ctrl {
		if key.len() == 1 {
			let b = key.as_bytes()[0].to_ascii_lowercase();
			if b.is_ascii_lowercase() {
				return Some(vec![b - b'a' + 1]);
			}
		}
		return None;
	}

	match key {
		"enter" | "return" => Some(vec![b'\r']),
		"backspace" => Some(vec![0x7f]),
		"tab" => Some(vec![b'\t']),
		"escape" => Some(vec![0x1b]),
		"up" => Some(b"\x1b[A".to_vec()),
		"down" => Some(b"\x1b[B".to_vec()),
		"right" => Some(b"\x1b[C".to_vec()),
		"left" => Some(b"\x1b[D".to_vec()),
		"home" => Some(b"\x1b[H".to_vec()),
		"end" => Some(b"\x1b[F".to_vec()),
		"pageup" => Some(b"\x1b[5~".to_vec()),
		"pagedown" => Some(b"\x1b[6~".to_vec()),
		other => {
			if other.chars().count() == 1 {
				Some(other.as_bytes().to_vec())
			} else {
				None
			}
		},
	}
}
