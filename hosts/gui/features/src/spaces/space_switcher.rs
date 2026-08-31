//! Space switcher control displaying active workspace space and switching
//! actions.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{Store, UiCommand};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner, owner_at},
	theme::{Theme, layout, radius, space, weight},
	ui::{Button, Fill, Icon, Tone, text},
};

use crate::act;

pub fn space_switcher(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let active_space_id = store.frontend.spaces.active_space_id();
	let spaces_count = store.frontend.spaces.spaces.len();

	let space_buttons = store
		.frontend
		.spaces
		.spaces
		.iter()
		.enumerate()
		.map(|(idx, sp)| {
			let is_active = Some(sp.id.clone()) == active_space_id;
			let btn_owner =
				owner_at(OwnerNamespace::Shell, "space-switcher-item", sp.id.as_str(), idx as u64);

			let bg = if is_active {
				theme.raised
			} else {
				theme.chrome
			};

			div()
				.id(format!("space-item-{idx}"))
				.flex()
				.items_center()
				.gap(px(space::X4))
				.px(px(space::X8))
				.h(px(layout::toolbar() - space::X8))
				.rounded(px(radius::CONTROL))
				.bg(bg)
				.child(
					Button::labelled(format!("select-space-{idx}"), btn_owner, sp.name.clone())
						.tip(format!("Switch to space {}", sp.name))
						.fill(if is_active { Fill::Tinted } else { Fill::Ghost })
						.tone(if is_active { Tone::Accent } else { Tone::Muted })
						.on_click(act::click(UiCommand::SelectSpace(sp.id.clone()))),
				)
				.children((spaces_count > 1).then(|| {
					Button::new(
						format!("close-space-{idx}"),
						owner_at(OwnerNamespace::Shell, "space-close-btn", sp.id.as_str(), idx as u64),
						Icon::Close,
					)
					.tip("Close space")
					.fill(Fill::Ghost)
					.tone(Tone::Muted)
					.on_click(act::click(UiCommand::CloseSpace(sp.id.clone())))
				}))
		});

	div()
		.id("space-switcher")
		.flex()
		.items_center()
		.gap(px(space::X4))
		.h(px(layout::toolbar()))
		.px(px(space::X8))
		.child(
			text::label("Spaces:", &theme)
				.font_weight(weight::STRONG)
				.text_color(theme.text_muted),
		)
		.children(space_buttons)
		.child(
			Button::new(
				"new-space-button",
				owner(OwnerNamespace::Shell, "space-switcher", "new-space"),
				Icon::New,
			)
			.tip("Create new space")
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.on_click(act::click(UiCommand::CreateSpace {
				name: format!("Space {}", spaces_count + 1),
			})),
		)
		.into_any_element()
}
