//! Stable boundary between terminal presentation and a retained cell renderer.
//!
//! The adapter receives presentation data and terminal damage. It never opens a
//! process, reads a PTY, or sends input; those operations remain typed commands
//! crossing the host boundary.

use gpui::{AnyElement, App, Hsla, SharedString};
use veyyon_gui_core::{
	UiCommand,
	model::{TerminalId, TerminalRunView},
};
use veyyon_gui_kit::theme::Theme;

/// Colours a terminal cell renderer needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RendererPalette {
	pub background:     Hsla,
	pub foreground:     Hsla,
	pub cursor:         Hsla,
	pub selection:      Hsla,
	pub black:          Hsla,
	pub red:            Hsla,
	pub green:          Hsla,
	pub yellow:         Hsla,
	pub blue:           Hsla,
	pub magenta:        Hsla,
	pub cyan:           Hsla,
	pub white:          Hsla,
	pub bright_black:   Hsla,
	pub bright_red:     Hsla,
	pub bright_green:   Hsla,
	pub bright_yellow:  Hsla,
	pub bright_blue:    Hsla,
	pub bright_magenta: Hsla,
	pub bright_cyan:    Hsla,
	pub bright_white:   Hsla,
}

impl RendererPalette {
	/// Derive terminal colours from the installed application palette.
	pub fn from_theme(theme: Theme) -> Self {
		Self {
			background:     theme.sunken,
			foreground:     theme.text,
			cursor:         theme.accent,
			selection:      theme.ring,
			black:          theme.canvas,
			red:            theme.danger,
			green:          theme.ok,
			yellow:         theme.warn,
			blue:           theme.syntax.function,
			magenta:        theme.syntax.keyword,
			cyan:           theme.syntax.attribute,
			white:          theme.text_muted,
			bright_black:   theme.text_faint,
			bright_red:     theme.syntax.constant,
			bright_green:   theme.syntax.string,
			bright_yellow:  theme.syntax.number,
			bright_blue:    theme.accent,
			bright_magenta: theme.syntax.kind,
			bright_cyan:    theme.syntax.punct,
			bright_white:   theme.text,
		}
	}

	/// Resolve a cell colour to an HSLA value through this palette.
	pub fn resolve_color(
		&self,
		color: veyyon_gui_core::text::terminal::CellColor,
		default_color: Hsla,
	) -> Hsla {
		match color {
			veyyon_gui_core::text::terminal::CellColor::Default => default_color,
			veyyon_gui_core::text::terminal::CellColor::Rgb(r, g, b) => {
				gpui::Rgba { r: r as f32 / 255.0, g: g as f32 / 255.0, b: b as f32 / 255.0, a: 1.0 }
					.into()
			},
			veyyon_gui_core::text::terminal::CellColor::Indexed(ix) => match ix {
				0 => self.black,
				1 => self.red,
				2 => self.green,
				3 => self.yellow,
				4 => self.blue,
				5 => self.magenta,
				6 => self.cyan,
				7 => self.white,
				8 => self.bright_black,
				9 => self.bright_red,
				10 => self.bright_green,
				11 => self.bright_yellow,
				12 => self.bright_blue,
				13 => self.bright_magenta,
				14 => self.bright_cyan,
				15 => self.bright_white,
				16..=231 => {
					let i = ix - 16;
					let r = (i / 36) % 6;
					let g = (i / 6) % 6;
					let b = i % 6;
					let conv = |v: u8| {
						if v == 0 {
							0.0
						} else {
							(v as f32 * 40.0 + 55.0) / 255.0
						}
					};
					gpui::Rgba { r: conv(r), g: conv(g), b: conv(b), a: 1.0 }.into()
				},
				232..=255 => {
					let gray = (ix - 232) as f32 * 10.0 + 8.0;
					let v = gray / 255.0;
					gpui::Rgba { r: v, g: v, b: v, a: 1.0 }.into()
				},
			},
		}
	}
}

/// Font settings applied without replacing the renderer instance.
#[derive(Debug, Clone, PartialEq)]
pub struct RendererFont {
	pub family:      SharedString,
	pub size_px:     f32,
	pub line_height: f32,
}

/// Latest terminal grid geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridSize {
	pub columns:   u16,
	pub rows:      u16,
	pub width_px:  u32,
	pub height_px: u32,
}

/// A changed rectangle in cell coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DamageRect {
	pub first_column: u16,
	pub first_row:    u16,
	pub last_column:  u16,
	pub last_row:     u16,
}

/// Damage is bounded metadata over a renderer-owned cell buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererDamage<'a> {
	Full,
	Cells(&'a [DamageRect]),
}

/// Interaction state passed to the retained viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewportState<'a> {
	pub focused:       bool,
	pub stale:         bool,
	pub accepts_input: bool,
	pub search:        Option<&'a str>,
	pub follow_tail:   bool,
}

/// Build the only write intent a renderer may emit.
pub fn write_command(terminal: &TerminalId, bytes: Vec<u8>) -> UiCommand {
	UiCommand::WriteTerminal { terminal: terminal.clone(), bytes }
}

/// Build a producer resize intent from the measured retained grid.
pub fn resize_command(terminal: &TerminalId, size: GridSize) -> UiCommand {
	UiCommand::ResizeTerminal {
		terminal: terminal.clone(),
		cols:     size.columns,
		rows:     size.rows,
	}
}

/// Adapter implemented by a retained terminal cell renderer.
///
/// Implementations keep cell buffers, shaped glyph runs, selection, scroll
/// position, and damage storage outside GPUI's element tree. `viewport` may be
/// called from the dock or inspector without constructing a new renderer.
///
/// A focused viewport draws the theme focus boundary; pointer or wheel input
/// cancels automatic scroll in that same event. The focused caret stays solid,
/// so an idle terminal schedules no blink frame.
pub trait RendererAdapter {
	/// Reconcile producer-owned output into the retained cell buffer.
	///
	/// This is data application, not process I/O. Implementations use
	/// `revision` to append or replace without rebuilding the viewport.
	fn reconcile(&mut self, terminal: &TerminalRunView, revision: u64);
	fn apply_palette(&mut self, terminal: &TerminalId, palette: RendererPalette);
	fn apply_font(&mut self, terminal: &TerminalId, font: &RendererFont);
	/// Apply raw host bytes to the retained emulator without performing I/O.
	fn apply_output(&mut self, terminal: &TerminalId, bytes: &[u8]);
	fn apply_damage(&mut self, terminal: &TerminalId, damage: RendererDamage<'_>);
	fn resize(&mut self, terminal: &TerminalId, size: GridSize);
	fn selection(&self, terminal: &TerminalId) -> Option<&str>;
	fn clear_selection(&mut self, terminal: &TerminalId);
	fn viewport(
		&mut self,
		terminal: &TerminalId,
		state: ViewportState<'_>,
		cx: &mut App,
	) -> AnyElement;
}
