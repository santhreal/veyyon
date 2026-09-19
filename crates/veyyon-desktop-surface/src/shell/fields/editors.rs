//! The constructor for each field a surface draws: what its editor starts
//! from, what a submit of it sends, and whether a value the host reports
//! replaces what it holds (§8.25).
//!
//! Every one resolves through [`super::ShellView::field_editor`], which
//! creates the entity once and hands the same handle back on every later
//! frame, so a keystroke survives the rebuild of the element that drew it.

use veyyon_desktop_kit::input::Editor;
use veyyon_desktop_model::{SessionId, SettingKind, SurfaceId};
use veyyon_gpui::{Context, Entity, Window};

use super::{Commit, FieldKey, FieldSlots, FieldSpec};
use crate::{ShellView, controls::availability_style};

impl ShellView {
	/// The retained editor for the secret a provider is waiting on: created
	/// when a flow asks for one, dropped when no flow does, so the next flow
	/// starts from an empty field.
	pub fn secret_field_editor(&mut self, cx: &mut Context<Self>) -> Option<Entity<Editor>> {
		if self.pending_secret_provider().is_none() {
			self.field_editors.remove(&FieldKey::AuthSecret);
			return None;
		}
		Some(self.field_editor(
			FieldSpec {
				key:         FieldKey::AuthSecret,
				commit:      Commit::Secret,
				placeholder: "API key or token".into(),
				mask:        true,
				multiline:   false,
				initial:     String::new(),
			},
			cx,
		))
	}

	/// The retained editor for the value of the setting `key`, holding
	/// `current` until the operator types into it. A value the host reports
	/// while the field is unfocused replaces what the field draws; one
	/// reported mid-edit does not, so a snapshot never eats a keystroke.
	pub fn setting_field_editor(
		&mut self,
		key: &str,
		kind: SettingKind,
		current: &str,
		window: &Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		let json = !matches!(kind, SettingKind::String);
		let editor = self.field_editor(
			FieldSpec {
				key:         FieldKey::Setting(key.to_owned()),
				commit:      if json {
					Commit::SettingJson
				} else {
					Commit::SettingText
				},
				placeholder: if json {
					"JSON value".into()
				} else {
					veyyon_gpui::SharedString::default()
				},
				mask:        false,
				multiline:   json,
				initial:     current.to_owned(),
			},
			cx,
		);
		let key_entry = FieldKey::Setting(key.to_owned());
		self.adopt_reported_value(&key_entry, &editor, current, window, cx);
		editor
	}

	/// The retained editor for renaming the session `session_id`, holding
	/// `current` until the operator edits it.
	pub fn session_rename_field_editor(
		&mut self,
		session_id: u64,
		current: &str,
		window: &Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		let editor = self.field_editor(
			FieldSpec {
				key:         FieldKey::SessionRename(session_id),
				commit:      Commit::SessionRename(session_id),
				placeholder: "Session name".into(),
				mask:        false,
				multiline:   false,
				initial:     current.to_owned(),
			},
			cx,
		);
		let key_entry = FieldKey::SessionRename(session_id);
		self.adopt_reported_value(&key_entry, &editor, current, window, cx);
		editor
	}

	/// Enters the session rename editing state for the current session if
	/// available and gated by the `RenameSession` capability.
	pub fn open_session_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let current_id = self.state.current_id;
		if current_id == 0 {
			return;
		}
		let surface_id = SurfaceId::SessionRenameField(SessionId(current_id.to_string()));
		let availability = self.state.controls.availability(&surface_id);
		let (_, _, allowed) = availability_style(&availability, &self.installed.set);
		if !allowed {
			return;
		}
		let title = self.state.title.clone();
		let editor = self.session_rename_field_editor(current_id, &title, window, cx);
		let focus = editor.read(cx).focus_handle().clone();
		window.focus(&focus, cx);
		cx.notify();
	}

	/// The retained editor for the alternatives bound to the keymap action
	/// `action`, holding what the host reports until the operator edits it.
	/// The alternatives are one field because the host stores them as one
	/// entry: `ctrl-enter, cmd-enter` is two bindings for one action.
	pub fn keybinding_field_editor(
		&mut self,
		action: &str,
		keys: &[String],
		window: &Window,
		cx: &mut Context<Self>,
	) -> Entity<Editor> {
		let current = keys.join(", ");
		let editor = self.field_editor(
			FieldSpec {
				key:         FieldKey::Keybinding(action.to_owned()),
				commit:      Commit::Keybinding,
				placeholder: "ctrl-enter".into(),
				mask:        false,
				multiline:   false,
				initial:     current.clone(),
			},
			cx,
		);
		let key_entry = FieldKey::Keybinding(action.to_owned());
		self.adopt_reported_value(&key_entry, &editor, &current, window, cx);
		editor
	}

	/// The retained editor for the task a background subagent is given. It
	/// is not reset from any reported value: the host has no draft of a task
	/// that has not been spawned yet, and a submit empties it.
	pub fn task_prompt_field_editor(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		self.field_editor(
			FieldSpec {
				key:         FieldKey::TaskPrompt,
				commit:      Commit::Task,
				placeholder: "Describe a task to run in the background".into(),
				mask:        false,
				multiline:   true,
				initial:     String::new(),
			},
			cx,
		)
	}

	/// The retained editor for the command a supervised process is started
	/// from. Nothing the host reports replaces it: the supervisor lists what
	/// is running, not what someone is about to type, and a submit empties
	/// the field.
	pub fn process_command_field_editor(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		self.field_editor(
			FieldSpec {
				key:         FieldKey::ProcessCommand,
				commit:      Commit::ProcessStart,
				placeholder: "Command to supervise, as in bun run dev".into(),
				mask:        false,
				multiline:   false,
				initial:     String::new(),
			},
			cx,
		)
	}

	/// The retained editor for the line written to a running process's
	/// input. Nothing the host reports replaces it, and a submit empties
	/// the field.
	pub fn process_input_field_editor(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		self.field_editor(
			FieldSpec {
				key:         FieldKey::ProcessInput,
				commit:      Commit::ProcessSend,
				placeholder: "Line to send, then press Send on the process it is for".into(),
				mask:        false,
				multiline:   false,
				initial:     String::new(),
			},
			cx,
		)
	}

	/// The retained editor for the query the General settings page is
	/// narrowed by. It is created empty and is the only thing that writes the
	/// filter afterwards, so the field and the rows it narrows never
	/// disagree; nothing the host reports replaces it, since a query is this
	/// window's own and the host stores none.
	pub fn settings_query_field_editor(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		self.field_editor(
			FieldSpec {
				key:         FieldKey::SettingsQuery,
				commit:      Commit::SettingsQuery,
				placeholder: "Search settings...".into(),
				mask:        false,
				multiline:   false,
				initial:     String::new(),
			},
			cx,
		)
	}

	/// The editors the settings pages draw their own fields from, created
	/// here because a page renders from a shared view that cannot create one.
	pub fn field_slots(&mut self, window: &Window, cx: &mut Context<Self>) -> FieldSlots {
		let secret = self.secret_field_editor(cx);
		let task = self.task_prompt_field_editor(cx);
		let query = self.settings_query_field_editor(cx);
		// The bindings are cloned out first: the editor for one is created
		// through the same view the listing is read from.
		let reported: Vec<(String, Vec<String>)> = self
			.active_settings()
			.map(|settings| {
				settings
					.keybindings
					.iter()
					.map(|binding| (binding.action.clone(), binding.keys.clone()))
					.collect()
			})
			.unwrap_or_default();
		let keybindings = reported
			.into_iter()
			.map(|(action, keys)| {
				let editor = self.keybinding_field_editor(&action, &keys, window, cx);
				(action, editor)
			})
			.collect();
		FieldSlots { secret, keybindings, task: Some(task), query }
	}

	/// Replaces what an unfocused field draws with the value the host
	/// reports, and leaves a focused or dirty one alone so a snapshot never eats
	/// a keystroke or uncommitted draft.
	fn adopt_reported_value(
		&self,
		key: &FieldKey,
		editor: &Entity<Editor>,
		current: &str,
		window: &Window,
		cx: &mut Context<Self>,
	) {
		let is_dirty = self.field_editors.get(key).is_some_and(|f| f.dirty);
		let focused = editor.read(cx).focus_handle().is_focused(window);
		if !focused && !is_dirty && editor.read(cx).text() != current {
			let current = current.to_owned();
			editor.update(cx, |editor, cx| editor.set_text(current, cx));
		}
	}
}
