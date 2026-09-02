use veyyon_desktop_model::{
	ComposerStore, PanelsStore, PersistenceError, QueueStore, ShellStore, TokensStore,
	TranscriptStore, WindowStore, load_or_default, validate_and_deserialize,
};

#[test]
fn test_persistence_window_store() {
	let original = WindowStore {
		version:    1,
		x:          50,
		y:          80,
		width:      1400,
		height:     900,
		maximized:  true,
		display_id: Some("display-1".to_string()),
	};

	// 1. Round trip
	let json = serde_json::to_string(&original).unwrap();
	let decoded: WindowStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// 2. Version one lower (0) rejected
	let lower_json = r#"{"version":0,"x":50,"y":80,"width":1400,"height":900,"maximized":true,"display_id":"display-1"}"#;
	let (loaded, err) = load_or_default::<WindowStore>(lower_json);
	assert_eq!(loaded, WindowStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// 3. Version one higher (2) rejected
	let higher_json = r#"{"version":2,"x":50,"y":80,"width":1400,"height":900,"maximized":true,"display_id":"display-1"}"#;
	let (loaded, err) = load_or_default::<WindowStore>(higher_json);
	assert_eq!(loaded, WindowStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// 4. Truncated payload rejected
	let trunc_json = r#"{"version":1,"x":50,"y":80,"width":1400"#;
	let (loaded, err) = load_or_default::<WindowStore>(trunc_json);
	assert_eq!(loaded, WindowStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// 5. Unknown key rejected
	let unknown_json = r#"{"version":1,"x":50,"y":80,"width":1400,"height":900,"maximized":true,"display_id":null,"unknown_field":42}"#;
	let (loaded, err) = load_or_default::<WindowStore>(unknown_json);
	assert_eq!(loaded, WindowStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}

#[test]
fn test_persistence_shell_store() {
	let original = ShellStore {
		version:         1,
		queue_width:     320,
		queue_collapsed: true,
		active_session:  Some("s1".into()),
	};

	let json = serde_json::to_string(&original).unwrap();
	let decoded: ShellStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// Version one lower
	let (loaded, err) = load_or_default::<ShellStore>(
		r#"{"version":0,"queue_width":320,"queue_collapsed":true,"active_session":"s1"}"#,
	);
	assert_eq!(loaded, ShellStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Version one higher
	let (loaded, err) = load_or_default::<ShellStore>(
		r#"{"version":2,"queue_width":320,"queue_collapsed":true,"active_session":"s1"}"#,
	);
	assert_eq!(loaded, ShellStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Truncated
	let (loaded, err) = load_or_default::<ShellStore>(r#"{"version":1,"queue_width":320"#);
	assert_eq!(loaded, ShellStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// Unknown key
	let (loaded, err) = load_or_default::<ShellStore>(
		r#"{"version":1,"queue_width":320,"queue_collapsed":true,"active_session":"s1","extra":true}"#,
	);
	assert_eq!(loaded, ShellStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}

#[test]
fn test_persistence_panels_store() {
	let original = PanelsStore {
		version:             2,
		right_panel_visible: true,
		right_panel_width:   600,
		drawer_visible:      true,
		drawer_height:       300,
		open_right_tabs:     vec!["diff".to_string()],
		active_right_tab:    Some("diff".to_string()),
		open_drawer_tabs:    vec!["terminal-1".to_string()],
		active_drawer_tab:   Some("terminal-1".to_string()),
		diff_mode:           veyyon_desktop_model::DiffMode::Split,
	};

	let json = serde_json::to_string(&original).unwrap();
	let decoded: PanelsStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// Version lower (e.g. stale version 1)
	let (loaded, err) = load_or_default::<PanelsStore>(
		r#"{"version":1,"right_panel_visible":false,"right_panel_width":540,"drawer_visible":false,"drawer_height":280,"open_right_tabs":[],"active_right_tab":null,"open_drawer_tabs":[],"active_drawer_tab":null,"diff_mode":"unified"}"#,
	);
	assert_eq!(loaded, PanelsStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Version higher
	let (loaded, err) = load_or_default::<PanelsStore>(
		r#"{"version":3,"right_panel_visible":false,"right_panel_width":540,"drawer_visible":false,"drawer_height":280,"open_right_tabs":[],"active_right_tab":null,"open_drawer_tabs":[],"active_drawer_tab":null,"diff_mode":"unified"}"#,
	);
	assert_eq!(loaded, PanelsStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Truncated
	let (loaded, err) = load_or_default::<PanelsStore>(r#"{"version":2,"right_panel_visible":true"#);
	assert_eq!(loaded, PanelsStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// Unknown key
	let (loaded, err) = load_or_default::<PanelsStore>(
		r#"{"version":2,"right_panel_visible":false,"right_panel_width":540,"drawer_visible":false,"drawer_height":280,"open_right_tabs":[],"active_right_tab":null,"open_drawer_tabs":[],"active_drawer_tab":null,"diff_mode":"unified","rogue_key":123}"#,
	);
	assert_eq!(loaded, PanelsStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}

#[test]
fn test_persistence_transcript_store() {
	let original = TranscriptStore {
		version:              1,
		scroll_anchor_entry:  Some("entry-10".into()),
		scroll_anchor_offset: 42.5,
		collapsed_block_ids:  std::iter::once("block-1".to_string()).collect(),
	};

	let json = serde_json::to_string(&original).unwrap();
	let decoded: TranscriptStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// Lower
	let (loaded, err) = load_or_default::<TranscriptStore>(
		r#"{"version":0,"scroll_anchor_entry":"entry-10","scroll_anchor_offset":42.5,"collapsed_block_ids":["block-1"]}"#,
	);
	assert_eq!(loaded, TranscriptStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Higher
	let (loaded, err) = load_or_default::<TranscriptStore>(
		r#"{"version":2,"scroll_anchor_entry":"entry-10","scroll_anchor_offset":42.5,"collapsed_block_ids":["block-1"]}"#,
	);
	assert_eq!(loaded, TranscriptStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Truncated
	let (loaded, err) = load_or_default::<TranscriptStore>(r#"{"version":1,"scroll_anchor"#);
	assert_eq!(loaded, TranscriptStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// Unknown key
	let (loaded, err) = load_or_default::<TranscriptStore>(
		r#"{"version":1,"scroll_anchor_entry":null,"scroll_anchor_offset":0.0,"collapsed_block_ids":[],"bad":1}"#,
	);
	assert_eq!(loaded, TranscriptStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}

#[test]
fn test_persistence_composer_store() {
	let original = ComposerStore {
		version:     1,
		draft_text:  "Hello, world!".to_string(),
		attachments: vec!["/path/file.txt".to_string()],
		queue_mode:  veyyon_desktop_model::QueueMode::Queue,
	};

	let json = serde_json::to_string(&original).unwrap();
	let decoded: ComposerStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// Lower
	let (loaded, err) = load_or_default::<ComposerStore>(
		r#"{"version":0,"draft_text":"hi","attachments":[],"queue_mode":"Steer"}"#,
	);
	assert_eq!(loaded, ComposerStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Higher
	let (loaded, err) = load_or_default::<ComposerStore>(
		r#"{"version":2,"draft_text":"hi","attachments":[],"queue_mode":"Steer"}"#,
	);
	assert_eq!(loaded, ComposerStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Truncated
	let (loaded, err) = load_or_default::<ComposerStore>(r#"{"version":1,"draft_text":"hi"#);
	assert_eq!(loaded, ComposerStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// Unknown key
	let (loaded, err) = load_or_default::<ComposerStore>(
		r#"{"version":1,"draft_text":"","attachments":[],"queue_mode":"Steer","unknown":null}"#,
	);
	assert_eq!(loaded, ComposerStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}

#[test]
fn test_persistence_queue_store() {
	let original = QueueStore {
		version:            1,
		deferred_collapsed: true,
		parked_collapsed:   true,
		parked_page_size:   50,
	};

	let json = serde_json::to_string(&original).unwrap();
	let decoded: QueueStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// Lower
	let (loaded, err) = load_or_default::<QueueStore>(
		r#"{"version":0,"deferred_collapsed":false,"parked_collapsed":false,"parked_page_size":25}"#,
	);
	assert_eq!(loaded, QueueStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Higher
	let (loaded, err) = load_or_default::<QueueStore>(
		r#"{"version":2,"deferred_collapsed":false,"parked_collapsed":false,"parked_page_size":25}"#,
	);
	assert_eq!(loaded, QueueStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Truncated
	let (loaded, err) = load_or_default::<QueueStore>(r#"{"version":1,"deferred_collapsed":false"#);
	assert_eq!(loaded, QueueStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// Unknown key
	let (loaded, err) = load_or_default::<QueueStore>(
		r#"{"version":1,"deferred_collapsed":false,"parked_collapsed":false,"parked_page_size":25,"extra_key":"bad"}"#,
	);
	assert_eq!(loaded, QueueStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}

#[test]
fn test_persistence_tokens_store() {
	let original = TokensStore { version: 1, overrides_toml: "font_size = 14".to_string() };

	let json = serde_json::to_string(&original).unwrap();
	let decoded: TokensStore = validate_and_deserialize(&json).unwrap();
	assert_eq!(original, decoded);

	// Lower
	let (loaded, err) = load_or_default::<TokensStore>(r#"{"version":0,"overrides_toml":""}"#);
	assert_eq!(loaded, TokensStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Higher
	let (loaded, err) = load_or_default::<TokensStore>(r#"{"version":2,"overrides_toml":""}"#);
	assert_eq!(loaded, TokensStore::default());
	assert!(matches!(err, Some(PersistenceError::VersionMismatch { .. })));

	// Truncated
	let (loaded, err) = load_or_default::<TokensStore>(r#"{"version":1,"overrides_toml":"#);
	assert_eq!(loaded, TokensStore::default());
	assert!(matches!(err, Some(PersistenceError::TruncatedPayload)));

	// Unknown key
	let (loaded, err) =
		load_or_default::<TokensStore>(r#"{"version":1,"overrides_toml":"","unexpected":true}"#);
	assert_eq!(loaded, TokensStore::default());
	assert!(matches!(err, Some(PersistenceError::DeserializationFailed(_))));
}
