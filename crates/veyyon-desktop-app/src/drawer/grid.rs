//! The grid a terminal or a process's output is drawn on: one mono row per
//! screen row, the caret, the selection, how far back it is scrolled, and
//! the keys, drags and wheel turns the grid takes.
//!
//! The grid's box is measured in the prepaint of the frame that laid it out,
//! and the columns and rows it holds are what the emulator is resized to and
//! what the host's terminal is told. The drawer is told only when the count
//! changes, so a settled grid asks for no further frame.

use veyyon_desktop_model::{
	HostAction, HostActionKind, TerminalStatus,
	text::terminal::{SelectionKind, TerminalSelection, cells_that_fit},
};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize},
	icons::IconName,
	theme::{ActiveTheme, Palette, TypeStyled, space, text},
};
use veyyon_gpui::{
	AnyElement, Bounds, ClickEvent, Context, KeyDownEvent, MouseButton, MouseDownEvent,
	MouseMoveEvent, Pixels, Point, ScrollWheelEvent, Size, StyledText, Window, canvas, div, font,
	prelude::*, size,
};

use super::{
	DrawerTab, TerminalDrawer,
	input::keystroke_bytes,
	rows::{RowText, row_text},
	screen::{DEFAULT_CELLS, MIN_CELLS, Screen},
};
use crate::panel::style::counted;

/// One cell of the mono face; `None` when the face resolves no glyph.
pub(super) fn cell_size(window: &Window) -> Option<Size<Pixels>> {
	let text_system = window.text_system();
	let face = text_system.resolve_font(&font(text::MONO.family));
	let advance = text_system.advance(face, text::MONO.size, 'm').ok()?;
	Some(size(advance.width, text::MONO.line_height))
}

impl TerminalDrawer {
	/// Feeds the shown tab's screen what arrived since it last read, and
	/// relabels the strip when the program set a new title. Returns whether
	/// the screen changed.
	pub(super) fn catch_up(&mut self, cx: &mut Context<Self>) -> bool {
		let Some(tab) = self.shown(cx) else {
			return false;
		};
		let cells = self.cells.unwrap_or(DEFAULT_CELLS);
		let app = self.app.read(cx);
		let domains = &app.store().domains;
		let screen = self
			.screens
			.entry(tab.clone())
			.or_insert_with(|| Screen::new(cells));
		let title = screen.title().to_owned();
		let changed = match &tab {
			DrawerTab::Terminal(id) => domains
				.terminal_output
				.get(id)
				.is_some_and(|output| screen.catch_up_bytes(&output.data, app.terminal_mark(id))),
			DrawerTab::Process(name) => domains
				.process_logs
				.get(name)
				.is_some_and(|logs| screen.catch_up_lines(&logs.lines, app.process_mark(name))),
			DrawerTab::Processes => false,
		};
		if changed && screen.title() != title {
			self.refresh_tabs(cx);
		}
		changed
	}

	/// Resizes the shown screen to the measured grid and tells a running
	/// terminal its new size once.
	pub(super) fn fit_shown(&mut self, cx: &mut Context<Self>) {
		let (Some(cells), Some(tab)) = (self.cells, self.shown(cx)) else {
			return;
		};
		if let Some(screen) = self.screens.get_mut(&tab) {
			screen.resize(cells);
		}
		let DrawerTab::Terminal(id) = tab else {
			return;
		};
		let app = self.app.read(cx);
		let running = app
			.store()
			.domains
			.terminals
			.iter()
			.find(|terminal| terminal.id == id)
			.is_some_and(|terminal| terminal.status == TerminalStatus::Running);
		if !running
			|| self.told.get(&id) == Some(&cells)
			|| app
				.panel_unavailable(HostActionKind::ResizeTerminal)
				.is_some()
		{
			return;
		}
		self.told.insert(id.clone(), cells);
		self.fire(HostAction::ResizeTerminal { terminal_id: id, cols: cells.0, rows: cells.1 }, cx);
	}

	/// Takes the box a frame laid the grid in: resizes the shown screen when
	/// it holds a different count of cells.
	fn fit(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
		self.grid_box.set(Some(bounds));
		let Some(cell) = self.cell else {
			return;
		};
		let cells = cells_that_fit(
			f32::from(bounds.size.width),
			f32::from(bounds.size.height),
			f32::from(cell.width),
			f32::from(cell.height),
			MIN_CELLS,
		);
		if self.cells == Some(cells) {
			return;
		}
		self.cells = Some(cells);
		self.fit_shown(cx);
		cx.notify();
	}

	/// The screen cell under `position`, clamped into the grid.
	fn cell_at(&self, position: Point<Pixels>, screen: &Screen) -> Option<(usize, usize)> {
		let (bounds, cell) = (self.grid_box.get()?, self.cell?);
		let grid = screen.emulator().grid();
		let along = |offset: Pixels, step: Pixels, count: usize| {
			let at = (f32::from(offset) / f32::from(step)).floor().max(0.0) as usize;
			at.min(count.saturating_sub(1))
		};
		// The rows sit on the box's bottom edge, which the newest row keeps.
		let top = bounds.origin.y + bounds.size.height - cell.height * grid.rows as f32;
		Some((
			along(position.x - bounds.origin.x, cell.width, grid.cols),
			along(position.y - top, cell.height, grid.rows),
		))
	}

	fn on_grid_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
		self.focus.focus(window, cx);
		let Some(tab) = self.shown(cx) else {
			return;
		};
		let Some(screen) = self.screens.get(&tab) else {
			return;
		};
		self.anchor = self.cell_at(event.position, screen);
		if let Some(screen) = self.screens.get_mut(&tab) {
			screen.select(None);
		}
		cx.notify();
	}

	fn on_grid_drag(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
		let (Some(anchor), Some(tab)) = (self.anchor, self.shown(cx)) else {
			return;
		};
		if event.pressed_button != Some(MouseButton::Left) {
			self.anchor = None;
			return;
		}
		let Some(at) = self
			.screens
			.get(&tab)
			.and_then(|screen| self.cell_at(event.position, screen))
		else {
			return;
		};
		let selection = (at != anchor).then_some(TerminalSelection {
			start_col: anchor.0,
			start_row: anchor.1,
			end_col:   at.0,
			end_row:   at.1,
			kind:      SelectionKind::Linear,
		});
		if let Some(screen) = self.screens.get_mut(&tab)
			&& screen.selection() != selection
		{
			screen.select(selection);
			cx.notify();
		}
	}

	fn on_grid_wheel(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
		let Some(tab) = self.shown(cx) else {
			return;
		};
		let step = text::MONO.line_height;
		self.wheel += event.delta.pixel_delta(step).y;
		let rows = (f32::from(self.wheel) / f32::from(step)).trunc();
		if rows == 0.0 {
			return;
		}
		self.wheel -= step * rows;
		let rows = rows as isize;
		if let Some(screen) = self.screens.get_mut(&tab)
			&& screen.scroll_by(rows)
		{
			cx.notify();
		}
	}

	/// Returns the shown tab to its newest output.
	fn follow_shown(&mut self, cx: &mut Context<Self>) {
		if let Some(tab) = self.shown(cx)
			&& let Some(screen) = self.screens.get_mut(&tab)
			&& screen.follow()
		{
			cx.notify();
		}
	}

	/// How far back the grid is scrolled, over its top edge, and the press
	/// that returns it to the newest output.
	fn scrolled_back(&self, back: usize, cx: &Context<Self>) -> AnyElement {
		let lines = u64::try_from(back).unwrap_or(u64::MAX);
		let badge = div()
			.absolute()
			.top(space::S1)
			.right(space::S1)
			// A press on the badge is not the start of a selection.
			.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
			.child(
				Button::new("drawer-follow", counted(lines, "line back", "lines back"))
					.size(ButtonSize::Sm)
					.icon(IconName::ChevronDown)
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.follow_shown(cx))),
			);
		self.target("drawer.follow", badge)
	}

	fn on_grid_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
		if !matches!(self.shown(cx), Some(DrawerTab::Terminal(_))) {
			return;
		}
		if let Some(bytes) = keystroke_bytes(&event.keystroke) {
			cx.stop_propagation();
			self.write(bytes, cx);
		}
	}

	/// The grid of `tab`: its rows, the caret while a running terminal holds
	/// focus and shows its newest output, and the handlers the grid takes.
	pub(super) fn grid(&self, tab: &DrawerTab, window: &Window, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let focused = self.focus.is_focused(window);
		let rows = self
			.screens
			.get(tab)
			.map(|screen| drawn(screen, tab, focused, &palette))
			.unwrap_or_default();
		// The alternate screen keeps no history, so it is never scrolled back.
		let back = self.screens.get(tab).map_or(0, |screen| {
			if screen.emulator().grid().alternate_screen {
				0
			} else {
				screen.scroll()
			}
		});
		let entity = cx.entity().downgrade();
		let held = self.grid_box.get();
		let measure = canvas(
			move |bounds, window, cx| {
				if held != Some(bounds) {
					window.defer(cx, move |_, cx| {
						entity.update(cx, |this, cx| this.fit(bounds, cx)).ok();
					});
				}
			},
			|_, (), _, _| {},
		)
		.absolute()
		.size_full();
		let key = format!("drawer.grid:{}", tab.slug());
		let grid = div()
			.id("drawer-grid")
			.key_context("Terminal")
			.track_focus(&self.focus)
			.relative()
			.flex()
			.flex_col()
			.justify_end()
			.flex_1()
			.min_h_0()
			.mx(space::S3)
			.my(space::S2)
			.overflow_hidden()
			.cursor_text()
			.type_style(text::MONO)
			.text_color(palette.text.primary)
			.on_key_down(cx.listener(Self::on_grid_key))
			.on_mouse_down(MouseButton::Left, cx.listener(Self::on_grid_down))
			.on_mouse_move(cx.listener(Self::on_grid_drag))
			.on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, _| this.anchor = None))
			.on_scroll_wheel(cx.listener(Self::on_grid_wheel))
			.child(measure)
			.children(rows.into_iter().map(|RowText { text, runs }| {
				div()
					.flex_none()
					.h(text::MONO.line_height)
					.child(StyledText::new(text).with_runs(runs))
			}))
			.when(back > 0, |grid| grid.child(self.scrolled_back(back, cx)));
		self.target(key, grid)
	}
}

/// The rows `screen` draws, the caret on the cursor's cell while a running
/// terminal holds focus and follows its output.
fn drawn(screen: &Screen, tab: &DrawerTab, focused: bool, palette: &Palette) -> Vec<RowText> {
	let grid = screen.emulator().grid();
	let caret = (focused
		&& matches!(tab, DrawerTab::Terminal(_))
		&& grid.cursor_visible
		&& (screen.scroll() == 0 || grid.alternate_screen))
		.then_some((grid.cursor_col, grid.cursor_row));
	let selection = screen.selection();
	screen
		.view()
		.enumerate()
		.map(|(row, cells)| {
			let caret = caret.filter(|&(_, at)| at == row).map(|(col, _)| col);
			row_text(cells, row, selection.as_ref(), caret, palette)
		})
		.collect()
}
