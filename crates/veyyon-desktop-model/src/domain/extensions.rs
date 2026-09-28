//! What the host discovers besides the agent itself: extension modules,
//! skills, hooks, rules and the other items its sources provide, and the
//! sources that provide them.

use serde::{Deserialize, Serialize};

/// What a discovered item is, spelled as the host spells it in the item's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionKind {
	ExtensionModule,
	Skill,
	Rule,
	Tool,
	Mcp,
	Prompt,
	Instruction,
	ContextFile,
	Hook,
	SlashCommand,
}

/// Where an item was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionLevel {
	/// The user's configuration, shared by every workspace.
	User,
	/// The workspace the host runs in.
	Project,
	/// Shipped with the host.
	Native,
}

/// Whether the host loads an item, and what withholds it when it does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum ExtensionState {
	/// Loaded.
	Active,
	/// Switched off by its own toggle, which `SetExtensionEnabled` flips.
	Disabled,
	/// Its source is switched off, which `SetExtensionSourceEnabled` flips.
	SourceDisabled,
	/// Another item of the same kind and name is loaded in its place.
	Shadowed,
}

/// One discovered item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionItemView {
	/// `<kind>:<name>`, the id `SetExtensionEnabled` names.
	pub id:          String,
	pub kind:        ExtensionKind,
	pub name:        String,
	pub description: Option<String>,
	/// The slash command, glob or pattern that brings the item in.
	pub trigger:     Option<String>,
	/// File the item was read from.
	pub path:        String,
	/// Id of the source that provides it.
	pub source:      String,
	pub level:       ExtensionLevel,
	pub state:       ExtensionState,
	/// The item loaded in its place, when it is shadowed.
	pub shadowed_by: Option<String>,
}

/// A source the host discovers items from, such as another agent's
/// configuration directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionSourceView {
	/// The id `SetExtensionSourceEnabled` names.
	pub id:      String,
	pub name:    String,
	/// Whether the host reads it. A source switched off withholds every item
	/// it provides.
	pub enabled: bool,
}

/// Every item the host discovers for its workspace, with the sources they
/// come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct ExtensionsView {
	pub sources: Vec<ExtensionSourceView>,
	pub items:   Vec<ExtensionItemView>,
}
