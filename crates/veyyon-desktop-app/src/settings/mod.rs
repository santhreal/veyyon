//! The settings view, drawn in place of the thread: a page navigation column
//! `size::SETTINGS_NAV` wide on the left, the page on the right no wider than
//! `size::SETTINGS_COLUMN`.
//!
//! The view follows [`WorkspaceLayout::settings_open`] and
//! [`WorkspaceLayout::settings_page`]: opening settings on a page shows it and
//! asks the host for what it draws. A page name may carry an anchor,
//! `providers#accounts`, which scrolls the page to that section. The view
//! notifies itself only for the sections the shown page draws.

mod appearance;
mod confirm;
mod extensions;
mod fields;
mod frame;
mod general;
mod held;
mod keybindings;
mod mcp;
mod mcp_add;
mod mcp_registry;
mod page;
mod providers;
mod search;
mod targets;
mod values;
mod widgets;

use std::collections::{HashMap, HashSet};

use veyyon_desktop_model::{
	HostAction, NotificationSource, RequestId, SnapshotSectionKind, SurfaceId,
};
use veyyon_desktop_ui::theme::Appearance;
use veyyon_gpui::{
	AnyElement, Context, Entity, FocusHandle, IntoElement, ScrollHandle, SharedString, Subscription,
	Window, canvas, div, point, prelude::*,
};

use self::{
	confirm::Ask,
	fields::Field,
	held::{Change, Held},
};
pub use self::{
	confirm::{ConfirmDialog, ConfirmEvent},
	page::Page,
};
use crate::{
	palette::refusal,
	state::{AppState, StoreEvent},
	workspace::WorkspaceLayout,
};

/// The settings region.
pub struct SettingsView {
	app:            Entity<AppState>,
	page:           Page,
	/// The section the shown page scrolls to once it is laid out.
	anchor:         Option<SharedString>,
	/// The layout's settings state the view last followed.
	requested:      (bool, Option<SharedString>),
	/// The schema tab the General page shows.
	tab:            Option<String>,
	/// The schema tabs whose advanced settings are unfolded.
	advanced:       HashSet<String>,
	/// Inputs keyed by what they edit, built the first time they are drawn.
	fields:         HashMap<String, Field>,
	/// Why the last value typed into a field was not sent, by field key.
	errors:         HashMap<String, SharedString>,
	/// The keybinding being edited.
	editing:        Option<String>,
	/// How a server added from the MCP page is reached.
	mcp_transport:  mcp_add::Transport,
	/// Whether the registry search ranks by meaning rather than by name.
	mcp_semantic:   bool,
	/// The registry result whose add form is unfolded, by id.
	mcp_deploying:  Option<String>,
	/// The requests the shown page sent that the host has not answered.
	sent:           HashSet<RequestId>,
	/// The changes those requests make, drawn before the host answers.
	held:           Held,
	/// Why the host refused the last request the shown page sent.
	failure:        Option<SharedString>,
	/// The window palette drawn while the pointer rests on its row.
	previewing:     Option<Appearance>,
	dialog:         Option<(Entity<ConfirmDialog>, Subscription)>,
	/// Held while the view is shown and nothing inside it holds focus, so
	/// the window's bindings and Escape reach through it.
	focus:          FocusHandle,
	/// The driver targets the last render drew.
	drawn:          HashSet<SharedString>,
	scroll:         ScrollHandle,
	renders:        usize,
	_subscriptions: [Subscription; 2],
}

impl SettingsView {
	/// The settings view over `app`, on the General page, following the
	/// workspace layout from here on.
	pub fn new(app: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let subscriptions = [
			cx.subscribe_in(&app, window, Self::on_store),
			cx.observe_global_in::<WorkspaceLayout>(window, Self::on_layout),
		];
		let layout = WorkspaceLayout::get(cx);
		let requested = (false, layout.settings_page.clone());
		let open = layout.settings_open;
		let mut view = Self {
			app,
			page: Page::General,
			anchor: None,
			requested,
			tab: None,
			advanced: HashSet::new(),
			fields: HashMap::new(),
			errors: HashMap::new(),
			editing: None,
			mcp_transport: mcp_add::Transport::Command,
			mcp_semantic: false,
			mcp_deploying: None,
			sent: HashSet::new(),
			held: Held::default(),
			failure: None,
			previewing: None,
			dialog: None,
			focus: cx.focus_handle(),
			drawn: HashSet::new(),
			scroll: ScrollHandle::new(),
			renders: 0,
			_subscriptions: subscriptions,
		};
		if open {
			view.on_layout(window, cx);
		}
		view
	}

	/// The page shown.
	pub const fn page(&self) -> Page {
		self.page
	}

	/// How many times the view has rendered.
	pub const fn render_count(&self) -> usize {
		self.renders
	}

	/// Shows `page` from its top and asks the host for what it draws.
	pub fn show(&mut self, page: Page, cx: &mut Context<Self>) {
		self.page = page;
		self.anchor = None;
		self.editing = None;
		self.sent.clear();
		self.held.clear();
		self.failure = None;
		self.scroll.set_offset(veyyon_gpui::Point::default());
		self.preview_appearance(None, cx);
		for action in page.loads() {
			self.send(action, SurfaceId::SettingsField(format!("load:{}", page.name())), cx);
		}
		cx.notify();
	}

	/// Shows the page `name` states, `<page>` or `<page>#<section>`, scrolled
	/// to the section when one is named. No name, or a name no page has,
	/// shows the page already shown again. Naming a section clears the
	/// settings search, which could leave the section out.
	pub fn show_named(&mut self, name: Option<&str>, cx: &mut Context<Self>) {
		let (page, anchor) = name.map_or((None, None), |name| match name.split_once('#') {
			Some((page, anchor)) => (Page::from_name(page), Some(anchor)),
			None => (Page::from_name(name), None),
		});
		self.show(page.unwrap_or(self.page), cx);
		self.anchor = anchor
			.filter(|anchor| !anchor.is_empty())
			.map(|anchor| anchor.to_owned().into());
		if self.anchor.is_some() {
			self.set_field(search::QUERY, "", cx);
		}
	}

	/// Shows the page the layout asks for when settings open or the page
	/// asked for changes, and takes focus while shown under a closed
	/// palette: settings opened from the composer or the palette would
	/// otherwise leave focus on an input no longer drawn, where no binding
	/// of the window reaches.
	fn on_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let layout = WorkspaceLayout::get(cx);
		let now = (layout.settings_open, layout.settings_page.clone());
		let palette_open = layout.palette_open;
		if !now.0 {
			// Closing settings drops the question asked over the page, the
			// palette previewed and the targets the hidden page drew.
			if self.requested.0 {
				self.dialog = None;
				self.preview_appearance(None, cx);
				self.forget_targets(window, cx);
			}
			self.requested = now;
			return;
		}
		if !palette_open && !self.focus.contains_focused(window, cx) {
			window.focus(&self.focus, cx);
		}
		if now == self.requested {
			return;
		}
		self.requested = now.clone();
		self.show_named(now.1.as_deref(), cx);
	}

	/// Sends `action` on behalf of `surface`. A request the gate rejects is
	/// not sent; its reason is stated on the page as a refusal of it would
	/// be, until the page's next request is taken.
	fn send(&mut self, action: HostAction, surface: SurfaceId, cx: &mut Context<Self>) {
		if let Some(reason) = refusal(self.app.read(cx), &action) {
			self.failure = Some(reason);
			cx.notify();
			return;
		}
		let settings = self.app.read(cx).store().domains.settings.as_ref();
		let change = Change::of(&action, settings);
		let request = self
			.app
			.update(cx, |app, cx| app.dispatch(action, surface, cx));
		self.sent.insert(request);
		self.held.hold(request, change);
	}

	/// `element`, scrolled to the top of the page once it is laid out when
	/// the page was opened at the section `name`.
	fn anchored(&mut self, name: &str, element: AnyElement) -> AnyElement {
		if self.anchor.as_deref() != Some(name) {
			return element;
		}
		self.anchor = None;
		let scroll = self.scroll.clone();
		let scroll_to = canvas(
			move |bounds, window, _| {
				let offset = scroll.offset();
				let top = bounds.origin.y - scroll.bounds().origin.y - offset.y;
				scroll.set_offset(point(offset.x, -top));
				window.refresh();
			},
			|_, (), _, _| {},
		)
		.absolute()
		.size_full();
		div()
			.relative()
			.child(element)
			.child(scroll_to)
			.into_any_element()
	}

	fn on_store(
		&mut self,
		_: &Entity<AppState>,
		event: &StoreEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		let drawn = match event {
			StoreEvent::DomainChanged(kind) => {
				if *kind == SnapshotSectionKind::Settings {
					self.sync_setting_fields(window, cx);
				}
				self.page.draws(*kind) || *kind == SnapshotSectionKind::Capabilities
			},
			StoreEvent::ConnectionChanged => true,
			StoreEvent::RequestFinished { request, ok } => self.settle(*request, *ok, cx),
			StoreEvent::SessionsChanged
			| StoreEvent::ActiveSessionChanged
			| StoreEvent::TranscriptReset { .. }
			| StoreEvent::TranscriptSpliced { .. }
			| StoreEvent::StreamingChanged { .. }
			| StoreEvent::InteractionsChanged { .. }
			| StoreEvent::NotificationsChanged
			| StoreEvent::OutboxReady => false,
		};
		// A hidden view draws nothing; showing it again renders it afresh.
		if drawn && WorkspaceLayout::get(cx).settings_open {
			cx.notify();
		}
	}

	/// Settles a request the shown page sent: a refusal is stated on the page
	/// in the words of the host's announcement of it, and a request the host
	/// takes clears the statement. The change a refused request made is drawn
	/// no longer, nor any once the page has no request outstanding. Answers
	/// whether the page changed.
	fn settle(&mut self, request: RequestId, ok: bool, cx: &Context<Self>) -> bool {
		if !self.sent.remove(&request) {
			return false;
		}
		let released = self.held.settle(request, ok, self.sent.is_empty());
		let failure = (!ok).then(|| {
			self
				.app
				.read(cx)
				.store()
				.notifications
				.raised()
				.iter()
				.filter(|held| held.source == NotificationSource::RequestFailed)
				.max_by_key(|held| held.raised_at_ms)
				.map_or_else(
					|| SharedString::from("The host refused the request"),
					|held| SharedString::from(held.title.clone()),
				)
		});
		let changed = self.failure != failure || released;
		self.failure = failure;
		changed
	}
}
