//! The rows the palette lists and what choosing one does.

use veyyon_desktop_model::{HostAction, SessionId, SurfaceId};
use veyyon_desktop_ui::controls::Kbd;
use veyyon_gpui::{Action, SharedString, Window};

/// The section a row is listed under, in the order the sections are drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Group {
	/// Window actions, host slash commands and host requests.
	Commands,
	/// The subcommands of one command.
	Subcommands,
	/// Sessions of every project.
	Threads,
	/// Workspace files by name.
	Files,
	/// Settings pages.
	Settings,
}

impl Group {
	/// The heading drawn above the section.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Commands => "Commands",
			Self::Subcommands => "Subcommands",
			Self::Threads => "Threads",
			Self::Files => "Files",
			Self::Settings => "Settings",
		}
	}
}

/// What choosing a row does.
#[derive(Clone, Debug)]
pub enum Run {
	/// Dispatches a window action built by the registry.
	Action(fn() -> Box<dyn Action>),
	/// Dispatches a window action that carries data.
	ActionWith(ActionData),
	/// Queues a host request on behalf of a control.
	Host(HostAction, SurfaceId),
	/// Runs a slash command line in the session the window shows.
	Command(String),
	/// Asks for the argument of a slash command, then runs it.
	Argument {
		/// The command line the argument is appended to.
		line: String,
		/// What the command expects, shown as the input's placeholder.
		hint: String,
	},
	/// Lists the subcommands of the command with this name.
	Subcommands(String),
	/// Opens a session.
	OpenSession(SessionId),
	/// Creates a session in a directory, or in the host's for `None`.
	CreateSession(Option<String>),
	/// Asks the platform for a directory and creates a session in it.
	CreateSessionInFolder,
}

/// A window action with data, built when the row is chosen.
#[derive(Clone, Debug)]
pub enum ActionData {
	/// Opens settings on a page.
	OpenSettings(SharedString),
	/// Opens a file in the panel, optionally at a one-based line.
	OpenFile {
		/// Workspace-relative path.
		path: String,
		/// One-based line.
		line: Option<u32>,
	},
}

/// The text at the end of a row.
#[derive(Clone, Debug)]
pub enum Hint {
	/// Nothing.
	None,
	/// The shortcut bound to the row's action.
	Shortcut(Kbd),
	/// A short muted word, such as a command's source.
	Text(SharedString),
}

/// One row of the palette.
#[derive(Clone, Debug)]
pub struct Item {
	/// The section it is listed under.
	pub group:   Group,
	/// The primary text.
	pub label:   SharedString,
	/// Secondary text drawn muted after the label.
	pub detail:  Option<SharedString>,
	/// The text at the end of the row.
	pub hint:    Hint,
	/// Extra spellings the query matches, never drawn.
	pub also:    Vec<String>,
	/// Why the host would refuse the row now; a blocked row is drawn muted
	/// and choosing it does nothing.
	pub blocked: Option<SharedString>,
	/// What choosing the row does.
	pub run:     Run,
}

impl Item {
	/// A row with no detail, hint or extra spellings.
	pub fn new(group: Group, label: impl Into<SharedString>, run: Run) -> Self {
		Self {
			group,
			label: label.into(),
			detail: None,
			hint: Hint::None,
			also: Vec::new(),
			blocked: None,
			run,
		}
	}

	/// Sets the detail text.
	pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
		self.detail = Some(detail.into());
		self
	}

	/// Sets the hint.
	pub fn hint(mut self, hint: Hint) -> Self {
		self.hint = hint;
		self
	}

	/// Adds spellings the query matches.
	pub fn also(mut self, also: impl IntoIterator<Item = String>) -> Self {
		self.also.extend(also);
		self
	}

	/// Marks the row blocked for `reason`.
	pub fn blocked(mut self, reason: Option<SharedString>) -> Self {
		self.blocked = reason;
		self
	}

	/// The texts the query is matched against: the label and the extra
	/// spellings. The detail is prose, and a short query is a subsequence of
	/// almost any sentence.
	pub fn targets(&self) -> impl Iterator<Item = &str> {
		std::iter::once(self.label.as_ref()).chain(self.also.iter().map(String::as_str))
	}
}

/// The shortcut the window's keymap binds to `action`, spelled for the
/// platform.
pub fn shortcut(action: &dyn Action, window: &Window) -> Hint {
	let Some(binding) = window.highest_precedence_binding_for_action(action) else {
		return Hint::None;
	};
	let chord = binding
		.keystrokes()
		.iter()
		.map(|keystroke| keystroke.inner().unparse())
		.collect::<Vec<_>>()
		.join(" ");
	Kbd::chord(&chord).map_or(Hint::None, Hint::Shortcut)
}
