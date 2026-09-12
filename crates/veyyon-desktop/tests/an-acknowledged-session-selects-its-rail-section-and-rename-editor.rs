//! WHY: a session load request does not switch the displayed session. These
//! native tests exercise request dispatch, host `ActiveSession` reduction and
//! real projection before checking rail expansion and the retained titlebar
//! editor. They replace surface-only tests that assumed optimistic session
//! switching. Transport delivery and rejected-request transaction handling
//! remain in their existing host integration suites.

mod support;

use std::{
	collections::HashMap,
	time::{Duration, Instant},
};

use support::{NOW_MS, memory::driven};
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ComposerStore, ConnectionState, HostAction, HostEvent,
	QueuePartition, RequestId, SessionHeaderView, SessionId, SnapshotSection, Store, Versioned,
	reduce,
};
use veyyon_desktop_scene::HeadlessSession;
use veyyon_desktop_surface::{FieldKey, Intent, Section, ShellState, ShellView};

fn acknowledge(store: &mut Store, id: &SessionId) {
	let title = store
		.sessions
		.get(id)
		.expect("host-listed session")
		.title
		.clone();
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    SessionHeaderView {
				id:             id.clone(),
				schema_version: 1,
				title:          Some(title),
				title_source:   None,
				parent:         None,
				created_at_ms:  0,
				cwd:            "/repo".into(),
				mode:           None,
			},
		})),
	);
	reduce(store, HostEvent::RequestSucceeded { request: RequestId(1) });
}

fn seed() -> (Store, SessionIndex, ShellState, Vec<(Section, SessionId, u64)>) {
	let mut store = Store::new();
	reduce(
		&mut store,
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "local-host".into(),
			protocol: 1,
		}),
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Sessions,
			CapabilityStatus::Available,
		)])),
	);
	let mut index = SessionIndex::new();
	let mut targets = Vec::new();
	for section in Section::all() {
		let partition = match section {
			Section::Unsent | Section::Live => QueuePartition::Live,
			Section::Pinned => QueuePartition::Pinned,
			Section::Deferred => QueuePartition::Deferred,
			Section::Parked => QueuePartition::Parked,
		};
		let id = SessionId::from(section.slug());
		store.sessions.insert(support::session(&id.0, partition));
		if section == Section::Unsent {
			store.persisted.composer.insert(id.clone(), ComposerStore {
				draft_text: "retained draft".into(),
				..ComposerStore::default()
			});
		}
		let row = index.row_of(&id);
		targets.push((section, id, row));
	}
	// A second draft keeps Unsent present after the first draft becomes active.
	let spare = SessionId::from("another-draft");
	store
		.sessions
		.insert(support::session(&spare.0, QueuePartition::Live));
	store.persisted.composer.insert(spare, ComposerStore {
		draft_text: "another retained draft".into(),
		..ComposerStore::default()
	});
	acknowledge(&mut store, &SessionId::from(Section::Live.slug()));
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	(store, index, state, targets)
}

fn project_window(
	window: &mut HeadlessSession<'_, ShellView>,
	store: &Store,
	index: &mut SessionIndex,
) {
	window
		.update(|view, _, cx| {
			let mut state = view.state().clone();
			project(store, index, &HashMap::new(), NOW_MS, &mut state);
			view.set_state(state);
			cx.notify();
		})
		.expect("host state projects into the existing window");
}

fn settle(window: &mut HeadlessSession<'_, ShellView>) {
	window.frame().expect("layout before advancing motion");
	window
		.update(|view, _, cx| {
			let start = Instant::now();
			for tick in 1..=240 {
				if !view
					.rail_motion_mut()
					.has_active_animations(start + Duration::from_millis(tick * 16))
				{
					cx.notify();
					return;
				}
			}
			panic!("queue animations must settle within 240 frames");
		})
		.expect("advance rail animation clock");
	window.frame().expect("settled queue frame");
}

#[test]
fn an_acknowledged_selection_expands_only_its_current_partition() {
	for source_section in Section::all() {
		let (mut store, mut index, mut state, targets) = seed();
		let (_, target, target_row) = targets
			.iter()
			.find(|(section, ..)| *section == source_section)
			.unwrap();
		if *target_row == state.current_id {
			acknowledge(&mut store, &SessionId::from(Section::Parked.slug()));
			project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
		}
		let before = state.current_id;
		driven(state, |window| {
			settle(window);
			window
				.update(|view, _, cx| {
					view.drain_intents();
					for section in Section::all() {
						view
							.rail_motion_mut()
							.toggle_collapsed(section, Instant::now());
					}
					cx.notify();
				})
				.expect("collapse every section");
			settle(window);
			window
				.update(|view, _, _| {
					for section in Section::all() {
						assert!(view.rail_motion().is_collapsed(section));
					}
					assert_eq!(view.rail_motion().list_state().item_count(), Section::all().len());
				})
				.expect("all headers remain visible");
			let sent = window
				.update(|view, _, cx| {
					view.dispatch(Intent::SelectSession(*target_row), cx);
					assert_eq!(
						view.state().current_id,
						before,
						"request must not change the acknowledged session"
					);
					view.drain_intents()
				})
				.expect("request the target");
			assert_eq!(sent, vec![Intent::SelectSession(*target_row)]);
			assert_eq!(actions_for(&sent[0], &index, &mut store), vec![
				HostAction::OpenSession { session: target.clone() },
				HostAction::RefreshChanges
			]);
			if *target_row != before {
				settle(window);
				window
					.update(|view, _, _| {
						for section in Section::all() {
							assert!(
								view.rail_motion().is_collapsed(section),
								"pending load expanded {section:?}"
							);
						}
					})
					.expect("no old section expands while the load is pending");
			}
			acknowledge(&mut store, target);
			project_window(window, &store, &mut index);
			settle(window);
			let destination = if source_section == Section::Unsent {
				Section::Live
			} else {
				source_section
			};
			window
				.update(|view, _, _| {
					assert_eq!(view.state().current_id, *target_row);
					for section in Section::all() {
						assert_eq!(
							view.rail_motion().is_collapsed(section),
							section != destination,
							"source {source_section:?}, section {section:?}"
						);
					}
					let visible_rows = if source_section == Section::Unsent {
						2
					} else {
						1
					};
					assert_eq!(
						view.rail_motion().list_state().item_count(),
						Section::all().len() + visible_rows
					);
				})
				.expect("acknowledged destination expands without opening siblings");
		});
	}
}

#[test]
fn the_retained_rename_editor_targets_the_host_acknowledged_session() {
	let (mut store, mut index, state, targets) = seed();
	let original = state.current_id;
	let (_, target, target_row) = targets
		.iter()
		.find(|(section, ..)| *section == Section::Parked)
		.unwrap();
	driven(state, |window| {
		window
			.update(|view, _, cx| {
				veyyon_desktop_kit::input::ensure_editor_bindings_registered(cx);
				assert!(
					view
						.retained_field(&FieldKey::SessionRename(original))
						.is_some()
				);
				view.drain_intents();
				view.dispatch(Intent::SelectSession(*target_row), cx);
				assert_eq!(view.state().current_id, original);
				assert_eq!(view.drain_intents(), vec![Intent::SelectSession(*target_row)]);
			})
			.expect("request leaves the original editor assigned");
		assert_eq!(actions_for(&Intent::SelectSession(*target_row), &index, &mut store), vec![
			HostAction::OpenSession { session: target.clone() },
			HostAction::RefreshChanges
		]);
		window
			.frame()
			.expect("pending request draws the original session");
		window
			.update(|view, _, _| {
				assert!(
					view
						.retained_field(&FieldKey::SessionRename(*target_row))
						.is_none()
				);
			})
			.expect("no target editor exists before acknowledgement");
		acknowledge(&mut store, target);
		project_window(window, &store, &mut index);
		window.frame().expect("acknowledged target draws");
		let editor = window
			.update(|view, _, _| {
				assert_eq!(view.state().current_id, *target_row);
				assert_eq!(view.state().title, store.sessions.get(target).unwrap().title);
				view
					.retained_field(&FieldKey::SessionRename(*target_row))
					.expect("target editor retained")
			})
			.unwrap();
		window
			.update(|_, win, cx| {
				let focus = editor.read(cx).focus_handle().clone();
				win.focus(&focus, cx);
			})
			.unwrap();
		window.frame().expect("focused titlebar field draws");
		assert!(window.keystroke("ctrl-a").expect("select-all dispatches"));
		window
			.type_text("Reticulating splines")
			.expect("type over the target title");
		window.frame().expect("typed title draws");
		assert!(window.keystroke("enter").expect("return commits the field"));
		window
			.update(|view, _, _| {
				assert_eq!(view.drain_intents(), vec![Intent::RenameSession {
					session: *target_row,
					title:   "Reticulating splines".into(),
				}]);
			})
			.expect("rename addresses the acknowledged session");
	});
}
