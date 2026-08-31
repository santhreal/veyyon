//! Search, grouping, and windowing for the model catalog.

use std::collections::BTreeSet;

use veyyon_gui_core::model::{Availability, ModelCatalogState, ModelId, ModelOption, ProviderId};

/// A stable row in a searchable model list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelRow<'a> {
	pub model:    &'a ModelOption,
	pub current:  bool,
	pub favorite: bool,
}

/// The retained visible interval of a virtual list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualWindow {
	pub first: usize,
	pub rows:  usize,
}

impl VirtualWindow {
	pub fn bounds(self, len: usize) -> std::ops::Range<usize> {
		let start = self.first.min(len);
		start..start.saturating_add(self.rows).min(len)
	}
}

/// Matches the display name, model id, or provider-instance id.
pub fn matches(model: &ModelOption, query: &str) -> bool {
	let query = query.trim();
	query.is_empty()
		|| model.name.to_lowercase().contains(&query.to_lowercase())
		|| model
			.id
			.as_str()
			.to_lowercase()
			.contains(&query.to_lowercase())
		|| model
			.provider
			.as_str()
			.to_lowercase()
			.contains(&query.to_lowercase())
}

/// Builds only the visible interval after filtering. Catalog order is retained.
pub fn visible_rows<'a>(
	state: &'a ModelCatalogState,
	query: &str,
	provider: Option<&ProviderId>,
	favorites: &'a BTreeSet<(ProviderId, ModelId)>,
	window: VirtualWindow,
) -> Vec<ModelRow<'a>> {
	let Some(models) = state.models.readable() else {
		return Vec::new();
	};
	let filtered = models.iter().filter(|model| {
		provider.is_none_or(|provider| &model.provider == provider) && matches(model, query)
	});
	let range = window.bounds(filtered.clone().count());
	filtered
		.skip(range.start)
		.take(range.len())
		.map(|model| {
			let pair = (&model.provider, &model.id);
			ModelRow {
				model,
				current: state
					.selected
					.as_ref()
					.is_some_and(|(provider, id)| pair == (provider, id)),
				favorite: favorites.contains(&(model.provider.clone(), model.id.clone())),
			}
		})
		.collect()
}

/// Resolves only an exact provider-instance and model pair.
///
/// A missing current selection stays missing rather than falling through to a
/// similarly named model from another provider instance.
pub fn exact_model<'a>(
	state: &'a ModelCatalogState,
	provider: &ProviderId,
	model: &ModelId,
) -> Option<&'a ModelOption> {
	state
		.models
		.readable()?
		.iter()
		.find(|candidate| &candidate.provider == provider && &candidate.id == model)
}

pub fn unavailable_reason(model: &ModelOption) -> Option<&str> {
	match &model.availability {
		Availability::Available => None,
		Availability::Unavailable { reason } => Some(reason),
	}
}
