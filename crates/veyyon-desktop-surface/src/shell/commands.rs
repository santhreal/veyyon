//! Secondary composer actions and their native selection surfaces.

use veyyon_desktop_model::{QueueMode, SessionId, SurfaceId};
use veyyon_gpui::Context;

use crate::{
	Intent, Overlay, PaletteState, ShellView,
	composer::ThinkingLevel,
	controls::availability_style,
	palette::{PaletteItem, PaletteMode, commands::ComposerCommand},
};

impl ShellView {
	/// Removes the selected command spelling, preserving trailing draft text and
	/// attachments.
	pub(super) fn consume_command_prefix(&mut self, cx: &mut Context<Self>) {
		if !self.palette_input.slash {
			return;
		}
		let prefix = self
			.state
			.overlay
			.as_ref()
			.and_then(Overlay::as_palette)
			.and_then(PaletteState::selected_item)
			.map(|item| item.title.as_str());
		let draft = prefix
			.and_then(|prefix| self.composer_cache.strip_prefix(prefix))
			.map_or_else(
				|| {
					self
						.composer_cache
						.split_once('\n')
						.map_or("", |(_, rest)| rest)
				},
				|rest| rest.strip_prefix(char::is_whitespace).unwrap_or(rest),
			)
			.to_owned();
		self.palette_input.slash = false;
		self.set_composed(draft, cx);
	}

	/// Replaces a command popover with a searchable native selection surface.
	pub(super) fn open_composer_options(&mut self, state: PaletteState, cx: &mut Context<Self>) {
		self.close_palette(cx);
		self.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(state))), cx);
		self.palette_input.anchored = true;
		self.palette_input.slash = false;
		self.palette_input.focus_search = true;
		let editor = self.ensure_palette_editor(cx);
		editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
	}

	pub(super) fn run_composer_command(&mut self, command: ComposerCommand, cx: &mut Context<Self>) {
		let session = SessionId::from(self.state.current_id.to_string());
		let surface = match command {
			ComposerCommand::AttachFiles => None,
			ComposerCommand::Models => Some(SurfaceId::ComposerModelSelector(session)),
			ComposerCommand::Effort => Some(SurfaceId::ComposerThinkingSelector(session)),
			ComposerCommand::QueueMode => Some(SurfaceId::ComposerQueueModeToggle(session)),
			ComposerCommand::Steer => Some(SurfaceId::ComposerSteerButton(session)),
			ComposerCommand::Queue => Some(SurfaceId::ComposerQueueButton(session)),
		};
		if surface.is_some_and(|id| {
			!availability_style(&self.state.controls.availability(&id), &self.installed.set).2
		}) {
			return;
		}
		match command {
			ComposerCommand::AttachFiles => {
				self.consume_command_prefix(cx);
				self.close_palette(cx);
				self.pick_attachments(cx);
			},
			ComposerCommand::Models => {
				let state =
					self.state.composer.model.as_ref().map_or_else(
						|| PaletteState::new(PaletteMode::Models),
						PaletteState::from_models,
					);
				self.consume_command_prefix(cx);
				self.open_composer_options(state, cx);
			},
			ComposerCommand::Effort => {
				let mut state = PaletteState::new(PaletteMode::Commands);
				if let Some(thinking) = &self.state.composer.thinking {
					state.items = thinking
						.levels
						.iter()
						.enumerate()
						.map(|(i, level)| {
							PaletteItem::command(
								i as u64 + 1,
								level.clone(),
								Intent::SetThinking(ThinkingLevel::new(level.clone())),
								None,
							)
						})
						.collect();
				}
				self.consume_command_prefix(cx);
				self.open_composer_options(state, cx);
			},
			ComposerCommand::QueueMode => {
				let mut state = PaletteState::new(PaletteMode::Commands);
				state.items = vec![
					PaletteItem::command(
						1,
						"Steer the running turn",
						Intent::SetQueueMode(QueueMode::Steer),
						None,
					),
					PaletteItem::command(
						2,
						"Queue after the running turn",
						Intent::SetQueueMode(QueueMode::Queue),
						None,
					),
				];
				self.consume_command_prefix(cx);
				self.open_composer_options(state, cx);
			},
			ComposerCommand::Steer | ComposerCommand::Queue => {
				if !self.state.turn.is_running() {
					return;
				}
				self.consume_command_prefix(cx);
				if !self.has_composer_text() {
					return;
				}
				let text = self.composer_cache.clone();
				self.close_palette(cx);
				self.dispatch(
					if command == ComposerCommand::Steer {
						Intent::Steer(text)
					} else {
						Intent::Queue(text)
					},
					cx,
				);
			},
		}
		cx.notify();
	}
}
