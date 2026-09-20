//! The slash commands the host can run, as it advertises them (§5.8).
//!
//! The window does not decide which commands exist. A command is a builtin the
//! agent can drive without a terminal, a skill, an extension contribution, a
//! project command file or an MCP prompt, and only the host knows which of
//! those are installed in the workspace it opened. The catalogue therefore
//! arrives as a snapshot section and the palette ranks what it holds, so a
//! workspace that adds a command file gets a row for it without a release.

use serde::{Deserialize, Serialize};

/// Where a command came from, which the palette states so two rows with one
/// name are told apart.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, strum::EnumIter,
)]
pub enum CommandSource {
	/// Declared by the agent itself.
	Builtin,
	/// A skill's invocation command.
	Skill,
	/// Contributed by an extension.
	Extension,
	/// A command file in the project or the profile.
	Custom,
	/// A prompt an MCP server offers.
	McpPrompt,
	/// A prompt file the workspace or the profile declares.
	File,
}

impl CommandSource {
	/// The one word a row draws for this source.
	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Builtin => "builtin",
			Self::Skill => "skill",
			Self::Extension => "extension",
			Self::Custom => "project",
			Self::McpPrompt => "mcp",
			Self::File => "file",
		}
	}
}

/// One subcommand of a command that has them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSubcommandView {
	pub name:        String,
	pub description: Option<String>,
	/// How the subcommand is spelled with its arguments, when it takes any.
	pub usage:       Option<String>,
}

/// One command the host will run when it is sent back as a `RunCommand`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandView {
	/// The name without its leading slash, as `RunCommand` spells it.
	pub name:        String,
	/// Every other spelling that reaches the same command.
	pub aliases:     Vec<String>,
	pub description: Option<String>,
	/// What the command expects after its name, for the commands that take
	/// arguments; a command that takes none has no hint.
	pub input_hint:  Option<String>,
	pub source:      CommandSource,
	pub subcommands: Vec<CommandSubcommandView>,
}

impl CommandView {
	/// Whether `query` reaches this command by its name or one of its
	/// aliases, ignoring case, which is how the palette matches a typed
	/// command word (§5.8).
	#[must_use]
	pub fn answers_to(&self, query: &str) -> bool {
		self.name.eq_ignore_ascii_case(query)
			|| self
				.aliases
				.iter()
				.any(|alias| alias.eq_ignore_ascii_case(query))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn view(name: &str, aliases: &[&str]) -> CommandView {
		CommandView {
			name:        name.to_owned(),
			aliases:     aliases.iter().map(|a| (*a).to_owned()).collect(),
			description: None,
			input_hint:  None,
			source:      CommandSource::Builtin,
			subcommands: Vec::new(),
		}
	}

	#[test]
	fn a_command_answers_to_its_name_and_its_aliases_in_any_case() {
		let model = view("model", &["models"]);
		assert!(model.answers_to("model"));
		assert!(model.answers_to("MODEL"));
		assert!(model.answers_to("models"));
		assert!(!model.answers_to("modell"));
		assert!(!model.answers_to(""));
	}
}
