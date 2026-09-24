#!/usr/bin/env bash
# The `room.view` setting: which layout the room view opens in.
#
# One scene, two arms seeded before the session starts:
#
#   proof/record.sh proof/scenes/settings-room-view.sh
#   proof/record.sh --settings 'room.view: all-windows' proof/scenes/settings-room-view.sh
#
# Frames:
#   room-view-setting   Settings searched to the Room View row, showing the value
#                       the arm seeded (Side By Side / All Windows)
#   room-view-opened    `→→` on the empty composer: the view opens in that layout;
#                       the one key pressed inside it closes the first-open guide
#
# The search lands on the row by name rather than by counting sidebar rows, and
# the scene stops at the filtered list: Return would open the row's editor.

# The layout the arm seeded, as the stage's title row names it.
layout="side by side"
[ "${SCENE_SETTINGS:-}" = "room.view: all-windows" ] && layout="all windows"

settle 20
submit "/settings"
settle 4
k "/"
pause 0.4
t "Room View"
settle 2
# needle-source: Room View -- the label settings-domains/interaction.ts gives room.view
expect_screen "Room View" 30
shot room-view-setting

# The first Escape leaves the search, the next closes the card; a slow first
# paint can swallow one, so close until the card is gone rather than counting.
for _ in 1 2 3 4; do
	case "$(visible_text)" in
	*"search settings"* | *"Room View"*) k Escape ;;
	*) break ;;
	esac
	pause 0.6
done
settle 2
clear_composer
k Right
pause 0.25
k Right
# needle-source: side by side / all windows -- room-stage.ts names the layout on its title row
expect_screen "$layout" 15
# The first room view in a profile opens with its guide over it; Escape takes
# it away and leaves the layout the arm seeded.
# needle-source: any key closes this -- room-guide.ts paintRoomGuide's last line
expect_screen "any key closes this" 10
k Escape
pause 1
shot room-view-opened
