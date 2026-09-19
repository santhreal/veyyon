//! Terminal grid cell rendering, styling, and colour resolution (§5.6, §9.3).
//!
//! Renders column-exact character cells in the resolved monospace family,
//! supporting 16 standard ANSI colours, 256-colour indices, 24-bit RGB
//! truecolour, text styles (bold, dim, italic, underline, strike, inverse),
//! cursor shapes (block, bar, underline, hollow), selection highlights,
//! wide CJK and emoji glyphs, and scrollback indicators.

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, MonoText, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight,
	TokenSet,
};
use veyyon_desktop_model::text::terminal::{Ink, NamedColor};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Hsla, InteractiveElement, IntoElement, KeyDownEvent, ParentElement,
	StatefulInteractiveElement, Styled, div, px, rgb,
};

use super::{
	content::{CursorShape, DrawerContent},
	keystroke_to_terminal_bytes, measure,
};
use crate::{Intent, ShellView, damage::LaidOut};

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

/// Renders the terminal cell grid at the width the drawer gives it.
pub fn render_terminal_grid(
	content: &DrawerContent,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	laid_out: &LaidOut,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let cell_width = geometry.terminal_cell_width_px;
	let cell_height = geometry.terminal_cell_height_px;
	let min_width = cell_width * geometry.terminal_min_columns as f32;

	let grid_el = div()
		.id("terminal-grid")
		.focusable()
		.key_context("Terminal")
		.flex()
		.flex_col()
		.w_full()
		.min_w(px(min_width))
		.flex_1()
		.overflow_hidden()
		.px(tokens.spacing(SpacingStep::S3))
		.py(tokens.spacing(SpacingStep::S2))
		.on_key_down(cx.listener(|view, event: &KeyDownEvent, _window, cx| {
			if let Some(bytes) =
				keystroke_to_terminal_bytes(&event.keystroke.key, event.keystroke.modifiers.control)
			{
				view.dispatch(Intent::TerminalInput(bytes), cx);
				cx.stop_propagation();
			}
		}));

	let mut cells_el = div().flex().flex_col().w_full().flex_1().min_h_0();
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

			let resolved_fg = resolve_ink(&cell.ink, tokens, true)
				.unwrap_or_else(|| tokens.color(ColorRole::Foreground));
			let resolved_bg = resolve_ink(&cell.bg_ink, tokens, false);

			let (fg, bg) = if cell.style.inverse {
				(resolved_bg.unwrap_or_else(|| tokens.color(ColorRole::Canvas)), Some(resolved_fg))
			} else {
				(resolved_fg, resolved_bg)
			};

			let mut cell_el = div()
				.flex_shrink_0()
				.w(px(cell_width * cell.width as f32))
				.h(px(cell_height))
				.flex()
				.items_center()
				.justify_center()
				.overflow_hidden()
				.mono_text(tokens, MonoSizeStep::Small);

			if is_cursor {
				cell_el = apply_cursor_style(cell_el, content.cursor_shape, fg, bg, tokens);
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
			if cell.style.italic {
				cell_el = cell_el.italic();
			}
			if cell.style.underline {
				cell_el = cell_el.underline();
			}
			if cell.style.strike {
				cell_el = cell_el.line_through();
			}

			if cell.c != ' ' && !cell.style.hidden {
				cell_el = cell_el.child(cell.c.to_string());
			}

			row_el = row_el.child(cell_el);
		}

		cells_el = cells_el.child(row_el);
	}

	let mut container = div().relative().w_full().flex_1().min_h_0().child(cells_el);

	if content.scroll_offset > 0 {
		container = container.child(
			div()
				.absolute()
				.top(tokens.spacing(SpacingStep::S1))
				.right(tokens.spacing(SpacingStep::S2))
				.px(tokens.spacing(SpacingStep::S2))
				.py(tokens.spacing(SpacingStep::S1))
				.bg(tokens.color(ColorRole::Inset))
				.border(tokens.stroke(StrokeStep::Hairline))
				.border_color(tokens.color(ColorRole::Hairline))
				.rounded(tokens.radius(RadiusStep::Sm))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("Scrollback: -{} lines", content.scroll_offset)),
		);
	}

	if content.is_active_terminal_exited() {
		container = container.child(
			div()
				.w_full()
				.pt(tokens.spacing(SpacingStep::S1))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child("[Process completed - press Restart or Close]"),
		);
	}

	grid_el.child(measure::track_grid_box(container, laid_out, cx))
}

fn apply_cursor_style<E: Styled>(
	el: E,
	shape: CursorShape,
	fg: Hsla,
	bg: Option<Hsla>,
	tokens: &TokenSet,
) -> E {
	match shape {
		CursorShape::Block => el
			.bg(tokens.color(ColorRole::Accent))
			.text_color(tokens.color(ColorRole::AccentForeground)),
		CursorShape::Bar => {
			let mut res = el
				.border_l(tokens.stroke(StrokeStep::Heavy))
				.border_color(tokens.color(ColorRole::Accent))
				.text_color(fg);
			if let Some(bg_color) = bg {
				res = res.bg(bg_color);
			}
			res
		},
		CursorShape::Underline => {
			let mut res = el
				.border_b(tokens.stroke(StrokeStep::Heavy))
				.border_color(tokens.color(ColorRole::Accent))
				.text_color(fg);
			if let Some(bg_color) = bg {
				res = res.bg(bg_color);
			}
			res
		},
		CursorShape::HollowBlock => {
			let mut res = el
				.border(tokens.stroke(StrokeStep::Hairline))
				.border_color(tokens.color(ColorRole::Accent))
				.text_color(fg);
			if let Some(bg_color) = bg {
				res = res.bg(bg_color);
			}
			res
		},
	}
}
