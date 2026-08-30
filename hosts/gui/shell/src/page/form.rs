//! Fields with values: settings, a hook editor, a provider login.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::screen::{Control, Field, FieldOrigin, Form, FormGroup};
use veyyon_gui_kit::{
	chrome::{chip, column, row, well},
	text::{caption, label, text_in},
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;
use veyyon_gui_views::tone;

pub fn form(value: &Form, cx: &App) -> Div {
	let focused = value.focused().map(|field| field.key.clone());
	let mut stack = column(space::BASE).children(
		value
			.groups
			.iter()
			.map(|group| self::group(group, focused.as_deref(), cx)),
	);
	if let Some(footer) = &value.footer {
		stack = stack.child(caption(footer.clone(), cx));
	}
	stack
}

/// One group: its name, its help, then the fields a condition leaves visible.
fn group(value: &FormGroup, focused: Option<&str>, cx: &App) -> Div {
	let mut stack = column(space::TIGHT).child(label(value.name.clone(), cx));
	if let Some(help) = &value.help {
		stack = stack.child(caption(help.clone(), cx));
	}
	stack.children(
		value
			.fields
			.iter()
			.filter(|field| !field.hidden)
			.map(|field| self::field(field, focused == Some(field.key.as_str()), cx)),
	)
}

/// One field: its label, its control, and where its value came from.
fn field(value: &Field, focused: bool, cx: &App) -> Div {
	let mut line = row(space::BASE)
		.w_full()
		.items_baseline()
		.p(space::TIGHT)
		.rounded(radius::SMALL)
		.child(text_in(value.label.clone(), Role::TextPrimary, text::BODY, cx).flex_1())
		.child(text_in(value.control.summary(), control_role(&value.control), text::BODY, cx));
	if let Some(origin) = origin_label(value.origin) {
		line = line.child(chip(origin, Role::TextMuted, cx));
	}
	line = line.children(
		value
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
	);
	if focused {
		line = line.bg(cx.color(Role::InteractionSelected));
	}
	match &value.help {
		None => line,
		Some(help) => {
			column(space::HAIR)
				.child(line)
				.child(well(help.clone(), Role::TextSecondary, cx))
		},
	}
}

/// The role a control's value reads in.
///
/// A destructive action reads as a failure, because that is what it does. A
/// value this front end cannot edit reads set back, so it is not mistaken for
/// one that can be.
pub fn control_role(control: &Control) -> Role {
	match control {
		Control::Action { destructive: true, .. } => Role::StateError,
		Control::Action { .. } => Role::TextAccent,
		Control::Reading { .. } => Role::TextMuted,
		Control::Toggle { .. }
		| Control::Choice { .. }
		| Control::Text { .. }
		| Control::Number { .. } => Role::TextPrimary,
	}
}

/// What a field says about where its value came from, or `None` for the
/// default, which needs no saying.
///
/// A settings screen showing `12` without saying whether that is the default,
/// the profile's or this session's is unreadable: the operator cannot tell what
/// changing it would override.
pub fn origin_label(origin: FieldOrigin) -> Option<&'static str> {
	match origin {
		FieldOrigin::Default => None,
		other => Some(other.label()),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A settings screen draws credentials, and the value it draws comes from
	//! `Control::summary`, which masks. The gap that suite states is exactly
	//! this one: nothing there proves a renderer calls it rather than reading
	//! the control. The first test closes that by masking every masked field in
	//! the settings fixture and searching the result for the bytes.
	//!
	//! The hidden-field rule is the other half: a field behind a toggle that is
	//! off must not be drawn, and it must stay in the form, because removing it
	//! loses the value when the toggle comes back on.
	//!
	//! WHAT IT DOES NOT CATCH. Editing. No control takes input yet.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn no_masked_value_in_the_settings_fixture_reaches_what_is_drawn() {
		let form = fixtures::routes::settings();
		let masked: Vec<String> = form
			.groups
			.iter()
			.flat_map(|group| group.fields.iter())
			.filter_map(|field| match &field.control {
				Control::Text { value, masked: true, .. } => Some(value.clone()),
				Control::Toggle { .. }
				| Control::Choice { .. }
				| Control::Text { .. }
				| Control::Number { .. }
				| Control::Action { .. }
				| Control::Reading { .. } => None,
			})
			.collect();
		assert!(!masked.is_empty(), "the fixture carries no masked field");

		for secret in masked {
			assert!(secret.len() > 8, "the fixture secret is too short to be a real test");
			let drawn = Control::Text {
				value:       secret.clone(),
				placeholder: String::new(),
				masked:      true,
			}
			.summary();
			for window in secret.as_bytes().windows(4) {
				let fragment = String::from_utf8_lossy(window);
				assert!(!drawn.contains(fragment.as_ref()), "{fragment} of the secret survived");
			}
		}
	}

	#[test]
	fn a_hidden_field_is_not_drawn_and_is_not_removed() {
		let form = fixtures::routes::settings();
		let total = form
			.groups
			.iter()
			.map(|group| group.fields.len())
			.sum::<usize>();
		let visible = form.visible_fields().count();
		assert_eq!(visible, total - 1, "the hidden field was drawn, or was removed");
		assert!(
			form
				.groups
				.iter()
				.flat_map(|group| group.fields.iter())
				.any(|field| field.hidden),
			"the hidden field left the form"
		);
	}

	#[test]
	fn the_default_origin_is_the_only_one_left_unsaid() {
		assert_eq!(origin_label(FieldOrigin::Default), None);
		for origin in [
			FieldOrigin::Profile,
			FieldOrigin::Project,
			FieldOrigin::Session,
			FieldOrigin::Environment,
		] {
			assert_eq!(origin_label(origin), Some(origin.label()), "{origin:?} says nothing");
		}
	}

	#[test]
	fn a_destructive_action_never_reads_like_an_ordinary_one() {
		let destructive =
			Control::Action { label: "Delete the profile".to_owned(), destructive: true };
		let plain = Control::Action { label: "Send a request".to_owned(), destructive: false };
		assert_eq!(control_role(&destructive), Role::StateError);
		assert_ne!(control_role(&destructive), control_role(&plain));
	}

	#[test]
	fn a_value_this_front_end_cannot_edit_reads_set_back() {
		let reading = Control::Reading { value: "claude-sonnet-4-6".to_owned() };
		let editable = Control::Toggle { on: true };
		assert_ne!(control_role(&reading), control_role(&editable));
	}
}
