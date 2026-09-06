use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The type tag a setting is declared with in the host's schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingKind {
	Boolean,
	String,
	ModelChain,
	Number,
	Enum,
	Array,
	Record,
}

/// One choice a setting offers, with the copy the settings screen shows for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingOption {
	/// The value written when the option is chosen.
	pub value:       String,
	/// Display label.
	pub label:       String,
	/// One-line description, when the schema has one.
	#[serde(default)]
	pub description: Option<String>,
}

/// One setting as the host reports it: the effective value, where it came
/// from, the schema it is declared with, and the copy the settings screen
/// shows.
///
/// Every field past `source` defaults, so a host that reports only the value
/// triple still decodes; such an entry renders under its key with no
/// description and no choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingEntry {
	/// The effective value.
	pub value:       serde_json::Value,
	/// The schema default.
	pub default:     serde_json::Value,
	/// Where the effective value came from (e.g. "default", "profile",
	/// "project").
	pub source:      String,
	/// The declared type.
	#[serde(rename = "type", default = "SettingKind::default_kind")]
	pub kind:        SettingKind,
	/// Display label; absent when the setting declares no UI block.
	#[serde(default)]
	pub label:       Option<String>,
	/// One-line description.
	#[serde(default)]
	pub description: Option<String>,
	/// The settings tab the entry is filed under.
	#[serde(default)]
	pub tab:         Option<String>,
	/// The group within the tab.
	#[serde(default)]
	pub group:       Option<String>,
	/// The values an `Enum` setting accepts, in declaration order.
	#[serde(default)]
	pub values:      Vec<String>,
	/// The choices offered with labels; empty when the setting is free-form.
	#[serde(default)]
	pub options:     Vec<SettingOption>,
	/// Inclusive lower bound of a `Number` setting.
	#[serde(default)]
	pub min:         Option<serde_json::Number>,
	/// Inclusive upper bound of a `Number` setting.
	#[serde(default)]
	pub max:         Option<serde_json::Number>,
	/// Whether the value is cross-profile rather than per-profile.
	#[serde(default)]
	pub global:      bool,
	/// Whether the setting belongs in the tab's collapsed advanced fold.
	#[serde(default)]
	pub advanced:    bool,
	/// Whether the setting is machine-written or retired and is not a row.
	#[serde(default)]
	pub hidden:      bool,
}

impl SettingKind {
	const fn default_kind() -> Self {
		Self::String
	}
}

/// Every setting the host reports, keyed by its dotted schema key.
pub type SettingsView = BTreeMap<String, SettingEntry>;
