use serde::{Deserialize, Serialize};

/// Reference identifying a provider and model pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
	/// Provider identifier (e.g. "anthropic", "openai").
	pub provider: String,
	/// Model identifier.
	pub id:       String,
}

/// One kind of input a model accepts, as the catalog declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputModality {
	Text,
	Image,
	Video,
	/// A modality this build does not know (the catalog also lists `audio`
	/// and `pdf`); kept so one new upstream value never fails a snapshot.
	#[serde(other)]
	Other,
}

/// Detailed model capabilities and token window bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelView {
	/// Provider identifier.
	pub provider:       String,
	/// Model identifier.
	pub id:             String,
	/// Human-readable model display name.
	pub name:           String,
	/// Flag indicating whether the model supports extended reasoning.
	pub reasoning:      bool,
	/// Maximum context window size in tokens.
	pub context_window: u64,
	/// Maximum generation output limit in tokens.
	pub max_output:     u64,
	/// Input modalities the model accepts. Empty when the host did not say,
	/// which a consumer treats as unknown rather than as text-only. Absent
	/// stays absent on the wire so a snapshot round-trips byte-for-byte.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub input:          Vec<InputModality>,
}

impl ModelView {
	/// Whether the model is known to accept `modality`. `None` when the host
	/// reported no modalities at all, so a caller can tell "unsupported" from
	/// "unknown".
	#[must_use]
	pub fn accepts(&self, modality: InputModality) -> Option<bool> {
		if self.input.is_empty() {
			return None;
		}
		Some(self.input.contains(&modality))
	}
}

/// Available models, current model selection, and thinking configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelsView {
	/// List of all available models.
	pub models:          Vec<ModelView>,
	/// Currently selected model reference.
	pub current:         Option<ModelRef>,
	/// Active thinking or reasoning effort level.
	pub thinking_level:  Option<String>,
	/// Supported thinking effort levels for the current model.
	pub thinking_levels: Vec<String>,
}
