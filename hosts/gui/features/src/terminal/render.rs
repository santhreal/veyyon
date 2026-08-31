//! Retained terminal renderer implementation mapping emulator grids to GPUI
//! elements.

use std::collections::BTreeMap;

use gpui::{AnyElement, App, FontWeight, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	model::{TerminalId, TerminalRunView},
	text::terminal::TerminalEmulator,
};
use veyyon_gui_kit::theme::Theme;

use super::adapter::{
	GridSize, RendererAdapter, RendererDamage, RendererFont, RendererPalette, ViewportState,
};

/// Retained state for a single terminal session.
#[derive(Debug, Clone)]
pub struct RetainedTerminalSession {
	pub emulator:   TerminalEmulator,
	pub revision:   u64,
	pub output_len: usize,
	pub palette:    Option<RendererPalette>,
	pub font:       Option<RendererFont>,
	pub size:       GridSize,
	pub selection:  Option<String>,
}

impl Default for RetainedTerminalSession {
	fn default() -> Self {
		Self {
			emulator:   TerminalEmulator::new(80, 24),
			revision:   0,
			output_len: 0,
			palette:    None,
			font:       None,
			size:       GridSize { columns: 80, rows: 24, width_px: 0, height_px: 0 },
			selection:  None,
		}
	}
}

/// Default retained terminal renderer implementing [`RendererAdapter`].
#[derive(Debug, Default)]
pub struct RetainedTerminalRenderer {
	pub sessions: BTreeMap<TerminalId, RetainedTerminalSession>,
}

impl RetainedTerminalRenderer {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn session(&self, terminal: &TerminalId) -> Option<&RetainedTerminalSession> {
		self.sessions.get(terminal)
	}

	pub fn session_mut(&mut self, terminal: &TerminalId) -> Option<&mut RetainedTerminalSession> {
		self.sessions.get_mut(terminal)
	}
}

impl RendererAdapter for RetainedTerminalRenderer {
	fn reconcile(&mut self, terminal: &TerminalRunView, revision: u64) {
		let session = self.sessions.entry(terminal.id.clone()).or_default();
		if revision > session.revision {
			if terminal.output.len() >= session.output_len {
				session
					.emulator
					.feed(&terminal.output[session.output_len..]);
			} else {
				let size = session.size;
				session.emulator = TerminalEmulator::new(size.columns as usize, size.rows as usize);
				session.emulator.feed(&terminal.output);
			}
			session.output_len = terminal.output.len();
			session.revision = revision;
		}
	}

	fn apply_palette(&mut self, terminal: &TerminalId, palette: RendererPalette) {
		let session = self.sessions.entry(terminal.clone()).or_default();
		session.palette = Some(palette);
	}

	fn apply_font(&mut self, terminal: &TerminalId, font: &RendererFont) {
		let session = self.sessions.entry(terminal.clone()).or_default();
		session.font = Some(font.clone());
	}

	fn apply_output(&mut self, terminal: &TerminalId, bytes: &[u8]) {
		let session = self.sessions.entry(terminal.clone()).or_default();
		session.emulator.feed(bytes);
		session.output_len = session.output_len.saturating_add(bytes.len());
	}

	fn apply_damage(&mut self, _terminal: &TerminalId, _damage: RendererDamage<'_>) {}

	fn resize(&mut self, terminal: &TerminalId, size: GridSize) {
		let session = self.sessions.entry(terminal.clone()).or_default();
		session.size = size;
		session
			.emulator
			.resize(size.columns as usize, size.rows as usize);
	}

	fn selection(&self, terminal: &TerminalId) -> Option<&str> {
		self
			.sessions
			.get(terminal)
			.and_then(|s| s.selection.as_deref())
	}

	fn clear_selection(&mut self, terminal: &TerminalId) {
		if let Some(session) = self.sessions.get_mut(terminal) {
			session.selection = None;
		}
	}

	fn viewport(
		&mut self,
		terminal: &TerminalId,
		state: ViewportState<'_>,
		cx: &mut App,
	) -> AnyElement {
		let theme = Theme::get(cx);
		let session = self.sessions.entry(terminal.clone()).or_default();
		let palette = session
			.palette
			.unwrap_or_else(|| RendererPalette::from_theme(theme));
		let cursor = session.emulator.cursor();
		let rows_count = session.emulator.rows();
		let cols_count = session.emulator.cols();

		let font_family = session
			.font
			.as_ref()
			.map_or_else(|| theme.font_mono.into(), |f| f.family.clone());
		let font_size = session.font.as_ref().map_or(12.0, |f| f.size_px);
		let line_height = session.font.as_ref().map_or(18.0, |f| f.line_height);

		let mut grid_el = div()
			.flex()
			.flex_col()
			.size_full()
			.min_h(px(0.0))
			.bg(palette.background)
			.font_family(font_family)
			.text_size(px(font_size));

		for r in 0..rows_count {
			let mut row_el = div()
				.flex()
				.flex_row()
				.w_full()
				.h(px(line_height))
				.items_center();

			if let Some(line) = session.emulator.line(r) {
				for (c, cell) in line.cells.iter().enumerate().take(cols_count) {
					if cell.wide_spacer {
						continue;
					}
					let is_cursor =
						state.focused && cursor.visible && cursor.row == r && cursor.col == c;

					let (fg_color, bg_color) = if cell.attrs.reverse {
						(
							palette.resolve_color(cell.bg, palette.background),
							palette.resolve_color(cell.fg, palette.foreground),
						)
					} else {
						(
							palette.resolve_color(cell.fg, palette.foreground),
							palette.resolve_color(cell.bg, palette.background),
						)
					};

					let (fg, bg) = if is_cursor {
						(palette.background, palette.cursor)
					} else {
						(fg_color, bg_color)
					};

					let mut cell_el = div()
						.flex()
						.items_center()
						.justify_center()
						.text_color(fg)
						.bg(bg);

					if cell.attrs.bold {
						cell_el = cell_el.font_weight(FontWeight::BOLD);
					}
					if cell.attrs.italic {
						cell_el = cell_el.italic();
					}
					if cell.attrs.underline {
						cell_el = cell_el.underline();
					}

					let text_content = if cell.attrs.hidden || cell.grapheme.is_empty() {
						" ".to_owned()
					} else {
						cell.grapheme.clone()
					};

					cell_el = cell_el.child(text_content);
					row_el = row_el.child(cell_el);
				}
			}

			grid_el = grid_el.child(row_el);
		}

		grid_el.into_any_element()
	}
}
