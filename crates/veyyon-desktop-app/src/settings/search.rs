//! The General page's search: a query narrows the page to the settings whose
//! key, label, description or group holds it, from every tab and from each
//! tab's advanced fold.

use veyyon_desktop_model::SettingEntry;
use veyyon_desktop_ui::theme::ActiveTheme;
use veyyon_gpui::{AnyElement, Context, Window};

use super::{SettingsView, widgets::input_box};

/// The field key of the search input.
pub const QUERY: &str = "settings-query";

impl SettingsView {
	/// The query typed into the search input, lowercased; empty when none.
	pub(super) fn settings_query(&self, cx: &Context<Self>) -> String {
		self.field_text(QUERY, cx).to_lowercase()
	}

	/// The search input, which redraws the page on each edit.
	pub(super) fn search_box(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let input = self.live_field(QUERY, "Search settings", redraw, window, cx);
		input_box(QUERY, input, &palette)
	}
}

fn redraw(
	_: &mut SettingsView,
	_: &str,
	_: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	cx.notify();
}

/// Whether the lowercased `query` is empty or held by the key, label,
/// description or group of the setting `key`.
pub fn matches(key: &str, entry: &SettingEntry, query: &str) -> bool {
	let holds = |text: &str| text.to_lowercase().contains(query);
	query.is_empty()
		|| holds(key)
		|| [&entry.label, &entry.description, &entry.group]
			.into_iter()
			.flatten()
			.any(|text| holds(text))
}
