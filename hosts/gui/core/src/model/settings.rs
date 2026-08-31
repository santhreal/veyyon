//! Serializable engine settings plus frontend edit projections.

use super::{CommandState, ModelId, ProviderId, Value};

#[derive(
	Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct SettingPath(pub String);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SettingEditor {
	Toggle,
	Stepper,
	Slider,
	Text,
	Select,
	MultiSelect,
	KeyCapture,
	ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SettingKind {
	Boolean,
	Integer,
	Number,
	String,
	Choice,
	StringList,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SettingDefinition {
	pub path:               SettingPath,
	pub label:              String,
	pub page:               crate::navigation::SettingsPage,
	pub category:           String,
	pub visible:            bool,
	pub editor:             SettingEditor,
	pub minimum:            Option<Value>,
	pub maximum:            Option<Value>,
	pub step:               Option<Value>,
	pub read_only:          bool,
	pub description:        Option<String>,
	pub group:              String,
	pub kind:               SettingKind,
	pub default:            Value,
	pub choices:            Vec<Value>,
	pub secret:             bool,
	pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SettingValueView {
	pub path:       SettingPath,
	pub value:      Value,
	pub provenance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SettingsState {
	pub schema:           Vec<SettingDefinition>,
	pub effective_values: Vec<SettingValueView>,
	pub validation:       Vec<(SettingPath, String)>,
	pub save:             CommandState,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThemeState {
	pub available: Vec<ThemeView>,
	pub selected:  Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThemeView {
	pub id:   String,
	pub name: String,
	pub dark: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeybindingView {
	pub command: String,
	pub chord:   String,
	pub source:  String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeybindingConflict {
	pub chord:    String,
	pub commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct KeybindingState {
	pub definitions: Vec<KeybindingView>,
	pub effective:   Vec<KeybindingView>,
	pub conflicts:   Vec<KeybindingConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FavoriteModel {
	pub provider: ProviderId,
	pub model:    ModelId,
}
