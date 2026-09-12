//! What a pointer does to a live headless window.
//!
//! A press, a move and a release are separate platform inputs, and an element
//! reads them across frames: group-hover styling is painted from the position
//! the previous frame recorded, and a drag is a press that stays down while the
//! position changes. Each method here dispatches the full sequence its name
//! implies and parks the context, so a caller draws a frame afterwards to read
//! what the sequence left behind.

use veyyon_gpui::{
	Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, PlatformInput,
	Point, Render, ScrollDelta, ScrollWheelEvent, TouchPhase,
};

use super::HeadlessSession;
use crate::headless::RenderError;

impl<V: Render + 'static> HeadlessSession<'_, V> {
	/// Moves the pointer to the given logical coordinates without pressing a
	/// button, which is how a hover reaches an element: group-hover styling and
	/// a hover tag are painted from the pointer position the previous frame
	/// recorded, so the caller draws a frame after this to read them.
	pub fn hover(&mut self, at: Point<Pixels>) -> Result<(), RenderError> {
		let mouse_move = PlatformInput::MouseMove(MouseMoveEvent {
			position:       at,
			pressed_button: None,
			modifiers:      Modifiers::default(),
		});

		self
			.cx
			.update_window(self.window.into(), |_, window, cx| {
				window.dispatch_event(mouse_move, cx);
			})
			.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;

		self.cx.run_until_parked();
		Ok(())
	}

	/// Dispatches a mouse click (`MouseDown` followed by `MouseUp`) at the given
	/// logical coordinates.
	pub fn click(&mut self, at: Point<Pixels>) -> Result<(), RenderError> {
		let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
			first_mouse: false,
		});

		let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
		});

		self
			.cx
			.update_window(self.window.into(), |_, window, cx| {
				window.dispatch_event(mouse_down, cx);
				window.dispatch_event(mouse_up, cx);
			})
			.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;

		self.cx.run_until_parked();
		Ok(())
	}

	/// Clicks at `at` with Shift held, which is how a surface that extends a
	/// selection from where it is rather than starting a new one is reached.
	pub fn shift_click(&mut self, at: Point<Pixels>) -> Result<(), RenderError> {
		let modifiers = Modifiers { shift: true, ..Modifiers::default() };
		let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
			button: MouseButton::Left,
			position: at,
			modifiers,
			click_count: 1,
			first_mouse: false,
		});
		let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
			button: MouseButton::Left,
			position: at,
			modifiers,
			click_count: 1,
		});

		self.dispatch(mouse_down)?;
		self.dispatch(mouse_up)?;
		self.cx.run_until_parked();
		Ok(())
	}

	/// Dispatches a right mouse click (`MouseDown` followed by `MouseUp`) at the
	/// given logical coordinates.
	pub fn right_click(&mut self, at: Point<Pixels>) -> Result<(), RenderError> {
		let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
			button:      MouseButton::Right,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
			first_mouse: false,
		});

		let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
			button:      MouseButton::Right,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
		});

		self
			.cx
			.update_window(self.window.into(), |_, window, cx| {
				window.dispatch_event(mouse_down, cx);
				window.dispatch_event(mouse_up, cx);
			})
			.map_err(|error| RenderError::Window { message: format!("{error:?}") })?;

		self.cx.run_until_parked();
		Ok(())
	}

	/// Drags the left button from `from` to `to`: a press, a move just past
	/// the renderer's 2px drag threshold that starts the drag, a move halfway
	/// and a move to `to` that a drag-move listener sees with the drag active,
	/// and a release there.
	///
	/// A frame is delivered after each move, as a live window draws between
	/// pointer events, so a listener that re-renders its element on every
	/// move is driven through the re-render rather than around it, and the
	/// second move it sees follows a frame drawn from the first.
	pub fn drag(&mut self, from: Point<Pixels>, to: Point<Pixels>) -> Result<(), RenderError> {
		let modifiers = Modifiers::default();
		let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
			button: MouseButton::Left,
			position: from,
			modifiers,
			click_count: 1,
			first_mouse: false,
		});
		let travel = to - from;
		let length = f32::from(travel.x).hypot(f32::from(travel.y));
		// The threshold move is skipped for a drag too short to have one.
		let threshold = (length > 4.0).then(|| from + travel * (4.0 / length));
		let midway = from + travel * 0.5;
		let moves = threshold.into_iter().chain([midway, to]).map(|position| {
			PlatformInput::MouseMove(MouseMoveEvent {
				position,
				pressed_button: Some(MouseButton::Left),
				modifiers,
			})
		});
		let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
			button: MouseButton::Left,
			position: to,
			modifiers,
			click_count: 1,
		});

		self.dispatch(mouse_down)?;
		for mouse_move in moves {
			self.dispatch(mouse_move)?;
			self.deliver_frame()?;
		}
		self.dispatch(mouse_up)?;

		self.cx.run_until_parked();
		Ok(())
	}

	/// Drags the left button from `from` to `to` and holds it there: the same
	/// press and moves [`Self::drag`] sends, without the release.
	///
	/// What a drag draws while it is still held is a state of its own — a
	/// splitter tinted under the hand that took it, a row lifted out of a
	/// list — and it is the state a completed drag has already left. The
	/// caller reads it with [`Self::frame`] and ends the drag with
	/// [`Self::release`].
	pub fn drag_and_hold(
		&mut self,
		from: Point<Pixels>,
		to: Point<Pixels>,
	) -> Result<(), RenderError> {
		let modifiers = Modifiers::default();
		let mouse_down = PlatformInput::MouseDown(MouseDownEvent {
			button: MouseButton::Left,
			position: from,
			modifiers,
			click_count: 1,
			first_mouse: false,
		});
		let travel = to - from;
		let length = f32::from(travel.x).hypot(f32::from(travel.y));
		let threshold = (length > 4.0).then(|| from + travel * (4.0 / length));
		let moves = threshold.into_iter().chain([to]).map(|position| {
			PlatformInput::MouseMove(MouseMoveEvent {
				position,
				pressed_button: Some(MouseButton::Left),
				modifiers,
			})
		});

		self.dispatch(mouse_down)?;
		for mouse_move in moves {
			self.dispatch(mouse_move)?;
			self.deliver_frame()?;
		}

		self.cx.run_until_parked();
		Ok(())
	}

	/// Releases the left button at `at`, ending a drag
	/// [`Self::drag_and_hold`] left held.
	pub fn release(&mut self, at: Point<Pixels>) -> Result<(), RenderError> {
		let mouse_up = PlatformInput::MouseUp(MouseUpEvent {
			button:      MouseButton::Left,
			position:    at,
			modifiers:   Modifiers::default(),
			click_count: 1,
		});

		self.dispatch(mouse_up)?;
		self.cx.run_until_parked();
		Ok(())
	}

	/// Turns the wheel by `lines` at `at`, negative upward, as a pointer over
	/// that position does. A move to `at` precedes the wheel, because a wheel
	/// arrives where the pointer already is.
	pub fn scroll(&mut self, at: Point<Pixels>, lines: f32) -> Result<(), RenderError> {
		let modifiers = Modifiers::default();
		let mouse_move =
			PlatformInput::MouseMove(MouseMoveEvent { position: at, pressed_button: None, modifiers });
		let wheel = PlatformInput::ScrollWheel(ScrollWheelEvent {
			position: at,
			delta: ScrollDelta::Lines(Point { x: 0.0, y: -lines }),
			modifiers,
			touch_phase: TouchPhase::Moved,
		});

		self.dispatch(mouse_move)?;
		self.dispatch(wheel)?;
		self.cx.run_until_parked();
		Ok(())
	}

	/// Turns the wheel sideways by `lines` at `at`, negative leftward, as a
	/// trackpad or a tilt wheel does over that position.
	///
	/// A pane that scrolls horizontally cannot be driven by [`Self::scroll`],
	/// which carries no x delta: GPUI maps a vertical delta onto a horizontal
	/// region only where the axis restriction is off, which is the behaviour a
	/// mono pane turns off.
	pub fn scroll_across(&mut self, at: Point<Pixels>, lines: f32) -> Result<(), RenderError> {
		let modifiers = Modifiers::default();
		let mouse_move =
			PlatformInput::MouseMove(MouseMoveEvent { position: at, pressed_button: None, modifiers });
		let wheel = PlatformInput::ScrollWheel(ScrollWheelEvent {
			position: at,
			delta: ScrollDelta::Lines(Point { x: -lines, y: 0.0 }),
			modifiers,
			touch_phase: TouchPhase::Moved,
		});

		self.dispatch(mouse_move)?;
		self.dispatch(wheel)?;
		self.cx.run_until_parked();
		Ok(())
	}
}
