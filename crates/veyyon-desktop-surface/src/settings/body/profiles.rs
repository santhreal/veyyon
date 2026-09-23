//! Profiles settings page body rendering (§5.9).
//!
//! A host process serves the one profile it was started under, so the page
//! creates, renames and removes profile directories and states where each
//! one's host is reached. Switching is not a control here: a window reaches
//! another profile by attaching to that profile's host, at the endpoint the
//! row carries.

use veyyon_desktop_kit::{
	Badge, Button, ButtonSize, InteractiveState, Row, SpacingStep, TextField, TintRole, TokenSet,
	controls::Toggle,
};
use veyyon_desktop_model::{ProfileCopyItemView, ProfileView, SurfaceId};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, ElementId, IntoElement, ParentElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
	settings::{
		SettingsState, empty,
		row::{empty_state_row, setting_row, setting_row_with_secondary},
	},
	shell::fields::FieldSlots,
};

/// Renders the profile directories, what a new one copies, and the field a
/// new one is named in.
pub fn render_profiles_page(
	state: &SettingsState,
	fields: &FieldSlots,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	// The sheet states the refusal of any control it draws -- this page's
	// `Create`, `Rename` and `Delete` included -- in one row above the page
	// (§4.4).
	let mut container = div().flex().flex_col().gap(px(geometry.row_gap));
	container = container.child(create_row(state, fields, controls, geometry, tokens, cx));
	for item in state
		.profiles
		.iter()
		.flat_map(|profiles| profiles.copy_items.iter())
	{
		container = container.child(copy_row(state, item, controls, geometry, tokens, cx));
	}

	let entries = state
		.profiles
		.as_ref()
		.map(|profiles| profiles.entries.as_slice())
		.unwrap_or_default();
	if entries.is_empty() {
		return container.child(empty_state_row(
			empty::PROFILES.condition,
			empty::PROFILES.action,
			geometry,
			tokens,
		));
	}
	for entry in entries {
		container = container.child(profile_row(entry, fields, controls, geometry, tokens, cx));
	}
	container
}

/// The field a new profile is named in, with the `Create` beside it.
fn create_row(
	state: &SettingsState,
	fields: &FieldSlots,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let av = controls.availability(&SurfaceId::ProfileCreateButton);
	let (_, _, allowed) = availability_style(&av, tokens);
	let mut create = Button::new("profile-create", "Create").size(ButtonSize::Small);
	if allowed {
		create = create.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
			view.submit_profile_create(cx);
		}));
	} else {
		create = create.state(InteractiveState::Disabled);
	}
	let control: AnyElement = match fields.profile.clone() {
		Some(editor) => Row::new(SpacingStep::S2)
			.child(TextField::new("profile-name", editor))
			.child(create)
			.into_any_element(),
		None => create.into_any_element(),
	};
	let copied = state.profile_copy_keys().len();
	let description = match copied {
		0 => "Creates an empty profile: every item below is off".to_string(),
		1 => "Copies 1 item below from the active profile".to_string(),
		n => format!("Copies {n} items below from the active profile"),
	};
	setting_row("New profile", Some(&description), control, &av, geometry, tokens)
}

/// One item a create seeds the new profile with, and the switch that drops it.
fn copy_row(
	state: &SettingsState,
	item: &ProfileCopyItemView,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let av = controls.availability(&SurfaceId::ProfileCreateButton);
	let key = item.key.clone();
	let entity = cx.entity();
	let on = !state.profile_copy_off.contains(&item.key);
	let toggle = Toggle::new(ElementId::Name(format!("profile-copy-{}", item.key).into()), on)
		.on_toggle(move |_val, _win, app| {
			let () = entity.update(app, |view, cx| {
				view.dispatch(Intent::ToggleProfileCopy(key.clone()), cx);
			});
		});
	setting_row(&item.label, Some(&item.description), toggle, &av, geometry, tokens)
}

/// One profile directory: where it is, where its host is, and what may be
/// done to it.
fn profile_row(
	entry: &ProfileView,
	fields: &FieldSlots,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let delete_id = SurfaceId::ProfileDeleteButton(entry.name.clone());
	let av = controls.availability(&delete_id);
	// The active profile is the one this host serves: it is not deletable,
	// and the badge is what says why no Delete is offered.
	let control: AnyElement = if entry.is_active {
		Badge::new("Active", TintRole::Done).into_any_element()
	} else {
		let (_, _, allowed) = availability_style(&av, tokens);
		let name = entry.name.clone();
		let mut delete =
			Button::new(ElementId::Name(format!("profile-delete-{}", entry.name).into()), "Delete")
				.size(ButtonSize::Small);
		if allowed {
			delete = delete.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
				view.dispatch(Intent::DeleteProfile(name.clone()), cx);
			}));
		} else {
			delete = delete.state(InteractiveState::Disabled);
		}
		delete.into_any_element()
	};
	let rename = rename_button(entry, fields, controls, tokens, cx);
	let label = entry.label();
	setting_row_with_secondary(
		&label,
		Some(&row_description(entry)),
		control,
		Some(rename),
		&av,
		geometry,
		tokens,
	)
}

/// The `Rename` that writes what the row shows as, taking the new name from
/// the page's one name field: the page holds no second field, and a row that
/// grew one would be a field per profile on a page that is a list of them.
fn rename_button(
	entry: &ProfileView,
	fields: &FieldSlots,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let av = controls.availability(&SurfaceId::ProfileRenameButton(entry.name.clone()));
	let (_, _, allowed) = availability_style(&av, tokens);
	let mut button =
		Button::new(ElementId::Name(format!("profile-rename-{}", entry.name).into()), "Rename")
			.size(ButtonSize::Small);
	if allowed && fields.profile.is_some() {
		let name = entry.name.clone();
		button = button.on_click(cx.listener(move |view, _e: &ClickEvent, _w, cx| {
			view.submit_profile_rename(&name, cx);
		}));
	} else {
		button = button.state(InteractiveState::Disabled);
	}
	button.into_any_element()
}

/// Where the profile is on disk, and where its host is reached; a profile
/// with no addressable endpoint states why instead.
fn row_description(entry: &ProfileView) -> String {
	match (&entry.endpoint, &entry.endpoint_error) {
		(Some(endpoint), _) => format!("{} -- host at {endpoint}", entry.root_dir),
		(None, Some(error)) => format!("{} -- no host address: {error}", entry.root_dir),
		(None, None) => entry.root_dir.clone(),
	}
}
