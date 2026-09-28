//! The pieces every settings page is built from: a section heading, a row
//! with a label, a description and a control, a button that sends a host
//! request and is disabled with the gate's reason when the host would refuse
//! it, a switch that sends one when flipped, and the box around an input.
//! Every request goes through [`SettingsView::send`], which states a refusal
//! on the page. Every control registers the driver target
//! `settings.control:<element id>` and every input `settings.field:<key>`.

use veyyon_desktop_model::{HostAction, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, Toggle, Tooltip},
	editor::Editor,
	theme::{Palette, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{
	AnyElement, App, ClickEvent, Context, ElementId, Entity, IntoElement, SharedString, Window, div,
	prelude::*,
};

use super::{SettingsView, targets};
use crate::{palette::refusal, state::AppState};

/// A bordered box around `input`, the input editing `key`.
pub fn input_box(key: &str, input: Entity<Editor>, palette: &Palette) -> AnyElement {
	let field = div()
		.h(size::CONTROL)
		.px(space::S2)
		.flex()
		.items_center()
		.rounded(radius::MD)
		.border_1()
		.border_color(palette.border.default)
		.bg(palette.bg.surface)
		.child(input);
	targets::target(("settings.field", key), field)
}

/// A heading above a group of rows.
pub fn heading(title: impl Into<SharedString>, palette: &Palette) -> AnyElement {
	div()
		.pt(space::S6)
		.pb(space::S2)
		.type_style(text::UI_MEDIUM)
		.text_color(palette.text.primary)
		.child(title.into())
		.into_any_element()
}

/// The page title and its one-line description.
pub fn title(label: &str, description: &str, palette: &Palette) -> AnyElement {
	div()
		.pb(space::S2)
		.child(
			div()
				.type_style(text::H2)
				.text_color(palette.text.primary)
				.child(label.to_owned()),
		)
		.child(
			div()
				.type_style(text::UI)
				.text_color(palette.text.muted)
				.child(description.to_owned()),
		)
		.into_any_element()
}

/// A muted line of text.
pub fn note(line: impl Into<SharedString>, palette: &Palette) -> AnyElement {
	div()
		.py(space::S1)
		.type_style(text::SMALL)
		.text_color(palette.text.muted)
		.child(line.into())
		.into_any_element()
}

/// A row: the label and description on the left, `control` on the right.
pub fn row(
	id: impl Into<ElementId>,
	label: impl Into<SharedString>,
	description: Option<SharedString>,
	control: AnyElement,
	palette: &Palette,
) -> AnyElement {
	div()
		.id(id)
		.flex()
		.items_center()
		.gap(space::S4)
		.py(space::S2_5)
		.border_b_1()
		.border_color(palette.border.subtle)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.child(
					div()
						.type_style(text::UI)
						.text_color(palette.text.primary)
						.child(label.into()),
				)
				.when_some(description, |el, description| {
					el.child(
						div()
							.type_style(text::SMALL)
							.text_color(palette.text.muted)
							.child(description),
					)
				}),
		)
		.child(
			div()
				.flex_none()
				.flex()
				.items_center()
				.gap(space::S2)
				.child(control),
		)
		.into_any_element()
}

/// A small button that sends `action` on behalf of `surface`. When the gate
/// rejects the action the button is disabled and its tooltip states why.
pub fn send_button(
	id: impl Into<ElementId>,
	label: impl Into<SharedString>,
	variant: ButtonVariant,
	action: HostAction,
	surface: SurfaceId,
	app: &Entity<AppState>,
	cx: &Context<SettingsView>,
) -> AnyElement {
	let reason = refusal(app.read(cx), &action);
	let id = id.into();
	let button = Button::new(id.clone(), label)
		.size(ButtonSize::Sm)
		.variant(variant)
		.disabled(reason.is_some())
		.on_click(cx.listener(move |this, _, _, cx| {
			this.send(action.clone(), surface.clone(), cx);
		}));
	gated(id, button, reason)
}

/// A small button that runs `handler`.
pub fn local_button(
	id: impl Into<ElementId>,
	label: impl Into<SharedString>,
	variant: ButtonVariant,
	handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
	let id = id.into();
	let button = Button::new(id.clone(), label)
		.size(ButtonSize::Sm)
		.variant(variant)
		.on_click(handler);
	gated(id, button, None)
}

/// A switch drawn `on` that sends the request `make` builds for the position
/// it is flipped to. It is disabled when `disabled` is set or when the gate
/// rejects the request, whose reason its tooltip states.
pub fn switch(
	id: impl Into<ElementId>,
	on: bool,
	disabled: bool,
	make: impl Fn(bool) -> (HostAction, SurfaceId) + 'static,
	app: &Entity<AppState>,
	cx: &Context<SettingsView>,
) -> AnyElement {
	let id = id.into();
	let reason = refusal(app.read(cx), &make(!on).0);
	let send = cx.listener(move |this, enabled: &bool, _, cx| {
		let (action, surface) = make(*enabled);
		this.send(action, surface, cx);
	});
	let toggle = Toggle::new(id.clone(), on)
		.disabled(disabled || reason.is_some())
		.on_change(move |enabled, window, cx| send(&enabled, window, cx));
	gated(id, toggle, reason)
}

/// `control`, wrapped so hovering it states `reason` when the gate rejects
/// what it sends, and registered as the driver target
/// `settings.control:<id>`.
fn gated(id: ElementId, control: impl IntoElement, reason: Option<SharedString>) -> AnyElement {
	let control = match reason {
		Some(reason) => div()
			.id(ElementId::Name(format!("{id}-gate").into()))
			.child(control)
			.tooltip(Tooltip::text(reason))
			.into_any_element(),
		None => control.into_any_element(),
	};
	targets::target(("settings.control", id), control)
}
