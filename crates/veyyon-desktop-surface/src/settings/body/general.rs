//! General settings page body rendering (§5.9).

use std::{
	cell::RefCell,
	collections::hash_map::DefaultHasher,
	hash::{Hash, Hasher},
	rc::Rc,
};

use veyyon_desktop_kit::{
	ColorRole, EditorSlot, SearchField, SpacingStep, TextRamp, TokenSet, Tooltip,
};
use veyyon_desktop_model::{SettingsView, SurfaceId};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, Div, ElementId, InteractiveElement, IntoElement, ListAlignment, ListOffset,
	ListState, ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	controls::ControlStates,
	settings::{
		SettingsState,
		body::{
			conditions::{is_setting_condition_met, matches_query},
			general_control::setting_control,
		},
		empty,
		row::{empty_state_row, setting_row_with_secondary},
	},
	shell::fields::FieldSlots,
};

/// Window-local retained list state for the General settings page (§5.9).
#[derive(Clone)]
pub struct GeneralSettingsListState(Rc<RefCell<GeneralSettingsListStateInner>>);

struct GeneralSettingsListStateInner {
	list_state:        ListState,
	visible_keys:      Vec<String>,
	text_fingerprints: Vec<u64>,
	query:             String,
	/// True from a changed query until the sync that lists its rows, which
	/// is where the offset is put back: the splice that lists them moves
	/// whatever offset stood before it.
	query_changed:     bool,
}

impl Default for GeneralSettingsListState {
	fn default() -> Self {
		Self::new()
	}
}

impl GeneralSettingsListState {
	/// Creates a new empty general settings list state.
	#[must_use]
	pub fn new() -> Self {
		let list_state = ListState::new(0, ListAlignment::Top, px(crate::list_overdraw::SETTINGS_PX));
		Self(Rc::new(RefCell::new(GeneralSettingsListStateInner {
			list_state,
			visible_keys: Vec::new(),
			text_fingerprints: Vec::new(),
			query: String::new(),
			query_changed: false,
		})))
	}

	/// Returns a clone of the underlying GPUI `ListState`.
	#[must_use]
	pub fn list_state(&self) -> ListState {
		self.0.borrow().list_state.clone()
	}

	/// Returns the number of visible settings in the list.
	#[must_use]
	pub fn item_count(&self) -> usize {
		self.0.borrow().visible_keys.len()
	}

	/// Returns the visible setting keys snapshot.
	#[must_use]
	pub fn visible_keys(&self) -> Vec<String> {
		self.0.borrow().visible_keys.clone()
	}

	/// Scrolls the list to reveal the setting at `index`.
	pub fn scroll_to_reveal_item(&self, index: usize) {
		self
			.0
			.borrow()
			.list_state
			.scroll_to(ListOffset { item_ix: index, offset_in_item: px(0.0) });
	}

	/// Scrolls the list to reveal the setting with `key`.
	pub fn scroll_to_reveal_key(&self, key: &str) {
		let inner = self.0.borrow();
		if let Some(ix) = inner.visible_keys.iter().position(|k| k == key) {
			inner
				.list_state
				.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.0) });
		}
	}

	/// Sets the active search filter query, and records that the next sync
	/// puts the list back at its first row.
	///
	/// The rows a query leaves are a different set, so the offset the
	/// operator scrolled to in the set before it anchors an item that is no
	/// longer at that index: a page widened by a query that emptied it drew
	/// rows from the middle of the schema rather than the ones it opened
	/// with. The offset is set in `sync` rather than here, because the splice
	/// that lists the new rows moves whatever offset stood before it.
	pub fn set_query(&self, query: String) {
		let mut inner = self.0.borrow_mut();
		if inner.query == query {
			return;
		}
		inner.query = query;
		inner.query_changed = true;
	}

	/// Returns the current search filter query.
	#[must_use]
	pub fn query(&self) -> String {
		self.0.borrow().query.clone()
	}

	/// Clears the search filter query, putting the list back at its first
	/// row the way any other change of the query does.
	pub fn clear_query(&self) {
		self.set_query(String::new());
	}

	/// Synchronizes visible keys and invalidates measurements if text or
	/// visibility changes, while preserving scroll and layout when only values
	/// change.
	pub fn sync(&self, settings: &SettingsView) {
		let mut inner = self.0.borrow_mut();
		let mut new_keys = Vec::new();
		let mut new_fps = Vec::new();
		let query = inner.query.trim().to_lowercase();

		for (key, entry) in settings {
			if entry.hidden {
				continue;
			}
			if !is_setting_condition_met(key, settings) {
				continue;
			}
			if !query.is_empty() && !matches_query(key, entry, &query) {
				continue;
			}
			new_keys.push(key.clone());
			let mut hasher = DefaultHasher::new();
			key.hash(&mut hasher);
			entry.label.hash(&mut hasher);
			entry.description.hash(&mut hasher);
			entry.kind.hash(&mut hasher);
			new_fps.push(hasher.finish());
		}
		let new_count = new_keys.len();
		let old_count = inner.visible_keys.len();

		if new_count != old_count {
			if new_count > old_count {
				inner
					.list_state
					.splice(old_count..old_count, new_count - old_count);
			} else {
				inner.list_state.splice(new_count..old_count, 0);
			}
		}

		for (ix, &fp) in new_fps.iter().enumerate() {
			let key_changed = inner.visible_keys.get(ix) != new_keys.get(ix);
			let fp_changed = inner.text_fingerprints.get(ix) != Some(&fp);
			if key_changed || fp_changed {
				inner.list_state.remeasure_items(ix..ix + 1);
			}
		}

		if inner.query_changed {
			inner.query_changed = false;
			inner
				.list_state
				.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
		}

		inner.visible_keys = new_keys;
		inner.text_fingerprints = new_fps;
	}
}

/// Renders the General configuration settings page rows.
pub fn render_general_page(
	state: &SettingsState,
	list_state_handle: &GeneralSettingsListState,
	fields: &FieldSlots,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	// The sheet states the refusal of any field it draws in one row above the
	// page, which a virtualized list cannot scroll out of sight (§4.4).

	if state.settings.is_empty() {
		// There is nothing to search, so the page draws no field: a query
		// over no schema narrows nothing and the row below states what is
		// missing instead.
		return div()
			.w_full()
			.flex_1()
			.min_h_0()
			.flex()
			.flex_col()
			.gap(px(geometry.row_gap))
			.child(empty_state_row(
				empty::GENERAL_NO_SCHEMA.condition,
				empty::GENERAL_NO_SCHEMA.action,
				geometry,
				tokens,
			));
	}

	list_state_handle.sync(&state.settings);
	let search_bar = query_field(fields, tokens, cx);

	let visible_keys: Rc<[String]> = Rc::from(list_state_handle.visible_keys());
	if visible_keys.is_empty() {
		let (empty_msg, action_msg) = if list_state_handle.query().is_empty() {
			(
				empty::GENERAL_ALL_HIDDEN.condition.to_string(),
				empty::GENERAL_ALL_HIDDEN.action.to_string(),
			)
		} else {
			(
				format!("No settings matching \"{}\"", list_state_handle.query()),
				empty::GENERAL_QUERY_ACTION.to_string(),
			)
		};
		// The field stays drawn over the row that states the empty result:
		// the query is what emptied the page, so editing it is the way out,
		// and a page that took its own field away leaves none.
		return div()
			.w_full()
			.h_full()
			.flex()
			.flex_col()
			.gap(px(geometry.row_gap))
			.child(search_bar)
			.child(empty_state_row(&empty_msg, &action_msg, geometry, tokens));
	}

	let list_state = list_state_handle.list_state();
	let controls_copy = controls.clone();
	let geometry_copy = geometry.clone();
	let tokens_copy = tokens.clone();
	let entity = cx.entity();
	let weak_view = cx.weak_entity();

	let list_el = veyyon_gpui::list(list_state, move |item_ix, window, app| {
		let Some(key) = visible_keys.get(item_ix) else {
			return div().into_any_element();
		};
		// The entry is cloned out of the view, because a text row creates its
		// editor through the same entity and cannot hold a read borrow of it.
		let entry = {
			let view_read = entity.read(app);
			let Some(entry) = view_read.active_settings().and_then(|s| s.entry(key)) else {
				return div().into_any_element();
			};
			entry.clone()
		};
		let entry = &entry;
		let field_id = SurfaceId::SettingsField(key.clone());
		let av = controls_copy.availability(&field_id);
		let is_invalid = controls_copy.error(&field_id).is_some();

		let control_el = setting_control(key, entry, &av, is_invalid, entity.clone(), window, app);
		let is_modified = entry.value != entry.default;
		let secondary_el = if is_modified {
			let key_clone = key.clone();
			let weak_for_reset = weak_view.clone();
			let foreground = tokens_copy.color(ColorRole::Foreground);
			let reset_btn = div()
				.id(ElementId::Name(format!("reset-{key}").into()))
				.cursor_pointer()
				.text_size(tokens_copy.font_size(TextRamp::Small))
				.text_color(tokens_copy.color(ColorRole::Muted))
				.hover(move |s| s.text_color(foreground))
				.on_click(move |_e: &ClickEvent, _w, app| {
					let _ = weak_for_reset.update(app, |view, cx| {
						view.dispatch(Intent::ResetSetting(key_clone.clone()), cx);
					});
				})
				.child("Reset");
			let default = entry
				.default
				.as_str()
				.map_or_else(|| entry.default.to_string(), crate::settings::row::shorten_path);
			Some(
				Tooltip::new(format!("Default: {default}"), reset_btn)
					.keyed(format!("reset-tip-{key}"))
					.into_any_element(),
			)
		} else {
			None
		};

		let prev_group = if item_ix > 0 {
			visible_keys.get(item_ix - 1).and_then(|k| {
				let view_read = entity.read(app);
				view_read
					.active_settings()
					.and_then(|s| s.entry(k))
					.and_then(|e| e.group.clone())
			})
		} else {
			None
		};
		let show_header = if item_ix == 0 {
			entry.group.is_some()
		} else {
			entry.group.is_some() && entry.group != prev_group
		};
		let group_header = if show_header {
			entry.group.as_deref().map(|g| {
				crate::settings::row::group_header_row(g, item_ix == 0, &geometry_copy, &tokens_copy)
			})
		} else {
			None
		};

		let mut row_container = div()
			.w_full()
			.flex()
			.flex_col()
			.gap(px(geometry_copy.row_gap));

		if let Some(gh) = group_header {
			row_container = row_container.child(gh);
		}

		row_container = row_container.child(setting_row_with_secondary(
			entry.label.as_deref().unwrap_or(key),
			entry.description.as_deref(),
			control_el,
			secondary_el,
			&av,
			&geometry_copy,
			&tokens_copy,
		));

		if item_ix > 0 && !show_header {
			row_container = row_container.mt(px(geometry_copy.row_gap));
		}
		row_container.into_any_element()
	})
	.w_full()
	.h_full();

	div()
		.w_full()
		.h_full()
		.flex()
		.flex_col()
		.overflow_hidden()
		.child(search_bar)
		.child(div().flex_1().min_h_0().child(list_el))
}

/// The field the page's rows are narrowed by.
///
/// It draws the editor the frame retained, so it takes focus and the rows
/// narrow as it is typed into; drawing it from the query string instead draws
/// a field nothing can be typed into. The prompt an empty field states is the
/// editor's own, set where the editor is created, because a field drawn from
/// an editor draws that editor and not a placeholder passed beside it.
fn query_field(fields: &FieldSlots, tokens: &TokenSet, cx: &Context<ShellView>) -> Div {
	let weak_for_clear = cx.weak_entity();
	div().w_full().mb(tokens.spacing(SpacingStep::S3)).child(
		SearchField::new("settings-search", EditorSlot::from(fields.query.clone())).on_clear(
			move |_win, app| {
				let _ = weak_for_clear.update(app, |view, cx| {
					view.clear_settings_query(cx);
				});
			},
		),
	)
}
