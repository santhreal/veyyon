//! Display-safe model, provider, account, and authentication replicas.

use super::{AccountId, CommandState, ModelId, ProviderId, RemoteData};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModelOption {
	pub id:                ModelId,
	pub provider:          ProviderId,
	pub name:              String,
	pub context_window:    Option<u64>,
	pub reasoning:         bool,
	pub thinking_mode:     Option<String>,
	pub supported_efforts: Vec<String>,
	pub default_effort:    Option<String>,
	pub input_modalities:  Vec<String>,
	pub tool_support:      Option<bool>,
	pub availability:      Availability,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Availability {
	Available,
	Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProviderView {
	pub id:            ProviderId,
	pub name:          String,
	pub available:     bool,
	pub authenticated: bool,
	pub status:        Option<String>,
	pub error:         Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThinkingSelection {
	pub configured:        Option<String>,
	pub effective:         Option<String>,
	pub supported_efforts: Vec<String>,
	pub default:           Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ModelCatalogState {
	pub models:   RemoteData<Vec<ModelOption>>,
	pub selected: Option<(ProviderId, ModelId)>,
	pub thinking: ThinkingSelection,
	pub refresh:  CommandState,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AccountView {
	pub id:       AccountId,
	pub provider: ProviderId,
	pub label:    String,
	pub selected: bool,
	pub status:   String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AuthFlowState {
	Starting,
	AwaitingBrowser {
		url:          String,
		launch_url:   Option<String>,
		instructions: Option<String>,
	},
	AwaitingSecretInput,
	AwaitingCallback,
	Succeeded,
	Failed {
		message: String,
	},
	Cancelled,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AuthState {
	pub providers:     RemoteData<Vec<ProviderView>>,
	pub accounts:      RemoteData<Vec<AccountView>>,
	pub flow_provider: Option<ProviderId>,
	pub flow:          Option<AuthFlowState>,
}
