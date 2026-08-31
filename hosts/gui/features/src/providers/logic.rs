//! Provider-instance filtering and status presentation decisions.

use veyyon_gui_core::model::{AccountView, AuthState, ProviderId, ProviderView};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualWindow {
	pub first: usize,
	pub rows:  usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderStatus<'a> {
	Ready,
	AuthRequired,
	Unavailable(&'a str),
	Failed(&'a str),
}

pub fn status(provider: &ProviderView) -> ProviderStatus<'_> {
	if let Some(error) = provider.error.as_deref() {
		ProviderStatus::Failed(error)
	} else if !provider.authenticated {
		ProviderStatus::AuthRequired
	} else if !provider.available {
		ProviderStatus::Unavailable(provider.status.as_deref().unwrap_or("Unavailable"))
	} else {
		ProviderStatus::Ready
	}
}

pub fn matches(provider: &ProviderView, query: &str) -> bool {
	let query = query.trim().to_lowercase();
	query.is_empty()
		|| provider.name.to_lowercase().contains(&query)
		|| provider.id.as_str().to_lowercase().contains(&query)
}

pub fn filtered<'a>(
	auth: &'a AuthState,
	query: &str,
	window: VirtualWindow,
) -> Vec<&'a ProviderView> {
	auth
		.providers
		.readable()
		.into_iter()
		.flatten()
		.filter(|provider| matches(provider, query))
		.skip(window.first)
		.take(window.rows)
		.collect()
}

pub fn accounts_for<'a>(auth: &'a AuthState, provider: &ProviderId) -> Vec<&'a AccountView> {
	auth
		.accounts
		.readable()
		.into_iter()
		.flatten()
		.filter(|account| &account.provider == provider)
		.collect()
}
