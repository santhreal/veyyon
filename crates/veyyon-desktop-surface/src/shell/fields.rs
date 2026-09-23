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
mod parse;
mod profile;
mod query;
mod supervisor;

use serde_json::Value;
use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_desktop_model::AuthFlowState;
use veyyon_gpui::{AppContext, Context, Entity, SharedString};

use self::parse::{parse_chords, split_command_line};
use crate::{Intent, ShellView, attach::ConnectionPhase};

/// Which field an editor belongs to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FieldKey {
	AuthSecret,
	Setting(String),
	SessionRename(u64),
	Keybinding(String),
	TaskPrompt,
	ProcessCommand,
	ProcessInput,
	SettingsQuery,
	ProfileName,
}

/// What a field's submit sends.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Commit {
	Secret,
	SettingText,
	SettingJson,
	SessionRename(u64),
	Keybinding,
	Task,
	ProcessStart,
	ProcessSend,
	SettingsQuery,
	ProfileCreate,
}
/// A retained field: its editor, and what a submit of it sends.
pub(super) struct Field {
	pub(super) editor: Entity<Editor>,
	commit:            Commit,
	pub(super) dirty:  bool,
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
#[derive(Clone)]
pub struct FieldSlots {
	/// The editor for the secret a provider is waiting on, when one is.
	pub secret:      Option<Entity<Editor>>,
	/// The editor for each keymap action the host reports a binding for,
	/// paired with the action it rebinds.
	pub keybindings: Vec<(String, Entity<Editor>)>,
	/// The editor for the task the Agents page spawns.
	pub task:        Option<Entity<Editor>>,
	/// The editor for the name a new profile is created under.
	pub profile:     Option<Entity<Editor>>,
	/// The editor for the query the General page's rows are narrowed by.
	/// Every frame that can draw the page retains one, so the field it draws
	/// is typeable rather than a picture of the query it holds.
	pub query:       Entity<Editor>,
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
			EditorEvent::Changed => {
				if let Some(field) = this.field_editors.get_mut(&key) {
					field.dirty = true;
				}
				// A query narrows the page as it is typed: it sends nothing,
				// so a submit is not what applies it, and the rows the list
				// draws are read from the state this writes.
				if key == FieldKey::SettingsQuery {
					this.apply_settings_query(cx);
				}
			},
			EditorEvent::PasteMedia(_) => {},
		});
		self.subscriptions.push(sub);
		self.field_editors.insert(spec.key, Field {
			editor: editor.clone(),
			commit: spec.commit,
			dirty:  false,
		});
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
		if let Some(field) = self.field_editors.get_mut(key) {
			field.dirty = false;
		}
		match (commit, key) {
			(Commit::Secret, _) => {
				let Some(provider) = self.pending_secret_provider() else {
					return;
				};
				let secret = editor.update(cx, |editor, cx| editor.take_text(cx));
				if secret.trim().is_empty() {
					self.refuse_field(cx, "A secret is required to authenticate");
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
						self.refuse_field(cx, &format!("{key} is not valid JSON: {error}"));
					},
				}
			},
			(Commit::SessionRename(id), FieldKey::SessionRename(_)) => {
				let title = editor.read(cx).text().trim().to_owned();
				if title.is_empty() {
					self.refuse_field(cx, "A session name cannot be empty");
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
					self.refuse_field(
						cx,
						&format!("{action} needs at least one chord, as in ctrl-enter"),
					);
					return;
				}
				let action = action.clone();
				self.clear_refusal();
				self.dispatch(Intent::KeybindingChanged { action, keys }, cx);
			},
			(Commit::Task, FieldKey::TaskPrompt) => {
				let task = editor.read(cx).text().trim().to_owned();
				if task.is_empty() {
					self.refuse_field(cx, "A task needs a description to run");
					return;
				}
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
				self.clear_refusal();
				self.dispatch(Intent::SpawnTask(task), cx);
			},
			(Commit::ProcessStart, FieldKey::ProcessCommand) => {
				let line = editor.read(cx).text().to_owned();
				// §9.3: an empty command is refused where it was typed. The
				// host answers one with `INVALID_ARGUMENTS`, so sending it
				// would spend a round trip to learn what the field already
				// states.
				let Some((command, args)) = split_command_line(&line) else {
					self.refuse_field(cx, "A process needs a command to run");
					return;
				};
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
				self.clear_refusal();
				self.dispatch(Intent::ProcessStart { command, args }, cx);
			},
			// A submit from inside the field names no row, so the process it
			// reaches is resolved from what is running.
			(Commit::ProcessSend, FieldKey::ProcessInput) => self.send_process_input(None, cx),
			(Commit::ProfileCreate, FieldKey::ProfileName) => {
				profile::commit_create(self, &editor, cx);
			},
			// A query is already applied on the frame each character landed
			// on, so a submit of it sends nothing and leaves the page as the
			// typing left it.
			(Commit::SettingsQuery, FieldKey::SettingsQuery) => {},
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
		if let Some(field) = self.field_editors.get_mut(key) {
			field.dirty = false;
		}
		match key {
			FieldKey::AuthSecret => {
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
				self.field_editors.remove(key);
				self.dispatch(Intent::CancelAuthFlow, cx);
			},
			FieldKey::Setting(k) => {
				let initial = self
					.active_settings()
					.and_then(|s| s.entry(k))
					.map(|e| match &e.value {
						Value::String(s) => s.clone(),
						other => other.to_string(),
					})
					.unwrap_or_default();
				editor.update(cx, |editor, cx| editor.set_text(initial, cx));
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
			FieldKey::TaskPrompt
			| FieldKey::ProcessCommand
			| FieldKey::ProcessInput
			| FieldKey::ProfileName => {
				editor.update(cx, |editor, cx| editor.set_text(String::new(), cx));
			},
			// The window captures Escape above the editor and widens the page
			// there, one rung per press, so this arm is what a revert from
			// anywhere else does: empty the query and the filter behind it.
			FieldKey::SettingsQuery => self.clear_settings_query(cx),
		}
		self.clear_refusal();
	}

	/// States a refusal in the attention strip, where the operator is looking.
	///
	/// A refusal sends nothing, so it reaches no `dispatch` and nothing else
	/// marks the window dirty: without the notification here the strip is
	/// stated in the state and drawn on whatever frame some later interaction
	/// happens to request.
	fn refuse_field(&mut self, cx: &mut Context<Self>, message: &str) {
		if self.field_refusal.as_deref() == Some(message) {
			return;
		}
		self.field_refusal = Some(message.to_owned());
		cx.notify();
	}

	/// Withdraws the refusal this window put up, and leaves what the host
	/// reports alone.
	///
	/// No repaint is asked for here, and none is needed: every caller goes on
	/// to dispatch the value it took or to rewrite the editor it reverted,
	/// and both of those mark the window dirty on the same frame. A caller
	/// that only withdraws a refusal would need one.
	fn clear_refusal(&mut self) {
		self.field_refusal = None;
	}
}
