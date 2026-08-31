//! Editor subscriptions and input event dispatch.

use gpui::{Context, Entity};
use veyyon_gui_core::UiCommand;
use veyyon_gui_kit::input::{Editor, EditorEvent, SecureEditor};

use super::Shell;

impl Shell {
	pub(super) fn subscribe(&self, cx: &mut Context<Self>) {
		cx.subscribe(&self.handles.editors.composer, Self::on_composer)
			.detach();
		cx.subscribe(&self.handles.editors.command, Self::on_command)
			.detach();
		for (editor, make_cmd) in [
			(&self.handles.editors.sessions, UiCommand::SetSessionFilter as fn(String) -> UiCommand),
			(&self.handles.editors.changes_search, UiCommand::SetChangesFilter),
			(&self.handles.editors.files, UiCommand::SetFileFilter),
			(&self.handles.editors.agents, UiCommand::SetAgentFilter),
			(&self.handles.editors.settings, UiCommand::SetSettingsFilter),
			(&self.handles.editors.models, UiCommand::SetModelQuery),
			(&self.handles.editors.providers, UiCommand::SetProviderQuery),
			(&self.handles.editors.mcp, UiCommand::SetMcpQuery),
			(&self.handles.editors.extensions, UiCommand::SetExtensionQuery),
			(&self.handles.editors.problems, UiCommand::SetProblemFilter),
		] {
			cx.subscribe(editor, move |this, editor, _event, cx| {
				let text = editor.read(cx).text().to_owned();
				this.editor_command(make_cmd(text), cx);
			})
			.detach();
		}
		cx.subscribe(&self.handles.editors.agent_message, Self::on_agent_message)
			.detach();
		cx.subscribe(&self.handles.editors.interaction, Self::on_interaction)
			.detach();
		cx.subscribe(&self.handles.editors.interaction_note, Self::on_interaction_note)
			.detach();
		cx.subscribe(&self.handles.editors.provider_secret, Self::on_provider_secret)
			.detach();
		cx.subscribe(&self.handles.editors.rename_session, Self::on_rename_session)
			.detach();
	}

	/// Dispatch a command raised by a field's own event.
	///
	/// A subscription is handed no window, so an effect that has to place the
	/// keyboard cannot run here: it is queued for the frame, which has one.
	/// Dropping them was how submitting a palette row left the window deaf —
	/// the row's sequence closed the overlay the command field was drawn in, and
	/// nothing ever moved the keyboard off it.
	pub(super) fn editor_command(&mut self, command: UiCommand, cx: &mut Context<Self>) {
		let effects = self.store.dispatch(command);
		self.deferred_effects.extend(effects.shell);
		cx.notify();
	}

	fn on_composer(&mut self, editor: Entity<Editor>, event: &EditorEvent, cx: &mut Context<Self>) {
		let Some(session) = self.store.frontend.selected_session.clone() else {
			return;
		};
		match event {
			EditorEvent::Changed => {
				let (text, caret) = {
					let editor = editor.read(cx);
					(editor.text().to_owned(), editor.caret())
				};
				self.editor_command(UiCommand::EditDraft { session: session.clone(), text }, cx);
				self.editor_command(UiCommand::SetDraftCaret { session, byte: caret }, cx);
			},
			EditorEvent::Submit => {
				self.editor_command(UiCommand::SubmitPrompt { session: session.clone() }, cx);
				// The field follows the draft rather than emptying itself, so a
				// submission the host boundary refused leaves the text where the
				// reader can send it again.
				let draft = self.store.frontend.drafts.get(&session);
				let text = draft.map(|draft| draft.text.clone()).unwrap_or_default();
				let caret = draft.map_or(0, |draft| draft.caret);
				editor.update(cx, |editor, cx| editor.set_text(&text, caret, cx));
			},
		}
	}

	fn on_command(&mut self, editor: Entity<Editor>, event: &EditorEvent, cx: &mut Context<Self>) {
		self.editor_command(
			match event {
				EditorEvent::Changed => UiCommand::SetPaletteQuery(editor.read(cx).text().to_owned()),
				EditorEvent::Submit => UiCommand::AcceptPalette,
			},
			cx,
		);
	}

	fn on_agent_message(
		&mut self,
		editor: Entity<Editor>,
		event: &EditorEvent,
		cx: &mut Context<Self>,
	) {
		if let Some(agent) = self.store.frontend.selected_agent.clone() {
			let text = editor.read(cx).text().to_owned();
			self.editor_command(
				match event {
					EditorEvent::Changed => UiCommand::EditAgentChatDraft { agent, text },
					EditorEvent::Submit => UiCommand::ChatAgent { agent, message: text },
				},
				cx,
			);
		}
	}

	fn on_interaction(&mut self, editor: Entity<Editor>, _: &EditorEvent, cx: &mut Context<Self>) {
		if let Some(interaction) =
			self
				.store
				.frontend
				.overlays
				.last()
				.and_then(|overlay| match overlay {
					veyyon_gui_core::navigation::Overlay::Approval { interaction }
					| veyyon_gui_core::navigation::Overlay::Question { interaction } => Some(interaction.clone()),
					_ => None,
				}) {
			self.editor_command(
				UiCommand::EditInteractionText { interaction, text: editor.read(cx).text().to_owned() },
				cx,
			);
		}
	}

	fn on_interaction_note(
		&mut self,
		editor: Entity<Editor>,
		_: &EditorEvent,
		cx: &mut Context<Self>,
	) {
		if let Some(interaction) =
			self
				.store
				.frontend
				.overlays
				.last()
				.and_then(|overlay| match overlay {
					veyyon_gui_core::navigation::Overlay::Question { interaction } => {
						Some(interaction.clone())
					},
					_ => None,
				}) {
			self.editor_command(
				UiCommand::EditInteractionNote { interaction, note: editor.read(cx).text().to_owned() },
				cx,
			);
		}
	}

	fn on_provider_secret(
		&mut self,
		editor: Entity<Editor>,
		event: &EditorEvent,
		cx: &mut Context<Self>,
	) {
		if !matches!(event, EditorEvent::Submit) {
			return;
		}
		let Some(provider) = self
			.store
			.frontend
			.overlays
			.last()
			.and_then(|overlay| match overlay {
				veyyon_gui_core::navigation::Overlay::ProviderAuth { provider } => {
					Some(provider.clone())
				},
				_ => None,
			})
		else {
			return;
		};
		let secret = editor.update(cx, SecureEditor::take);
		let secret = String::from_utf8_lossy(secret.expose()).into_owned();
		self.editor_command(UiCommand::SubmitAuthSecret { provider, secret }, cx);
	}

	fn on_rename_session(
		&mut self,
		editor: Entity<Editor>,
		event: &EditorEvent,
		cx: &mut Context<Self>,
	) {
		let Some(session) = self
			.store
			.frontend
			.overlays
			.last()
			.and_then(|overlay| match overlay {
				veyyon_gui_core::navigation::Overlay::RenameSession { session, .. } => {
					Some(session.clone())
				},
				_ => None,
			})
		else {
			return;
		};
		let text = editor.read(cx).text().to_owned();
		match event {
			EditorEvent::Changed => {
				if let Some(veyyon_gui_core::navigation::Overlay::RenameSession { value, .. }) =
					self.store.frontend.overlays.last_mut()
				{
					*value = text;
				}
			},
			EditorEvent::Submit => {
				self.editor_command(UiCommand::CloseTopOverlay, cx);
				self.editor_command(UiCommand::RenameSession { session, name: text }, cx);
			},
		}
	}
}
