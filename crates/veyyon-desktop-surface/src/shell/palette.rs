//! Palette input, composer anchoring, and focus transitions.

mod route;

use std::{cell::Cell, rc::Rc};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_gpui::{AppContext, Context, Entity, Pixels, Point, Window};

use crate::{
	Intent, Overlay, PaletteState, ShellView,
	controls::availability_style,
	palette::{PaletteMode, commands::ComposerCommand},
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
	pub parents:       Vec<PaletteState>,
	pub motion:        crate::palette::motion::FloatMotion,
	pub scroll:        veyyon_gpui::ScrollHandle,
	pub menu_selected: usize,
	pub menu_focused:  bool,
}

impl ShellView {
	/// The model trigger's last prepaint origin, shared without reentrant entity
	/// updates.
	#[must_use]
	pub fn palette_anchor(&self) -> Rc<Cell<Point<Pixels>>> {
		self.palette_input.anchor.clone()
	}

	pub(crate) fn picker_scroll(&self) -> veyyon_gpui::ScrollHandle {
		self.palette_input.scroll.clone()
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

	/// Opens the thinking effort selector without changing the draft.
	pub fn open_thinking_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let id =
			SurfaceId::ComposerThinkingSelector(SessionId::from(self.state.current_id.to_string()));
		let availability = self.state.controls.availability(&id);
		if !availability_style(&availability, &self.installed.set).2 {
			return;
		}
		let mut state = PaletteState::new(PaletteMode::Commands);
		if let Some(thinking) = &self.state.composer.thinking {
			state.set_items(
				thinking
					.levels
					.iter()
					.enumerate()
					.map(|(i, level)| {
						crate::palette::PaletteItem::command(
							i as u64 + 1,
							level.clone(),
							Intent::SetThinking(crate::composer::ThinkingLevel::new(level.clone())),
							None,
						)
					})
					.collect(),
			);
			if let Some(idx) = thinking.levels.iter().position(|l| *l == thinking.level) {
				state.selected = idx;
			}
		}
		self.palette_input.anchored = true;
		self.palette_input.slash = false;
		self.palette_input.restore_focus = false;
		self.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(state))), cx);
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
		let editor = cx.new(|cx| Editor::new(EditorMode::SingleLine, cx));
		let subscription = cx.subscribe(&editor, |view, editor, event, cx| {
			match event {
				EditorEvent::Changed => {
					let query = editor.read(cx).text().to_owned();
					let Some(palette) = view.state.overlay.as_ref().and_then(Overlay::as_palette) else {
						return;
					};
					if palette.query() == query {
						return;
					}
					// A mode whose rows are the host's answer to what was
					// typed reports a lookup; every other mode ranks the rows
					// it already holds (§5.8).
					let intent = palette.query_intent(query);
					view.dispatch(intent, cx);
				},
				EditorEvent::Submit => {
					view.picker_key("enter", cx);
				},
				EditorEvent::Escape => view.back_surface(cx),
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
		// A command that carries a message is ranked on its first word, so the
		// message after it is not scored against the row and cannot lose it.
		// Which commands those are is read off the command table, and the
		// spelling is compared the way the ranker compares, ignoring case:
		// `/Steer hello` reaches the same row as `/steer hello`.
		let first = query.split_whitespace().next().unwrap_or("");
		let carries = ComposerCommand::iter().any(|command| {
			command.carries_draft()
				&& command
					.name()
					.trim_start_matches('/')
					.eq_ignore_ascii_case(first)
		});
		let query = if carries { first } else { query };
		let query = if query.eq_ignore_ascii_case("commands") {
			""
		} else {
			query
		}
		.to_owned();
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
		match selected {
			Some(crate::palette::PaletteItemKind::Composer { command }) => {
				self.run_composer_command(command, cx);
				return;
			},
			// A directory row is a step of navigation and the palette stays
			// open: the rows it draws next are the host's listing of what the
			// row named, so the descent has to reach the host.
			Some(crate::palette::PaletteItemKind::Directory { path }) => {
				self.dispatch(Intent::BrowseTo { path: Some(path) }, cx);
				self.focus_palette_query(cx);
				cx.notify();
				return;
			},
			_ => {},
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
		if let Intent::Navigate(route) = intent {
			self.consume_command_prefix(cx);
			self.navigate_surface(route, cx);
			return;
		}
		// A command taking arguments runs with the ones that were typed, and
		// the row's own spelling runs when the draft holds no arguments for
		// it, which is what a row reached by arrow key holds.
		let intent = match (&intent, self.palette_input.slash) {
			(Intent::RunCommand(row), true) => Intent::RunCommand(self.typed_command(row)),
			_ => intent,
		};
		if self.palette_input.slash {
			self.consume_command_prefix(cx);
		}
		self.close_palette(cx);
		self.dispatch(intent, cx);
		// A row whose answer is another mode's rows leaves that mode open, and
		// the query the operator types next is that mode's rather than the
		// composer's. Which rows do that is read from what the row left open,
		// not from a second list of the intents that open one (§5.8).
		self.focus_palette_query(cx);
	}

	/// The command as the operator spelled it: the row's own text, or the
	/// whole draft when the draft is that command with arguments after it.
	fn typed_command(&self, row: &str) -> String {
		let typed = self.composer_cache.as_str().trim_start_matches('/');
		// Sliced through `get`, since a command name is whatever the host
		// spelled and a byte index into it need not land on a character.
		let takes_arguments = typed
			.get(..row.len())
			.is_some_and(|head| head.eq_ignore_ascii_case(row))
			&& typed
				.get(row.len()..)
				.is_some_and(|rest| rest.starts_with(char::is_whitespace));
		if takes_arguments {
			typed.to_owned()
		} else {
			row.to_owned()
		}
	}

	/// Hands the keyboard to the query of the palette a row left open, off the
	/// composer's anchor and holding that palette's own query (§5.8). Does
	/// nothing when the row closed the palette.
	fn focus_palette_query(&mut self, cx: &mut Context<Self>) {
		let Some(query) = self
			.state
			.overlay
			.as_ref()
			.and_then(Overlay::as_palette)
			.map(|palette| palette.query().to_owned())
		else {
			return;
		};
		self.palette_input.anchored = false;
		self.palette_input.restore_focus = false;
		let editor = self.ensure_palette_editor(cx);
		editor.update(cx, |editor, cx| editor.set_text(query, cx));
		self.palette_input.focus_search = true;
	}
}
