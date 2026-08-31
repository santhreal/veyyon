//! Page routing for backend-published setting definitions.

use gpui::{AnyElement, App, IntoElement, ParentElement};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		Capability, CapabilityStatus, CommandState, SettingDefinition, SettingsState, Versioned,
	},
	navigation::SettingsPage,
};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Banner, Empty, Icon, text},
};

use super::{fields, registry, remote};

pub fn render(store: &Store, page: SettingsPage, cx: &mut App) -> AnyElement {
	render_with_heading(store, page, true, cx)
}

pub fn render_embedded(store: &Store, page: SettingsPage, cx: &mut App) -> AnyElement {
	render_with_heading(store, page, false, cx)
}

fn render_with_heading(
	store: &Store,
	page: SettingsPage,
	heading: bool,
	cx: &mut App,
) -> AnyElement {
	match store.replica.capability(Capability::Settings) {
		CapabilityStatus::Unavailable { reason } => {
			return Empty::new("Settings are unavailable")
				.icon(Icon::Settings)
				.note(reason.clone())
				.filling()
				.into_any_element();
		},
		CapabilityStatus::UnknownUntilAttached if store.connection.is_connected() => {
			return Empty::new("Settings capability was not advertised")
				.icon(Icon::Settings)
				.note("This host does not report whether profile settings are supported.")
				.filling()
				.into_any_element();
		},
		CapabilityStatus::UnknownUntilAttached | CapabilityStatus::Available => {},
	}
	remote::render(
		&store.replica.settings,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading settings",
			empty:       "No settings were published",
			empty_note:  "This host returned an empty settings schema.",
			detached:    "Profile settings are not loaded",
			unavailable: "Profile settings are unavailable",
		},
		UiCommand::LoadSettings,
		|versioned: &Versioned<SettingsState>, mutable, cx| {
			page_fields(store, &versioned.value, page, heading, mutable, cx)
		},
		cx,
	)
}

fn page_fields(
	store: &Store,
	state: &SettingsState,
	page: SettingsPage,
	heading: bool,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let registration = registry::registration(page);
	let query = store.frontend.settings_filter.trim().to_lowercase();
	let definitions: Vec<&SettingDefinition> = state
		.schema
		.iter()
		.filter(|definition| definition.page == page)
		.filter(|definition| matches_query(definition, &query))
		.collect();
	let theme = Theme::get(cx);
	let mut content = text::stack(space::LOOSE);
	if heading {
		content = content
			.child(text::title(registration.label, &theme))
			.child(text::note_wrapping(registration.summary, &theme));
	}
	if let CommandState::Failed { message, .. } = &state.save {
		content =
			content.child(Banner::failure("Settings could not be saved").detail(message.clone()));
	}
	if definitions.is_empty() {
		return content
			.child(
				Empty::new(if query.is_empty() {
					"No settings in this section"
				} else {
					"No settings match this search"
				})
				.icon(Icon::Search)
				.note(if query.is_empty() {
					"Unsupported conditional fields are hidden."
				} else {
					"Try a label, description, category, group, or setting path."
				}),
			)
			.into_any_element();
	}
	content
		.child(fields::render_groups(store, state, &definitions, mutable, cx))
		.into_any_element()
}

fn matches_query(definition: &SettingDefinition, query: &str) -> bool {
	query.is_empty()
		|| definition.label.to_lowercase().contains(query)
		|| definition.group.to_lowercase().contains(query)
		|| definition.category.to_lowercase().contains(query)
		|| definition.path.0.to_lowercase().contains(query)
		|| definition
			.description
			.as_ref()
			.is_some_and(|description| description.to_lowercase().contains(query))
}
