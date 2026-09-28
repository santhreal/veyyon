//! The General page: every setting the host's schema declares, filed by its
//! tab and group as the terminal files them, one tab at a time with its
//! advanced settings folded, or every match of a search.

use std::collections::BTreeMap;

use serde_json::Value;
use veyyon_desktop_model::{HostAction, SettingEntry, SettingKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::{ButtonVariant, Tooltip, hover_transition},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*};

use super::{
	SettingsView,
	search::matches,
	targets,
	values::{submit_setting, value_text},
	widgets::{heading, input_box, local_button, note, row, switch, title},
};
use crate::palette::refusal_kind;

/// Settings with no tab are filed under this one.
const UNFILED: &str = "general";

/// The visible settings by tab, then group, then key.
type Tabs<'a> = BTreeMap<String, BTreeMap<String, Vec<(&'a String, &'a SettingEntry)>>>;

impl SettingsView {
	pub(super) fn general(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let Some(mut settings) = self.app.read(cx).store().domains.settings.clone() else {
			return div()
				.child(title("General", super::Page::General.description(), &palette))
				.child(note("Loading settings from the host…", &palette))
				.into_any_element();
		};
		self.held.settings(&mut settings);
		let query = self.settings_query(cx);
		let searching = !query.is_empty();
		let tabs = tabs(&settings, &query);
		// An anchor `<tab>` or `<tab>/<group>` picks the tab it names.
		if let Some(anchor) = &self.anchor {
			let named = anchor
				.split_once('/')
				.map_or_else(|| anchor.as_ref(), |(tab, _)| tab);
			if tabs.contains_key(named) {
				self.tab = Some(named.to_owned());
			}
		}
		let tab = self
			.tab
			.clone()
			.filter(|tab| tabs.contains_key(tab))
			.or_else(|| tabs.keys().next().cloned())
			.unwrap_or_else(|| UNFILED.to_owned());
		let blocked =
			refusal_kind(self.app.read(cx), veyyon_desktop_model::HostActionKind::SetSetting);
		let mut page = div()
			.child(title("General", super::Page::General.description(), &palette))
			.child(div().pt(space::S2).child(self.search_box(window, cx)));
		if !searching {
			page = page.child(Self::tab_strip(tabs.keys(), &tab, &palette, cx));
		}
		if let Some(reason) = &blocked {
			page = page.child(note(reason.clone(), &palette));
		}
		if tabs.is_empty() {
			let empty = if searching {
				format!("No setting matches “{query}”")
			} else if settings.is_empty() {
				"The host reported no settings".to_owned()
			} else {
				"Every setting the host reported is hidden".to_owned()
			};
			page = page.child(note(empty, &palette));
		}
		// A search lists what it found on every tab, advanced settings too.
		let shown: Vec<_> = if searching {
			tabs.iter().collect()
		} else {
			tabs.get_key_value(&tab).into_iter().collect()
		};
		let unfolded = searching || self.advanced.contains(&tab);
		let mut has_advanced = false;
		for (tab_name, groups) in shown {
			for (group, entries) in groups {
				let listed: Vec<_> = entries
					.iter()
					.filter(|(_, entry)| {
						has_advanced |= entry.advanced;
						unfolded || !entry.advanced
					})
					.collect();
				if listed.is_empty() {
					continue;
				}
				let label = if searching {
					format!("{} · {group}", title_case(tab_name))
				} else {
					group.clone()
				};
				let group_heading = heading(label, &palette);
				page = page.child(self.anchored(&format!("{tab_name}/{group}"), group_heading));
				for (key, entry) in listed {
					let control = self.control(key, entry, blocked.is_some(), window, cx);
					page = page.child(self.setting_row(key, entry, control, &palette, cx));
				}
			}
		}
		// The anchor picked the tab once; a tab chosen later stays chosen.
		self.anchor = None;
		if has_advanced && !searching {
			let label = if unfolded {
				"Hide advanced settings"
			} else {
				"Show advanced settings"
			};
			let tab_key = tab.clone();
			page = page.child(div().pt(space::S4).child(local_button(
				"settings-advanced",
				label,
				ButtonVariant::Ghost,
				cx.listener(move |this, _, _, cx| {
					if !this.advanced.remove(&tab_key) {
						this.advanced.insert(tab_key.clone());
					}
					cx.notify();
				}),
			)));
		}
		page.into_any_element()
	}

	fn tab_strip<'a>(
		tabs: impl Iterator<Item = &'a String>,
		current: &str,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let mut strip = div().flex().flex_wrap().gap(space::S1).pt(space::S2);
		for tab in tabs {
			let selected = tab == current;
			let name = tab.clone();
			let id = SharedString::from(format!("settings-tab-{tab}"));
			let chip = div()
				.id(id.clone())
				.px(space::S2_5)
				.h(size::CONTROL_SM)
				.flex()
				.items_center()
				.rounded(radius::MD)
				.type_style(text::SMALL)
				.transition(hover_transition())
				.when(selected, |el| el.bg(palette.bg.selected).text_color(palette.text.primary))
				.when(!selected, |el| {
					el.text_color(palette.text.muted)
						.hover(|el| el.bg(palette.bg.hover))
				})
				.on_click(cx.listener(move |this, _, _, cx| {
					this.tab = Some(name.clone());
					cx.notify();
				}))
				.child(title_case(tab));
			strip = strip.child(targets::target(("settings.control", id), chip));
		}
		strip.into_any_element()
	}

	fn setting_row(
		&self,
		key: &str,
		entry: &SettingEntry,
		control: AnyElement,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let label = entry.label.clone().unwrap_or_else(|| key.to_owned());
		let mut description = entry.description.clone().unwrap_or_default();
		if entry.source != "default" {
			if !description.is_empty() {
				description.push_str(" · ");
			}
			description.push_str("set in ");
			description.push_str(&entry.source);
		}
		if let Some(error) = self.errors.get(key) {
			description = error.to_string();
		}
		let reset = (entry.value != entry.default).then(|| {
			let default = match value_text(&entry.default) {
				text if text.is_empty() => "Default: none".to_owned(),
				text => format!("Default: {text}"),
			};
			let tip = SharedString::from(format!("reset-tip-{key}"));
			let key = key.to_owned();
			let button = local_button(
				SharedString::from(format!("reset-{key}")),
				"Reset",
				ButtonVariant::Ghost,
				cx.listener(move |this, _, _, cx| {
					this.errors.remove(&key);
					this.send(
						HostAction::ResetSetting { key: key.clone() },
						SurfaceId::SettingsField(key.clone()),
						cx,
					);
				}),
			);
			div().id(tip).tooltip(Tooltip::text(default)).child(button)
		});
		let control = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.children(reset)
			.child(control);
		row(
			SharedString::from(format!("setting-{key}")),
			label,
			(!description.is_empty()).then(|| description.into()),
			control.into_any_element(),
			palette,
		)
	}

	/// The control for `entry`: a toggle, a choice per option, or an input
	/// whose Enter sends the parsed value.
	fn control(
		&mut self,
		key: &str,
		entry: &SettingEntry,
		disabled: bool,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		match entry.kind {
			SettingKind::Boolean => {
				let key = key.to_owned();
				let on = entry.value == Value::Bool(true);
				switch(
					SharedString::from(format!("toggle-{key}")),
					on,
					disabled,
					move |on| {
						let action =
							HostAction::SetSetting { key: key.clone(), value: Value::Bool(on) };
						(action, SurfaceId::SettingsField(key.clone()))
					},
					&self.app,
					cx,
				)
			},
			SettingKind::Enum => Self::choices(key, entry, &palette, cx),
			SettingKind::Array if !(entry.options.is_empty() && entry.values.is_empty()) => {
				Self::choices(key, entry, &palette, cx)
			},
			SettingKind::String
			| SettingKind::ModelChain
			| SettingKind::Number
			| SettingKind::Array
			| SettingKind::Record => {
				let input = self.field(key, &value_text(&entry.value), "", submit_setting, window, cx);
				div()
					.w(size::MENU_MIN_WIDTH)
					.child(input_box(key, input, &palette))
					.into_any_element()
			},
		}
	}

	/// One chip per option of an enum setting, the chosen one selected. An
	/// array setting with declared choices takes a chip per choice, selected
	/// while the array holds it, which adds or drops it.
	fn choices(
		key: &str,
		entry: &SettingEntry,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let options: Vec<(String, String)> = if entry.options.is_empty() {
			entry
				.values
				.iter()
				.map(|value| (value.clone(), value.clone()))
				.collect()
		} else {
			entry
				.options
				.iter()
				.map(|option| (option.value.clone(), option.label.clone()))
				.collect()
		};
		let chosen: Vec<&str> = match &entry.value {
			Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
			value => value.as_str().into_iter().collect(),
		};
		let mut chips = div().flex().flex_wrap().justify_end().gap(space::S1);
		for (value, label) in options {
			let selected = chosen.contains(&value.as_str());
			let next = if entry.kind == SettingKind::Array {
				let mut items = entry.value.as_array().cloned().unwrap_or_default();
				if selected {
					items.retain(|item| item.as_str() != Some(value.as_str()));
				} else {
					items.push(Value::String(value.clone()));
				}
				Value::Array(items)
			} else {
				Value::String(value.clone())
			};
			let key = key.to_owned();
			let id = SharedString::from(format!("choice-{key}-{value}"));
			let chip = div()
				.id(id.clone())
				.px(space::S2)
				.h(size::CONTROL_SM)
				.flex()
				.items_center()
				.rounded(radius::MD)
				.border_1()
				.type_style(text::SMALL)
				.transition(hover_transition())
				.when(selected, |el| {
					el.border_color(palette.accent.base)
						.text_color(palette.text.primary)
				})
				.when(!selected, |el| {
					el.border_color(palette.border.subtle)
						.text_color(palette.text.secondary)
						.hover(|el| el.bg(palette.bg.hover))
				})
				.on_click(cx.listener(move |this, _, _, cx| {
					this.send(
						HostAction::SetSetting { key: key.clone(), value: next.clone() },
						SurfaceId::SettingsField(key.clone()),
						cx,
					);
				}))
				.child(label);
			chips = chips.child(targets::target(("settings.control", id), chip));
		}
		chips.into_any_element()
	}
}

/// The visible settings the lowercased `query` matches, by tab then group
/// then key. A setting whose feature is switched off arrives `hidden` from
/// the host, which resolves each setting's condition.
fn tabs<'a>(settings: &'a BTreeMap<String, SettingEntry>, query: &str) -> Tabs<'a> {
	let mut tabs = Tabs::new();
	let listed = settings
		.iter()
		.filter(|(key, entry)| !entry.hidden && matches(key, entry, query));
	for (key, entry) in listed {
		let tab = entry.tab.clone().unwrap_or_else(|| UNFILED.to_owned());
		let group = entry.group.clone().unwrap_or_else(|| title_case(&tab));
		tabs
			.entry(tab)
			.or_default()
			.entry(group)
			.or_default()
			.push((key, entry));
	}
	tabs
}

fn title_case(word: &str) -> String {
	let mut chars = word.chars();
	chars
		.next()
		.map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}
