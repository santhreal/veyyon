//! The Extensions page: the sources the host discovers items from, each with
//! a switch, and every item it found, grouped by kind, each with its own
//! switch and what withholds it when it is not loaded.

use std::collections::BTreeMap;

use veyyon_desktop_model::{
	HostAction, SurfaceId,
	action::ExtensionsRequest,
	domain::{ExtensionItemView, ExtensionKind, ExtensionLevel, ExtensionState, ExtensionsView},
};
use veyyon_desktop_ui::{controls::ButtonVariant, theme::ActiveTheme};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, div, prelude::*};

use super::{
	Page, SettingsView,
	widgets::{heading, note, row, send_button, switch, title},
};

impl SettingsView {
	pub(super) fn extensions(&self, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let refresh = send_button(
			"extensions-refresh",
			"Refresh",
			ButtonVariant::Ghost,
			HostAction::Extensions(ExtensionsRequest::RefreshExtensions),
			SurfaceId::SettingsField("extensions:refresh".to_owned()),
			&self.app,
			cx,
		);
		let mut page = div()
			.child(title(Page::Extensions.label(), Page::Extensions.description(), &palette))
			.child(refresh);
		let Some(view) = self.app.read(cx).store().domains.extensions.clone() else {
			return page
				.child(note("Loading extensions from the host…", &palette))
				.into_any_element();
		};
		page = page.child(heading("Sources", &palette));
		if view.sources.is_empty() {
			page = page.child(note("No sources", &palette));
		}
		for source in &view.sources {
			let id = source.id.clone();
			let toggle = switch(
				SharedString::from(format!("extension-source-switch-{}", source.id)),
				source.enabled,
				false,
				move |enabled| {
					let request =
						ExtensionsRequest::SetExtensionSourceEnabled { source: id.clone(), enabled };
					(
						HostAction::Extensions(request),
						SurfaceId::SettingsField(format!("extension-source:{id}")),
					)
				},
				&self.app,
				cx,
			);
			page = page.child(row(
				SharedString::from(format!("extension-source-{}", source.id)),
				source.name.clone(),
				None,
				toggle,
				&palette,
			));
		}
		let mut kinds: BTreeMap<u8, (ExtensionKind, Vec<&ExtensionItemView>)> = BTreeMap::new();
		for item in &view.items {
			kinds
				.entry(kind_order(item.kind))
				.or_insert_with(|| (item.kind, Vec::new()))
				.1
				.push(item);
		}
		if view.items.is_empty() {
			page = page
				.child(heading("Items", &palette))
				.child(note("Nothing discovered", &palette));
		}
		for (kind, items) in kinds.into_values() {
			page = page.child(heading(kind_label(kind), &palette));
			for item in items {
				let toggle = switch(
					SharedString::from(format!("extension-switch-{}", item.id)),
					matches!(item.state, ExtensionState::Active | ExtensionState::Shadowed),
					item.state == ExtensionState::Shadowed,
					{
						let id = item.id.clone();
						move |enabled| {
							let request =
								ExtensionsRequest::SetExtensionEnabled { id: id.clone(), enabled };
							(
								HostAction::Extensions(request),
								SurfaceId::SettingsField(format!("extension:{id}")),
							)
						}
					},
					&self.app,
					cx,
				);
				page = page.child(row(
					SharedString::from(format!("extension-{}", item.id)),
					item.name.clone(),
					Some(detail(item, &view).into()),
					toggle,
					&palette,
				));
			}
		}
		page.into_any_element()
	}
}

/// What the row under an item's name states: its description, what brings it
/// in, where it was found, the source that provides it, and its state.
pub fn detail(item: &ExtensionItemView, view: &ExtensionsView) -> String {
	let level = match item.level {
		ExtensionLevel::User => "User",
		ExtensionLevel::Project => "Project",
		ExtensionLevel::Native => "Built in",
	};
	let source = view
		.sources
		.iter()
		.find(|source| source.id == item.source)
		.map_or(item.source.as_str(), |source| source.name.as_str());
	let state = match item.state {
		ExtensionState::Active => "Active".to_owned(),
		ExtensionState::Disabled => "Disabled".to_owned(),
		ExtensionState::SourceDisabled => "Source off".to_owned(),
		ExtensionState::Shadowed => {
			format!("Shadowed by {}", item.shadowed_by.as_deref().unwrap_or("another item"))
		},
	};
	[item.description.as_deref(), item.trigger.as_deref(), Some(level), Some(source), Some(&state)]
		.into_iter()
		.flatten()
		.filter(|part| !part.is_empty())
		.collect::<Vec<_>>()
		.join(" · ")
}

/// Kinds in the order the terminal's `/extensions` dashboard lists them.
const fn kind_order(kind: ExtensionKind) -> u8 {
	match kind {
		ExtensionKind::ExtensionModule => 0,
		ExtensionKind::Skill => 1,
		ExtensionKind::Tool => 2,
		ExtensionKind::SlashCommand => 3,
		ExtensionKind::Rule => 4,
		ExtensionKind::Mcp => 5,
		ExtensionKind::Hook => 6,
		ExtensionKind::Prompt => 7,
		ExtensionKind::ContextFile => 8,
		ExtensionKind::Instruction => 9,
	}
}

const fn kind_label(kind: ExtensionKind) -> &'static str {
	match kind {
		ExtensionKind::ExtensionModule => "Extension modules",
		ExtensionKind::Skill => "Skills",
		ExtensionKind::Rule => "Rules",
		ExtensionKind::Tool => "Tools",
		ExtensionKind::Mcp => "MCP servers",
		ExtensionKind::Prompt => "Prompts",
		ExtensionKind::Instruction => "Instructions",
		ExtensionKind::ContextFile => "Context files",
		ExtensionKind::Hook => "Hooks",
		ExtensionKind::SlashCommand => "Slash commands",
	}
}
