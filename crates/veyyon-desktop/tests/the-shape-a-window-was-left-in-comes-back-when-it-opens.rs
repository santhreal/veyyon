//! WHY: §8.10's stores had shapes, a version rule, a document layer and a
//! debounced writer, and nothing joined them to a window. Nothing read the
//! drawn window's shape into a store and nothing put a store back onto a
//! drawn window, so every field was written by a test and by no operator: a
//! collapsed section, a dragged panel, a disclosed tool card and an unsent
//! draft were all lost on relaunch while the suites stayed green.
//!
//! The class this closes is a field that is persisted in one direction. Each
//! test drives the real window through the intents the operator's own clicks
//! raise, records through `Keeper` onto a scratch directory, and reads the
//! documents back onto a second window. The shapes are destructured
//! exhaustively, so a field added to `HostShape` or `SessionShape` fails to
//! compile here rather than silently persisting in neither direction.
//!
//! What it does not catch: the document format itself, which is the model
//! crate's sweep, and whether the debounce window is 400ms, which is the disk
//! suite in this crate.

mod support;

use std::time::Duration;

use support::memory::{
	CALL_WITH_VIEWS, FIRST, SECOND, disclosed_transcript, driven, keeper_over, store_on,
};
use veyyon_desktop_model::{DiffMode, QueueMode, SessionId};
use veyyon_desktop_surface::{HostShape, Intent, PanelTab, SessionShape};

#[test]
fn every_field_a_window_holds_is_written_and_read_back() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-round-trip");
	let recorded = driven(support::memory::seeded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		// The first sync is the one that adopts the session the host named and
		// hands the window whatever was remembered for it, which here is
		// nothing. What the operator does after that is what is recorded.
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
			})
			.expect("the keeper adopts the session the host named");
		session
			.update(|view, _window, cx| {
				// Everything below is what a click, a chord or a drag raises.
				view.dispatch(Intent::ToggleQueue, cx);
				view.dispatch(Intent::SetPanel { open: true }, cx);
				view.dispatch(Intent::SelectTab(1), cx);
				view.dispatch(Intent::SetDiffMode(DiffMode::Split), cx);
				view.dispatch(Intent::SetDrawer { open: true }, cx);
				view.dispatch(Intent::SetQueueMode(QueueMode::Queue), cx);
				view.set_composed("half a sentence, unsent", cx);
				view.rail_motion_mut().toggle_collapsed(
					veyyon_desktop_surface::Section::Parked,
					cx.background_executor().now(),
				);
				view.set_panel_width(620.0);
				view.rail_motion_mut().show_more_parked(1);
				// Reading back through the transcript, which is what leaves an
				// anchor: a view at the live edge holds none.
				view.transcript_viewport().scroll_to_offset(1, 12.0);
			})
			.expect("the window takes what the operator did");
		session.frame().expect("the window draws the shape it took");
		let shape = session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 1_000, cx);
				(view.host_shape(), view.session_shape())
			})
			.expect("the keeper records the drawn window");
		// The debounce window has to pass before anything is on the disk.
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 1_000 + 400, cx);
			})
			.expect("the keeper writes what is due");
		shape
	});

	let (loaded, rejections) = dir.load();
	assert_eq!(rejections, Vec::new(), "nothing this window wrote is refused");
	let host_back = support::memory::host_shape(&loaded);
	let session_back = support::memory::session_shape(&loaded, Some(&SessionId::from(FIRST)));

	let HostShape { queue_collapsed, collapsed_sections, parked_page } = &recorded.0;
	assert!(*queue_collapsed, "the rail was collapsed by the chord");
	assert_eq!(*parked_page, 2, "the operator paged in one more page of parked rows");
	assert_eq!(host_back.queue_collapsed, *queue_collapsed);
	assert_eq!(&host_back.collapsed_sections, collapsed_sections);
	assert_eq!(host_back.parked_page, *parked_page);
	assert!(
		collapsed_sections.contains("parked"),
		"the section the operator collapsed is named: {collapsed_sections:?}"
	);

	let SessionShape {
		panel_visible,
		panel_width_px,
		drawer_visible,
		drawer_height_px,
		active_panel_tab,
		active_drawer_tab,
		diff_mode,
		draft_text,
		attachment_paths,
		queue_mode,
		expanded_call_ids,
		scroll_anchor,
	} = &recorded.1;
	assert!(*panel_visible, "the panel was docked open");
	assert_eq!(*panel_width_px, Some(620.0));
	assert!(*drawer_visible, "the drawer was opened");
	assert_eq!(*active_panel_tab, PanelTab::File);
	assert_eq!(active_drawer_tab.as_deref(), Some("terminal:term-1"));
	assert_eq!(*diff_mode, DiffMode::Split);
	assert_eq!(draft_text, "half a sentence, unsent");
	assert_eq!(*queue_mode, QueueMode::Queue);
	let anchor = scroll_anchor
		.as_ref()
		.expect("a view scrolled off the live edge holds where it was read");
	assert_eq!(anchor.entry_id, "entry-1", "the anchor names the entry, not the index");
	assert_eq!(anchor.offset_px, 12.0);

	assert_eq!(session_back.panel_visible, *panel_visible);
	assert_eq!(session_back.panel_width_px, *panel_width_px);
	assert_eq!(session_back.drawer_visible, *drawer_visible);
	assert_eq!(session_back.drawer_height_px, *drawer_height_px);
	assert_eq!(session_back.active_panel_tab, *active_panel_tab);
	assert_eq!(session_back.active_drawer_tab, *active_drawer_tab);
	assert_eq!(session_back.diff_mode, *diff_mode);
	assert_eq!(session_back.draft_text, *draft_text);
	assert_eq!(session_back.attachment_paths, *attachment_paths);
	assert_eq!(session_back.queue_mode, *queue_mode);
	assert_eq!(session_back.expanded_call_ids, *expanded_call_ids);
	assert_eq!(session_back.scroll_anchor, *scroll_anchor);
}

#[test]
fn the_shape_read_off_the_disk_reaches_the_window_that_opens_next() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-restore");
	driven(support::memory::crowded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
			})
			.expect("the keeper adopts the session the host named");
		session
			.update(|view, _window, cx| {
				view.dispatch(Intent::ToggleQueue, cx);
				view.dispatch(Intent::SetPanel { open: true }, cx);
				view.dispatch(Intent::SelectTab(2), cx);
				view.set_composed("what the operator was typing", cx);
				view.set_panel_width(480.0);
				view.rail_motion_mut().show_more_parked(1);
				view.transcript_viewport().scroll_to_offset(1, 8.0);
			})
			.expect("the first window takes what the operator did");
		session.frame().expect("a frame draws it");
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 10, cx);
				keeper.sync(view, &mut store, window, 10 + 400, cx);
			})
			.expect("the first window writes it");
	});

	let (loaded, _) = dir.load();
	driven(support::memory::crowded(), |session| {
		let mut store = store_on(FIRST);
		store.persisted = loaded.clone();
		let mut keeper = keeper_over_loaded(&dir, loaded);
		session
			.update(|view, window, cx| {
				keeper.restore_host(view);
				// The active session is the host's, so the per-session shape
				// comes back through the same sync the window runs each tick.
				keeper.sync(view, &mut store, window, 1, cx);
			})
			.expect("the second window takes the shape back");
		session.frame().expect("the second window draws it");
		let (host, shape) = session
			.update(|view, _window, _cx| (view.host_shape(), view.session_shape()))
			.expect("the second window states what it holds");
		assert!(host.queue_collapsed, "the rail comes back collapsed");
		assert_eq!(
			host.parked_page, 2,
			"the parked rows the operator paged in come back paged in"
		);
		assert_eq!(shape.active_panel_tab, PanelTab::Tree);
		assert!(shape.panel_visible, "the panel comes back docked open");
		assert_eq!(shape.panel_width_px, Some(480.0));
		assert_eq!(shape.draft_text, "what the operator was typing");
		let anchor = shape
			.scroll_anchor
			.as_ref()
			.expect("the second window comes back where the first was reading");
		assert_eq!(anchor.entry_id, "entry-1");
		let placed = session
			.update(|view, _window, _cx| {
				(
					view.transcript_viewport().logical_scroll_top().item_ix,
					view.transcript_viewport().is_following_tail(),
				)
			})
			.expect("the window states where it placed the view");
		assert_eq!(placed.0, 1, "the anchor placed the view on the turn it names");
		assert!(!placed.1, "a window told where to open is not at the live edge");
	});
}

#[test]
fn the_session_the_operator_left_keeps_the_draft_they_left_in_it() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-two-sessions");
	driven(support::memory::seeded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		// The draft is typed and the host names another session before the next
		// sync, so one sync both records the outgoing session and hands the
		// incoming one its own shape. That is the ordering the keeper is
		// written around: recording after restoring writes the text the
		// operator left in one session under the key of the one they opened.
		session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
				view.set_composed("the first session's draft", cx);
				store.persisted.shell.active_session = Some(SessionId::from(SECOND));
				keeper.sync(view, &mut store, window, 1, cx);
			})
			.expect("one sync records the session left and opens the session entered");
		let carried = session
			.update(|view, _window, _cx| view.session_shape().draft_text)
			.expect("the window states the draft it now holds");
		assert_eq!(
			carried, "",
			"a session with no draft of its own opens empty, not holding the last one's"
		);

		session
			.update(|view, window, cx| {
				view.set_composed("the second session's draft", cx);
				keeper.sync(view, &mut store, window, 2, cx);
				keeper.sync(view, &mut store, window, 2 + 400, cx);
			})
			.expect("the second session's draft is recorded under its own key");

		let first = store
			.persisted
			.composer
			.get(&SessionId::from(FIRST))
			.expect("the first session kept an entry");
		let second = store
			.persisted
			.composer
			.get(&SessionId::from(SECOND))
			.expect("the second session has its own entry");
		assert_eq!(first.draft_text, "the first session's draft");
		assert_eq!(second.draft_text, "the second session's draft");
	});
}

#[test]
fn a_draft_typed_before_the_host_names_a_session_is_written_under_none() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-no-session");
	driven(support::memory::seeded(), |session| {
		let mut store = veyyon_desktop_model::Store::new();
		let mut keeper = keeper_over(&dir);
		session
			.update(|view, window, cx| {
				view.set_composed("typed with nothing open", cx);
				keeper.sync(view, &mut store, window, 1, cx);
				keeper.sync(view, &mut store, window, 1 + 400, cx);
			})
			.expect("the keeper runs with no session open");
		assert!(
			store.persisted.composer.is_empty(),
			"a draft belonging to no session is keyed by nothing: {:?}",
			store.persisted.composer
		);
	});
}

#[test]
fn a_disclosed_card_comes_back_open_and_the_host_is_told_it_is() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-disclosure");
	driven(disclosed_transcript(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		let shape = SessionShape {
			expanded_call_ids: std::iter::once(CALL_WITH_VIEWS.to_string()).collect(),
			..SessionShape::default()
		};
		session
			.update(|view, _window, cx| {
				view.restore_session_shape(&shape, cx);
				let _ = view.drain_intents();
			})
			.expect("the window takes the remembered disclosure");
		session
			.frame()
			.expect("the frame that draws the transcript applies it");
		let (intents, held) = session
			.update(|view, window, cx| {
				let intents = view.drain_intents();
				keeper.sync(view, &mut store, window, 1, cx);
				(intents, view.session_shape().expanded_call_ids)
			})
			.expect("the window states what it disclosed");
		assert!(
			intents.contains(&Intent::SetToolViewExpanded {
				call_id:  CALL_WITH_VIEWS.to_string(),
				expanded: true,
			}),
			"the host owns the disclosed view, so it is told: {intents:?}"
		);
		assert!(
			held.contains(CALL_WITH_VIEWS),
			"the card the window opened is the card it remembers: {held:?}"
		);
		session.advance(Duration::from_millis(1));
	});
}

#[test]
fn a_measure_no_operator_dragged_leaves_the_breakpoint_ladder_alone() {
	let (_tree, dir) = support::memory::state_dir("gui-memory-undragged");
	driven(support::memory::seeded(), |session| {
		let mut store = store_on(FIRST);
		let mut keeper = keeper_over(&dir);
		let shape = session
			.update(|view, window, cx| {
				keeper.sync(view, &mut store, window, 0, cx);
				keeper.sync(view, &mut store, window, 1, cx);
				view.session_shape()
			})
			.expect("a window nobody dragged is recorded");
		assert_eq!(
			shape.panel_width_px, None,
			"a width the operator never set is absent, so the shed decides it"
		);
		let panels = store
			.persisted
			.panels
			.get(&SessionId::from(FIRST))
			.expect("the session has an entry");
		assert_eq!(panels.right_panel_width, None);
		assert_eq!(panels.drawer_height, None);
	});
}

/// A keeper over a directory whose loaded state is `loaded`, which is what a
/// second launch starts from.
fn keeper_over_loaded(
	dir: &veyyon_desktop::state::StateDir,
	loaded: veyyon_desktop_model::PersistedState,
) -> veyyon_desktop::state::Keeper {
	veyyon_desktop::state::Keeper::new(dir.clone(), loaded)
}
