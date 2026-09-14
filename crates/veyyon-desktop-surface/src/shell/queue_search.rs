//! Queue session search palette integration (§5.1, §5.2, §5.8).
//!
//! Connects queue header search actions to the command palette overlay,
//! initializing session search candidates from the current queue partitions,
//! configuring text editor input, and managing window focus.

use veyyon_gpui::{Context, Window};

use crate::{ShellView, palette::PaletteState};

impl ShellView {
	/// Opens the queue session search palette, creates/focuses the palette
	/// editor, and populates search items from active queue partitions.
	pub fn open_queue_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let state = PaletteState::from_sessions(&self.state.sections);
		self.open_composer_options(state, cx);
		self.palette_input.anchored = false;
		self.palette_input.slash = false;
		self.palette_input.restore_focus = false;
		if let Some(editor) = self.palette_editor() {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		}
		cx.notify();
	}
}
