//! WHY: tabs must retain host identities and per-space selection without
//! creating runtime sessions. This covers membership transitions and
//! malformed/stale persisted navigation; native pointer routing and host
//! acknowledgements are covered by desktop integration.

use serde_json::json;
use veyyon_desktop_model::{
	PanelsStore, PersistenceError, SessionId, ShellStore, VersionedStore,
	persistence::{NavigationStore, load_or_default, validate_and_deserialize},
};

fn id(value: &str) -> SessionId {
	value.into()
}

#[test]
fn reorder_and_close_preserve_identity_and_choose_the_right_neighbor_then_left() {
	let mut nav = NavigationStore::default();
	for session in ["one", "two", "three", "four"] {
		nav.opened(id(session));
	}
	nav.opened(id("two"));
	nav.reorder(&id("four"), &id("one"));
	assert_eq!(nav.active().tabs, [id("four"), id("one"), id("two"), id("three")]);
	assert_eq!(nav.active().selected, Some(id("two")));
	nav.reorder(&id("four"), &id("three"));
	assert_eq!(nav.active().tabs, [id("one"), id("two"), id("three"), id("four")]);
	assert_eq!(nav.close(&id("two")), Some(id("three")));
	assert_eq!(nav.close(&id("one")), Some(id("three")));
	assert_eq!(nav.close(&id("three")), Some(id("four")));
	assert_eq!(nav.close(&id("four")), None);
	assert!(nav.active().tabs.is_empty());
	assert!(nav.is_initialized(), "closing the final tab does not adopt the host's old session");
}

#[test]
fn named_spaces_round_trip_independent_selection_and_layout() {
	let mut shell = ShellStore::default();
	let nav = &mut shell.navigation;
	nav.opened(id("one"));
	nav.opened(id("two"));
	nav.active_mut()
		.panels
		.insert(id("one"), PanelsStore { right_panel_width: Some(620), ..PanelsStore::default() });
	let research = nav.create("Research").unwrap();
	assert!(nav.rename(research, "Reading"));
	assert!(nav.switch(research));
	nav.opened(id("one"));
	nav.active_mut().queue_collapsed = true;
	nav.active_mut()
		.panels
		.insert(id("one"), PanelsStore { right_panel_width: Some(400), ..PanelsStore::default() });
	let bytes = serde_json::to_string(&shell).unwrap();
	let restored: ShellStore = validate_and_deserialize(&bytes).unwrap();
	assert_eq!(restored, shell);
	let mut nav = restored.navigation;
	assert_eq!(nav.active().selected, Some(id("one")));
	assert!(nav.active().queue_collapsed);
	assert!(nav.switch(1));
	assert_eq!(nav.active().selected, Some(id("two")));
	assert!(!nav.active().queue_collapsed);
	assert_eq!(nav.active().panels[&id("one")].right_panel_width, Some(620));
	assert!(!nav.rename(research, "Default"));
	assert!(!nav.rename(research, "  "));
	assert_eq!(nav.create("Default"), None);
	assert!(!nav.switch(999));
	assert_eq!(nav.active().id, 1);
}

#[test]
fn space_buttons_keep_creation_order_across_activation_and_relaunch() {
	let mut shell = ShellStore::default();
	let research = shell.navigation.create("Research").unwrap();
	let review = shell.navigation.create("Review").unwrap();
	let expected = [(1, "Default"), (research, "Research"), (review, "Review")];
	for (target, _) in expected
		.iter()
		.rev()
		.chain(expected.iter())
		.cycle()
		.take(18)
	{
		assert!(shell.navigation.switch(*target));
		assert_eq!(
			shell
				.navigation
				.spaces()
				.map(|space| (space.id, space.name.as_str()))
				.collect::<Vec<_>>(),
			expected
		);
		let mut saved = serde_json::to_value(&shell).unwrap();
		// Document array order does not change stable button positions.
		saved["navigation"]["spaces"]
			.as_array_mut()
			.unwrap()
			.rotate_left(1);
		let restored: ShellStore = validate_and_deserialize(&saved.to_string()).unwrap();
		assert_eq!(restored.navigation.active().id, *target);
		assert_eq!(
			restored
				.navigation
				.spaces()
				.map(|space| (space.id, space.name.as_str()))
				.collect::<Vec<_>>(),
			expected
		);
		shell = restored;
	}
}

#[test]
fn invalid_navigation_and_nested_versions_are_rejected_without_partial_restore() {
	let mut shell = ShellStore::default();
	shell.navigation.opened(id("one"));
	let valid = serde_json::to_value(&shell).unwrap();
	let mut variants = Vec::new();
	for (field, value) in [
		("tabs", json!(["one", "one"])),
		("tabs", json!([""])),
		("selected", json!("missing")),
		("selected", json!(null)),
		("name", json!("  ")),
		("id", json!(0)),
	] {
		let mut invalid = valid.clone();
		invalid["navigation"]["spaces"][0][field] = value;
		variants.push(invalid);
	}
	let mut missing = valid.clone();
	missing["navigation"]["active_space"] = json!(999);
	variants.push(missing);
	let mut duplicated = valid.clone();
	duplicated["navigation"]["spaces"]
		.as_array_mut()
		.unwrap()
		.push(valid["navigation"]["spaces"][0].clone());
	variants.push(duplicated);
	let mut stale_layout = valid.clone();
	stale_layout["navigation"]["spaces"][0]["queue"]["version"] = json!(0);
	variants.push(stale_layout);
	let mut stale_draft = valid.clone();
	stale_draft["navigation"]["spaces"][0]["empty_draft"]["version"] = json!(0);
	variants.push(stale_draft);
	let mut stale_panel = valid.clone();
	let mut panel = serde_json::to_value(PanelsStore::default()).unwrap();
	panel["version"] = json!(0);
	stale_panel["navigation"]["spaces"][0]["panels"]["one"] = panel;
	variants.push(stale_panel);
	for invalid in variants {
		let (loaded, error) = load_or_default::<ShellStore>(&invalid.to_string());
		assert_eq!(loaded, ShellStore::default());
		assert!(error.is_some(), "invalid document was accepted: {invalid}");
	}
	let mut stale = valid;
	stale["version"] = json!(ShellStore::CURRENT_VERSION - 1);
	stale.as_object_mut().unwrap().remove("navigation");
	assert_eq!(
		validate_and_deserialize::<ShellStore>(&stale.to_string()),
		Err(PersistenceError::VersionMismatch {
			expected: ShellStore::CURRENT_VERSION,
			found:    ShellStore::CURRENT_VERSION - 1,
		})
	);
}
