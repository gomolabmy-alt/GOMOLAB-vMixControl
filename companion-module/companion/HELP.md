# GOMOLAB vMix Control

Connects to a running GOMOLAB vMix Control desktop app over its local
read-only WebSocket server, so a Stream Deck can trigger any hotkey-bound
action in the app and show live REC/STR/FTB/toggle feedback.

## Configuration

- **Target IP** — the IP address of the machine running GOMOLAB vMix Control.
- **Port** — its readonly server port. Check **Sidebar → Remote Access** in
  the app (readonly toggle must be ON); default is `9878`.

## Actions

- **Trigger button** — fires whichever button you pick from the dropdown,
  same as clicking it in the app. Includes: every Button widget (main + side
  buttons), every Scoreboard "Hotkey Actions" entry, every Timer widget's
  Start/Pause/Toggle/Reset/End Period/Skip Break/Jump to Period N/Start
  Extra Time/Start After Extra Time/Start Final Play/Adjust (the same
  +/-1m/+/-10s nudges the widget's own clock-adjust row offers, or whatever
  custom set is configured), every Scoreboard's Reset Score/Undo Last Score
  (per team), a "Go to Page" per canvas page, and a global Toggle Edit Mode
  — whether or not any of them also has a keyboard shortcut assigned in the
  app.
- **Score (pick scorer)** — adds points for a team on a Scoreboard widget.
  The dropdown lists every "Team — Points — Player" combination (plus
  "— (no scorer)") from every Scoreboard's linked roster, so one button
  press both scores and records who scored — same as the app's own
  on-screen scorer picker. One button per exact combo — if you don't want a
  button per player per score type, use the two actions below instead.
- **Arm score type** + **Score armed type (pick player)** — a 2-press
  alternative to `Score (pick scorer)` that avoids needing a button per
  player per score type. Press `Arm score type` once (e.g. "Try") — it just
  remembers that choice, nothing happens in the app yet. Then press any
  `Score armed type` button — its dropdown picks a Player List *slot*
  ("Starter 3", "Sub 2"), not a fixed player, so it scores whoever currently
  occupies that slot — checked fresh every press, so the same button keeps
  scoring correctly across substitutions with no reconfiguring. If that
  slot is currently empty, it logs an error and scores nothing. N score
  types + M slots = N+M buttons instead of N×M, and everything fits on one
  page (no Companion page-switching needed). Pair `Score armed type`
  buttons with the `Score type armed` feedback (below) on your type buttons
  so the currently-armed one lights up.
- **Set player (team + jersey)** — picks which player a Player Stats/Head
  to Head widget shows, same as its own on-screen team+jersey picker. The
  dropdown already includes the team where relevant (e.g. "Player Stats —
  #9 John Smith (Team A)"); slots with a fixed team (Head to Head's Player
  A/Player B) just list that team's roster directly. One button per exact
  combo — for the arm+press alternative, see below.
- **Arm player target** + **Set armed target (pick player)** — same 2-press
  pattern as scoring. Arm which slot (e.g. "Head to Head — Player A"), then
  press any player button to show them there.
- **Assign player list slot** — puts a player into a Player List
  starter/sub slot (same "Starter N"/"Sub N" slots the `[Player List]`
  feedback section shows), or clears one via its "(clear slot)" choice.
  Placing a player already in another slot moves them there instead —
  starter→sub, sub→starter, or within the same section — and the player
  dropdown shows where they currently are (e.g. "#7 J. Smith (from Starter
  3)") so it's obvious a pick like that is a move, not a duplicate. One
  button per exact slot+player combo — for the arm+press alternative, see
  below.
- **Arm player list slot** + **Assign armed slot (pick player)** +
  **Clear armed slot** — arm a slot once, then any player button fills it
  (same move behavior and current-slot labels as above); `Clear armed slot`
  empties whichever slot is currently armed.
- **Give card** — gives a yellow/orange/red card to a player currently on a
  Player List's roster. Sin bin timer, HIA timer, on-field removal, and
  stat counting all follow automatically, same as using the app's own card
  picker. One button per exact player+card-type combo — for the arm+press
  alternative, see below.
- **Arm card type** + **Give armed card (pick player)** — arm Yellow/
  Orange/Red once, then any player button gives that card to them.
- **Highlight player** — sets which player a linked Player Lower Third
  widget shows, same as clicking a player's highlight button in the app's
  Player List. One button per exact player — for the arm+press
  alternative, see below.
- **Arm highlight target** + **Highlight armed target (pick player)** —
  arm which Player Lower Third link, then any player button sets them
  there.

## Feedbacks

- **Recording active** / **Streaming active** / **Fade to black active**
- **Toggle button is ON** — true while the selected toggle-mode button is
  currently on (e.g. a Start/Stop Recording button).
- **Show app display text** — overrides this button's own text with
  something the controller app itself is currently showing (not vMix's own
  state) — pick a field from any of these sections: `[Timer]`
  Time/Stage/Period/Status plus dedicated Main Clock Time/Half Time/Extra
  Time/ET Break/After ET/Final Play fields (Time follows whichever stage is
  actually active, the dedicated fields always show that one stage's own
  time), `[Custom Timer]` Time/Status, `[Label]` Text,
  `[File Path]` Path, `[Player List]` each starter/sub slot (jersey number,
  or "-" if empty), `[Player Lower Third]` Name/Jersey/Position/Team/Score
  Summary, `[Player Stats]` Name/Jersey/Team/Appearances/Tries/Conversions/
  Penalties/Drop Goals/Yellow Cards/Red Cards, `[Head to Head]` the same
  stat set for Player A and Player B, `[Rugby Lineup]` Team + all 15
  position slots, `[Timeline]` Latest Event/Latest Score/Latest Card/Latest
  Substitution (each with its own time) — pick whichever kind you actually
  want, since the overall latest may not be the one you care about,
  `[Score Lower Third]` Team/Scorer/Jersey/Action/Time, `[Sin Bin Lower
  Third]` who's currently sin-binned, `[Card Lower Third]`/`[Card Display]`
  who's currently carded per team.
- **Timer stage active** — true while the selected Timer widget is
  currently on the selected stage (a regular period, Half Time/Break,
  Extra Time — split per ET period when there's more than one — Extra Time
  Break, After Extra Time, or Final Play). Good for highlighting a "Jump to
  Period"/"Start Extra Time" button while that stage is the active one.
- **Timer running** — true while the selected Timer widget is running,
  regardless of which stage it's on (every stage shares the same
  running/paused state). Good for a Start/Pause button that should reflect
  reality even when it changed some other way.
- **Score type armed** — true while the selected score type is the one last
  set with `Arm score type`. Add to each type button so you can see at a
  glance which one is currently armed.
- **Player target armed** / **Slot armed** / **Card type armed** /
  **Highlight target armed** — same as `Score type armed`, one per other
  arm+press family. Add to your "arm" buttons to see which is currently set.
- **Show team score** — overrides this button's own text with a team's live
  score — same data as `board{n}_a_score`/`board{n}_b_score`, as a feedback
  instead of typing a variable reference.
- **Show team logo** — shows a team's logo image on this button, fetched
  from the same URL vMix itself uses. Only PNG logos are supported
  currently — other formats log a warning in this connection's log (Settings
  → this connection → Log) and show nothing.

## Variables

One group per Scoreboard widget in the app (`board1_…`, `board2_…`, ...):
`board{n}_a_name`, `board{n}_a_score`, `board{n}_a_last_scorer`,
`board{n}_a_last_jersey`, `board{n}_a_last_action` — and the matching `_b_`
set for the other team. Use these in any button's own text to show live
score/scorer info on the deck.

Also one variable per app display text field: `{widgetType}{n}_{fieldName}`
— e.g. `timer1_time`, `label1_text`, `filepath1_path`,
`player_list1_starter_1` (jersey number, or "-" if empty),
`player_stats1_tries`, `player_h2h1_player_a_tries`, `rugby_lineup1_position_9`,
`timeline1_latest_event`, `score_lower_third1_scorer`,
`sin_bin_lower_third1_sin_binned`, `card_display1_team_a_carded`, and more
— covering every section listed under Feedbacks above, live, for every
matching widget on the canvas. Each variable's own friendly name is
prefixed the same way, e.g. "[Player Stats] Player Stats 1 — Tries".

Also general match-context variables, not tied to any widget: `tournament_name`,
`venue` (the app's current Venue Scope), and `next_fixture_team_a`,
`next_fixture_team_b`, `next_fixture_teams` (both names combined),
`next_fixture_date`, `next_fixture_time`, `next_fixture_venue`,
`next_fixture_round`, `next_fixture_competition` — the soonest not-yet-sent
fixture within that scope.
