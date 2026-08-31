//! Search and category decisions for contributed capabilities.

use veyyon_gui_core::model::{
	DiscoveredCapabilityView, ExtensionRegistryState, ExtensionView, SlashCommandView,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
	Extensions,
	Plugins,
	Commands,
	Skills,
	Tools,
	Failures,
}

impl Category {
	pub const ALL: [Category; 6] = [
		Category::Extensions,
		Category::Plugins,
		Category::Commands,
		Category::Skills,
		Category::Tools,
		Category::Failures,
	];

	pub fn label(self) -> &'static str {
		match self {
			Category::Extensions => "Extensions",
			Category::Plugins => "Plugins",
			Category::Commands => "Commands",
			Category::Skills => "Skills",
			Category::Tools => "Tools",
			Category::Failures => "Load failures",
		}
	}
}

fn contains(value: &str, query: &str) -> bool {
	query.trim().is_empty() || value.to_lowercase().contains(&query.trim().to_lowercase())
}

pub fn extensions<'a>(
	state: &'a ExtensionRegistryState,
	category: Category,
	query: &str,
) -> Vec<&'a ExtensionView> {
	let values = match category {
		Category::Extensions => &state.extensions,
		Category::Plugins => &state.plugins,
		Category::Commands | Category::Skills | Category::Tools | Category::Failures => {
			return Vec::new();
		},
	};
	values
		.iter()
		.filter(|item| contains(&item.name, query) || contains(&item.source, query))
		.collect()
}

pub fn commands<'a>(state: &'a ExtensionRegistryState, query: &str) -> Vec<&'a SlashCommandView> {
	state
		.commands
		.iter()
		.filter(|command| {
			contains(&command.name, query)
				|| contains(&command.description, query)
				|| command.aliases.iter().any(|alias| contains(alias, query))
		})
		.collect()
}

pub fn capabilities<'a>(
	state: &'a ExtensionRegistryState,
	category: Category,
	query: &str,
) -> Vec<&'a DiscoveredCapabilityView> {
	let values = match category {
		Category::Skills => &state.skills,
		Category::Tools => &state.tools,
		_ => return Vec::new(),
	};
	values
		.iter()
		.filter(|cap| {
			contains(&cap.name, query)
				|| contains(&cap.source, query)
				|| contains(&cap.id, query)
				|| cap
					.description
					.as_deref()
					.is_some_and(|d| contains(d, query))
		})
		.collect()
}
