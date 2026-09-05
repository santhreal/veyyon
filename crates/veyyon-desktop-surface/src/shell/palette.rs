//! Palette input, composer anchoring, and focus transitions.

use std::{cell::Cell, rc::Rc};

use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_gpui::{AppContext, Context, Entity, Pixels, Point, Window};

use crate::{
	Intent, Overlay, PaletteState, ShellView, controls::availability_style, palette::PaletteMode,
};

/// Window-local input state; host snapshots do not replace the query editor or
/// its anchor.
#[derive(Default)]
pub(super) struct PaletteInput {
	pub editor:        Option<Entity<Editor>>,
	pub anchor:        Rc<Cell<Point<Pixels>>>,
	pub anchored:      bool,
	pub slash:         bool,
	pub dismissed:     Option<String>,
	pub restore_focus: bool,
	pub focus_search:  bool,
	pub retained:      Option<Overlay>,
	pub motion:        crate::palette::motion::FloatMotion,
}

impl ShellView {
	/// The model trigger's last prepaint origin, shared without reentrant entity
	/// updates.
	#[must_use]
	pub fn palette_anchor(&self) -> Rc<Cell<Point<Pixels>>> {
		self.palette_input.anchor.clone()
	}

	/// The search editor for a non-slash palette.
	#[must_use]
	pub fn palette_editor(&self) -> Option<Entity<Editor>> {
		self.palette_input.editor.clone()
	}

	/// Opens the model catalogue without changing the draft or the selected
	/// model.
	pub fn open_model_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let id = SurfaceId::ComposerModelSelector(SessionId::from(self.state.current_id.to_string()));
		let availability = self.state.controls.availability(&id);
		if !availability_style(&availability, &self.installed.set).2 {
			return;
		}
		let palette = self
			.state
			.composer
			.model
			.as_ref()
			.map_or_else(|| PaletteState::new(PaletteMode::Models), PaletteState::from_models);
		self.palette_input.anchored = true;
		self.palette_input.slash = false;
		self.palette_input.restore_focus = false;
		self.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(palette))), cx);
		let editor = self.ensure_palette_editor(cx);
		editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
		let focus = editor.read(cx).focus_handle().clone();
		window.focus(&focus, cx);
		cx.notify();
	}

	/// Opens the global command surface with the same input and selection
	/// implementation.
	pub fn open_command_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.open_composer_options(PaletteState::commands(), cx);
		self.palette_input.anchored = false;
		self.palette_input.restore_focus = false;
		if let Some(editor) = self.palette_editor() {
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
		}
	}

	/// Installs the same text input path used by the composer, including IME and
	/// paste.
	pub(super) fn ensure_palette_editor(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		if let Some(editor) = &self.palette_input.editor {
			return editor.clone();
		}
		let editor = cx.new(|cx| Editor::new(EditorMode::SingleLine, cx).placeholder("Search"));
		let subscription = cx.subscribe(&editor, |view, editor, event, cx| {
			match event {
				EditorEvent::Changed => {
					let query = editor.read(cx).text().to_owned();
					if let Some(palette) = view
						.state
						.overlay
						.as_mut()
						.and_then(Overlay::as_palette_mut)
					{
						palette.set_query(query);
					}
				},
				EditorEvent::Submit => view.run_palette(cx),
				EditorEvent::Escape => view.close_palette(cx),
				EditorEvent::PasteMedia(_) => {},
			}
			cx.notify();
		});
		self.subscriptions.push(subscription);
		self.palette_input.editor = Some(editor.clone());
		editor
	}

	/// Opens command search from the leading slash while retaining draft
	/// ownership in the composer.
	pub(super) fn update_slash_palette(&mut self, cx: &mut Context<Self>) {
		let text = self.composer_cache.as_str();
		if self.palette_input.dismissed.as_deref() == Some(text) {
			return;
		}
		self.palette_input.dismissed = None;
		let Some(query) = text.strip_prefix('/') else {
			if self.palette_input.slash {
				self.state.overlay = None;
				self.palette_input.slash = false;
			}
			return;
		};
		let first = query.split_whitespace().next().unwrap_or("");
		let query = if matches!(first, "steer" | "queue") {
			first
		} else {
			query
		};
		let query = if query == "commands" { "" } else { query }.to_owned();
		if !self.palette_input.slash
			|| self
				.state
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.is_none()
		{
			self.state.overlay = Some(Overlay::Palette(PaletteState::commands()));
		}
		self.palette_input.anchored = true;
		self.palette_input.slash = true;
		if let Some(palette) = self
			.state
			.overlay
			.as_mut()
			.and_then(Overlay::as_palette_mut)
		{
			palette.set_query(query);
		}
		cx.notify();
	}

	/// Executes the selected row, never a second composer submission.
	pub fn run_palette(&mut self, cx: &mut Context<Self>) {
		let selected = self
			.state
			.overlay
			.as_ref()
			.and_then(Overlay::as_palette)
			.and_then(PaletteState::selected_item)
			.map(|item| item.kind.clone());
		if let Some(crate::palette::PaletteItemKind::Composer { command }) = selected {
			self.run_composer_command(command, cx);
			return;
		}
		let Some(intent) = self
			.state
			.overlay
			.as_ref()
			.and_then(Overlay::as_palette)
			.and_then(PaletteState::run_intent)
		else {
			return;
		};
		if !self.composer_action_allowed(&intent) {
			return;
		}
		if self.palette_input.slash {
			self.consume_command_prefix(cx);
		}
		self.close_palette(cx);
		self.dispatch(intent, cx);
	}

	/// Closes the menu without discarding the draft and restores focus on the
	/// next frame.
	pub fn close_palette(&mut self, cx: &mut Context<Self>) {
		if self.palette_input.slash {
			self.palette_input.dismissed = Some(self.composer_cache.clone());
		}
		self.palette_input.slash = false;
		self.palette_input.restore_focus = true;
		self.dispatch(Intent::CloseOverlay, cx);
	}
}
