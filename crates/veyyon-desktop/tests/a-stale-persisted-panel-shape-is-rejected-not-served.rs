//! WHY: a persisted panel shape from an earlier version (such as version 1
//! without typed diff mode or with different fields) must be rejected rather
//! than silently served or corrupted into invalid runtime state (§8.10).
//!
//! The class this closes is "a stale persisted session state file from an older
//! release is deserialized into the active session without migration or
//! rejection".
//!
//! This suite writes a v1 `PanelsStore` JSON payload and asserts that
//! `load_or_default` rejects it with `PersistenceError::VersionMismatch` and
//! falls back to `PanelsStore::default()`.

use veyyon_desktop_model::{
	PanelsStore, PersistenceError, load_or_default, validate_and_deserialize,
};

#[test]
fn a_stale_version_one_panels_store_is_rejected_and_serves_default() {
	// Version 1 payload with boolean `diff_mode_split`
	let v1_payload = r#"{
		"version": 1,
		"right_panel_visible": true,
		"right_panel_width": 600,
		"drawer_visible": false,
		"drawer_height": 280,
		"open_right_tabs": ["diff", "file"],
		"active_right_tab": "diff",
		"open_drawer_tabs": [],
		"active_drawer_tab": null,
		"diff_mode_split": true
	}"#;

	let direct_result = validate_and_deserialize::<PanelsStore>(v1_payload);
	assert!(
		matches!(direct_result, Err(PersistenceError::VersionMismatch { found: 1, expected: 2 })),
		"validate_and_deserialize must return VersionMismatch for v1 payload, got: {direct_result:?}"
	);

	let (loaded, err) = load_or_default::<PanelsStore>(v1_payload);
	assert_eq!(
		loaded,
		PanelsStore::default(),
		"load_or_default must return default PanelsStore when version is stale"
	);
	assert!(
		matches!(err, Some(PersistenceError::VersionMismatch { found: 1, expected: 2 })),
		"load_or_default must report VersionMismatch error for stale version"
	);
}

#[test]
fn a_valid_current_version_two_panels_store_is_loaded_correctly() {
	let v2_store = PanelsStore {
		version:             2,
		right_panel_visible: true,
		right_panel_width:   580,
		drawer_visible:      true,
		drawer_height:       320,
		open_right_tabs:     vec!["diff".to_string(), "tree".to_string()],
		active_right_tab:    Some("diff".to_string()),
		open_drawer_tabs:    vec!["term".to_string()],
		active_drawer_tab:   Some("term".to_string()),
		diff_mode:           veyyon_desktop_model::DiffMode::Split,
	};

	let json = serde_json::to_string(&v2_store).expect("serialize v2 store");
	let (loaded, err) = load_or_default::<PanelsStore>(&json);

	assert!(err.is_none(), "loading valid v2 store must produce no error");
	assert_eq!(loaded, v2_store, "loaded store must match original v2 store");
}
