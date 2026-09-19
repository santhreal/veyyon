//! Whole-window scene builders (§9.2, pass X1).
//!
//! Synthesises whole-window states across the 12 lifecycle and assembly states:
//! rest, populated, streaming, panel docked, panel overlaid, drawer open,
//! both open, dialog up, toast, mid-approval, disconnected, and first-run.
//!
//! The content each state is assembled from is in `fixtures`.

mod fixtures;

use veyyon_desktop_model::{
	ApprovalInteraction, ConnectionState, ContentBlock, InteractionId, MessageRole, Notification,
	NotificationPriority, NotificationSource, QueueMode, QueuePartition, SettingEntry, SettingKind,
	SettingsView,
};
use veyyon_desktop_surface::{Badge, Overlay, TurnPhase};

use self::fixtures::{add_drawer_content, add_right_panel_content, base_populated_seed};
use crate::{
	project::connection_notice,
	scene::seed::{Built, SCENE_CLOCK_MS, Seed},
};

/// 1. Whole window at rest: single session, transcript, idle composer, no
///    panels.
#[must_use]
pub fn whole_window_rest() -> Built {
	let mut seed = Seed::attached();
	let active_id = seed.session(QueuePartition::Live);
	if let Some(s) = seed.store.sessions.get_mut(&active_id) {
		s.title = "File tree row retention".to_string();
	}
	seed.entry(&active_id, MessageRole::User, vec![ContentBlock::Text {
		text: "Keep the file tree's expanded rows across a panel resize.".to_string(),
	}]);
	seed.entry(&active_id, MessageRole::Assistant, vec![ContentBlock::Text {
		text: "The tree holds its expanded rows across a resize.".to_string(),
	}]);
	seed.state.title = "veyyon · File tree row retention".to_string();
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = false;
	built
}

/// 2. Whole window with content and no panels: four sessions with badges, a
///    transcript carrying a code block, and both side surfaces closed (§9.2,
///    pass X1).
#[must_use]
pub fn whole_window_populated() -> Built {
	let (seed, _) = base_populated_seed();
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = false;
	built
}

/// 3. Whole window during active streaming turn with tool run status.
#[must_use]
pub fn whole_window_streaming() -> Built {
	let (mut seed, active_id) = base_populated_seed();
	add_right_panel_content(&mut seed);
	seed.stream(&active_id, "bash");
	let mut built = seed.finish();
	built.state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	built.state.run_status = Some((Badge::Working, "bash · compiling veyyon-desktop".to_string()));
	built
}

/// 4. Whole window with the right panel open beside the transcript.
///
/// The overlaid presentation is the same panel below the 980px row, which one
/// viewport cannot show, so the shed's own suite proves it instead.
#[must_use]
pub fn whole_window_panel_docked() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = false;
	built.state.drawer_open = false;
	built
}

/// 5. Whole window with terminal drawer open.
#[must_use]
pub fn whole_window_drawer_open() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_drawer_content(&mut seed);
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = true;
	built
}

/// 6. Whole window with both right panel and terminal drawer open.
#[must_use]
pub fn whole_window_both_open() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	add_drawer_content(&mut seed);
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = false;
	built.state.drawer_open = true;
	built
}

/// 7. Whole window with modal Settings dialog up.
#[must_use]
pub fn whole_window_dialog_up() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let mut settings = SettingsView::new();
	let entry = |value: serde_json::Value, kind: SettingKind, label: &str| SettingEntry {
		value: value.clone(),
		default: value,
		source: "default".to_string(),
		kind,
		label: Some(label.to_string()),
		description: Some("Configures desktop interface behavior.".to_string()),
		tab: Some("General".to_string()),
		group: None,
		values: Vec::new(),
		options: Vec::new(),
		min: None,
		max: None,
		global: false,
		advanced: false,
		hidden: false,
	};
	settings.insert(
		"ui.compact".to_string(),
		entry(serde_json::Value::Bool(true), SettingKind::Boolean, "Compact rows"),
	);
	settings.insert(
		"ui.theme".to_string(),
		entry(serde_json::Value::String("dark".to_string()), SettingKind::String, "Theme"),
	);
	seed.store.domains.settings = Some(settings);
	// The overlay is set before the seed is finished, because the schema
	// reaches the sheet through the overlay projection that `finish` runs: an
	// overlay attached afterwards draws the no-schema empty state over a
	// populated store.
	seed.state.overlay = Some(Overlay::Settings(Box::default()));
	seed.finish()
}

/// 8. Whole window with announcement toast cards displayed.
#[must_use]
pub fn whole_window_toast() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	seed.store.notifications.raise(Notification {
		key:          "toast_001".to_string(),
		source:       NotificationSource::RequestFailed,
		priority:     NotificationPriority::Normal,
		title:        "Host refused to write src/main.rs".to_string(),
		detail:       Some("The path is outside the workspace root".to_string()),
		raised_at_ms: SCENE_CLOCK_MS - 2_000,
	});
	seed.store.notifications.raise(Notification {
		key:          "toast_002".to_string(),
		source:       NotificationSource::DecisionWaiting,
		priority:     NotificationPriority::Low,
		title:        "Approval waiting on Run clippy and cargo check".to_string(),
		detail:       None,
		raised_at_ms: SCENE_CLOCK_MS - 1_000,
	});
	seed.finish()
}

/// 9. Whole window mid-approval with a pending action card above the composer.
#[must_use]
pub fn whole_window_mid_approval() -> Built {
	let (mut seed, active_id) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let unread = SCENE_CLOCK_MS - 5_000;
	seed.decide(&active_id, |pending| {
		pending.approvals.push(ApprovalInteraction {
			id:              InteractionId::from("interaction_0001"),
			tool_name:       "bash".to_string(),
			detail:          "cargo test -p veyyon-desktop --all-targets".to_string(),
			requested_at_ms: unread,
		});
	});
	seed.finish()
}

/// 10. Whole window in reconnecting / disconnected state with attention strip.
#[must_use]
pub fn whole_window_disconnected() -> Built {
	let (mut seed, _) = base_populated_seed();
	add_right_panel_content(&mut seed);
	let conn = ConnectionState::Reconnecting {
		attempt:     3,
		retry_at_ms: SCENE_CLOCK_MS + 2_000,
		message:     "connection reset by peer".to_string(),
	};
	seed.notice = connection_notice(&conn);
	seed.store.connection = conn;
	let mut built = seed.finish();
	built.state.connection = veyyon_desktop_surface::ConnectionPhase::Reconnecting {
		attempt:     3,
		retry_at_ms: SCENE_CLOCK_MS + 2_000,
		message:     "connection reset by peer".to_string(),
	};
	built
}

/// 11. Whole window on first run with empty queue and welcome prompt.
#[must_use]
pub fn whole_window_first_run() -> Built {
	let mut seed = Seed::attached();
	seed.store.persisted.shell.active_session = None;
	let mut built = seed.finish();
	built.state.keymap.panel_collapsed = true;
	built.state.drawer_open = false;
	built.state.title = "veyyon".to_string();
	built
}
