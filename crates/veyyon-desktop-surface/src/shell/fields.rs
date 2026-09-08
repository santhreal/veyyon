//! The editors behind every field a surface draws besides the composer and
//! the palette search: the secret a provider is waiting on, and the value of
//! a setting whose kind is text (§8.25).
//!
//! An element is rebuilt every frame, so a field drawn from a value carries no
//! keystroke: what a submit reads back out of one is the value it was
//! constructed with. An editable field therefore resolves through
//! [`ShellView::setting_field_editor`] or [`ShellView::secret_field_editor`],
//! which create the editor entity once, subscribe to it, and hand back the
//! same handle on every later frame.

use serde_json::Value;
use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_desktop_model::{AuthFlowState, SettingKind};
use veyyon_gpui::{AppContext, Context, Entity, SharedString, Window};

use crate::{Intent, ShellView, attach::ConnectionPhase};

/// Which field an editor belongs to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FieldKey {
	/// The secret the provider named by the flow in progress is waiting on.
	/// One editor serves the attach dialog and the Accounts page, because one
	/// authentication flow runs at a time.
	AuthSecret,
	/// The value of the setting this key names.
	Setting(String),
	/// The in-place name editor for the session with this row id.
	SessionRename(u64),
}

/// What a field's submit sends.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Commit {
	/// The text is the secret the waiting provider asked for.
	Secret,
	/// The text is the setting's value.
	SettingText,
	/// The text is JSON, and the setting's value is what it parses to.
	SettingJson,
	/// The text is the new session title.
	SessionRename(u64),
}

/// A retained field: its editor, and what a submit of it sends.
pub struct Field {
	editor: Entity<Editor>,
	commit: Commit,
}

/// How a field's editor is created on first use.
struct FieldSpec {
	key:         FieldKey,
	commit:      Commit,
	placeholder: SharedString,
	/// True for a field whose value is drawn masked, which is a secret.
	mask:        bool,
	/// True for a field whose editor accepts a value longer than one line.
	multiline:   bool,
	/// The value the editor starts from.
	initial:     String,
}

/// The retained editors a settings page draws its fields from, for a page
/// rendered from a shared `&ShellView` that cannot create one.
#[derive(Clone, Default)]
pub struct FieldSlots {
	/// The editor for the secret a provider is waiting on, when one is.
	pub secret: Option<Entity<Editor>>,
}

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
					SharedString::default()
				},
				mask:        false,
				multiline:   json,
				initial:     current.to_owned(),
			},
			cx,
		);
		let focused = editor.read(cx).focus_handle().is_focused(window);
		if !focused && editor.read(cx).text() != current {
			let current = current.to_owned();
			editor.update(cx, |editor, cx| editor.set_text(current, cx));
		}
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
		let focused = editor.read(cx).focus_handle().is_focused(window);
		if !focused && editor.read(cx).text() != current {
			let current = current.to_owned();
			editor.update(cx, |editor, cx| editor.set_text(current, cx));
		}
		editor
	}

	/// Sends the secret the field holds, for the button beside it. The
	/// provider comes from the flow in progress, which is what asked.
	pub fn submit_pending_secret(&mut self, cx: &mut Context<Self>) {
		self.commit_field(&FieldKey::AuthSecret, cx);
	}

	/// The editor a drawn field registered under `key`, without creating one:
	/// the handle a caller outside the render reads the live text out of, and
	/// `None` where no frame has drawn that field.
	pub fn retained_field(&self, key: &FieldKey) -> Option<Entity<Editor>> {
		self
			.field_editors
			.get(key)
			.map(|field| field.editor.clone())
	}

	/// The field created since the last frame that takes focus, which is the
	/// secret field: the screen exists to be typed into.
	pub const fn take_field_focus(&mut self) -> Option<Entity<Editor>> {
		self.field_focus.take()
	}

	/// The editors the settings pages draw their own fields from.
	pub fn field_slots(&mut self, cx: &mut Context<Self>) -> FieldSlots {
		FieldSlots { secret: self.secret_field_editor(cx) }
	}

	/// The provider waiting on a secret, named by the transport's phase or by
	/// the authentication flow the Accounts page reports.
	fn pending_secret_provider(&self) -> Option<String> {
		if let ConnectionPhase::NeedsSecret { provider } = &self.state.connection {
			return Some(provider.clone());
		}
		let flow = self.active_settings()?.auth_flow.as_ref()?;
		(flow.state == AuthFlowState::AwaitingSecret).then(|| flow.provider.clone())
	}

	/// The editor for `spec`, created and subscribed on first use.
	fn field_editor(&mut self, spec: FieldSpec, cx: &mut Context<Self>) -> Entity<Editor> {
		if let Some(field) = self.field_editors.get(&spec.key) {
			return field.editor.clone();
		}

		let mode = if spec.multiline {
			EditorMode::Multiline { newline_on_enter: false }
		} else {
			EditorMode::SingleLine
		};
		let placeholder = spec.placeholder.clone();
		let mask = spec.mask;
		let initial = spec.initial.clone();
		let editor = cx.new(|cx| {
			let mut editor = Editor::new(mode, cx).placeholder(placeholder);
			if mask {
				editor = editor.masked();
			}
			if spec.multiline {
				editor = editor.max_visible_lines(1);
			}
			editor.buffer_mut().set_text(initial);
			editor
		});

		let key = spec.key.clone();
		let sub = cx.subscribe(&editor, move |this, _editor, event: &EditorEvent, cx| match event {
			EditorEvent::Submit => this.commit_field(&key, cx),
			EditorEvent::Escape => this.revert_field(&key, cx),
			EditorEvent::Changed | EditorEvent::PasteMedia(_) => {},
		});
		self.subscriptions.push(sub);
		self
			.field_editors
			.insert(spec.key, Field { editor: editor.clone(), commit: spec.commit });
		if spec.commit == Commit::Secret {
			self.field_focus = Some(editor.clone());
		}
		editor
	}

	/// Sends what the field holds: the secret to the provider waiting for it,
	/// or the value to the setting that names it.
	fn commit_field(&mut self, key: &FieldKey, cx: &mut Context<Self>) {
		let Some(field) = self.field_editors.get(key) else {
			return;
		};
		let commit = field.commit;
		let editor = field.editor.clone();
		match (commit, key) {
			(Commit::Secret, _) => {
				let Some(provider) = self.pending_secret_provider() else {
					return;
				};
				let secret = editor.update(cx, |editor, cx| editor.take_text(cx));
				if secret.trim().is_empty() {
					self.refuse_field("A secret is required to authenticate");
					return;
				}
				self.clear_refusal();
				self.dispatch(Intent::SubmitAuthSecret { provider, secret }, cx);
			},
			(Commit::SettingText, FieldKey::Setting(key)) => {
				let value = Value::String(editor.read(cx).text().to_owned());
				let key = key.clone();
				self.clear_refusal();
				self.dispatch(Intent::SettingChanged { key, value }, cx);
			},
			(Commit::SettingJson, FieldKey::Setting(key)) => {
				let text = editor.read(cx).text().to_owned();
				match serde_json::from_str::<Value>(&text) {
					Ok(value) => {
						let key = key.clone();
						self.clear_refusal();
						self.dispatch(Intent::SettingChanged { key, value }, cx);
					},
					// §9.3: a value that cannot be parsed is refused where the
					// operator typed it, never sent on as a string the host
					// would store under a key of another shape.
					Err(error) => {
						self.refuse_field(&format!("{key} is not valid JSON: {error}"));
					},
				}
			},
			(Commit::SessionRename(id), FieldKey::SessionRename(_)) => {
				let title = editor.read(cx).text().trim().to_owned();
				if title.is_empty() {
					self.refuse_field("A session name cannot be empty");
					return;
				}
				self.clear_refusal();
				self.dispatch(Intent::RenameSession { session: id, title }, cx);
			},
			_ => {},
		}
	}

	/// Drops what the field holds: a secret is discarded, and a setting's
	/// field returns to the value the host reports on the next frame.
	fn revert_field(&mut self, key: &FieldKey, cx: &mut Context<Self>) {
		let Some(field) = self.field_editors.get(key) else {
			return;
		};
		let editor = field.editor.clone();
		match key {
			FieldKey::AuthSecret => {
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
				self.field_editors.remove(key);
				self.dispatch(Intent::CancelAuthFlow, cx);
			},
			FieldKey::Setting(_) => {
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
			},
			FieldKey::SessionRename(id) => {
				let initial = self
					.state
					.row(*id)
					.map_or_else(|| self.state.title.clone(), |r| r.title.clone());
				editor.update(cx, |editor, cx| editor.set_text(initial, cx));
			},
		}
		self.clear_refusal();
	}

	/// States a refusal in the attention strip, where the operator is looking.
	fn refuse_field(&mut self, message: &str) {
		self.set_notice(Some(message.to_owned()));
		self.field_refusal = Some(message.to_owned());
	}

	/// Withdraws the refusal this window put up, and leaves a host notice
	/// alone.
	fn clear_refusal(&mut self) {
		if let Some(refusal) = self.field_refusal.take()
			&& self.notice() == Some(refusal.as_str())
		{
			self.set_notice(None);
		}
	}
}
