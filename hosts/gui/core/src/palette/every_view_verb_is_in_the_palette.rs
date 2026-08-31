//! WHY: a control reachable only by a click at a coordinate. The panels, the
//! dock's tabs, the inspector's tabs and the appearance switches were each
//! wired to one element and nothing else, so a reader without a pointer could
//! not reach them, and a recording that clicked where the control used to be
//! recorded the previous frame twice instead of failing.
//!
//! The class this closes is a verb with one route to it. The palette is the
//! surface that has to hold every verb, so the sweep below derives the verb
//! space from the sets the product itself enumerates — `BottomTab::ALL`,
//! `InspectorTab::ALL`, the panel toggles, both appearances — and a member
//! added to any of them turns this red until it is listed. Each row is then
//! accepted through the real store, so a row that resolves to nothing, or that
//! leaves the palette open on top of the change, fails here.
//!
//! Not covered: whether the change is visible. Two of these verbs move a panel
//! by animating it, and the recorded scenes own that.

use crate::{
	Store, UiCommand,
	model::{
		ConnectionState, ContentBlock, EntryId, MessageRole, PlanApproval, PlanState, RemoteData,
		TranscriptEntry, Value, Versioned,
	},
	navigation::{BottomTab, InspectorTab, Overlay, PaletteMode},
	palette::{Item, results},
};

fn store_with_verbs() -> Store {
	let mut store = Store::detached();
	store.connection = ConnectionState::Connected { endpoint: "local".to_owned(), protocol: 1 };
	store
		.frontend
		.overlays
		.push(Overlay::CommandPalette { mode: PaletteMode::Commands });
	store
}

fn rows(store: &Store) -> Vec<Item> {
	results(store, PaletteMode::Commands, "")
		.groups
		.into_iter()
		.flat_map(|group| group.items)
		.collect()
}

fn commands(store: &Store) -> Vec<UiCommand> {
	rows(store)
		.into_iter()
		.flat_map(|item| item.commands)
		.collect()
}

/// Every verb the palette has to carry, derived from the sets the product
/// enumerates rather than written out, so a new tab is red until it is here.
fn required(store: &Store) -> Vec<UiCommand> {
	let mut wanted = vec![
		UiCommand::ToggleSidebar,
		UiCommand::ToggleInspector,
		UiCommand::ToggleBottomDock,
		UiCommand::JumpToOldest,
		UiCommand::JumpToLatest,
		UiCommand::SetDarkAppearance(true),
		UiCommand::SetDarkAppearance(false),
		UiCommand::SetReducedMotion(!store.frontend.preferences.reduced_motion),
	];
	wanted.extend(BottomTab::ALL.map(UiCommand::SetBottomTab));
	wanted.extend(InspectorTab::ALL.map(UiCommand::SetInspectorTab));
	wanted
}

#[test]
fn every_view_verb_is_reachable_from_the_command_palette() {
	let store = store_with_verbs();
	let listed = commands(&store);
	let missing: Vec<String> = required(&store)
		.into_iter()
		.filter(|command| !listed.contains(command))
		.map(|command| format!("{command:?}"))
		.collect();
	assert_eq!(missing, Vec::<String>::new());
}

#[test]
fn a_verb_closes_the_palette_before_it_changes_anything() {
	// A verb accepted with the palette still on top changes the window behind
	// an overlay nobody asked to keep, which is how a toggle reads as doing
	// nothing.
	let store = store_with_verbs();
	for item in rows(&store) {
		if item.commands.is_empty() {
			continue;
		}
		assert_eq!(
			item.commands.first(),
			Some(&UiCommand::CloseTopOverlay),
			"{} runs before the palette closes",
			item.title
		);
	}
}

#[test]
fn accepting_a_verb_runs_it_and_leaves_no_overlay_behind() {
	// Driven through the store the window drives: the cursor walks the rendered
	// rows, `AcceptPalette` runs the row's sequence, and the assertion is on the
	// state that sequence produced.
	let required = required(&store_with_verbs());
	for command in required {
		let mut store = store_with_verbs();
		let panels = store.frontend.panels.clone();
		let index = rows(&store)
			.into_iter()
			.position(|item| item.commands.contains(&command))
			.unwrap_or_else(|| panic!("{command:?} is not a palette row"));
		store.frontend.palette_cursor = index;
		let effects = store.dispatch(UiCommand::AcceptPalette);
		assert!(store.frontend.overlays.is_empty(), "{command:?} left an overlay open");
		// A verb either changed frontend state or reached the shell. One that
		// did neither is a row that resolves to nothing.
		let acted = !effects.shell.is_empty() || !effects.requests.is_empty();
		match command {
			// A toggle is asserted against the state it started from, because
			// the contract is the flip and not the value a default happens to
			// hold.
			UiCommand::ToggleSidebar => {
				assert_eq!(store.frontend.panels.sidebar_open, !panels.sidebar_open)
			},
			UiCommand::ToggleInspector => {
				assert_eq!(store.frontend.panels.inspector_open, !panels.inspector_open)
			},
			UiCommand::ToggleBottomDock => {
				assert_eq!(store.frontend.panels.bottom_open, !panels.bottom_open)
			},
			UiCommand::SetBottomTab(tab) => assert_eq!(store.frontend.bottom_tab, tab),
			UiCommand::SetInspectorTab(tab) => assert_eq!(store.frontend.inspector_tab, tab),
			UiCommand::SetDarkAppearance(dark) => {
				assert_eq!(store.frontend.preferences.dark, dark)
			},
			UiCommand::SetReducedMotion(value) => {
				assert_eq!(store.frontend.preferences.reduced_motion, value)
			},
			UiCommand::JumpToOldest | UiCommand::JumpToLatest => {
				assert!(acted, "{command:?} reached nothing")
			},
			other => panic!("{other:?} has no assertion in this sweep"),
		}
	}
}

#[test]
fn the_palette_states_which_tab_and_appearance_are_in_force() {
	// A list of verbs with nothing marked current is a list a reader has to
	// guess at. The dock's tabs are the case that turns on it: three rows that
	// look identical unless one of them says it is the one on screen.
	let mut store = store_with_verbs();
	store.frontend.panels.bottom_open = true;
	store.frontend.bottom_tab = BottomTab::Problems;
	let current = |store: &Store| -> Vec<String> {
		rows(store)
			.into_iter()
			.filter(|item| item.current)
			.map(|item| item.title)
			.collect()
	};

	store.frontend.preferences.dark = false;
	let light = current(&store);
	assert!(light.contains(&"Show problems".to_owned()), "{light:?}");
	assert!(!light.contains(&"Show terminals".to_owned()), "{light:?}");
	assert!(light.contains(&"Light appearance".to_owned()), "{light:?}");
	assert!(!light.contains(&"Dark appearance".to_owned()), "{light:?}");

	// Both directions, because a row hardcoded to either value satisfies one of
	// them: this is the assertion a `current: false` in the dark row survives.
	store.frontend.preferences.dark = true;
	let dark = current(&store);
	assert!(dark.contains(&"Dark appearance".to_owned()), "{dark:?}");
	assert!(!dark.contains(&"Light appearance".to_owned()), "{dark:?}");

	// And reduced motion, which is a toggle rather than a pair: current says it
	// is on, not that accepting it turns it on.
	assert!(!dark.contains(&"Toggle reduced motion".to_owned()), "{dark:?}");
	store.frontend.preferences.reduced_motion = true;
	assert!(current(&store).contains(&"Toggle reduced motion".to_owned()));
}

#[test]
fn a_closed_dock_marks_none_of_its_tabs_current() {
	// The stored tab survives the dock closing, so a row that reads the tab
	// alone claims a panel that is not on screen is showing.
	let mut store = store_with_verbs();
	store.frontend.panels.bottom_open = false;
	store.frontend.panels.inspector_open = false;
	let shown: Vec<String> = rows(&store)
		.into_iter()
		.filter(|item| item.title.starts_with("Show "))
		.map(|item| item.title)
		.collect();
	// Every tab of both panels is listed, so the assertion below covers the
	// whole set rather than whichever rows happen to exist.
	assert_eq!(shown.len(), BottomTab::ALL.len() + InspectorTab::ALL.len());
	for item in rows(&store) {
		if item.title.starts_with("Show ") {
			assert!(!item.current, "{} claims a closed panel is showing", item.title);
		}
	}
}

#[test]
fn a_plan_waiting_for_review_and_an_image_are_listed_with_the_conversation() {
	// Both were reachable from one element each: a banner button and a button
	// inside a message. The group appears only when there is something in it,
	// which is why the group set pinned in `tests.rs` does not carry it.
	let mut store = store_with_verbs();
	assert!(
		!results(&store, PaletteMode::Commands, "")
			.groups
			.iter()
			.any(|group| group.id == "content")
	);

	store.replica.plan = RemoteData::Ready(Versioned {
		revision: 1,
		value:    PlanState::Active {
			file_path: "plan.md".to_owned(),
			workflow:  None,
			reentry:   None,
			content:   RemoteData::Empty,
			approval:  Some(Box::new(PlanApproval {
				title:       Some("Ship the parser".to_owned()),
				summary:     None,
				request:     None,
				interaction: None,
			})),
		},
	});
	let entry = EntryId::new("entry-1").expect("entry id");
	store.replica.transcript = RemoteData::Ready(Versioned {
		revision: 1,
		value:    vec![TranscriptEntry {
			id:                entry.clone(),
			parent:            None,
			revision:          1,
			timestamp_ms:      1,
			role:              MessageRole::Assistant,
			content:           vec![
				ContentBlock::Text { text: "here it is".to_owned() },
				ContentBlock::Image {
					media_type: "image/png".to_owned(),
					data:       vec![1, 2, 3],
					alt:        Some("a diagram".to_owned()),
				},
				// No bytes: the message draws a fallback with nothing to open,
				// so the palette offers nothing either.
				ContentBlock::Image {
					media_type: "image/png".to_owned(),
					data:       Vec::new(),
					alt:        None,
				},
			],
			meta:              None,
			raw_discriminator: "assistant".to_owned(),
			raw:               Value::Null,
		}],
	});

	let groups = results(&store, PaletteMode::Commands, "").groups;
	let content = groups
		.iter()
		.find(|group| group.id == "content")
		.expect("the conversation's own group");
	let titles: Vec<&str> = content
		.items
		.iter()
		.map(|item| item.title.as_str())
		.collect();
	assert_eq!(titles, vec!["Review plan", "Open image"]);
	// The image row names the block it opens, not the image's position among
	// images: that index is what the message's own button sends.
	assert_eq!(content.items[1].commands, vec![UiCommand::CloseTopOverlay, UiCommand::OpenImage {
		entry,
		index: 1
	},]);

	store.frontend.palette_cursor = rows(&store)
		.into_iter()
		.position(|item| item.title == "Review plan")
		.expect("the plan row");
	store.dispatch(UiCommand::AcceptPalette);
	assert_eq!(store.frontend.overlays, vec![Overlay::PlanReview {
		request:     None,
		interaction: None,
	}]);
}
