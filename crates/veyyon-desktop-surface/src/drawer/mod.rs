//! The terminal drawer surface (§5.6, §5.12).
//!
//! Provides a resizable docking drawer hosting terminal sessions and supervised
//! background processes with an 80-column monospace grid, 16 ANSI colours, SGR
//! styling, selection highlighting, and raw byte input forwarding.

mod chrome;
mod content;
mod process_list;

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, MonoText, SpacingStep, TextWeight, TokenSet,
	input::{Editor, TextField},
};
use veyyon_desktop_tokens::{DrawerPlacement, PanelsSurfaceTokens};
use veyyon_gpui::{
	Context, Entity, Hsla, InteractiveElement, IntoElement, KeyDownEvent, ParentElement,
	StatefulInteractiveElement, Styled, div, px, rgb,
};

pub use self::{
	chrome::drawer_chrome,
	content::{DrawerContent, DrawerFailure, DrawerSearch, DrawerTab, ProcessRow},
	process_list::process_list,
};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, error_hairline},
	damage::{LaidOut, Region},
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

/// The editors the supervisor's controls read, drawn on the tab that offers
/// those controls: `command` is what a `Start` starts, and `input` is what a
/// row's `Send` writes to that process.
#[derive(Clone, Copy, Default)]
pub struct SupervisorFields<'a> {
	/// The command line a `Start` reads, when the supervisor is open.
	pub command: Option<&'a Entity<Editor>>,
	/// The line a row's `Send` reads, when a process is running to take it.
	pub input:   Option<&'a Entity<Editor>>,
}

/// Builds the terminal drawer component.
///
/// A docked drawer is the second pane of a split, and the split's handle draws
/// the hairline between the drawer and the column above it. An overlaid
/// drawer has no split, so it draws that edge itself: without the placement
/// the docked drawer draws a second hairline a grip's half-height under the
/// first.
pub fn terminal_drawer(
	content: &DrawerContent,
	placement: DrawerPlacement,
	height: f32,
	controls: &ControlStates,
	session_id: u64,
	fields: SupervisorFields<'_>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	laid_out: &LaidOut,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let body = if content.is_processes_active() {
		div()
			.flex_1()
			.w_full()
			.overflow_hidden()
			.flex()
			.flex_col()
			// The supervisor starts what this field states, so the tab that
			// offers `Start` is the tab that offers somewhere to say what to
			// start: without it the control can only ask the host to run
			// nothing (§5.12).
			.children(fields.command.map(|editor| {
				div()
					.w_full()
					.flex_shrink_0()
					.px(tokens.spacing(SpacingStep::S3))
					.pt(tokens.spacing(SpacingStep::S2))
					.child(TextField::new("process-command-field", editor.clone()))
			}))
			.child(process_list(&content.processes, controls, session_id, geometry, tokens, cx))
			// A row's `Send` writes what this field states, so the field is
			// drawn wherever a row offers one: without it the control can
			// only write nothing, which the host reports as a success
			// (§5.12).
			.children(fields.input.map(|editor| {
				div()
					.w_full()
					.flex_shrink_0()
					.px(tokens.spacing(SpacingStep::S3))
					.pb(tokens.spacing(SpacingStep::S2))
					.child(TextField::new("process-input-field", editor.clone()))
			}))
	} else {
		div()
			.flex_1()
			.w_full()
			.overflow_hidden()
			.child(render_terminal_grid(content, geometry, tokens, cx))
	};

	let mut shell = div()
		.occlude()
		.w_full()
		.h(px(height))
		.flex_shrink_0()
		.flex()
		.flex_col()
		.bg(tokens.color(ColorRole::Canvas))
		.overflow_hidden();
	if placement == DrawerPlacement::Overlay {
		shell = shell
			.border_t(px(geometry.chrome_resize_handle_line_px))
			.border_color(tokens.color(ColorRole::Hairline));
	}

	// The host's sentence for whatever the drawer last asked it for, above
	// the tab it was asked from. The drawer read one control for this -- the
	// terminal it creates on its own opening -- so a start the host refused,
	// a line it could not write and a process it could not stop each landed
	// on a control nothing draws (§4.4). What lands here is resolved every
	// projection, so an error the operator dismissed is gone from the next
	// frame.
	let failure_row = content.failure.as_ref().map(|failure| {
		div()
			.id("drawer-failure")
			.flex_shrink_0()
			.w_full()
			.px(tokens.spacing(SpacingStep::S3))
			.py(tokens.spacing(SpacingStep::S1))
			.child(error_hairline(&failure.error, failure.surface.clone(), tokens, cx))
	});

	laid_out.track_children(
		shell
			.child(drawer_chrome(content, controls, session_id, geometry, tokens, cx))
			.children(failure_row)
			.child(body),
		|index| (index == 0).then_some(Region::DrawerChrome),
	)
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
				.mono_text(tokens, MonoSizeStep::Small);

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
		if key == "space" || key == " " {
			return Some(vec![0]);
		}
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
		"space" => Some(vec![b' ']),
		"delete" => Some(b"\x1b[3~".to_vec()),
		"insert" => Some(b"\x1b[2~".to_vec()),
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
