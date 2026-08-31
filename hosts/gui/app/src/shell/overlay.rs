//! Modal and overlay element rendering.

use gpui::{App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	UiCommand,
	navigation::{Overlay, PaletteMode},
};
use veyyon_gui_features::{act, overlays, palette};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Button, Fill, Sheet, Tone, text},
};

use super::Shell;

impl Shell {
	pub(super) fn render_overlay(&mut self, cx: &mut App) -> Option<gpui::AnyElement> {
		let overlay = self.store.frontend.overlays.last()?;
		match overlay {
			Overlay::CommandPalette { mode } => Some(palette::render(
				&self.store,
				*mode,
				&self.handles.editors.command,
				&self.handles.scrolls.palette_results,
				true,
				cx,
			)),
			Overlay::ModelPicker => Some(overlays::render_model_picker(
				&self.store,
				&self.handles.editors.command,
				&self.handles.scrolls.palette_results,
				true,
				cx,
			)),
			Overlay::ProviderAuth { provider } => Some(overlays::render_provider_auth(
				&self.store,
				provider,
				&self.handles.editors.provider_secret,
				true,
				cx,
			)),
			Overlay::Approval { interaction } => {
				Some(overlays::render_approval(&self.store, interaction, true, cx))
			},
			Overlay::Question { interaction } => Some(overlays::render_question(
				&self.store,
				interaction,
				&self.handles.editors.interaction,
				&self.handles.editors.interaction_note,
				true,
				cx,
			)),
			Overlay::PlanReview { request, interaction } => {
				Some(overlays::render_plan_review(&self.store, *request, interaction.clone(), true, cx))
			},
			Overlay::QuickOpen => Some(palette::render(
				&self.store,
				PaletteMode::QuickOpen,
				&self.handles.editors.command,
				&self.handles.scrolls.palette_results,
				true,
				cx,
			)),
			Overlay::SessionSwitcher => Some(palette::render(
				&self.store,
				PaletteMode::Sessions,
				&self.handles.editors.command,
				&self.handles.scrolls.palette_results,
				true,
				cx,
			)),
			Overlay::RenameSession { session, value } => {
				let sheet_owner = overlays::owner_of(&format!("rename-session:{session}"));
				let cancel_owner = overlays::owner_of(&format!("rename-session:{session}:cancel"));
				let save_owner = overlays::owner_of(&format!("rename-session:{session}:save"));
				let theme = Theme::get(cx);
				Some(
					Sheet::new("rename-session", sheet_owner, true)
						.centred()
						.on_dismiss(act::click(UiCommand::CloseTopOverlay))
						.child(
							text::stack(space::BASE)
								.child(text::heading("Rename session", &theme))
								.child(
									div()
										.p(px(space::BASE))
										.child(self.handles.editors.rename_session.clone()),
								),
						)
						.child(
							div()
								.flex()
								.items_center()
								.justify_end()
								.gap(px(space::SNUG))
								.child(
									Button::labelled("rename-cancel", cancel_owner, "Cancel")
										.on_click(act::click(UiCommand::CloseTopOverlay)),
								)
								.child(
									Button::labelled("rename-save", save_owner, "Save")
										.tone(Tone::Accent)
										.fill(Fill::Solid)
										.on_click(act::click(UiCommand::RenameSession {
											session: session.clone(),
											name:    value.clone(),
										})),
								),
						)
						.into_any_element(),
				)
			},
			Overlay::Confirmation { title, body, confirm } => {
				Some(overlays::render_confirmation(title, body, confirm, true, cx))
			},
			Overlay::ImageViewer { entry, index } => Some(overlays::render_image_viewer(
				&self.store,
				entry,
				*index,
				&mut self.handles.image_viewer,
				true,
				cx,
			)),
		}
	}
}
