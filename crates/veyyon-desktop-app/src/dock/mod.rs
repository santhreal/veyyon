//! The interaction dock above the composer: the decision the session waits
//! on, the goal it runs and the autoswarm console it opened.
//!
//! One decision shows at a time, the oldest first, and the rest are counted
//! under it. A card is answered by its buttons, by 1–9 for its options, by
//! Enter for its default and folded by Esc, which hands the keyboard back to
//! the composer. A decision that arrives while the composer holds no draft
//! takes the keyboard so the digits reach it; a draft being written keeps it.
//!
//! The dock renders for the decisions, the goal and the console of the shown
//! session and for its own controls; a streamed delta renders nothing here.

mod approval;
mod autoswarm;
mod card;
mod console;
mod countdown;
mod dialog;
mod dialog_card;
mod goal;
mod keys;
mod plan;
mod question;
mod row;
mod view;

use gpui::{
	App, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, Pixels, Subscription,
	Window,
	motion::{Animator, FrameInstant, MotionDriver},
};
use veyyon_desktop_model::{InteractionId, RequestId, SessionId, SnapshotSectionKind};
use veyyon_desktop_ui::theme::motion;

pub use self::keys::init;
use self::{card::Shown, console::Console};
use crate::{
	AppState, StoreEvent,
	composer::measure::{Measured, Resized},
	state::Decision,
	workspace::{FocusSlot, focus_slot},
};

/// The key context the dock declares.
pub const KEY_CONTEXT: &str = "Dock";

/// The dock region.
pub struct InteractionDock {
	app:            Entity<AppState>,
	session:        Option<SessionId>,
	focus:          FocusHandle,
	/// The decision shown and what its card holds.
	shown:          Option<Shown>,
	/// Whether the decisions waiting under the card are listed.
	more_open:      bool,
	/// The answer in flight and the decision it answers, so a refusal marks
	/// the card it puts back.
	answering:      Option<(RequestId, InteractionId)>,
	console:        Console,
	/// How far a newly shown card has risen into place, 0 to 1.
	reveal:         Animator<FrameInstant>,
	driver:         MotionDriver,
	bounds:         Option<Bounds<Pixels>>,
	renders:        usize,
	_subscriptions: Vec<Subscription>,
}

impl EventEmitter<Resized> for InteractionDock {}

impl Measured for InteractionDock {
	fn bounds_mut(&mut self) -> &mut Option<Bounds<Pixels>> {
		&mut self.bounds
	}
}

impl InteractionDock {
	/// The dock over `app`, showing the session the window shows.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		init(cx);
		crate::composer::route::register(window, &cx.entity(), cx);
		let subscriptions = vec![cx.subscribe_in(&app, window, Self::on_store_event)];
		let mut dock = Self {
			app,
			session: None,
			focus: cx.focus_handle(),
			shown: None,
			more_open: false,
			answering: None,
			console: Console::default(),
			reveal: Animator::at_rest(1.0),
			driver: MotionDriver::default(),
			bounds: None,
			renders: 0,
			_subscriptions: subscriptions,
		};
		dock.sync(false, window, cx);
		dock
	}

	/// The decision the dock shows.
	pub fn shown(&self) -> Option<&InteractionId> {
		self.shown.as_ref().map(|shown| &shown.id)
	}

	/// Whether the shown card is folded to its one line.
	pub fn is_folded(&self) -> bool {
		self.shown.as_ref().is_some_and(|shown| shown.folded)
	}

	/// The height the dock last laid out at, zero before its first layout:
	/// a dock opened over a waiting decision reveals from nothing.
	pub fn height(&self) -> Pixels {
		self
			.bounds
			.map_or(Pixels::ZERO, |bounds| bounds.size.height)
	}

	/// How many times the dock has rendered.
	pub const fn render_count(&self) -> usize {
		self.renders
	}

	fn on_store_event(
		&mut self,
		_: &Entity<AppState>,
		event: &StoreEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match event {
			StoreEvent::ActiveSessionChanged => self.sync(false, window, cx),
			StoreEvent::InteractionsChanged { session } if self.session.as_ref() == Some(session) => {
				self.sync(true, window, cx);
			},
			StoreEvent::RequestFinished { request, ok } => self.answer_finished(*request, *ok, cx),
			StoreEvent::DomainChanged(SnapshotSectionKind::AutoswarmConsole) => {
				self
					.console
					.sync(&self.app, self.session.as_ref(), window, cx);
				cx.notify();
			},
			StoreEvent::DomainChanged(
				SnapshotSectionKind::Goal | SnapshotSectionKind::Capabilities,
			) => {
				cx.notify();
			},
			_ => {},
		}
	}

	/// Shows the oldest decision of the window's session, keeping the card's
	/// state while it stays the same decision. `arrived` marks a change the
	/// host made, after which a new card may take the keyboard.
	fn sync(&mut self, arrived: bool, window: &mut Window, cx: &mut Context<Self>) {
		let session = self.app.read(cx).active_session().cloned();
		if session != self.session {
			self.session.clone_from(&session);
			self.shown = None;
			self.more_open = false;
			self.answering = None;
			self.console.sync(&self.app, session.as_ref(), window, cx);
		}
		let next = session.as_ref().and_then(|session| {
			let app = self.app.read(cx);
			app.decisions(session).first().map(card::Owned::from)
		});
		let same = match (&self.shown, &next) {
			(Some(shown), Some(next)) => shown.id == *next.id(),
			(None, None) => true,
			_ => false,
		};
		if !same {
			let had_keys = self.focus.contains_focused(window, cx);
			let keys = next.as_ref().is_some_and(card::Owned::takes_keys);
			self.shown = next.map(|next| Shown::new(next, window, cx));
			if self.shown.is_some() {
				self.start_reveal(cx);
			}
			if keys && (arrived || had_keys) {
				self.take_keyboard(had_keys, window, cx);
			} else if had_keys {
				focus_slot(FocusSlot::Composer, window, cx);
			}
		}
		cx.notify();
	}

	/// Starts a newly shown card rising into place, or places it at once
	/// under reduced motion.
	fn start_reveal(&mut self, cx: &App) {
		let policy = cx.motion_policy();
		if policy.reduced() {
			self.reveal.snap(1.0);
		} else {
			self.reveal.snap(0.0);
			self
				.reveal
				.retarget(1.0, motion::REVEAL, policy, cx.frame_instant());
		}
	}

	/// Focuses the dock when the keyboard is not writing anything: the dock
	/// already had it, nothing has focus, or the composer does and its draft
	/// is empty.
	fn take_keyboard(&self, had_keys: bool, window: &mut Window, cx: &mut Context<Self>) {
		let in_composer = window
			.context_stack()
			.iter()
			.any(|context| context.contains(crate::composer::KEY_CONTEXT));
		let draft_empty = self.session.as_ref().is_none_or(|session| {
			self
				.app
				.read(cx)
				.draft(session)
				.is_none_or(|draft| draft.draft_text.trim().is_empty())
		});
		if had_keys || window.focused(cx).is_none() || (in_composer && draft_empty) {
			window.focus(&self.focus, cx);
		}
	}

	/// The host answered `request`. A refused answer marks the card it put
	/// back, which is shown again by then.
	fn answer_finished(&mut self, request: RequestId, ok: bool, cx: &mut Context<Self>) {
		let Some((_, interaction)) = self.answering.take_if(|(sent, _)| *sent == request) else {
			return;
		};
		if ok {
			return;
		}
		if let Some(shown) = self.shown.as_mut().filter(|shown| shown.id == interaction) {
			shown.refused = true;
			shown.folded = false;
			cx.notify();
		}
	}

	/// The decisions of the shown session, oldest first.
	fn decisions<'a>(&self, cx: &'a App) -> Vec<Decision<'a>> {
		self
			.session
			.as_ref()
			.map_or_else(Vec::new, |session| self.app.read(cx).decisions(session))
	}
}

impl Focusable for InteractionDock {
	fn focus_handle(&self, _: &App) -> FocusHandle {
		self.focus.clone()
	}
}
