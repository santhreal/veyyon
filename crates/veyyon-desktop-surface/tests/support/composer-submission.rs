//! WHY: Request attempts previously consumed drafts before the host accepted
//! them. Exercise the real shell's submission, acknowledgement, and command
//! paths. Failures, unrelated acknowledgements, later edits, and session
//! changes must preserve editable content. These tests do not exercise
//! transport delivery or native window presentation.

use veyyon_desktop_model::{QueueMode, RequestId, SessionId, SurfaceId};
use veyyon_desktop_surface::{
	Attachment, Availability, Intent, ModelChoice, Overlay, ThinkingLevel,
	composer::{MediaType, TurnPhase, payload_for},
	fixture,
};

use super::render_session;

fn attachment(sequence: u32) -> Attachment {
	Attachment::from_clipboard(
		sequence,
		MediaType::Png,
		payload_for(MediaType::Png, b"\x89PNG\r\n\x1a\n".to_vec()),
	)
}

#[test]
fn only_a_matching_success_consumes_the_submitted_draft() {
	for succeeded in [false, true] {
		for edited in [false, true] {
			for switched in [false, true] {
				let mut state = fixture::populated();
				state.turn = TurnPhase::Idle;
				state.composer.attachments = vec![attachment(1)];
				render_session(state, Some("original draft"), 1440, 900, |session| {
					session
						.update(|view, _window, cx| {
							view.submit_primary_turn_action(cx);
							let intents = view.drain_intents();
							assert_eq!(intents, vec![Intent::Send {
								text:        "original draft".to_owned(),
								attachments: vec![attachment(1)],
							}]);
							assert_eq!(view.state().turn, TurnPhase::Idle);
							assert_eq!(view.state().composer.attachments, vec![attachment(1)]);
							view.track_submission(RequestId(1), &intents[0]);
							view.finish_submission(RequestId(2), true, cx);
							assert_eq!(view.composer().expect("editor").read(cx).text(), "original draft");
							if edited {
								view.set_composed("later draft", cx);
							}
							if switched {
								view.state_mut().current_id += 1;
							}
							view.state_mut().composer.attachments.push(attachment(2));
							view.finish_submission(RequestId(1), succeeded, cx);
							let expected_text = if edited {
								"later draft"
							} else if succeeded && !switched {
								""
							} else {
								"original draft"
							};
							assert_eq!(view.composer().expect("editor").read(cx).text(), expected_text);
							let expected_attachments = if succeeded && !switched {
								vec![attachment(2)]
							} else {
								vec![attachment(1), attachment(2)]
							};
							assert_eq!(view.state().composer.attachments, expected_attachments);
							view.finish_submission(RequestId(1), true, cx);
							assert_eq!(view.composer().expect("editor").read(cx).text(), expected_text);
						})
						.expect("submission lifecycle");
				});
			}
		}
	}
}

#[test]
fn request_availability_applies_to_direct_and_palette_dispatch() {
	let mut state = fixture::populated();
	state.turn = TurnPhase::Idle;
	render_session(state, Some("draft"), 1440, 900, |session| {
		session
			.update(|view, _window, cx| {
				let row = SessionId::from(view.state().current_id.to_string());
				let cases = [
					(
						Intent::Send { text: "draft".to_owned(), attachments: vec![] },
						SurfaceId::ComposerSendButton(row.clone()),
					),
					(Intent::Steer("draft".to_owned()), SurfaceId::ComposerSteerButton(row.clone())),
					(Intent::Queue("draft".to_owned()), SurfaceId::ComposerQueueButton(row.clone())),
					(Intent::AbortTurn, SurfaceId::ComposerAbortButton(row.clone())),
					(
						Intent::SelectModel(ModelChoice::new("provider", "model")),
						SurfaceId::ComposerModelSelector(row.clone()),
					),
					(
						Intent::SetThinking(ThinkingLevel::new("high")),
						SurfaceId::ComposerThinkingSelector(row.clone()),
					),
					(Intent::SetQueueMode(QueueMode::Queue), SurfaceId::ComposerQueueModeToggle(row)),
				];
				for (intent, surface) in cases {
					for availability in [
						Availability::Pending,
						Availability::Unavailable { reason: "not supported".to_owned() },
						Availability::Enabled,
						Availability::Unknown,
					] {
						let allowed =
							matches!(availability, Availability::Enabled | Availability::Unknown);
						view
							.state_mut()
							.controls
							.set_availability(surface.clone(), availability);
						view.dispatch(intent.clone(), cx);
						assert_eq!(
							view.drain_intents(),
							if allowed {
								vec![intent.clone()]
							} else {
								vec![]
							},
							"{surface:?}"
						);
					}
				}
			})
			.expect("request availability");
	});
}

#[test]
fn slash_turn_commands_preserve_the_payload_and_do_not_submit_the_query() {
	for (command, expected) in [
		("/steer", Intent::Steer("  payload".to_owned())),
		("/queue", Intent::Queue("  payload".to_owned())),
	] {
		let mut state = fixture::populated();
		state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
		let text = format!("{command}\n  payload");
		render_session(state, Some(&text), 1440, 900, |session| {
			session
				.update(|view, _window, cx| {
					view.submit_primary_turn_action(cx);
					let intents = view.drain_intents();
					assert_eq!(
						intents
							.into_iter()
							.filter(|intent| !matches!(intent, Intent::CloseOverlay))
							.collect::<Vec<_>>(),
						vec![expected]
					);
					assert_eq!(view.composer().expect("editor").read(cx).text(), "  payload");
					assert!(view.state().overlay.is_none());
				})
				.expect("slash command submission");
		});
	}
}

#[test]
fn slash_alias_and_dismissal_preserve_the_editor() {
	for query in ["/", "/commands"] {
		render_session(fixture::populated(), Some(query), 1440, 900, |session| {
			session
				.update(|view, _window, cx| {
					let palette = view
						.state()
						.overlay
						.as_ref()
						.and_then(Overlay::as_palette)
						.expect("command menu");
					assert_eq!(palette, &veyyon_desktop_surface::PaletteState::commands());
					view.close_palette(cx);
					assert_eq!(view.composer().expect("editor").read(cx).text(), query);
					assert!(view.state().overlay.is_none());
				})
				.expect("command dismissal");
		});
	}
}

#[test]
fn model_search_preserves_the_draft_and_requires_available_selection() {
	render_session(fixture::populated(), Some("draft"), 1440, 900, |session| {
		session
			.update(|view, window, cx| {
				let previous = view
					.state()
					.composer
					.model
					.clone()
					.expect("model catalogue");
				let query = previous.options[1].name.clone();
				view.open_model_picker(window, cx);
				view.drain_intents();
				let editor = view.palette_editor().expect("search editor");
				editor.update(cx, |editor, cx| editor.set_text(query, cx));
			})
			.expect("model search");
		session
			.update(|view, _window, cx| {
				let previous = view
					.state()
					.composer
					.model
					.clone()
					.expect("model catalogue");
				let choice = previous.options[1].choice.clone();
				let palette = view
					.state()
					.overlay
					.as_ref()
					.and_then(Overlay::as_palette)
					.expect("model picker");
				assert_eq!(palette.run_intent(), Some(Intent::SelectModel(choice.clone())));
				let id = SurfaceId::ComposerModelSelector(SessionId::from(
					view.state().current_id.to_string(),
				));
				for availability in
					[Availability::Pending, Availability::Unavailable { reason: "offline".to_owned() }]
				{
					view
						.state_mut()
						.controls
						.set_availability(id.clone(), availability);
					view.run_palette(cx);
					assert!(view.drain_intents().is_empty());
					assert!(view.state().overlay.is_some());
				}
				view
					.state_mut()
					.controls
					.set_availability(id, Availability::Enabled);
				view.run_palette(cx);
				assert_eq!(view.drain_intents(), vec![Intent::SelectModel(choice)]);
				assert_eq!(view.state().composer.model, Some(previous));
				assert_eq!(view.composer().expect("editor").read(cx).text(), "draft");
			})
			.expect("model selection");
	});
}
