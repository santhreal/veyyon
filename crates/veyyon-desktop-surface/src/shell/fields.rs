//! The registry behind every field a surface draws besides the composer and
//! the palette search (§8.25).
//!
//! It states which field an editor belongs to, what a submit of it sends, and
//! the one editor entity each field retains across frames.
//!
//! An element is rebuilt every frame, so a field drawn from a value carries no
//! keystroke: what a submit reads back out of one is the value it was
//! constructed with. The constructors are in [`editors`], and each resolves
//! through [`ShellView::field_editor`], which creates the editor entity once,
//! subscribes to it, and hands back the same handle on every later frame.

mod editors;

use serde_json::Value;
use veyyon_desktop_kit::{
	KeyChord,
	input::{Editor, EditorEvent, EditorMode},
};
use veyyon_desktop_model::AuthFlowState;
use veyyon_gpui::{AppContext, Context, Entity, SharedString};

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
	/// The alternatives bound to the keymap action this name states.
	Keybinding(String),
	/// The description of the task the Agents page spawns.
	TaskPrompt,
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
	/// The text is the comma-separated alternatives bound to the keymap
	/// action the field's key names.
	Keybinding,
	/// The text is the task a background subagent is given.
	Task,
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
	pub secret:      Option<Entity<Editor>>,
	/// The editor for each keymap action the host reports a binding for,
	/// paired with the action it rebinds.
	pub keybindings: Vec<(String, Entity<Editor>)>,
	/// The editor for the task the Agents page spawns.
	pub task:        Option<Entity<Editor>>,
}

impl FieldSlots {
	/// The editor that rebinds `action`, and `None` where the host reports
	/// no binding for it.
	#[must_use]
	pub fn keybinding(&self, action: &str) -> Option<Entity<Editor>> {
		self
			.keybindings
			.iter()
			.find(|(name, _)| name == action)
			.map(|(_, editor)| editor.clone())
	}
}

impl ShellView {
	/// Sends the secret the field holds, for the button beside it. The
	/// provider comes from the flow in progress, which is what asked.
	pub fn submit_pending_secret(&mut self, cx: &mut Context<Self>) {
		self.commit_field(&FieldKey::AuthSecret, cx);
	}

	/// Runs the task the Agents page's field holds, for the button beside
	/// it. The text is the task, and a submit empties the field.
	pub fn submit_task_prompt(&mut self, cx: &mut Context<Self>) {
		self.commit_field(&FieldKey::TaskPrompt, cx);
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
			(Commit::Keybinding, FieldKey::Keybinding(action)) => {
				let text = editor.read(cx).text().to_owned();
				let keys = parse_chords(&text);
				// §9.3: a chord the keymap grammar cannot read is refused
				// where it was typed, never written to the keymap as a
				// binding no key press would ever match.
				if keys.is_empty() {
					self.refuse_field(&format!("{action} needs at least one chord, as in ctrl-enter"));
					return;
				}
				let action = action.clone();
				self.clear_refusal();
				self.dispatch(Intent::KeybindingChanged { action, keys }, cx);
			},
			(Commit::Task, FieldKey::TaskPrompt) => {
				let task = editor.read(cx).text().trim().to_owned();
				if task.is_empty() {
					self.refuse_field("A task needs a description to run");
					return;
				}
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
				self.clear_refusal();
				self.dispatch(Intent::SpawnTask(task), cx);
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
			FieldKey::Keybinding(action) => {
				let initial = self
					.active_settings()
					.and_then(|settings| {
						settings
							.keybindings
							.iter()
							.find(|binding| &binding.action == action)
					})
					.map(|binding| binding.keys.join(", "))
					.unwrap_or_default();
				editor.update(cx, |editor, cx| editor.set_text(initial, cx));
			},
			FieldKey::TaskPrompt => {
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
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

/// The chords a keybinding field's text states: the alternatives separated by
/// commas, each one token in the keymap grammar. A part that is blank, or one
/// whose modifiers are not followed by a key, is dropped, so a field that
/// states nothing readable yields no chord and is refused rather than sent.
fn parse_chords(text: &str) -> Vec<String> {
	text
		.split(',')
		.map(str::trim)
		.filter(|chord| !chord.is_empty() && !chord.contains(char::is_whitespace))
		.filter(|chord| !KeyChord::parse(chord).key.is_empty())
		.map(str::to_owned)
		.collect()
}
