//! The Keybindings page: each action the host binds, its keys and where the
//! binding came from. Edit opens an input; Enter writes the keys typed,
//! separated by commas.

use veyyon_desktop_model::{HostAction, HostActionKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::{ButtonVariant, Kbd},
	theme::{ActiveTheme, radius, size, space},
};
use veyyon_gpui::{AnyElement, Context, IntoElement, SharedString, Window, div, prelude::*};

use super::{
	Page, SettingsView, targets,
	widgets::{local_button, note, row, title},
};
use crate::palette::refusal_kind;

/// The field key of the keybinding input.
const FIELD: &str = "keybinding";

impl SettingsView {
	pub(super) fn keybindings(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let mut page =
			div().child(title(Page::Keybindings.label(), Page::Keybindings.description(), &palette));
		let mut bindings = self.app.read(cx).store().domains.keybindings.clone();
		self.held.keybindings(&mut bindings);
		if bindings.is_empty() {
			return page
				.child(note("Loading keybindings from the host…", &palette))
				.into_any_element();
		}
		let blocked = refusal_kind(self.app.read(cx), HostActionKind::SetKeybinding);
		if let Some(reason) = &blocked {
			page = page.child(note(reason.clone(), &palette));
		}
		for binding in bindings {
			let editing = self.editing.as_deref() == Some(binding.action.as_str());
			let control = if editing {
				let input = self.field(
					FIELD,
					&binding.keys.join(", "),
					"ctrl+k, ctrl+shift+p",
					submit_keys,
					window,
					cx,
				);
				let editor = div()
					.w(size::MENU_MIN_WIDTH)
					.h(size::CONTROL)
					.px(space::S2)
					.flex()
					.items_center()
					.rounded(radius::MD)
					.border_1()
					.border_color(palette.accent.focus_ring)
					.bg(palette.bg.surface)
					.child(input);
				targets::target(("settings.field", FIELD), editor)
			} else {
				let chords = binding
					.keys
					.iter()
					.map(|keys| match Kbd::chord(&keys.replace('+', "-")) {
						Ok(kbd) => kbd.into_any_element(),
						Err(_) => div().child(keys.clone()).into_any_element(),
					})
					.collect::<Vec<_>>();
				let action = binding.action.clone();
				let keys = binding.keys.join(", ");
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.children(chords)
					.when(blocked.is_none(), |el| {
						el.child(local_button(
							SharedString::from(format!("edit-binding-{action}")),
							"Edit",
							ButtonVariant::Ghost,
							cx.listener(move |this, _, window, cx| {
								this.editing = Some(action.clone());
								this.set_field(FIELD, &keys, cx);
								if let Some(field) = this.fields.get(FIELD) {
									field.input.update(cx, |input, cx| input.focus(window, cx));
								}
								cx.notify();
							}),
						))
					})
					.into_any_element()
			};
			page = page.child(row(
				SharedString::from(format!("binding-{}", binding.action)),
				binding.action.clone(),
				Some(binding.source.clone().into()),
				control,
				&palette,
			));
		}
		page.into_any_element()
	}
}

/// Writes the keys typed for the binding being edited.
fn submit_keys(
	view: &mut SettingsView,
	_: &str,
	text: String,
	_: &mut Window,
	cx: &mut Context<SettingsView>,
) {
	let Some(action) = view.editing.take() else {
		return;
	};
	let keys = text
		.split(',')
		.map(str::trim)
		.filter(|keys| !keys.is_empty())
		.map(str::to_owned)
		.collect();
	view.send(
		HostAction::SetKeybinding { action: action.clone(), keys },
		SurfaceId::KeybindingField(action),
		cx,
	);
	cx.notify();
}
