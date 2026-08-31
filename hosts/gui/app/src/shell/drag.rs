//! Direct panel resize transactions.

use gpui::{Context, MouseMoveEvent, Window};
use veyyon_gui_core::UiCommand;
use veyyon_gui_features::shell::{BOTTOM_HEIGHT, INSPECTOR_WIDTH, SIDEBAR_WIDTH};
use veyyon_gui_kit::{motion::Damage, paint, theme::layout};

use super::Shell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
	Sidebar,
	Inspector,
	Bottom,
}

#[derive(Debug, Clone, Copy)]
pub struct Drag {
	pub panel:  Panel,
	pub origin: f32,
	pub start:  f32,
}

impl Shell {
	pub fn begin_panel_drag(
		&mut self,
		panel: Panel,
		position: f32,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let start = match panel {
			Panel::Sidebar => self.store.frontend.panels.sidebar_width,
			Panel::Inspector => self.store.frontend.panels.inspector_width,
			Panel::Bottom => self.store.frontend.panels.bottom_height,
		};
		self.drag = Some(Drag { panel, origin: position, start });
		// The keyboard leaves the field so escape cancels the drag, and it goes
		// to the frame rather than to a per-panel handle: a handle no element
		// draws is one gpui cannot find, and the window answers nothing at all
		// until something focuses a drawn element again.
		window.focus(&self.handles.focus.shell, cx);
		cx.notify();
	}

	pub fn move_panel_drag(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
		let Some(drag) = self.drag else { return };
		let (value, command, key) = match drag.panel {
			Panel::Sidebar => {
				let value = (drag.start + f32::from(event.position.x) - drag.origin)
					.clamp(layout::SIDEBAR_MIN, layout::SIDEBAR_MAX);
				(
					value,
					UiCommand::ResizeSidebar { width_milli_px: (value * 1000.0) as u32 },
					SIDEBAR_WIDTH,
				)
			},
			Panel::Inspector => {
				let value = (drag.start + drag.origin - f32::from(event.position.x))
					.clamp(layout::INSPECTOR_MIN, layout::INSPECTOR_MAX);
				(
					value,
					UiCommand::ResizeInspector { width_milli_px: (value * 1000.0) as u32 },
					INSPECTOR_WIDTH,
				)
			},
			Panel::Bottom => {
				let value = (drag.start + drag.origin - f32::from(event.position.y))
					.max(layout::BOTTOM_DOCK_MIN);
				(
					value,
					UiCommand::ResizeBottomDock { height_milli_px: (value * 1000.0) as u32 },
					BOTTOM_HEIGHT,
				)
			},
		};
		// The pointer is the authority while it is down, so the value is
		// committed rather than animated: an interpolated leg here would trail
		// the seam the reader is holding.
		paint::direct(cx, key, value, Damage::Layout(0));
		let _ = self.store.dispatch(command);
		cx.notify();
	}

	pub fn end_panel_drag(&mut self, cx: &mut Context<Self>) {
		self.drag = None;
		cx.notify();
	}

	pub fn cancel_panel_drag(&mut self, cx: &mut Context<Self>) {
		let Some(drag) = self.drag.take() else { return };
		let command = match drag.panel {
			Panel::Sidebar => {
				UiCommand::ResizeSidebar { width_milli_px: (drag.start * 1000.0) as u32 }
			},
			Panel::Inspector => {
				UiCommand::ResizeInspector { width_milli_px: (drag.start * 1000.0) as u32 }
			},
			Panel::Bottom => {
				UiCommand::ResizeBottomDock { height_milli_px: (drag.start * 1000.0) as u32 }
			},
		};
		let _ = self.store.dispatch(command);
		cx.notify();
	}
}
