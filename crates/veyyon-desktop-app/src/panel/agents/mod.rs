//! The agents tab: the live roster of the host's agents, the traffic between
//! them, and a read-only transcript of one agent's session.
//!
//! The roster puts an agent inside a turn above one that is not. An agent
//! with a session opens it or previews its transcript here; a parked one
//! revives; one mid-turn that is not the session's own agent ends after a
//! confirmation. A task typed into the field at the foot spawns a new agent.

mod comms;
mod preview;
mod roster;

use veyyon_desktop_model::{HostAction, HostActionKind, SessionId, SnapshotSectionKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant},
	editor::{Editor, EditorEvent, EditorMode},
	theme::{ActiveTheme, size, space},
};
use veyyon_gpui::{
	ClickEvent, Context, Entity, IntoElement, ListAlignment, ListState, ParentElement, Render,
	Styled, Subscription, Window, div, prelude::*,
};

pub use self::roster::{can_revive, can_terminate, roster_order, row_kind, row_name};
use super::style::{refresh_control, toolbar};
use crate::{AppState, StoreEvent};

/// Which list the tab shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentsSection {
	/// The roster.
	Live,
	/// The traffic between agents, oldest first.
	Comms,
}

/// The agents tab's view.
pub struct AgentsView {
	app:            Entity<AppState>,
	section:        AgentsSection,
	/// The agent whose end is waiting on a confirmation.
	confirming:     Option<String>,
	/// The session whose transcript the tab previews.
	previewing:     Option<SessionId>,
	spawn:          Entity<Editor>,
	/// The comms stream, pinned to its newest line.
	comms:          ListState,
	/// The first line of the stream the comms list was measured for.
	comms_head:     Option<String>,
	/// The previewed transcript's entries.
	preview_list:   ListState,
	renders:        u64,
	_subscriptions: Vec<Subscription>,
}

impl AgentsView {
	/// Builds the tab over `app`'s agents.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let spawn = cx.new(|cx| {
			let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
			editor.set_placeholder("Spawn an agent on a task", cx);
			editor
		});
		let subscriptions = vec![
			cx.subscribe(&app, |this, _, event: &StoreEvent, cx| match event {
				StoreEvent::DomainChanged(SnapshotSectionKind::AgentComms) => {
					this.sync_comms(cx);
					cx.notify();
				},
				StoreEvent::DomainChanged(
					SnapshotSectionKind::Agents | SnapshotSectionKind::Capabilities,
				) => {
					cx.notify();
				},
				StoreEvent::DomainChanged(SnapshotSectionKind::SessionTranscript)
					if this.previewing.is_some() =>
				{
					this.sync_preview(cx);
					cx.notify();
				},
				_ => {},
			}),
			cx.subscribe(&spawn, |this, editor, event: &EditorEvent, cx| {
				if *event == EditorEvent::Submit {
					let task = editor.read(cx).text().trim().to_owned();
					if !task.is_empty() {
						this.send(HostAction::SpawnTask { task }, SurfaceId::TaskSpawnButton, cx);
						editor.update(cx, |editor, cx| editor.set_text("", cx));
					}
				}
			}),
		];
		let comms_len = app.read(cx).store().domains.agent_comms.len();
		let comms_head = app
			.read(cx)
			.store()
			.domains
			.agent_comms
			.first()
			.map(|message| message.id.clone());
		Self {
			app,
			section: AgentsSection::Live,
			confirming: None,
			previewing: None,
			spawn,
			comms: ListState::new(comms_len, ListAlignment::Bottom, size::TOOL_OUTPUT_MAX),
			comms_head,
			preview_list: ListState::new(0, ListAlignment::Top, size::TOOL_OUTPUT_MAX),
			renders: 0,
			_subscriptions: subscriptions,
		}
	}

	/// How many times the tab has rendered.
	pub const fn render_count(&self) -> u64 {
		self.renders
	}

	/// Which list the tab shows.
	pub const fn section(&self) -> AgentsSection {
		self.section
	}

	/// Shows `section`.
	pub fn show(&mut self, section: AgentsSection, cx: &mut Context<Self>) {
		if self.section != section {
			self.section = section;
			cx.notify();
		}
	}

	/// Asks the host for `session`'s transcript and shows it under the roster.
	pub fn preview(&mut self, session: SessionId, cx: &mut Context<Self>) {
		self.send(
			HostAction::PreviewSessionTranscript { session: session.clone() },
			SurfaceId::RightPanelPreviewTab(session.clone()),
			cx,
		);
		self.previewing = Some(session);
		self.sync_preview(cx);
		cx.notify();
	}

	fn close_preview(&mut self, cx: &mut Context<Self>) {
		self.previewing = None;
		self.preview_list.reset(0);
		cx.notify();
	}

	fn send(&self, action: HostAction, surface: SurfaceId, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| {
			app.dispatch(action, surface, cx);
		});
	}

	fn section_button(&self, section: AgentsSection, label: String, cx: &Context<Self>) -> Button {
		let id = match section {
			AgentsSection::Live => "agents-live",
			AgentsSection::Comms => "agents-comms",
		};
		Button::new(id, label)
			.size(ButtonSize::Sm)
			.variant(if self.section == section {
				ButtonVariant::Secondary
			} else {
				ButtonVariant::Ghost
			})
			.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.show(section, cx)))
	}
}

impl Render for AgentsView {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let palette = cx.theme().palette;
		let app = self.app.read(cx);
		let domains = &app.store().domains;
		let live =
			self.section_button(AgentsSection::Live, format!("Live {}", domains.agents.len()), cx);
		let comms = self.section_button(
			AgentsSection::Comms,
			format!("Comms {}", domains.agent_comms.len()),
			cx,
		);
		let refresh = refresh_control(
			"agents-refresh",
			"Ask the host for the roster again",
			app.panel_pending(HostActionKind::RefreshAgents),
			app.panel_unavailable(HostActionKind::RefreshAgents),
			cx.listener(|this, _: &ClickEvent, _, cx| {
				this.send(HostAction::RefreshAgents, SurfaceId::TaskSpawnButton, cx);
			}),
		);
		let spawn_refused = app.panel_unavailable(HostActionKind::SpawnTask);
		let body = match self.section {
			AgentsSection::Live => self.render_roster(&palette, cx),
			AgentsSection::Comms => self.render_comms(&palette, cx),
		};
		let preview = self
			.previewing
			.clone()
			.map(|session| self.render_preview(&session, &palette, cx));
		div()
			.flex()
			.flex_col()
			.size_full()
			.child(
				toolbar(&palette)
					.child(live)
					.child(comms)
					.child(div().flex_1())
					.child(refresh),
			)
			.child(body)
			.children(preview)
			.when(self.section == AgentsSection::Live, |el| {
				el.child(
					div()
						.flex_none()
						.px(space::S3)
						.py(space::S2)
						.border_t_1()
						.border_color(palette.border.subtle)
						.when_some(spawn_refused, |el, reason| {
							el.text_color(palette.text.faint).child(reason)
						})
						.child(self.spawn.clone()),
				)
			})
	}
}
