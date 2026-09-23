//! Every field a return on can be refused, seeded in a shell that draws it,
//! and the shape vocabulary a sweep checks those cases against.
//!
//! The case table states what each field refuses and what it takes, which is
//! the protocol between a field and the attention strip rather than the
//! invariant under test, so it sits beside the suite that sweeps it.

use serde_json::json;
use strum::EnumIter;
use veyyon_desktop_model::SettingKind;
use veyyon_desktop_scene::HeadlessSession;
use veyyon_desktop_surface::{
	ConnectionPhase, FieldKey, SettingsPage, ShellState, ShellView, fixture,
};

use super::fields::{
	SETTING_KEY, general_page_holds, keybindings_page_binds, settings_page_open, share_card_open,
	supervisor_tab_open, supervisor_tab_running, transport_asks_for_a_secret,
};

/// The keymap action a seeded Keybindings page reports a binding for.
const BOUND_ACTION: &str = "shell::Submit";

/// A field, without the value that names which one, so the sweep can be
/// checked against the set of fields that exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, EnumIter)]
pub enum KeyShape {
	/// [`FieldKey::AuthSecret`].
	AuthSecret,
	/// [`FieldKey::Setting`].
	Setting,
	/// [`FieldKey::SessionRename`].
	SessionRename,
	/// [`FieldKey::Keybinding`].
	Keybinding,
	/// [`FieldKey::TaskPrompt`].
	TaskPrompt,
	/// [`FieldKey::ProcessCommand`].
	ProcessCommand,
	/// [`FieldKey::ProcessInput`].
	ProcessInput,
	/// [`FieldKey::SettingsQuery`].
	SettingsQuery,
	/// [`FieldKey::ProfileName`].
	ProfileName,
	/// [`FieldKey::ShareLink`].
	ShareLink,
}

/// The exhaustive match that makes a new `FieldKey` fail to compile here until
/// its refusal is recorded.
pub const fn key_shape(key: &FieldKey) -> KeyShape {
	match key {
		FieldKey::AuthSecret => KeyShape::AuthSecret,
		FieldKey::Setting(_) => KeyShape::Setting,
		FieldKey::SessionRename(_) => KeyShape::SessionRename,
		FieldKey::Keybinding(_) => KeyShape::Keybinding,
		FieldKey::TaskPrompt => KeyShape::TaskPrompt,
		FieldKey::ProcessCommand => KeyShape::ProcessCommand,
		FieldKey::ProcessInput => KeyShape::ProcessInput,
		FieldKey::SettingsQuery => KeyShape::SettingsQuery,
		FieldKey::ProfileName => KeyShape::ProfileName,
		FieldKey::ShareLink => KeyShape::ShareLink,
	}
}

/// One field, the shell it is drawn in, and the text a return on it refuses.
pub struct Case {
	/// The field the seeded surface draws.
	pub key:   FieldKey,
	/// The shell the field is drawn in.
	pub state: ShellState,
	/// What the field is left holding before the return. Empty text is what a
	/// field cleared by the operator holds, which every field but the keymap
	/// one refuses; a keymap field refuses anything that states no chord.
	pub text:  &'static str,
	/// What the attention strip has to say, in full or as its opening, since
	/// a JSON refusal quotes the parser.
	pub says:  &'static str,
	/// What the same field takes, so the refusal it put up is withdrawn on
	/// the frame that takes it rather than left standing over a value that
	/// was accepted.
	pub takes: &'static str,
}

/// Every field that refuses, each seeded in a shell that draws it.
pub fn cases() -> Vec<Case> {
	vec![
		Case {
			key:   FieldKey::AuthSecret,
			state: transport_asks_for_a_secret(),
			text:  "",
			says:  "A secret is required to authenticate",
			takes: "sk-typed-by-the-operator",
		},
		Case {
			key:   FieldKey::Setting(SETTING_KEY.to_owned()),
			state: general_page_holds(SettingKind::Record, json!({})),
			text:  "not json at all",
			says:  "settings.seeded is not valid JSON",
			takes: "{\"seeded\":true}",
		},
		Case {
			key:   FieldKey::SessionRename(fixture::populated().current_id),
			state: ShellState { connection: ConnectionPhase::Attached, ..fixture::populated() },
			text:  "",
			says:  "A session name cannot be empty",
			takes: "A name the operator typed",
		},
		Case {
			key:   FieldKey::Keybinding(BOUND_ACTION.to_owned()),
			state: keybindings_page_binds(BOUND_ACTION, &["ctrl-enter"]),
			// Modifiers with no key after them: the keymap grammar reads no
			// chord out of it, so no key press would ever match what it would
			// have been bound to.
			text:  "ctrl-",
			says:  "shell::Submit needs at least one chord",
			takes: "ctrl-enter",
		},
		Case {
			key:   FieldKey::Keybinding(BOUND_ACTION.to_owned()),
			state: keybindings_page_binds(BOUND_ACTION, &["ctrl-enter"]),
			// Modifiers spelled apart: one token of the grammar carries no
			// space inside it, so this states no chord either.
			text:  "ctrl alt",
			says:  "shell::Submit needs at least one chord",
			takes: "ctrl-enter, cmd-enter",
		},
		Case {
			key:   FieldKey::TaskPrompt,
			// The Agents page is the one that draws the task field, and a
			// field the surface never drew takes no return.
			state: settings_page_open(SettingsPage::Extensions),
			text:  "",
			says:  "A task needs a description to run",
			takes: "Read the tokens and report what is unauthored",
		},
		Case {
			key:   FieldKey::ProcessCommand,
			// The supervisor's tab is the one that draws the command field,
			// and it is offered before anything is running, which is the
			// state the first process is started from.
			state: supervisor_tab_open(),
			text:  "",
			says:  "A process needs a command to run",
			takes: "bun run dev",
		},
		Case {
			key:   FieldKey::ProfileName,
			// The Profiles page draws the one field a create and a rename
			// both read, and it draws it whether or not the host has listed
			// a profile yet.
			state: settings_page_open(SettingsPage::Profiles),
			text:  "",
			says:  "A new profile needs a name",
			takes: "review",
		},
		Case {
			key:   FieldKey::ProcessInput,
			// A row's `Send` is the only thing that reads this field, so the
			// state that draws it is a supervisor with a process running in
			// it.
			state: supervisor_tab_running(),
			text:  "",
			says:  "Sending to a process needs something to send",
			takes: "y",
		},
		Case {
			key:   FieldKey::ShareLink,
			// The share card draws the link field only while the window is
			// hosting nothing, which is the state a join is reached from.
			state: share_card_open(),
			text:  "",
			says:  "A link is required to join a share",
			takes: "https://relay.example/s/abc123",
		},
	]
}

/// Focuses the editor the drawn surface registered under `key` and leaves it
/// holding `text`, so the return that follows submits exactly that.
pub fn hold(session: &mut HeadlessSession<'_, ShellView>, key: &FieldKey, text: &str) {
	let key = key.clone();
	let text = text.to_owned();
	session
		.update(move |view, window, cx| {
			let editor = view.retained_field(&key).unwrap_or_else(|| {
				panic!("the drawn surface registered no editor under {key:?}, which it holds")
			});
			let focus = editor.read(cx).focus_handle().clone();
			window.focus(&focus, cx);
			editor.update(cx, |editor, cx| editor.set_text(text, cx));
		})
		.expect("the field takes focus and the text it is asked to hold");
}
