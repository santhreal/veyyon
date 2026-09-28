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

use veyyon_desktop_model::{HostAction, RequestId, SnapshotSectionKind, SurfaceId};
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
	/// The requests the shown page sent that the host has not answered, by
	/// the control each was sent from.
	sent:           HashMap<RequestId, SurfaceId>,
	/// The changes those requests make, drawn before the host answers.
	held:           Held,
	/// Why the host refused the last request the shown page sent.
	failure:        Option<SharedString>,
	/// Whether the gate rejected a load of the shown page, which the page
	/// asks for again once the gate takes it.
	unloaded:       bool,
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
			sent: HashMap::new(),
			held: Held::default(),
			failure: None,
			unloaded: false,
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
		self.load(cx);
		cx.notify();
	}

	/// Asks the host for what the shown page draws. A load the gate rejects
	/// is stated on the page and leaves it unloaded.
	fn load(&mut self, cx: &mut Context<Self>) {
		let surface = SurfaceId::SettingsField(format!("load:{}", self.page.name()));
		let loads = self.page.loads();
		self.unloaded = loads
			.iter()
			.any(|action| refusal(self.app.read(cx), action).is_some());
		for action in loads {
			self.send(action, surface.clone(), cx);
		}
	}

	/// Asks again for what the shown page draws once the gate that rejected
	/// its load takes it: the link to the host came back, or the host
	/// declares the capability. While the gate still rejects it, the page
	/// states the reason the gate gives now.
	fn reload(&mut self, cx: &mut Context<Self>) {
		if !self.unloaded || !WorkspaceLayout::get(cx).settings_open {
			return;
		}
		let app = self.app.read(cx);
		let refused = self
			.page
			.loads()
			.iter()
			.find_map(|action| refusal(app, action));
		self.failure = refused;
		if self.failure.is_none() {
			self.load(cx);
		}
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
			.update(cx, |app, cx| app.dispatch(action, surface.clone(), cx));
		self.sent.insert(request, surface);
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
				if *kind == SnapshotSectionKind::Capabilities {
					self.reload(cx);
				}
				self.page.draws(*kind) || *kind == SnapshotSectionKind::Capabilities
			},
			StoreEvent::ConnectionChanged => {
				self.reload(cx);
				true
			},
			StoreEvent::RequestFinished { request, ok } => self.settle(*request, *ok, cx),
			StoreEvent::SessionsChanged
			| StoreEvent::ActiveSessionChanged
			| StoreEvent::TranscriptReset { .. }
			| StoreEvent::TranscriptSpliced { .. }
			| StoreEvent::StreamingChanged { .. }
			| StoreEvent::InteractionsChanged { .. }
			| StoreEvent::NotificationsChanged
			| StoreEvent::Remembered
			| StoreEvent::OutboxReady => false,
		};
		// A hidden view draws nothing; showing it again renders it afresh.
		if drawn && WorkspaceLayout::get(cx).settings_open {
			cx.notify();
		}
	}

	/// Settles a request the shown page sent: a refusal is stated on the page
	/// in the host's words for that request, and a request the host takes
	/// clears the statement. The change a refused request made is drawn no
	/// longer, nor any once the page has no request outstanding. Answers
	/// whether the page changed.
	fn settle(&mut self, request: RequestId, ok: bool, cx: &Context<Self>) -> bool {
		let Some(surface) = self.sent.remove(&request) else {
			return false;
		};
		let released = self.held.settle(request, ok, self.sent.is_empty());
		let failure = (!ok).then(|| {
			self
				.app
				.read(cx)
				.store()
				.retries
				.reason(&surface)
				.map_or_else(
					|| SharedString::from("The host refused the request"),
					|reason| SharedString::from(reason.to_owned()),
				)
		});
		let changed = self.failure != failure || released;
		self.failure = failure;
		changed
	}
}
