//! Availability transitions preserve selection styling and reject stale
//! activation.

use veyyon_desktop_surface::{
	Intent, Overlay, PaletteState, fixture,
	palette::{PaletteItem, PaletteMode},
};

use super::{
	picker_contract::{self, Source, open, row_fill},
	render_session,
};

#[test]
fn pending_and_unavailable_rows_are_skipped_until_the_same_control_enables_them() {
	for availability in [
		veyyon_desktop_surface::controls::Availability::Pending,
		veyyon_desktop_surface::controls::Availability::Unavailable {
			reason: "Not available".into(),
		},
	] {
		render_session(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					view.open_command_palette(window, cx);
					let mut state = PaletteState::new(PaletteMode::Commands);
					state.set_items(vec![
						PaletteItem::command(
							1,
							"Unavailable effort",
							Intent::SetThinking(veyyon_desktop_surface::composer::ThinkingLevel::new(
								"high",
							)),
							None,
						),
						PaletteItem::command(2, "New session", Intent::NewSession, None),
					]);
					state.selected = 1;
					view.state_mut().overlay = Some(Overlay::Palette(state));
					view.drain_intents();
				})
				.unwrap();
			let neutral = picker_contract::row_fill(&session.frame().unwrap(), "Unavailable effort");
			session.keystroke("home").unwrap();
			assert_ne!(
				picker_contract::row_fill(&session.frame().unwrap(), "Unavailable effort"),
				neutral
			);
			session
				.update(|view, _, cx| {
					let id = veyyon_desktop_model::SurfaceId::ComposerThinkingSelector(
						veyyon_desktop_model::SessionId::from(view.state().current_id.to_string()),
					);
					view.state_mut().controls.set_availability(id, availability);
					view.picker_pointer(0, true, cx);
					assert!(view.drain_intents().is_empty());
					cx.notify();
				})
				.unwrap();
			assert_eq!(
				picker_contract::row_fill(&session.frame().unwrap(), "Unavailable effort"),
				neutral,
				"withdrawn selection loses its highlight"
			);
			session.keystroke("enter").unwrap();
			session
				.update(|view, _, _| assert!(view.drain_intents().is_empty()))
				.unwrap();
			for key in ["home", "end", "up", "down", "pageup", "pagedown"] {
				session.keystroke(key).unwrap();
				session
					.update(|view, _, _| {
						assert_eq!(
							view
								.state()
								.overlay
								.as_ref()
								.and_then(Overlay::as_palette)
								.unwrap()
								.selected,
							1
						);
					})
					.unwrap();
			}
			session
				.update(|view, _, _| {
					let id = veyyon_desktop_model::SurfaceId::ComposerThinkingSelector(
						veyyon_desktop_model::SessionId::from(view.state().current_id.to_string()),
					);
					view
						.state_mut()
						.controls
						.set_availability(id, veyyon_desktop_surface::controls::Availability::Enabled);
				})
				.unwrap();
			session.keystroke("home").unwrap();
			session.keystroke("enter").unwrap();
			session
				.update(|view, _, _| {
					assert_eq!(view.drain_intents(), vec![Intent::SetThinking(
						veyyon_desktop_surface::composer::ThinkingLevel::new("high")
					)]);
					assert!(view.state().overlay.is_none());
				})
				.unwrap();
		});
	}
}
#[test]
fn host_theme_withdrawal_clears_selection_styling_and_blocks_activation() {
	use veyyon_desktop_model::{SurfaceId, ThemesView, domain::ThemeView};
	use veyyon_desktop_surface::controls::Availability;
	for availability in
		[Availability::Pending, Availability::Unavailable { reason: "Not available".into() }]
	{
		super::render_session(veyyon_desktop_surface::fixture::populated(), |session| {
			let index = session
				.update(|view, window, cx| {
					open(Source::Themes, view, window, cx);
					let index = cx
						.try_global::<veyyon_desktop_surface::ThemeLibrary>()
						.unwrap()
						.themes()
						.len();
					let Some(Overlay::Settings(state)) = view.state_mut().overlay.as_mut() else {
						panic!("themes open")
					};
					state.themes = Some(ThemesView {
						themes:  vec![
							ThemeView { id: "first".into(), name: "Host first".into(), dark: true },
							ThemeView { id: "second".into(), name: "Host second".into(), dark: false },
						],
						current: "second".into(),
					});
					view.picker_pointer(index + 1, false, cx);
					view.drain_intents();
					index
				})
				.unwrap();
			let neutral = row_fill(&session.frame().unwrap(), "Host first");
			session.keystroke("up").unwrap();
			assert_ne!(row_fill(&session.frame().unwrap(), "Host first"), neutral);
			session
				.update(|view, _, cx| {
					view
						.state_mut()
						.controls
						.set_availability(SurfaceId::ThemeSelector, availability);
					cx.notify();
				})
				.unwrap();
			assert_eq!(row_fill(&session.frame().unwrap(), "Host first"), neutral);
			session.keystroke("enter").unwrap();
			session
				.update(|view, _, cx| {
					view.picker_pointer(index, true, cx);
					assert!(view.drain_intents().is_empty());
					view
						.state_mut()
						.controls
						.set_availability(SurfaceId::ThemeSelector, Availability::Enabled);
					view.picker_pointer(index, true, cx);
					assert_eq!(view.drain_intents(), vec![Intent::SelectTheme("first".into())]);
				})
				.unwrap();
		});
	}
}
