# Companion module — GOMOLAB vMix Control

Lets a Stream Deck (via Bitfocus Companion) trigger any hotkey-bound action
inside GOMOLAB vMix Control, and shows live REC / STR / FTB and toggle-button
feedback on the deck.

It works by connecting to the app's existing **readonly** local WebSocket
server (default port `9878`) — the same server the read-only remote-control
web page uses. No new server or protocol surface was added to the app beyond
four new message types layered onto the existing sync channel.

## Which widgets can connect to Companion

Every **Button widget** in the app — its main action and every side button —
is directly controllable from Companion, whether or not it also has a
keyboard shortcut assigned. **Scoreboard** widgets additionally expose any
entries in their "Hotkey Actions" list (extra score/period/etc. shortcuts
beyond the on-canvas buttons) the same way. Nothing needs a hotkey bound to
it anymore — every button gets a stable id the moment it's created, and
that id is what Companion sees and triggers.

**Scoreboard** widgets also expose their own on-canvas score buttons (Try,
Conversion, Penalty, etc — whatever that board's own increments are
configured as) for every team, through a separate `Score (pick scorer)`
action. If the Scoreboard is linked (or auto-paired) to a Player List
widget, each choice includes that team's current roster, so pressing a
Stream Deck button can add the points **and** record exactly which jersey
number scored — the same thing the app's own on-screen scorer picker does
when you tap a score button with a roster loaded. No roster linked just
means scoring still works, with no scorer recorded (pick the "(no scorer)"
choice).

**Scoreboard** widgets also expose each team's live score and logo as
feedbacks — `Show team score` (overrides a button's text with the score,
same data as the `board{n}_a_score`/`board{n}_b_score` variables) and
`Show team logo` (shows the team's logo image on the button itself, fetched
from the same URL vMix uses — PNG logos only for now, see [Known v1
limitations](#known-v1-limitations)).

**Timer** widgets expose their own built-in controls too: Start, Pause,
Start/Pause (toggle), Reset, End Period, Skip Break, Jump to Period N (one
per period), Start Extra Time, Start After Extra Time, Start Final Play, and
Adjust (the same +/-1m/+/-10s nudge buttons the widget's own clock-adjust
row offers, or whatever custom set is configured) — one full set per Timer
widget on the canvas, all through the same `Trigger button` dropdown. Two
feedbacks track their state: `Timer stage active` highlights whichever
stage (a period, Half Time/Break, Extra Time — split per ET period when
there's more than one — Extra Time Break, After Extra Time, or Final Play)
is currently active, and `Timer running` reflects Start/Paused regardless
of which stage that is. **Scoreboard**
widgets additionally expose Reset Score and Undo Last Score (per team) the
same way, alongside their scoring buttons above. Every **page** on the
canvas gets a "Go to Page: {name}" trigger, and there's one global "Toggle
Edit Mode" trigger — none of these need a Button widget built around them,
they're just there.

**Player Stats** and **Head to Head** widgets — every widget with its own
on-screen "pick a player to show" UI — expose that same flow through a
`Set player (team + jersey)` action: pick a team then a jersey number, same
two steps as clicking through the widget itself, except when the widget's
slot already has a fixed team (Head to Head's Player A is always Team A's
roster, Player B always Team B's) — then the team step is skipped
entirely, straight to a jersey-number choice for that side.

**Player List** widgets expose three more actions, all roster-aware the same
way scoring/player-selecting are above:
- `Assign player list slot` — puts a player into a starter/sub slot (or
  clears one), same as dragging them there in the app's own lineup grid.
  Picking someone already in a *different* slot moves them there instead of
  duplicating them — works starter→sub, sub→starter, or within the same
  section — the player dropdown shows their current slot (e.g. "#7 J.
  Smith (from Starter 3)") so it's clear a pick like that is a move. This
  is the write side of the `[Player List]` feedback fields below — press
  the action, the feedback field updates to match.
- `Give card` — gives a yellow/orange/red card to a currently-assigned
  player. Replicates the app's own card logic in full: sin bin timer, HIA
  timer, on-field removal + time-played bookkeeping, local stat counting,
  and a Timeline event, if linked.
- `Highlight player` — sets which player a linked Player Lower Third shows,
  same as the app's own highlight button.

No other widget type (Substitution's in/out swap, Card Display/Card Lower
Third's "which carded player is shown", Rugby Lineup's position
assignments) can be *triggered* from Companion yet, for reasons specific to
each:
- **Substitution** needs picking two players (who's coming off, who's going
  on) — a different, two-sided picker shape not built yet.
- **Card Display / Card Lower Third** — which of several currently-carded
  players is shown when there's more than one is local React state (a
  `selectedId`), never written to config, so nothing outside that component
  can set it.
- **Rugby Lineup** — when linked to a Player List, its on-field display is
  computed live from that Player List's own starters (an override applied
  at render time), not from its own `config.players` fields — so directly
  patching those would have no visible effect while linked, and pointless
  to expose as a picker when not linked (it's just free-text name typing
  there, no roster to pick from).

For anything else, add a Button widget (it can be placed anywhere on the
canvas, including off-screen/unused space) wired to the same action; it'll
appear in the `Trigger button` dropdown immediately, no hotkey required.

A whole family of widget types can't be *triggered* (no "press" action to
speak of), but what they're currently *showing* is readable from Companion
as `appText` — see [How it works](#how-it-works) below for the exact
mechanics. Covered, grouped into sections (Companion has no native dropdown
grouping, so the label/variable name itself carries the section, e.g.
`[Player Stats] ...`):

| Section | What's exposed |
| --- | --- |
| Timer | Time (whichever stage is currently active — a period, Half Time, ET, ET Break, After ET, or Final Play), Stage (a name for that same active stage), Period, Status (Running/Paused), plus dedicated per-stage fields that always show that one stage's own time regardless of which is active: Main Clock Time, Half Time, Extra Time, ET Break, After ET, Final Play |
| Custom Timer | Time, Status |
| Label | its Text |
| File Path | the selected Path |
| Player List | every starter/sub slot — jersey number, or "-" if empty (the same lineup grid the widget shows) |
| Player Lower Third | Name, Jersey, Position, Team, Score Summary |
| Player Stats | the selected player's Name/Jersey/Team + every stat (Appearances/Tries/Conversions/Penalties/Drop Goals/Yellow Cards/Red Cards) |
| Head to Head | the same stat set, once for Player A and once for Player B |
| Rugby Lineup | Team name + all 15 position slots (jersey + name) |
| Timeline | Latest Event/Latest Score/Latest Card/Latest Substitution (each with its own time) — separately, since the overall latest may not be the type you care about |
| Score Lower Third | Team/Scorer/Jersey/Action/Time of its newest scoring entry |
| Sin Bin Lower Third | who's currently sin-binned |
| Card Lower Third / Card Display | who's currently carded, per team |

**Not covered, and why** (these are real architecture constraints, not
arbitrary gaps):
- **tbar, volume, overlay, input-tally, transitions** — their live state is
  entirely vMix's own state (read from `vmixState`, not widget config), so
  they're out of scope for an *app*-display (not vMix-state) feature by
  definition.
- **Title Field, Substitution, NDI Input, Panel, vMix Titles** — the
  values an operator would actually want (typed-but-not-sent text, "last
  substitution made", discovered NDI source, typed panel values, live GT
  field text) exist only in that widget's own local React state — never
  written to the shared widget config — so nothing outside that
  component can read them without first refactoring the widget to persist
  that state. Not attempted here.
- **Recent Matches, Match Schedule, Standings, Bracket, Team Form** — their
  content is computed live from separate stores (match results/schedule,
  team DB, tournament standings), not from widget config at all. Exposing
  these needs its own collector reading those stores with each widget's own
  filters replicated — a bigger, separate follow-up, not a config read like
  everything above.

## How it works

- On connect, the module sends `COMPANION_REQUEST_LIST`. The app replies with
  `COMPANION_LIST`, containing six lists:
  - `bindings` — every Button widget's main + side buttons and every
    Scoreboard hotkey-action entry, each with a stable id, a friendly label,
    and — if one happens to be assigned — its keyboard shortcut (shown for
    reference only).
  - `scoreTargets` — every Scoreboard widget's own score buttons, one per
    team+point-value, each carrying that team's current roster (jersey
    number + name) if a squad is linked, *and* every starter/sub slot of
    that same roster (position + current occupant, or empty) for the
    slot-based arm+press flow below.
  - `playerSelectors` — every Player Stats/Head to Head widget's player
    slot, each carrying the relevant roster(s) (both teams' if the slot's
    team is pickable, one team's if it's fixed) for a jersey-number
    dropdown.
  - `slotTargets` — every Player List starter/sub slot, each carrying that
    team's full roster to assign into it.
  - `cardTargets` — one per Player List side, carrying its currently
    eligible (assigned, not dismissed) players.
  - `highlightTargets` — one per Player List side that has a Player Lower
    Third linked, carrying its roster.
  `appText` (Timer/Label/File Path values, see below) rides along on the
  separate `COMPANION_FEEDBACK` broadcast instead, since it changes far more
  often than the button/scoring/player-selector list does.
- The module turns `bindings` into the choices for a `Trigger button`
  action. Firing it sends `COMPANION_TRIGGER {id, state}` with `press`
  immediately followed by `release` ~80ms later — identical to clicking the
  button in the app (a toggle-mode button flips exactly as it would on a
  real click, reading live vMix state to decide which side of the toggle to
  run).
- The module turns `scoreTargets` into the choices for a `Score (pick
  scorer)` action — one combined dropdown of every "Team — Points — Player"
  and "Team — Points — (no scorer)" combination (Companion can't filter one
  dropdown's choices by another dropdown's live value, so team + points +
  scorer has to be a single pick to stay unambiguous). Firing it sends
  `COMPANION_TRIGGER {id, state: 'press', jerseyNo}`; the app resolves the
  scorer's name from the jersey number and records the score exactly as if
  scored through its own scorer picker.
- The module turns `playerSelectors` into the choices for a `Set player
  (team + jersey)` action — one dropdown per player-selector target,
  flattened the same way as scoring (team already baked into the label
  where relevant). Firing it sends `COMPANION_TRIGGER {id, state: 'press',
  playerId}`; the app patches that widget's own `playerId` (and `teamSide`,
  for a team-pickable slot) config directly — a persistent "which player is
  shown" change, not a momentary press.
- The module turns `slotTargets`/`cardTargets`/`highlightTargets` into
  `Assign player list slot`/`Give card`/`Highlight player`, each a single
  flattened dropdown for the same reason as above (`Give card`'s choice
  encodes player *and* card type together, since both need picking).
  Firing sends `COMPANION_TRIGGER {id, state: 'press', playerId, cardType?}`;
  the app replicates the widget's own `assignToSlot`/`giveCard`/
  `highlightPlayer` logic directly against config — for `giveCard` that's
  the full side-effect chain (sin bin/HIA timers, on-field removal + time
  bookkeeping, local stat count, Timeline event), not just the headline
  field.
- The app pushes `COMPANION_FEEDBACK` whenever recording/streaming/FTB state,
  a toggle-mode button's on/off state, any Scoreboard's score/last-scorer, or
  **what the controller app itself is currently displaying** changes; the
  module turns the first three into `Recording active`, `Streaming active`,
  `Fade to black active`, and a parameterized `Toggle button is ON` feedback
  — the same live-state feedback vMix itself gives the app, now one hop
  further out to Companion.
- The scoreboard part of that same broadcast becomes **Variables** — one
  group per Scoreboard widget (`board1_a_score`, `board1_a_last_scorer`,
  `board1_a_last_jersey`, `board1_a_last_action`, and the same `_b_` set for
  the other team, repeated as `board2_…` etc for additional boards). Drop
  one into any button's own text — e.g.
  `$(gomolab-vmixcontrol:board1_a_last_scorer)` — to show who scored last
  right on the deck, pulled from the same player library the app scores
  against. They update automatically as soon as a score comes in, from
  either the app itself or a Companion-triggered score.
- **What the app itself is showing** — not vMix's raw state — becomes both a
  Variable per field (`{widgetType}{n}_{fieldName}`, e.g. `timer1_time`,
  `label2_text`, `filepath1_path`) and a `Show app display text` feedback
  you can add to any button to override its whole text with a chosen
  field's live value, no variable syntax needed. Currently covers Timer
  (per-stage time / stage name / period / running-or-paused, see the table
  above), Label (its text), and File Path (the selected path) — see [Which
  widgets can connect to Companion](#which-widgets-can-connect-to-companion)
  for what's not covered yet.
- **General match-context data** — not tied to any widget — also becomes
  Variables: `tournament_name`, `venue` (the app's current Venue Scope), and
  `next_fixture_team_a`/`_team_b`/`_teams`/`_date`/`_time`/`_venue`/`_round`/
  `_competition` for the soonest not-yet-sent fixture within that scope
  (same fixture a Match Schedule widget or "Player List — Next Match" widget
  would pick up next).
- Each Timer's stage (which period, Half Time/Break, Extra Time — and which
  ET period, ET Break, After Extra Time, or Final Play) also rides along in
  that same broadcast and becomes the `Timer stage active` feedback — pick
  a Timer + stage combination and it's
  true exactly while that widget is actually on that stage, so a
  "Jump to Period 2" button and its own "is this the active period"
  highlight can sit on the same physical Stream Deck key (as separate
  action/feedback on that button, or as two adjacent keys). Each Timer's
  running/paused state rides along the same way and becomes the
  `Timer running` feedback (just a Timer picker — running/paused applies
  regardless of stage, so it doesn't need a stage choice too).
- The `Arm ...` actions (score type, player target, slot, card type,
  highlight target) never send anything over the wire at all — "arming" is
  purely local state inside the module. The paired `... (pick player)`
  action reuses the armed target's own id as `COMPANION_TRIGGER`'s `id`
  exactly as the non-armed version of that action would, so the app needs
  no awareness that arming exists — every armed press looks identical to a
  plain, fully-specified one.
- `scoreboards` also carries each team's raw logo URL (`teamALogo`/
  `teamBLogo` — the same LAN-reachable URL vMix itself fetches, not the
  app-webview-only substitution). `Show team logo`'s callback fetches that
  URL directly using Node's built-in `fetch` (no image-processing
  dependency added), and only proceeds if the response's `content-type`
  contains `png`; the base64-encoded result is cached per widget+side so a
  logo already fetched isn't re-downloaded on every feedback re-check, only
  when its URL actually changes.

## Building

```sh
npm install
npm run typecheck   # tsc --noEmit, no build output
npm run build        # bundles with esbuild via companion-module-build, writes gomolab-vmixcontrol-<version>.tgz
```

`npm run build` produces `pkg/gomolab-vmixcontrol/` and a `.tgz` of it. Both
are gitignored — rebuild locally rather than committing them.

## Installing into Companion for testing

There are two ways to get this module into a running Companion instance.
Companion detects file changes and restarts just the affected module, so
option A is the better one while you're actively iterating.

### Option A — Developer folder (recommended for development)

Companion can watch a folder of *unpacked* module builds and load them
directly, no store/import step needed:

1. Run `npm run build` here. This produces `pkg/gomolab-vmixcontrol/` —
   ready to load as-is (no further build step).
2. Pick (or create) a **developer folder** anywhere on disk that will hold
   one subfolder per module. It must be the parent folder, not the module
   folder itself — e.g. if you use `~/companion-dev/gomolab-vmixcontrol/`,
   point Companion at `~/companion-dev`, not the `gomolab-vmixcontrol`
   subfolder.
3. Copy (or symlink) this module's `pkg/gomolab-vmixcontrol/` folder into
   that developer folder.
4. Open Companion's **launcher window** → click the **cog icon** (top
   right) → **Advanced Settings** → **Developer** section.
5. Click **Select** and choose your developer folder, then enable **Enable
   Developer Modules**.
6. Click **Launch GUI** to open the Companion admin web UI.
7. Go to **Connections** (the admin UI's connections tab) → **Add
   connection** → search for "GOMOLAB vMix Control" — it should now be
   listed alongside store modules.
8. Configure it (see below) and confirm it goes green.

After a rebuild (`npm run build` again), Companion picks up the change and
restarts just this module automatically; if it doesn't, toggle the
connection off/on in Companion.

### Option B — Import the packaged `.tgz`

More like installing a real release; use this to sanity-check the actual
distributable rather than iterate on it.

1. Run `npm run build` here — it also writes
   `gomolab-vmixcontrol-<version>.tgz` alongside `pkg/`.
2. In the Companion admin UI, go to **Modules** and use its "import/upload a
   module package" option, pointing it at that `.tgz`.
3. Add a connection using "GOMOLAB vMix Control" as in Option A step 7.

### Configuring the connection (either option)

- **Target IP** — the machine running GOMOLAB vMix Control.
- **Port** — its readonly server port (default `9878` — check **Sidebar →
  Remote Access** in the app; the readonly toggle must be ON).
- The connection should go green (`Ok`). Add the `Trigger button` action to
  a button and pick one of the discovered buttons from the dropdown — no
  hotkey needs to be assigned to it in the app first. For scoring, add the
  `Score (pick scorer)` action instead and pick a "Team — Points — Player"
  (or "— (no scorer)") combination. To make a Player Stats/Head to Head
  widget show a specific player, use `Set player (team + jersey)` instead.
  For a Player List, use `Assign player list slot`/`Give card`/
  `Highlight player`.

### Scoring without a button per player per score type

`Score (pick scorer)` needs one button per exact "Team — Points — Player"
combo, which multiplies fast (4 score types × 30 players × 2 teams = 240
buttons). `Arm score type` + `Score armed type (pick player)` avoid that —
and its "player" buttons are actually **slot** buttons, so they don't need
rebuilding when a substitution happens:

1. Set up a handful of **type** buttons — one `Arm score type` action each,
   picking "Try", "Conversion", "Penalty", etc. Add the `Score type armed`
   feedback to each one (same score type in its dropdown) so the currently
   armed one visibly lights up.
2. Set up one button per **slot** — `Score armed type (pick player)`,
   picking a *position* from its dropdown (e.g. "Team A — Starter 3 — #9
   John Smith"). The label shows who's there right now for reference while
   you're configuring it, but the button itself targets the slot, not that
   specific player. These buttons are shared across every score type; you
   only build this set once, not once per type.
3. To score: press a type button (e.g. "Try") to arm it, then press the
   scoring slot's button. That's it — press a different type first to
   switch what the slot buttons currently do.
4. Because it's slot-based, whoever the app currently has in "Starter 3"
   scores — sub them out for someone else mid-match and the same button
   correctly credits the new player, with nothing to reconfigure in
   Companion. If a slot is empty (no one currently assigned to it), pressing
   its button logs an error in Companion's connection log and scores
   nothing, rather than silently doing nothing or scoring blank.

N score types + M players = N+M buttons total, all on one page, instead of
N×M — no Companion page-switching required. If you have multiple
Scoreboard widgets, arming a type from one board and then pressing a
player from a *different* board silently does nothing (mismatched board) —
each board's own type buttons only combine with that same board's own
player buttons.

### The same "arm, then press any player" pattern everywhere else

Every other player-picker action has the identical 2-press alternative, for
the identical reason — one player button set, reused across every "what to
do with them" choice, instead of a button per combo:

| Instead of... | Arm... | ...then press... | Feedback |
| --- | --- | --- | --- |
| `Set player (team + jersey)` | `Arm player target` (which Player Stats/Head to Head slot) | `Set armed target (pick player)` | `Player target armed` |
| `Assign player list slot` | `Arm player list slot` (which slot) | `Assign armed slot (pick player)`, or `Clear armed slot` for an empty one | `Slot armed` |
| `Give card` | `Arm card type` (Yellow/Orange/Red) | `Give armed card (pick player)` | `Card type armed` |
| `Highlight player` | `Arm highlight target` (which Player Lower Third link) | `Highlight armed target (pick player)` | `Highlight target armed` |

Each "...pick player" action's player list is shared across every valid
target in that family (e.g. one player button set works for arming either
Head to Head's Player A *or* Player B) — pressing it while a player who
isn't valid for whatever's currently armed (wrong team, wrong roster) is
armed does nothing, same mismatch-safety as scoring above. Build the
"press player" button set once per family and reuse it regardless of which
target you arm.

## Known v1 limitations

- `Show team logo` only supports PNG logos — a JPG/WebP/SVG logo shows
  nothing on the button and logs a warning (with the URL and detected
  content-type) in this connection's log, rather than silently failing.
  Re-saving/exporting the team's logo as a PNG in the app's Team Database
  is the workaround for now; adding real image-format conversion would need
  a new dependency, which this module deliberately doesn't have yet.
- `Arm score type`'s armed selection lives only in the module's own memory
  — it resets to nothing when Companion restarts or the connection is
  removed/re-added, and it isn't shown anywhere except via the `Score type
  armed` feedback you place on your own buttons.
- Substitution's in/out swap, Card Display/Card Lower Third's "which shown
  player" pick, and Rugby Lineup's position assignment aren't triggerable
  from Companion — see the reasons under [Which widgets can connect to
  Companion](#which-widgets-can-connect-to-companion). Wire a Button
  widget to the same action as a workaround where one exists.
- App display text (`appText`) covers every section listed in [Which
  widgets can connect to Companion](#which-widgets-can-connect-to-companion)
  — not Scoreboard (which has its own richer `board{n}_…` variables
  instead, see above), and not Standings/Bracket/Recent Matches/Match
  Schedule/Team Form or the local-state-only widgets listed there, for the
  reasons given.
- Rugby Lineup's position slots read straight from `config.players[i]` —
  they don't chase that widget's own live substitution-override logic, so a
  sub made through a *linked Player List* may take a moment longer to show
  here than it does on the actual lineup graphic.
- `Assign player list slot`/`Give card` choice lists are one flattened
  dropdown of every slot/player (or player/card-type) combination — for a
  large roster or many slots this can be a long list; Companion's dropdown
  search (type to filter) is the way to navigate it quickly.
- If a button, scoreboard, or app-text widget is deleted from the app's
  canvas, its id(s)/variable(s) simply stop appearing in the next update —
  any Companion button still pointed at one will silently do nothing (for
  an action) or show a stale/blank value (for a variable). Re-pick the
  target in Companion after deleting/recreating one in the app.
- Timer's `Time` field now follows whichever stage is actually active
  (period/Half Time/ET/ET Break/After ET/Final Play, same as the widget's
  own on-screen clock) and uses the widget's own Display Format options
  (milliseconds, no-leading-zero, sub-minute seconds:milliseconds) if set —
  but it's still a straightforward time format, not a full replica of every
  visual edge case the on-canvas Timer widget itself renders (the "+"
  overrun prefix, color changes).
- Roster/team-name/button changes in the app *do* propagate to Companion on
  their own (the module resends its full list ~200ms after any change, and
  Companion re-fetches an action's choices the next time you open it) — the
  one gap is an action's config popup that's already open in Companion when
  a change happens; it was rendered with the choices as they were at that
  moment, so close and reopen it to see the update. Already-placed buttons
  are unaffected either way, since they just store the id they were
  configured with.
