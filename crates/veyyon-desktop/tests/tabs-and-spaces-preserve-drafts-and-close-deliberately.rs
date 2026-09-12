//! WHY: navigation must save the departing session before restoring its
//! destination. This drives the native `ShellView` and Keeper, including focus
//! and pending submissions. Transport refusal/timeout ordering is covered by
//! the host navigation transaction tests.

mod support;

use std::sync::Arc;

use support::memory::{FIRST, SECOND, driven, keeper_over, seeded, state_dir, store_on};
use veyyon_desktop::{
	SessionIndex, actions_for,
	state::{Keeper, session_shape},
};
use veyyon_desktop_model::{HostAction, PanelsStore, RequestId, SessionId};
use veyyon_desktop_surface::{
	Attachment, Intent,
	composer::{MediaType, Payload},
};

#[test]
fn escape_restores_the_saved_space_name_without_submitting_a_rename() {
	driven(seeded(), |session| {
		session.frame().unwrap();
		let (editor, saved) = session
			.update(|view, window, cx| {
				let space = view.state().navigation.active();
				let id = space.id;
				let saved = space.name.clone();
				let editor = view.space_name_field_editor(id, &saved, window, cx);
				editor.update(cx, |editor, cx| editor.set_text("abandoned space name", cx));
				let focus = editor.read(cx).focus_handle().clone();
				window.focus(&focus, cx);
				view.drain_intents();
				(editor, saved)
			})
			.unwrap();
		session.frame().unwrap();
		assert!(session.keystroke("escape").unwrap());
		session
			.update(|view, _, cx| {
				assert_eq!(editor.read(cx).text(), saved);
				assert_eq!(view.state().navigation.active().name, saved);
				assert!(view.drain_intents().is_empty());
			})
			.unwrap();
	});
}

#[test]
fn switching_spaces_keeps_layout_separate_and_draft_bytes_session_scoped() {
	let (_tree, dir) = state_dir("space-draft-preservation");
	let loaded = driven(seeded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
				view.set_composed("shared session draft", cx);
				let clip = Attachment::from_clipboard(
					1,
					MediaType::Text,
					Payload::Data(Arc::from(b"clipboard payload".as_slice())),
				);
				view.state_mut().composer.attachments.push(clip.clone());
				view.set_panel_width(620.0);
				keeper.sync(view, &mut store, window, 1, cx);
				let reading = store.persisted.shell.navigation.create("Reading").unwrap();
				let space = store.persisted.shell.navigation.space_mut(reading).unwrap();
				space.tabs.push(FIRST.into());
				space.selected = Some(FIRST.into());
				space.panels.insert(FIRST.into(), PanelsStore {
					right_panel_width: Some(400),
					..PanelsStore::default()
				});
				let actions =
					actions_for(&Intent::SwitchSpace(reading), &SessionIndex::new(), &mut store);
				assert!(actions.is_empty(), "the same host session needs no new runtime or open");
				keeper.sync(view, &mut store, window, 2, cx);
				assert_eq!(view.composer_text(), "shared session draft");
				assert_eq!(view.panel_width(), Some(400.0));
				assert_eq!(view.state().composer.attachments.as_slice(), std::slice::from_ref(&clip));
				view.set_composed("edited in Reading", cx);
				keeper.sync(view, &mut store, window, 3, cx);
				actions_for(&Intent::SwitchSpace(1), &SessionIndex::new(), &mut store);
				keeper.sync(view, &mut store, window, 4, cx);
				assert_eq!(view.panel_width(), Some(620.0));
				assert_eq!(view.composer_text(), "edited in Reading");
				assert_eq!(view.state().composer.attachments, [clip]);
				store.persisted.shell.active_session = Some(SECOND.into());
				store.persisted.shell.navigation.opened(SECOND.into());
				keeper.sync(view, &mut store, window, 5, cx);
				assert_eq!(view.composer_text(), "");
				assert!(view.state().composer.attachments.is_empty());
				store.persisted.shell.active_session = Some(FIRST.into());
				store.persisted.shell.navigation.opened(FIRST.into());
				keeper.sync(view, &mut store, window, 6, cx);
				assert_eq!(view.composer_text(), "edited in Reading");
				assert_eq!(view.state().composer.attachments[0].payload.bytes(), b"clipboard payload");
				keeper.sync(view, &mut store, window, 1000, cx);
				keeper.flush_all();
			})
			.unwrap();
		store.persisted
	});
	let (restored, rejected) = dir.load();
	assert!(rejected.is_empty());
	assert_eq!(restored.shell.navigation, loaded.shell.navigation);
	assert_eq!(session_shape(&restored, Some(&FIRST.into())).draft_text, "edited in Reading");
	let saved_paths = &restored.composer[&SessionId::from(FIRST)].attachments;
	assert_eq!(saved_paths.len(), 1);
	assert_eq!(std::fs::read(&saved_paths[0]).unwrap(), b"clipboard payload");
}

#[test]
fn dirty_close_cancel_restores_focus_and_confirmation_only_removes_membership() {
	let (_tree, dir) = state_dir("tab-close-confirmation");
	driven(seeded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
				view.set_composed("not sent", cx);
				let focus = view.ensure_composer(cx).read(cx).focus_handle().clone();
				window.focus(&focus, cx);
				view.drain_intents();
				view.request_close_tab(FIRST.into(), window, cx);
				assert_eq!(view.state().close_tab_prompt, Some(FIRST.into()));
				assert!(view.drain_intents().is_empty());
				view.answer_close_tab(false, window, cx);
				assert_eq!(window.focused(cx), Some(focus));
				assert_eq!(view.composer_text(), "not sent");
				assert_eq!(view.state().navigation.active().selected, Some(FIRST.into()));
				assert!(view.drain_intents().is_empty());
				view.request_close_tab(FIRST.into(), window, cx);
				view.answer_close_tab(true, window, cx);
				let intents = view.drain_intents();
				assert_eq!(intents, [Intent::CloseSessionTab(FIRST.into())]);
				keeper.sync(view, &mut store, window, 1, cx);
				assert!(actions_for(&intents[0], &SessionIndex::new(), &mut store).is_empty());
				keeper.sync(view, &mut store, window, 2, cx);
				assert!(store.persisted.shell.navigation.active().tabs.is_empty());
				assert_eq!(store.persisted.composer[&SessionId::from(FIRST)].draft_text, "not sent");
				assert_eq!(store.persisted.shell.active_session, Some(FIRST.into()));
			})
			.unwrap();
	});
}

#[test]
fn pending_submission_blocks_navigation_without_consuming_draft() {
	let (_tree, dir) = state_dir("pending-tab-submission");
	driven(seeded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
				view.set_composed("pending prompt", cx);
				view.track_submission(RequestId(42), &Intent::Send {
					text:        "pending prompt".into(),
					attachments: vec![],
				});
				view.drain_intents();
				for intent in [
					Intent::OpenSession(SECOND.into()),
					Intent::SwitchSpace(2),
					Intent::CreateSpace("Other".into()),
					Intent::CloseSessionTab(FIRST.into()),
					Intent::NewSession,
					Intent::BranchSession(1),
					Intent::BranchTurn(0),
					Intent::LoadTranscript(None),
					Intent::MoveQueueSelection(1),
				] {
					view.dispatch(intent, cx);
					assert!(view.drain_intents().is_empty());
					assert_eq!(view.composer_text(), "pending prompt");
					assert_eq!(view.state().navigation.active().selected, Some(FIRST.into()));
				}
			})
			.unwrap();
	});
}

#[test]
fn opening_a_session_blocks_submission_and_new_attachment_reads() {
	driven(seeded(), |session| {
		session
			.update(|view, _, cx| {
				view.set_composed("retained while opening", cx);
				let attachment = Attachment::from_clipboard(
					1,
					MediaType::Text,
					Payload::Data(Arc::from(b"existing bytes".as_slice())),
				);
				view
					.state_mut()
					.composer
					.attachments
					.push(attachment.clone());
				view.state_mut().navigation_pending = true;
				view.drain_intents();
				for intent in [
					Intent::Send { text: "retained while opening".into(), attachments: vec![] },
					Intent::Steer("steer".into()),
					Intent::Queue("queue".into()),
					Intent::RemoveAttachment(0),
					Intent::Attach(attachment.clone()),
					Intent::NewSession,
				] {
					view.dispatch(intent, cx);
					assert!(view.drain_intents().is_empty());
					assert_eq!(view.composer_text(), "retained while opening");
					assert_eq!(
						view.state().composer.attachments.as_slice(),
						std::slice::from_ref(&attachment)
					);
				}
				view.attach_paths(vec!["never-read.txt".into()], cx);
				view.pick_attachments(cx);
				let image = veyyon_gpui::Image::from_bytes(
					veyyon_gpui::ImageFormat::Png,
					b"\x89PNG\r\n\x1a\n".to_vec(),
				);
				view.attach_clipboard(&veyyon_gpui::ClipboardItem::new_image(&image), cx);
				assert!(
					!view.attachments_loading(),
					"no picker or background read starts while opening"
				);
				assert_eq!(view.state().composer.attachments, [attachment]);
				assert!(view.composer_local().notice.is_some());
			})
			.unwrap();
	});
}

#[test]
fn requested_session_load_does_not_commit_selection_or_erase_drafts() {
	let mut store = store_on(FIRST);
	store.persisted.shell.navigation.opened(FIRST.into());
	veyyon_desktop::state::record_draft(&mut store.persisted, &FIRST.into(), "keep on failure");
	let before = store.persisted.clone();
	let actions = actions_for(&Intent::OpenSession(SECOND.into()), &SessionIndex::new(), &mut store);
	assert_eq!(actions, [
		HostAction::OpenSession { session: SECOND.into() },
		HostAction::RefreshChanges
	]);
	assert_eq!(store.persisted, before, "only a host acknowledgement may replace this selection");
}

#[test]
fn an_empty_space_restores_without_reopening_the_hosts_old_session() {
	let (_tree, dir) = state_dir("empty-space-relaunch");
	let mut store = store_on(FIRST);
	store.persisted.shell.navigation.opened(FIRST.into());
	store.persisted.shell.navigation.close(&FIRST.into());
	let mut keeper = Keeper::new(dir, store.persisted.clone());
	assert_eq!(keeper.resolve_reopen(&mut store), None);
	assert_eq!(veyyon_desktop::project::navigation::active_session(&store), None);
}
