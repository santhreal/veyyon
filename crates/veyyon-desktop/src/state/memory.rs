//! The window's shape as the stores §8.10 keeps it in, and back.
//!
//! `veyyon-desktop-surface` states what the window holds without knowing it is
//! written anywhere; `veyyon-desktop-model` states the documents without
//! knowing what draws them. This module is the one place the two meet, so a
//! field added to a store reaches the window here or nowhere.

use veyyon_desktop_model::{
	ComposerStore, PanelsStore, PersistedState, QueueStore, SessionId, ShellStore, TranscriptAnchor,
	TranscriptStore, VersionedStore as _,
};
use veyyon_desktop_surface::{HostShape, PanelTab, ScrollAnchor, SessionShape};
use veyyon_desktop_tokens::{APPEARANCES, DEFAULT_APPEARANCE};
use veyyon_gpui::{Bounds, Pixels};

/// The appearance the stores name, resolved against what this build ships.
///
/// A name no bundled theme draws -- a store written by a later build, or a
/// theme file that has since gone -- resolves to the default rather than
/// travelling on to the window, which would ask for an install that fails
/// under the operator's pointer.
#[must_use]
pub fn chosen_appearance(state: &PersistedState) -> &'static str {
	state
		.shell
		.appearance
		.as_deref()
		.and_then(|chosen| APPEARANCES.into_iter().find(|known| *known == chosen))
		.unwrap_or(DEFAULT_APPEARANCE)
}

/// What the loaded stores state about every session at once.
#[must_use]
pub fn host_shape(state: &PersistedState) -> HostShape {
	HostShape {
		navigation:         state.shell.navigation.clone(),
		queue_collapsed:    state.shell.navigation.active().queue_collapsed,
		collapsed_sections: state
			.shell
			.navigation
			.active()
			.queue
			.collapsed_sections
			.clone(),
		parked_page:        state.shell.navigation.active().queue.parked_page.max(1) as usize,
		appearance:         chosen_appearance(state).to_string(),
	}
}

/// What the loaded stores state about one session.
///
/// A session with no entry is a session this window has not drawn before, so
/// it comes back as the default shape rather than the last session's.
#[must_use]
pub fn session_shape(state: &PersistedState, session: Option<&SessionId>) -> SessionShape {
	let panels = session
		.and_then(|id| {
			state
				.shell
				.navigation
				.active()
				.panels
				.get(id)
				.or_else(|| state.panels.get(id))
		})
		.cloned()
		.unwrap_or_default();
	let composer = session
		.and_then(|id| state.composer.get(id))
		.or_else(|| {
			session
				.is_none()
				.then_some(&state.shell.navigation.active().empty_draft)
		})
		.cloned()
		.unwrap_or_default();
	let transcript = session
		.and_then(|id| state.transcripts.get(id))
		.cloned()
		.unwrap_or_default();
	SessionShape {
		panel_visible:     panels.right_panel_visible,
		panel_width_px:    panels.right_panel_width.map(|width| width as f32),
		drawer_visible:    panels.drawer_visible,
		drawer_height_px:  panels.drawer_height.map(|height| height as f32),
		// A tab name this binary draws no tab for leaves the default, which is
		// the same rule the document layer applies to a whole store.
		active_panel_tab:  panels
			.active_right_tab
			.as_deref()
			.and_then(PanelTab::from_slug)
			.unwrap_or_default(),
		active_drawer_tab: panels.active_drawer_tab,
		diff_mode:         panels.diff_mode,
		draft_text:        composer.draft_text,
		attachment_paths:  composer.attachments,
		queue_mode:        composer.queue_mode,
		expanded_call_ids: transcript.expanded_call_ids,
		scroll_anchor:     transcript.scroll_anchor.map(|anchor| ScrollAnchor {
			entry_id:  anchor.entry_id,
			offset_px: anchor.offset_px as f32,
		}),
	}
}

/// Writes the shape the window holds for every session at once into the stores.
pub fn record_host(state: &mut PersistedState, shape: &HostShape) {
	state.shell.version = ShellStore::CURRENT_VERSION;
	state.shell.queue_collapsed = shape.queue_collapsed;
	state.shell.appearance = Some(shape.appearance.clone());
	// Navigation and the host-confirmed session are committed by their transition
	// paths.
	state.queue = QueueStore {
		version:            QueueStore::CURRENT_VERSION,
		collapsed_sections: shape.collapsed_sections.clone(),
		parked_page:        u32::try_from(shape.parked_page.max(1)).unwrap_or(u32::MAX),
	};
}

/// Writes the shape the window holds for one session into the stores.
///
/// Without a session there is nothing to key the entry by, so nothing is
/// written: a draft typed with no session open belongs to no session.
pub fn record_session(
	state: &mut PersistedState,
	session: Option<&SessionId>,
	shape: &SessionShape,
) {
	let Some(session) = session else {
		return;
	};
	state.panels.insert(session.clone(), PanelsStore {
		version:             PanelsStore::CURRENT_VERSION,
		right_panel_visible: shape.panel_visible,
		right_panel_width:   shape.panel_width_px.map(round_px),
		drawer_visible:      shape.drawer_visible,
		drawer_height:       shape.drawer_height_px.map(round_px),
		active_right_tab:    Some(shape.active_panel_tab.slug().to_string()),
		active_drawer_tab:   shape.active_drawer_tab.clone(),
		diff_mode:           shape.diff_mode,
	});
	state.transcripts.insert(session.clone(), TranscriptStore {
		version:           TranscriptStore::CURRENT_VERSION,
		expanded_call_ids: shape.expanded_call_ids.clone(),
		scroll_anchor:     shape.scroll_anchor.as_ref().map(|anchor| TranscriptAnchor {
			entry_id:  anchor.entry_id.clone(),
			offset_px: round_px(anchor.offset_px),
		}),
	});
	state.composer.insert(session.clone(), ComposerStore {
		version:     ComposerStore::CURRENT_VERSION,
		draft_text:  shape.draft_text.clone(),
		attachments: shape.attachment_paths.clone(),
		queue_mode:  shape.queue_mode,
	});
}

/// Records a departing space before restoring the destination's layout.
pub fn record_space(
	state: &mut PersistedState,
	space_id: u64,
	session: Option<&SessionId>,
	shape: &HostShape,
	session_shape: &SessionShape,
) {
	let panel = session.and_then(|id| state.panels.get(id)).cloned();
	if let Some(space) = state.shell.navigation.space_mut(space_id) {
		space.queue_collapsed = shape.queue_collapsed;
		space.queue = state.queue.clone();
		if session.is_none() {
			space.empty_draft = ComposerStore {
				version:     ComposerStore::CURRENT_VERSION,
				draft_text:  session_shape.draft_text.clone(),
				attachments: session_shape.attachment_paths.clone(),
				queue_mode:  session_shape.queue_mode,
			};
		}
		if let (Some(id), Some(panel)) = (session, panel) {
			space.panels.insert(id.clone(), panel);
		}
	}
}

/// Writes one session's draft into the store its composer is restored from.
///
/// `record_session` writes a whole shape read off the drawn window, which is
/// the outgoing session's while the pointer is moving. A draft that belongs
/// to the incoming session -- the prompt a branch cut off the transcript it
/// forked -- is written here instead, under that session's own key, and the
/// rest of its remembered shape is left alone.
pub fn record_draft(state: &mut PersistedState, session: &SessionId, draft: &str) {
	let composer = state.composer.entry(session.clone()).or_default();
	composer.version = ComposerStore::CURRENT_VERSION;
	draft.clone_into(&mut composer.draft_text);
}

/// Writes the window's own geometry into the window store.
///
/// A maximised window keeps the bounds it would return to, so unmaximising it
/// after a relaunch lands where it was rather than at the default measure.
pub fn record_geometry(
	state: &mut PersistedState,
	bounds: Bounds<Pixels>,
	maximized: bool,
	display_id: Option<String>,
) {
	if maximized {
		state.window.maximized = true;
		state.window.display_id = display_id;
		return;
	}
	state.window.maximized = false;
	state.window.x = round_i32(f32::from(bounds.origin.x));
	state.window.y = round_i32(f32::from(bounds.origin.y));
	state.window.width = round_px(f32::from(bounds.size.width));
	state.window.height = round_px(f32::from(bounds.size.height));
	state.window.display_id = display_id;
}

/// A measure in pixels as the whole number the document holds.
fn round_px(value: f32) -> u32 {
	// A negative or non-finite measure is not a size; it is clamped rather
	// than wrapping into a window several thousand pixels wide.
	if value.is_finite() && value > 0.0 {
		value.round().min(f32::from(u16::MAX)) as u32
	} else {
		0
	}
}

/// A coordinate as the whole number the document holds. A window may sit at a
/// negative origin on a display left of the primary one, so this keeps the
/// sign.
const fn round_i32(value: f32) -> i32 {
	if value.is_finite() {
		value.round().clamp(-100_000.0, 100_000.0) as i32
	} else {
		0
	}
}
