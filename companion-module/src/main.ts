import {
	InstanceBase,
	InstanceStatus,
	combineRgb,
	type SomeCompanionConfigField,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type JsonValue,
} from '@companion-module/base'
import WebSocket from 'ws'

interface ModuleConfig {
	host: string
	port: number
	[key: string]: JsonValue
}

interface ModuleInstanceTypes {
	config: ModuleConfig
	secrets: undefined
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	actions: Record<string, any>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	feedbacks: Record<string, any>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	variables: Record<string, any>
}

interface CompanionBindingInfo {
	id: string
	label: string
	mode?: string
	accelerator?: string
}

interface CompanionScorerChoice {
	jerseyNo: string
	name: string
}

interface CompanionScoreSlotInfo {
	section: 'starter' | 'sub'
	index: number
	jerseyNo: string
	name: string
}

interface CompanionScoreTargetInfo {
	id: string
	label: string
	widgetId: string
	widgetLabel: string
	team: 'A' | 'B'
	teamName: string
	scoreLabel: string
	scorers: CompanionScorerChoice[]
	slots: CompanionScoreSlotInfo[]
}

interface CompanionPlayerChoiceInfo {
	playerId: string
	jerseyNo: string
	name: string
	side?: 'A' | 'B'
}

interface CompanionPlayerSelectorTargetInfo {
	id: string
	label: string
	needsTeamPick: boolean
	choices: CompanionPlayerChoiceInfo[]
}

interface CompanionRosterChoiceInfo {
	playerId: string
	jerseyNo: string
	name: string
	currentSlot?: string
}

interface CompanionSlotTargetInfo {
	id: string
	label: string
	roster: CompanionRosterChoiceInfo[]
}

interface CompanionCardTargetInfo {
	id: string
	label: string
	roster: CompanionRosterChoiceInfo[]
}

interface CompanionHighlightTargetInfo {
	id: string
	label: string
	roster: CompanionRosterChoiceInfo[]
}

interface CompanionLastScorer {
	scorer: string
	jerseyNo: string
	action: string
}

interface CompanionScoreboardInfo {
	widgetId: string
	teamAName: string
	teamBName: string
	scoreA: number
	scoreB: number
	lastA?: CompanionLastScorer
	lastB?: CompanionLastScorer
	teamALogo: string
	teamBLogo: string
}

interface CompanionAppTextFieldInfo {
	widgetId: string
	widgetType: string
	typeIndex: number
	widgetLabel: string
	fieldName: string
	value: string
}

interface CompanionNextFixture {
	teamAName: string
	teamBName: string
	date: string
	time: string
	venue: string
	round: string
	competition: string
}

interface CompanionMatchInfo {
	tournamentName: string
	venue: string
	nextFixture?: CompanionNextFixture
}

interface CompanionTimerStageInfo {
	widgetId: string
	widgetLabel: string
	periods: number
	currentPeriod: number
	inBreak: boolean
	inExtraTime: boolean
	etCurrentPeriod: number
	etPeriods: number
	etInBreak: boolean
	inAfterEt: boolean
	inFinalPlay: boolean
	running: boolean
}

interface CompanionFeedbackState {
	recording: boolean
	streaming: boolean
	fadeToBlack: boolean
	toggles: Record<string, boolean>
}

const RECONNECT_DELAY_MS = 2000
const REQUEST_LIST_DEBOUNCE_MS = 50

function appFieldKey(f: CompanionAppTextFieldInfo): string {
	return `${f.widgetType}${f.typeIndex}|${f.fieldName}`
}

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field'
}

// Mirrors the section labels in the app's companionAppText.ts — Companion
// dropdowns have no native grouping, so this is what makes the flat
// "app display text" list read as sections by widget type.
const APP_TEXT_SECTIONS: Record<string, string> = {
	timer: 'Timer',
	pomodoro: 'Custom Timer',
	label: 'Label',
	'file-path': 'File Path',
	'player-list': 'Player List',
	'player-list-next': 'Player List',
	'player-lower-third': 'Player Lower Third',
	'player-stats': 'Player Stats',
	'player-h2h': 'Head to Head',
	'rugby-lineup': 'Rugby Lineup',
	timeline: 'Timeline',
	'score-lower-third': 'Score Lower Third',
	'sin-bin-lower-third': 'Sin Bin Lower Third',
	'card-lower-third': 'Card Lower Third',
	'card-display': 'Card Display',
}

class ModuleInstance extends InstanceBase<ModuleInstanceTypes> {
	private config: ModuleConfig = { host: '127.0.0.1', port: 9878 }
	private ws: WebSocket | null = null
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private destroyed = false

	private bindings: CompanionBindingInfo[] = []
	private scoreTargets: CompanionScoreTargetInfo[] = []
	// "Arm score type" remembers a representative target id (e.g. team A's
	// variant of "Try") purely module-side — no network message, since
	// arming doesn't change anything in the app. "Score armed type" later
	// swaps in the actual player's team to build the real target id. Lets
	// N score types + M players cover every combo with N+M buttons instead
	// of N×M, with no Companion page-switching required.
	private armedScoreType: { id: string; label: string } | null = null
	// Same "arm once, then press any player" pattern applied to every other
	// player-picker action — each remembers a target id (already exactly the
	// id its own non-armed action sends as COMPANION_TRIGGER's `id`), so
	// pressing an armed-family player button reuses that same trigger
	// unchanged; the app needs no new handling at all.
	private armedPlayerTarget: { id: string; label: string } | null = null
	private armedSlot: { id: string; label: string } | null = null
	private armedCardType: 'yellow' | 'orange' | 'red' | null = null
	private armedHighlightTarget: { id: string; label: string } | null = null
	private playerSelectors: CompanionPlayerSelectorTargetInfo[] = []
	private slotTargets: CompanionSlotTargetInfo[] = []
	private cardTargets: CompanionCardTargetInfo[] = []
	private highlightTargets: CompanionHighlightTargetInfo[] = []
	private scoreboards: CompanionScoreboardInfo[] = []
	// Keyed by `${widgetId}:${side}` — avoids re-fetching a logo on every
	// feedback re-check, only when its URL actually changes.
	private logoCache: Map<string, { url: string; base64: string | null }> = new Map()
	private appText: CompanionAppTextFieldInfo[] = []
	private matchInfo: CompanionMatchInfo = { tournamentName: '', venue: '' }
	private timerStages: CompanionTimerStageInfo[] = []
	private feedbackState: CompanionFeedbackState = {
		recording: false,
		streaming: false,
		fadeToBlack: false,
		toggles: {},
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		this.destroyed = false
		this.updateActionsAndFeedbacks()
		this.connect()
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.close()
			this.ws = null
		}
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		if (this.ws) {
			this.ws.removeAllListeners()
			this.ws.close()
			this.ws = null
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		this.connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return [
			{
				type: 'static-text',
				id: 'info',
				label: 'Connection',
				width: 12,
				value:
					'Point this at the GOMOLAB vMix Control readonly server port (default 9878). ' +
					'Find it in the app under Sidebar → Remote Access.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				default: '127.0.0.1',
			},
			{
				type: 'number',
				id: 'port',
				label: 'Port',
				width: 6,
				default: 9878,
				min: 1,
				max: 65535,
				step: 1,
				asInteger: true,
			},
		]
	}

	private connect(): void {
		if (this.destroyed) return
		this.updateStatus(InstanceStatus.Connecting)

		const url = `ws://${this.config.host}:${this.config.port}`
		let socket: WebSocket
		try {
			socket = new WebSocket(url)
		} catch (e) {
			this.log('error', `Failed to open WebSocket to ${url}: ${e instanceof Error ? e.message : String(e)}`)
			this.scheduleReconnect()
			return
		}
		this.ws = socket

		socket.on('open', () => {
			this.updateStatus(InstanceStatus.Ok)
			this.requestBindingList()
		})

		socket.on('message', (data: WebSocket.RawData) => {
			this.handleMessage(data.toString())
		})

		socket.on('close', () => {
			if (this.ws === socket) this.ws = null
			if (!this.destroyed) {
				this.updateStatus(InstanceStatus.Disconnected)
				this.scheduleReconnect()
			}
		})

		socket.on('error', (err: Error) => {
			this.log('debug', `WebSocket error: ${err.message}`)
		})
	}

	private scheduleReconnect(): void {
		if (this.destroyed || this.reconnectTimer) return
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, RECONNECT_DELAY_MS)
	}

	private requestBindingList(): void {
		this.send({ type: 'COMPANION_REQUEST_LIST' })
	}

	private send(msg: Record<string, unknown>): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg))
		} else {
			this.log('warn', `Not connected — dropped a "${msg.type}" message. Check the connection status.`)
		}
	}

	private handleMessage(raw: string): void {
		let msg: Record<string, unknown>
		try {
			msg = JSON.parse(raw)
		} catch {
			return
		}

		switch (msg.type) {
			case 'COMPANION_LIST': {
				const bindings = msg.bindings
				const scoreTargets = msg.scoreTargets
				const playerSelectors = msg.playerSelectors
				const slotTargets = msg.slotTargets
				const cardTargets = msg.cardTargets
				const highlightTargets = msg.highlightTargets
				let changed = false
				if (Array.isArray(bindings)) {
					this.bindings = bindings as CompanionBindingInfo[]
					changed = true
				}
				if (Array.isArray(scoreTargets)) {
					this.scoreTargets = scoreTargets as CompanionScoreTargetInfo[]
					changed = true
				}
				if (Array.isArray(playerSelectors)) {
					this.playerSelectors = playerSelectors as CompanionPlayerSelectorTargetInfo[]
					changed = true
				}
				if (Array.isArray(slotTargets)) {
					this.slotTargets = slotTargets as CompanionSlotTargetInfo[]
					changed = true
				}
				if (Array.isArray(cardTargets)) {
					this.cardTargets = cardTargets as CompanionCardTargetInfo[]
					changed = true
				}
				if (Array.isArray(highlightTargets)) {
					this.highlightTargets = highlightTargets as CompanionHighlightTargetInfo[]
					changed = true
				}
				if (changed) this.updateActionsAndFeedbacks()
				break
			}
			case 'COMPANION_FEEDBACK': {
				this.feedbackState = {
					recording: !!msg.recording,
					streaming: !!msg.streaming,
					fadeToBlack: !!msg.fadeToBlack,
					toggles: (msg.toggles as Record<string, boolean>) ?? {},
				}
				this.scoreboards = Array.isArray(msg.scoreboards) ? (msg.scoreboards as CompanionScoreboardInfo[]) : []
				this.matchInfo = (msg.matchInfo as CompanionMatchInfo) ?? { tournamentName: '', venue: '' }
				this.timerStages = Array.isArray(msg.timerStages) ? (msg.timerStages as CompanionTimerStageInfo[]) : []

				const nextAppText = Array.isArray(msg.appText) ? (msg.appText as CompanionAppTextFieldInfo[]) : []
				const prevKeys = this.appText.map(appFieldKey).join(',')
				const nextKeys = nextAppText.map(appFieldKey).join(',')
				this.appText = nextAppText

				this.checkFeedbacks('recording', 'streaming', 'fadeToBlack', 'toggleOn', 'appDisplayText', 'timerStageActive', 'timerRunning', 'teamScore', 'teamLogo')
				this.updateVariables()
				// The dropdown of available text fields only needs rebuilding when
				// which fields exist changes (a widget was added/removed/retyped) —
				// not on every value tick, which would otherwise thrash it.
				if (nextKeys !== prevKeys) this.updateActionsAndFeedbacks()
				break
			}
			default:
				break
		}
	}

	private bindingChoices(): { id: string; label: string }[] {
		if (this.bindings.length === 0) {
			return [{ id: '', label: '(no buttons received yet - open the app and load a page with a Button widget)' }]
		}
		return this.bindings.map((b) => ({
			id: b.id,
			label: b.accelerator ? `${b.label} (${b.accelerator})` : b.label,
		}))
	}

	// One flattened choice per (score target × scorer), plus a "no scorer"
	// choice per target — e.g. "Team A — Try — #9 John Smith" and
	// "Team A — Try — (no scorer)". Companion has no way to filter one
	// dropdown's choices based on another dropdown's live selection, so
	// team+points+scorer has to be a single pick to stay unambiguous; the id
	// encodes `${targetId}|${jerseyNo}` (jerseyNo empty for "no scorer").
	private scoreChoices(): { id: string; label: string }[] {
		if (this.scoreTargets.length === 0) {
			return [{ id: '', label: '(no scoreboards received yet - open the app and load a page with a Scoreboard widget)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const t of this.scoreTargets) {
			out.push({ id: `${t.id}|`, label: `${t.label} — (no scorer)` })
			for (const s of t.scorers) {
				out.push({ id: `${t.id}|${s.jerseyNo}`, label: `${t.label} — #${s.jerseyNo} ${s.name}` })
			}
		}
		return out
	}

	// One choice per distinct (board, score type) — deduped from
	// scoreTargets, which otherwise repeats "Try (+5)" once per team. Each
	// choice's id is a REPRESENTATIVE full target id (team A's variant) so
	// "Score armed type" can later swap in the actual player's team without
	// needing any other lookup.
	private scoreTypeChoices(): { id: string; label: string }[] {
		if (this.scoreTargets.length === 0) {
			return [{ id: '', label: '(no scoreboards received yet - open the app and load a page with a Scoreboard widget)' }]
		}
		const multipleBoards = new Set(this.scoreTargets.map((t) => t.widgetId)).size > 1
		const seen = new Set<string>()
		const out: { id: string; label: string }[] = []
		for (const t of this.scoreTargets) {
			const key = `${t.widgetId}|${t.scoreLabel}`
			if (seen.has(key)) continue
			seen.add(key)
			// Labeled by the board itself (same convention "Arm player list
			// slot" already uses), never by team — a type like "Try" applies
			// to whichever team scores it, it isn't owned by one side.
			out.push({ id: t.id, label: multipleBoards ? `${t.widgetLabel} — ${t.scoreLabel}` : t.scoreLabel })
		}
		return out
	}

	// One choice per (board+team, player) — deduped the same way, so the
	// same player list works no matter which score type is currently armed.
	// One choice per (board+team, slot) — a position ("Starter 3"), not a
	// specific player. The label shows who's currently in it for reference
	// when configuring the button, but the id only encodes the slot itself;
	// scoreArmedType's callback looks up the CURRENT occupant fresh at press
	// time, so the same button keeps working correctly across substitutions
	// with no reconfiguration.
	private scoreSlotChoices(): { id: string; label: string }[] {
		if (this.scoreTargets.length === 0) {
			return [{ id: '', label: '(no scoreboards received yet - open the app and load a page with a Scoreboard widget)' }]
		}
		const seen = new Set<string>()
		const out: { id: string; label: string }[] = []
		for (const t of this.scoreTargets) {
			const key = `${t.widgetId}|${t.team}`
			if (seen.has(key)) continue
			seen.add(key)
			for (const s of t.slots) {
				const sectionLabel = s.section === 'starter' ? 'Starter' : 'Sub'
				const who = s.jerseyNo ? `#${s.jerseyNo} ${s.name}` : '(empty)'
				out.push({ id: `${t.widgetId}|${t.team}|${s.section}|${s.index}`, label: `${t.teamName} — ${sectionLabel} ${s.index + 1} — ${who}` })
			}
		}
		if (out.length === 0) return [{ id: '', label: '(no Player List slots received yet - link one to this Scoreboard in the app)' }]
		return out
	}

	// One flattened choice per (player-selector target × player) — team is
	// already baked into the label/choice ("Player Stats — #9 John Smith
	// (Team A)" vs "Head to Head — Player A — #9 John Smith"), so there's
	// only ever one dropdown to pick from, whether or not that target's slot
	// needed a team choice in the first place. The id encodes
	// `${targetId}|${playerId}`.
	private playerChoices(): { id: string; label: string }[] {
		if (this.playerSelectors.length === 0) {
			return [{ id: '', label: '(no player-picker widgets received yet - add a Player Stats/Head to Head widget in the app)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const t of this.playerSelectors) {
			for (const p of t.choices) {
				const label = t.needsTeamPick
					? `${t.label} — #${p.jerseyNo} ${p.name} (Team ${p.side})`
					: `${t.label} — #${p.jerseyNo} ${p.name}`
				out.push({ id: `${t.id}|${p.playerId}`, label })
			}
		}
		return out
	}

	// One flattened choice per (slot × roster player), plus a "(clear slot)"
	// choice per slot — same reasoning as scoreChoices()/playerChoices(): a
	// slot number alone means nothing without which player fills it, so
	// they're one combined pick. Filling a slot with a player already in
	// another slot moves them, same as the app's own drag-to-assign.
	private slotChoices(): { id: string; label: string }[] {
		if (this.slotTargets.length === 0) {
			return [{ id: '', label: '(no Player List slots received yet - add a Player List widget in the app)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const t of this.slotTargets) {
			out.push({ id: `${t.id}|`, label: `${t.label} — (clear slot)` })
			for (const p of t.roster) {
				out.push({ id: `${t.id}|${p.playerId}`, label: `${t.label} — #${p.jerseyNo} ${p.name}${p.currentSlot ? ` (from ${p.currentSlot})` : ''}` })
			}
		}
		return out
	}

	// One flattened choice per (Player List side × eligible player × card
	// type) — giving a card needs both a player and a card type picked, so
	// (again, same reasoning) they're one combined choice, not two
	// independent dropdowns.
	private cardChoices(): { id: string; label: string }[] {
		if (this.cardTargets.length === 0) {
			return [{ id: '', label: '(no Player List widgets received yet - add one in the app)' }]
		}
		const out: { id: string; label: string }[] = []
		const CARD_LABELS: Record<'yellow' | 'orange' | 'red', string> = { yellow: 'Yellow Card', orange: 'Orange Card (HIA)', red: 'Red Card' }
		for (const t of this.cardTargets) {
			for (const p of t.roster) {
				for (const cardType of ['yellow', 'orange', 'red'] as const) {
					out.push({ id: `${t.id}|${p.playerId}|${cardType}`, label: `${t.label} — #${p.jerseyNo} ${p.name} — ${CARD_LABELS[cardType]}` })
				}
			}
		}
		return out
	}

	// One flattened choice per (Player List side × roster player), for
	// setting which player a linked Player Lower Third shows.
	private highlightChoices(): { id: string; label: string }[] {
		if (this.highlightTargets.length === 0) {
			return [{ id: '', label: '(no Player List → Player Lower Third links received yet)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const t of this.highlightTargets) {
			for (const p of t.roster) {
				out.push({ id: `${t.id}|${p.playerId}`, label: `${t.label} — #${p.jerseyNo} ${p.name}` })
			}
		}
		return out
	}

	// ── "Arm target, then press any player" choice builders ──────────────
	// One choice per TARGET only (no player) for the "Arm ..." actions, and
	// one choice per distinct PLAYER only (deduped across every target in
	// that family) for the paired "... (pick player)" action. At press
	// time, the callback checks the picked player actually belongs to
	// whichever target is currently armed before firing — see the action
	// callbacks below.

	private armPlayerTargetChoices(): { id: string; label: string }[] {
		if (this.playerSelectors.length === 0) {
			return [{ id: '', label: '(no player-picker widgets received yet - add a Player Stats/Head to Head widget in the app)' }]
		}
		return this.playerSelectors.map((t) => ({ id: t.id, label: t.label }))
	}

	private applyPlayerChoices(): { id: string; label: string }[] {
		const seen = new Set<string>()
		const out: { id: string; label: string }[] = []
		for (const t of this.playerSelectors) {
			for (const p of t.choices) {
				if (seen.has(p.playerId)) continue
				seen.add(p.playerId)
				out.push({ id: p.playerId, label: p.side ? `#${p.jerseyNo} ${p.name} (Team ${p.side})` : `#${p.jerseyNo} ${p.name}` })
			}
		}
		if (out.length === 0) return [{ id: '', label: '(no players received yet)' }]
		return out
	}

	private armSlotChoices(): { id: string; label: string }[] {
		if (this.slotTargets.length === 0) {
			return [{ id: '', label: '(no Player List slots received yet - add a Player List widget in the app)' }]
		}
		return this.slotTargets.map((t) => ({ id: t.id, label: t.label }))
	}

	private applySlotPlayerChoices(): { id: string; label: string }[] {
		const seen = new Set<string>()
		const out: { id: string; label: string }[] = []
		for (const t of this.slotTargets) {
			for (const p of t.roster) {
				if (seen.has(p.playerId)) continue
				seen.add(p.playerId)
				// Shows where they currently sit (if anywhere) so picking someone
				// already in a slot makes it obvious this MOVES them — a starter
				// picked here comes out of their starter slot and into whichever
				// one is armed, same the other way round, exactly like dragging
				// them there in the app's own lineup grid.
				out.push({ id: p.playerId, label: `#${p.jerseyNo} ${p.name}${p.currentSlot ? ` (${p.currentSlot})` : ''}` })
			}
		}
		if (out.length === 0) return [{ id: '', label: '(no players received yet)' }]
		return out
	}

	private applyCardPlayerChoices(): { id: string; label: string }[] {
		const seen = new Set<string>()
		const out: { id: string; label: string }[] = []
		for (const t of this.cardTargets) {
			for (const p of t.roster) {
				if (seen.has(p.playerId)) continue
				seen.add(p.playerId)
				out.push({ id: p.playerId, label: `#${p.jerseyNo} ${p.name}` })
			}
		}
		if (out.length === 0) return [{ id: '', label: '(no players received yet)' }]
		return out
	}

	private armHighlightTargetChoices(): { id: string; label: string }[] {
		if (this.highlightTargets.length === 0) {
			return [{ id: '', label: '(no Player List → Player Lower Third links received yet)' }]
		}
		return this.highlightTargets.map((t) => ({ id: t.id, label: t.label }))
	}

	private applyHighlightPlayerChoices(): { id: string; label: string }[] {
		const seen = new Set<string>()
		const out: { id: string; label: string }[] = []
		for (const t of this.highlightTargets) {
			for (const p of t.roster) {
				if (seen.has(p.playerId)) continue
				seen.add(p.playerId)
				out.push({ id: p.playerId, label: `#${p.jerseyNo} ${p.name}` })
			}
		}
		if (out.length === 0) return [{ id: '', label: '(no players received yet)' }]
		return out
	}

	private appTextChoices(): { id: string; label: string }[] {
		if (this.appText.length === 0) {
			return [{ id: '', label: '(no app display text received yet - add a Timer/Label/File Path widget in the app)' }]
		}
		return this.appText.map((f) => ({
			id: appFieldKey(f),
			label: `[${APP_TEXT_SECTIONS[f.widgetType] ?? f.widgetType}] ${f.widgetLabel} — ${f.fieldName}`,
		}))
	}

	// One flattened choice per (Timer × stage) — regular periods 1..N plus
	// Extra Time / After Extra Time / Final Play — same reasoning as
	// scoreChoices(): a feedback option's choices are static, so "which
	// timer" and "which stage" have to be one combined pick, not two
	// independent dropdowns, to stay meaningful (a period number alone means
	// nothing without knowing which timer it belongs to).
	private timerStageChoices(): { id: string; label: string }[] {
		if (this.timerStages.length === 0) {
			return [{ id: '', label: '(no timers received yet - add a Timer widget in the app)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const t of this.timerStages) {
			for (let p = 1; p <= t.periods; p++) {
				out.push({ id: `${t.widgetId}|period:${p}`, label: `${t.widgetLabel} — Period ${p}` })
			}
			out.push({ id: `${t.widgetId}|break`, label: `${t.widgetLabel} — Half Time / Break` })
			if (t.etPeriods > 1) {
				for (let p = 1; p <= t.etPeriods; p++) {
					out.push({ id: `${t.widgetId}|extraTime:${p}`, label: `${t.widgetLabel} — Extra Time ${p}` })
				}
			} else {
				out.push({ id: `${t.widgetId}|extraTime`, label: `${t.widgetLabel} — Extra Time` })
			}
			out.push({ id: `${t.widgetId}|etBreak`, label: `${t.widgetLabel} — Extra Time Break` })
			out.push({ id: `${t.widgetId}|afterEt`, label: `${t.widgetLabel} — After Extra Time` })
			out.push({ id: `${t.widgetId}|finalPlay`, label: `${t.widgetLabel} — Final Play` })
		}
		return out
	}

	private timerChoices(): { id: string; label: string }[] {
		if (this.timerStages.length === 0) {
			return [{ id: '', label: '(no timers received yet - add a Timer widget in the app)' }]
		}
		return this.timerStages.map((t) => ({ id: t.widgetId, label: t.widgetLabel }))
	}

	private teamScoreChoices(): { id: string; label: string }[] {
		if (this.scoreboards.length === 0) {
			return [{ id: '', label: '(no scoreboards received yet - open the app and load a page with a Scoreboard widget)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const b of this.scoreboards) {
			out.push({ id: `${b.widgetId}|A`, label: `${b.teamAName} Score` })
			out.push({ id: `${b.widgetId}|B`, label: `${b.teamBName} Score` })
		}
		return out
	}

	private teamLogoChoices(): { id: string; label: string }[] {
		if (this.scoreboards.length === 0) {
			return [{ id: '', label: '(no scoreboards received yet - open the app and load a page with a Scoreboard widget)' }]
		}
		const out: { id: string; label: string }[] = []
		for (const b of this.scoreboards) {
			out.push({ id: `${b.widgetId}|A`, label: `${b.teamAName} Logo` })
			out.push({ id: `${b.widgetId}|B`, label: `${b.teamBName} Logo` })
		}
		return out
	}

	// Fetches + base64-encodes a team's logo image for the "Show team logo"
	// feedback's `png64` field, cached per widget+side so it's only
	// re-fetched when the logo URL actually changes (not on every feedback
	// re-check). Node 22/26's built-in `fetch`/`Buffer` are enough for this
	// — deliberately no image-processing dependency, so only logos that are
	// already PNGs are supported for now (see companion-module/README.md).
	private async getLogoBase64(widgetId: string, side: 'A' | 'B', url: string): Promise<string | null> {
		const key = `${widgetId}:${side}`
		const cached = this.logoCache.get(key)
		if (cached && cached.url === url) return cached.base64
		if (!url) {
			this.logoCache.set(key, { url, base64: null })
			return null
		}
		try {
			const res = await fetch(url)
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			const contentType = res.headers.get('content-type') || ''
			if (!contentType.includes('png')) {
				this.log('warn', `Team logo at ${url} is not a PNG (${contentType || 'unknown type'}) — only PNG logos are supported currently.`)
				this.logoCache.set(key, { url, base64: null })
				return null
			}
			const buf = Buffer.from(await res.arrayBuffer())
			const base64 = buf.toString('base64')
			this.logoCache.set(key, { url, base64 })
			return base64
		} catch (e) {
			this.log('warn', `Failed to fetch team logo (${url}): ${e instanceof Error ? e.message : String(e)}`)
			this.logoCache.set(key, { url, base64: null })
			return null
		}
	}

	// Registers one group of Variables per Scoreboard widget on the app's
	// canvas — live score plus each team's most recent scorer, jersey
	// number, and action label (Try/Conversion/Penalty/etc), pulled from the
	// same player library the app itself scores against. Reference them in
	// any button's own text (e.g. "$(gomolab-vmixcontrol:board1_a_last_scorer)")
	// to show "who scored" on the deck without a separate action/feedback.
	// Boards are numbered by their order in COMPANION_FEEDBACK (stable for a
	// given canvas layout, but re-numbers if a Scoreboard widget is added,
	// removed, or reordered — re-check button text after doing that).
	private updateVariables(): void {
		const defs: Record<string, { name: string }> = {}
		const values: Record<string, string | number> = {}
		const add = (id: string, name: string, value: string | number) => {
			defs[id] = { name }
			values[id] = value
		}

		this.scoreboards.forEach((b, i) => {
			const n = i + 1
			add(`board${n}_a_name`, `Board ${n} — Team A Name`, b.teamAName)
			add(`board${n}_b_name`, `Board ${n} — Team B Name`, b.teamBName)
			add(`board${n}_a_score`, `Board ${n} — ${b.teamAName} Score`, b.scoreA)
			add(`board${n}_b_score`, `Board ${n} — ${b.teamBName} Score`, b.scoreB)
			add(`board${n}_a_last_scorer`, `Board ${n} — ${b.teamAName} Last Scorer`, b.lastA?.scorer ?? '')
			add(`board${n}_a_last_jersey`, `Board ${n} — ${b.teamAName} Last Scorer #`, b.lastA?.jerseyNo ?? '')
			add(`board${n}_a_last_action`, `Board ${n} — ${b.teamAName} Last Action`, b.lastA?.action ?? '')
			add(`board${n}_b_last_scorer`, `Board ${n} — ${b.teamBName} Last Scorer`, b.lastB?.scorer ?? '')
			add(`board${n}_b_last_jersey`, `Board ${n} — ${b.teamBName} Last Scorer #`, b.lastB?.jerseyNo ?? '')
			add(`board${n}_b_last_action`, `Board ${n} — ${b.teamBName} Last Action`, b.lastB?.action ?? '')
		})

		// One variable per app display text field (Timer time/period/status,
		// Label text, File Path, ...) — keyed by widget type + its 1-based
		// index among widgets of that type, so it stays unique and readable
		// (e.g. "timer1_time") without leaking widget uuids.
		for (const f of this.appText) {
			add(
				`${slugify(f.widgetType)}${f.typeIndex}_${slugify(f.fieldName)}`,
				`[${APP_TEXT_SECTIONS[f.widgetType] ?? f.widgetType}] ${f.widgetLabel} — ${f.fieldName}`,
				f.value,
			)
		}

		// General match-context data from the database, not tied to any one
		// widget — current tournament/venue scope (Sidebar's own "Venue
		// Scope" picker) and the next unsent fixture within it.
		add('tournament_name', 'Tournament Name', this.matchInfo.tournamentName)
		add('venue', 'Venue', this.matchInfo.venue)
		const nf = this.matchInfo.nextFixture
		add('next_fixture_teams', 'Next Fixture — Teams', nf ? `${nf.teamAName} vs ${nf.teamBName}` : '')
		add('next_fixture_team_a', 'Next Fixture — Team A', nf?.teamAName ?? '')
		add('next_fixture_team_b', 'Next Fixture — Team B', nf?.teamBName ?? '')
		add('next_fixture_date', 'Next Fixture — Date', nf?.date ?? '')
		add('next_fixture_time', 'Next Fixture — Time', nf?.time ?? '')
		add('next_fixture_venue', 'Next Fixture — Venue', nf?.venue ?? '')
		add('next_fixture_round', 'Next Fixture — Round', nf?.round ?? '')
		add('next_fixture_competition', 'Next Fixture — Competition', nf?.competition ?? '')

		this.setVariableDefinitions(defs)
		this.setVariableValues(values)
	}

	private updateActionsAndFeedbacks(): void {
		const choices = this.bindingChoices()
		const scoreChoices = this.scoreChoices()
		const scoreTypeChoices = this.scoreTypeChoices()
		const scoreSlotChoices = this.scoreSlotChoices()
		const playerChoices = this.playerChoices()
		const slotChoices = this.slotChoices()
		const cardChoices = this.cardChoices()
		const highlightChoices = this.highlightChoices()
		const armPlayerTargetChoices = this.armPlayerTargetChoices()
		const applyPlayerChoices = this.applyPlayerChoices()
		const armSlotChoices = this.armSlotChoices()
		const applySlotPlayerChoices = this.applySlotPlayerChoices()
		const applyCardPlayerChoices = this.applyCardPlayerChoices()
		const armHighlightTargetChoices = this.armHighlightTargetChoices()
		const applyHighlightPlayerChoices = this.applyHighlightPlayerChoices()
		const cardTypeChoices: { id: string; label: string }[] = [
			{ id: 'yellow', label: 'Yellow Card' },
			{ id: 'orange', label: 'Orange Card (HIA)' },
			{ id: 'red', label: 'Red Card' },
		]
		const appTextChoices = this.appTextChoices()
		const timerStageChoices = this.timerStageChoices()
		const timerChoices = this.timerChoices()
		const teamScoreChoices = this.teamScoreChoices()
		const teamLogoChoices = this.teamLogoChoices()

		const actions: CompanionActionDefinitions = {
			trigger: {
				name: 'Trigger button',
				description: 'Fires the same action as clicking this button inside GOMOLAB vMix Control.',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Button',
						choices,
						default: choices[0]?.id ?? '',
						allowCustom: true,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const id = String(event.options.target ?? '')
					if (!id) return
					this.send({ type: 'COMPANION_TRIGGER', id, state: 'press' })
					setTimeout(() => {
						this.send({ type: 'COMPANION_TRIGGER', id, state: 'release' })
					}, 80)
				},
			},
			score: {
				name: 'Score (pick scorer)',
				description:
					'Adds points for a team on a Scoreboard widget, optionally recording which player scored — ' +
					'same as picking a player from the app\'s own on-screen scorer picker.',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Team, points & scorer',
						choices: scoreChoices,
						default: scoreChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const raw = String(event.options.target ?? '')
					if (!raw) return
					const sep = raw.indexOf('|')
					const id = sep === -1 ? raw : raw.slice(0, sep)
					const jerseyNo = sep === -1 ? '' : raw.slice(sep + 1)
					this.send({ type: 'COMPANION_TRIGGER', id, state: 'press', jerseyNo: jerseyNo || undefined })
				},
			},
			armScoreType: {
				name: 'Arm score type',
				description:
					'Remembers which score type (Try, Conversion, Penalty, ...) the next "Score armed type" press ' +
					'should use. Lets one small set of type buttons work with any player button, instead of ' +
					'needing a separate button per player per score type. Nothing happens in the app yet — this ' +
					'only sets which type is armed here in Companion.',
				options: [
					{
						id: 'type',
						type: 'dropdown',
						label: 'Score type',
						choices: scoreTypeChoices,
						default: scoreTypeChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const id = String(event.options.type ?? '')
					if (!id) return
					const choice = scoreTypeChoices.find((c) => c.id === id)
					this.armedScoreType = { id, label: choice?.label ?? id }
					this.checkFeedbacks('scoreTypeArmed')
				},
			},
			scoreArmedType: {
				name: 'Score armed type (pick player)',
				description:
					'Scores whichever type was last set with "Arm score type", for whoever currently occupies the ' +
					'selected Player List slot (e.g. "Starter 3") — press "Arm score type" once, then any number of ' +
					'these. The slot\'s occupant is looked up fresh every press, so the same button keeps working ' +
					'correctly across substitutions with no reconfiguring. Logs an error and does nothing if that ' +
					'slot is currently empty, if nothing is armed yet, or if the armed type belongs to a different ' +
					'Scoreboard than this slot.',
				options: [
					{
						id: 'slot',
						type: 'dropdown',
						label: 'Slot',
						choices: scoreSlotChoices,
						default: scoreSlotChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					if (!this.armedScoreType) {
						this.log('warn', 'Score armed type: no score type is armed — press an "Arm score type" button first.')
						return
					}
					const raw = String(event.options.slot ?? '')
					const parts = raw.split('|')
					if (parts.length !== 4) {
						this.log('warn', `Score armed type: slot option had an unexpected value ("${raw}") — is a Player List linked yet?`)
						return
					}
					const [widgetId, side, section, indexStr] = parts
					// armedScoreType.id is a full target id: `${widgetId}:score:${side}:${incIndex}`.
					const armedParts = this.armedScoreType.id.split(':')
					if (armedParts.length !== 4 || armedParts[0] !== widgetId) {
						this.log('warn', `Score armed type: armed type "${this.armedScoreType.label}" belongs to a different Scoreboard than this slot — pick a slot from the same board.`)
						return
					}
					// Look up who's CURRENTLY in that slot, fresh — not from
					// whatever the dropdown showed when the button was configured.
					const target = this.scoreTargets.find((t) => t.widgetId === widgetId && t.team === side)
					const slot = target?.slots.find((s) => s.section === section && String(s.index) === indexStr)
					const sectionLabel = section === 'starter' ? 'Starter' : 'Sub'
					if (!slot || !slot.jerseyNo) {
						this.log('error', `Score armed type: ${sectionLabel} ${Number(indexStr) + 1} is currently empty — no player assigned, nothing was scored.`)
						return
					}
					const finalId = `${widgetId}:score:${side}:${armedParts[3]}`
					this.send({ type: 'COMPANION_TRIGGER', id: finalId, state: 'press', jerseyNo: slot.jerseyNo })
				},
			},
			setPlayer: {
				name: 'Set player (team + jersey)',
				description:
					'Picks which player a Player Stats/Head to Head widget shows — same as picking team then ' +
					'jersey number in the widget\'s own on-screen picker. Team is skipped in the list below when ' +
					'the widget slot already has a fixed team (e.g. Head to Head\'s Player A/Player B).',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Widget & player',
						choices: playerChoices,
						default: playerChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const raw = String(event.options.target ?? '')
					if (!raw) return
					const sep = raw.indexOf('|')
					if (sep === -1) return
					const id = raw.slice(0, sep)
					const playerId = raw.slice(sep + 1)
					this.send({ type: 'COMPANION_TRIGGER', id, state: 'press', playerId })
				},
			},
			assignSlot: {
				name: 'Assign player list slot',
				description:
					'Puts a player into a Player List starter/sub slot — same as dragging them there in the ' +
					'app\'s own lineup grid. Placing a player already in another slot moves them; "(clear slot)" ' +
					'empties it.',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Slot & player',
						choices: slotChoices,
						default: slotChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const raw = String(event.options.target ?? '')
					if (!raw) return
					const sep = raw.indexOf('|')
					if (sep === -1) return
					const id = raw.slice(0, sep)
					const playerId = raw.slice(sep + 1)
					this.send({ type: 'COMPANION_TRIGGER', id, state: 'press', playerId })
				},
			},
			giveCard: {
				name: 'Give card',
				description:
					'Gives a yellow/orange/red card to a player currently on a Player List\'s roster — same as ' +
					'using the app\'s own card picker (sin bin timer, HIA timer, on-field removal, and stat count ' +
					'all follow automatically, same as in the app).',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Player & card',
						choices: cardChoices,
						default: cardChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const raw = String(event.options.target ?? '')
					if (!raw) return
					const parts = raw.split('|')
					if (parts.length !== 3) return
					const [id, playerId, cardType] = parts
					if (cardType !== 'yellow' && cardType !== 'orange' && cardType !== 'red') return
					this.send({ type: 'COMPANION_TRIGGER', id, state: 'press', playerId, cardType })
				},
			},
			highlightPlayer: {
				name: 'Highlight player',
				description:
					'Sets which player a linked Player Lower Third widget shows — same as clicking a player\'s ' +
					'highlight button in the app\'s Player List.',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Player',
						choices: highlightChoices,
						default: highlightChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const raw = String(event.options.target ?? '')
					if (!raw) return
					const sep = raw.indexOf('|')
					if (sep === -1) return
					const id = raw.slice(0, sep)
					const playerId = raw.slice(sep + 1)
					this.send({ type: 'COMPANION_TRIGGER', id, state: 'press', playerId })
				},
			},
			armPlayerTarget: {
				name: 'Arm player target (Player Stats/Head to Head)',
				description:
					'Remembers which Player Stats/Head to Head slot the next "Set armed target" press should fill — ' +
					'same "arm once, press any player" pattern as scoring. Nothing happens in the app yet.',
				options: [
					{
						id: 'target', type: 'dropdown', label: 'Target',
						choices: armPlayerTargetChoices, default: armPlayerTargetChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const id = String(event.options.target ?? '')
					if (!id) return
					const choice = armPlayerTargetChoices.find((c) => c.id === id)
					this.armedPlayerTarget = { id, label: choice?.label ?? id }
					this.checkFeedbacks('playerTargetArmed')
				},
			},
			setArmedTarget: {
				name: 'Set armed target (pick player)',
				description:
					'Shows the selected player on whichever Player Stats/Head to Head slot was last armed with ' +
					'"Arm player target". Does nothing if that player isn\'t valid for the armed slot (e.g. wrong team).',
				options: [
					{
						id: 'player', type: 'dropdown', label: 'Player',
						choices: applyPlayerChoices, default: applyPlayerChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					if (!this.armedPlayerTarget) {
						this.log('warn', 'Set armed target: nothing is armed — press an "Arm player target" button first.')
						return
					}
					const playerId = String(event.options.player ?? '')
					if (!playerId) return
					const target = this.playerSelectors.find((t) => t.id === this.armedPlayerTarget!.id)
					if (!target || !target.choices.some((c) => c.playerId === playerId)) {
						this.log('warn', `Set armed target: picked player isn't valid for armed target "${this.armedPlayerTarget.label}".`)
						return
					}
					this.send({ type: 'COMPANION_TRIGGER', id: this.armedPlayerTarget.id, state: 'press', playerId })
				},
			},
			armSlot: {
				name: 'Arm player list slot',
				description:
					'Remembers which Player List starter/sub slot the next "Assign armed slot" press should fill — ' +
					'same "arm once, press any player" pattern as scoring. Nothing happens in the app yet.',
				options: [
					{
						id: 'slot', type: 'dropdown', label: 'Slot',
						choices: armSlotChoices, default: armSlotChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const id = String(event.options.slot ?? '')
					if (!id) return
					const choice = armSlotChoices.find((c) => c.id === id)
					this.armedSlot = { id, label: choice?.label ?? id }
					this.checkFeedbacks('slotArmed')
				},
			},
			assignArmedSlot: {
				name: 'Assign armed slot (pick player)',
				description:
					'Puts the selected player into whichever Player List slot was last armed with "Arm player list ' +
					'slot". Does nothing if that player isn\'t on the armed slot\'s team roster.',
				options: [
					{
						id: 'player', type: 'dropdown', label: 'Player',
						choices: applySlotPlayerChoices, default: applySlotPlayerChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					if (!this.armedSlot) {
						this.log('warn', 'Assign armed slot: nothing is armed — press an "Arm player list slot" button first.')
						return
					}
					const playerId = String(event.options.player ?? '')
					if (!playerId) return
					const target = this.slotTargets.find((t) => t.id === this.armedSlot!.id)
					if (!target || !target.roster.some((p) => p.playerId === playerId)) {
						this.log('warn', `Assign armed slot: picked player isn't on armed slot "${this.armedSlot.label}"'s team roster.`)
						return
					}
					this.send({ type: 'COMPANION_TRIGGER', id: this.armedSlot.id, state: 'press', playerId })
				},
			},
			clearArmedSlot: {
				name: 'Clear armed slot',
				description: 'Empties whichever Player List slot was last armed with "Arm player list slot".',
				options: [],
				callback: async () => {
					if (!this.armedSlot) {
						this.log('warn', 'Clear armed slot: nothing is armed — press an "Arm player list slot" button first.')
						return
					}
					this.send({ type: 'COMPANION_TRIGGER', id: this.armedSlot.id, state: 'press', playerId: '' })
				},
			},
			armCardType: {
				name: 'Arm card type',
				description:
					'Remembers which card (yellow/orange/red) the next "Give armed card" press should give — same ' +
					'"arm once, press any player" pattern as scoring. Nothing happens in the app yet.',
				options: [
					{
						id: 'cardType', type: 'dropdown', label: 'Card type',
						choices: cardTypeChoices, default: cardTypeChoices[0]?.id ?? '',
						allowCustom: false,
					},
				],
				callback: async (event) => {
					const cardType = String(event.options.cardType ?? '')
					if (cardType !== 'yellow' && cardType !== 'orange' && cardType !== 'red') return
					this.armedCardType = cardType
					this.checkFeedbacks('cardTypeArmed')
				},
			},
			giveArmedCard: {
				name: 'Give armed card (pick player)',
				description:
					'Gives the selected player whichever card type was last armed with "Arm card type" — sin bin/HIA ' +
					'timers, on-field removal, stat count, and Timeline event all follow automatically, same as the ' +
					'app\'s own card picker. Does nothing if that player isn\'t currently eligible on any Player List.',
				options: [
					{
						id: 'player', type: 'dropdown', label: 'Player',
						choices: applyCardPlayerChoices, default: applyCardPlayerChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					if (!this.armedCardType) {
						this.log('warn', 'Give armed card: no card type is armed — press an "Arm card type" button first.')
						return
					}
					const playerId = String(event.options.player ?? '')
					if (!playerId) return
					const target = this.cardTargets.find((t) => t.roster.some((p) => p.playerId === playerId))
					if (!target) {
						this.log('warn', 'Give armed card: picked player isn\'t currently eligible on any Player List.')
						return
					}
					this.send({ type: 'COMPANION_TRIGGER', id: target.id, state: 'press', playerId, cardType: this.armedCardType })
				},
			},
			armHighlightTarget: {
				name: 'Arm highlight target',
				description:
					'Remembers which Player Lower Third link the next "Highlight armed target" press should set — ' +
					'same "arm once, press any player" pattern as scoring. Nothing happens in the app yet.',
				options: [
					{
						id: 'target', type: 'dropdown', label: 'Target',
						choices: armHighlightTargetChoices, default: armHighlightTargetChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					const id = String(event.options.target ?? '')
					if (!id) return
					const choice = armHighlightTargetChoices.find((c) => c.id === id)
					this.armedHighlightTarget = { id, label: choice?.label ?? id }
					this.checkFeedbacks('highlightTargetArmed')
				},
			},
			highlightArmedTarget: {
				name: 'Highlight armed target (pick player)',
				description:
					'Sets the selected player on whichever Player Lower Third link was last armed with "Arm ' +
					'highlight target". Does nothing if that player isn\'t on the armed target\'s team roster.',
				options: [
					{
						id: 'player', type: 'dropdown', label: 'Player',
						choices: applyHighlightPlayerChoices, default: applyHighlightPlayerChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				callback: async (event) => {
					if (!this.armedHighlightTarget) {
						this.log('warn', 'Highlight armed target: nothing is armed — press an "Arm highlight target" button first.')
						return
					}
					const playerId = String(event.options.player ?? '')
					if (!playerId) return
					const target = this.highlightTargets.find((t) => t.id === this.armedHighlightTarget!.id)
					if (!target || !target.roster.some((p) => p.playerId === playerId)) {
						this.log('warn', `Highlight armed target: picked player isn't on armed target "${this.armedHighlightTarget.label}"'s team roster.`)
						return
					}
					this.send({ type: 'COMPANION_TRIGGER', id: this.armedHighlightTarget.id, state: 'press', playerId })
				},
			},
		}
		this.setActionDefinitions(actions)

		const feedbacks: CompanionFeedbackDefinitions = {
			recording: {
				type: 'boolean',
				name: 'Recording active',
				description: 'True while vMix is recording.',
				options: [],
				defaultStyle: { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255, 255, 255) },
				callback: () => this.feedbackState.recording,
			},
			streaming: {
				type: 'boolean',
				name: 'Streaming active',
				description: 'True while vMix is streaming.',
				options: [],
				defaultStyle: { bgcolor: combineRgb(0, 130, 0), color: combineRgb(255, 255, 255) },
				callback: () => this.feedbackState.streaming,
			},
			fadeToBlack: {
				type: 'boolean',
				name: 'Fade to black active',
				description: 'True while vMix FTB is engaged.',
				options: [],
				defaultStyle: { bgcolor: combineRgb(0, 0, 0), color: combineRgb(255, 255, 255) },
				callback: () => this.feedbackState.fadeToBlack,
			},
			toggleOn: {
				type: 'boolean',
				name: 'Toggle button is ON',
				description: 'True while the selected toggle-mode button is currently ON.',
				options: [
					{
						id: 'target',
						type: 'dropdown',
						label: 'Button',
						choices,
						default: choices[0]?.id ?? '',
						allowCustom: true,
						minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(255, 191, 0), color: combineRgb(0, 0, 0) },
				callback: (feedback) => {
					const id = String(feedback.options.target ?? '')
					return !!this.feedbackState.toggles[id]
				},
			},
			appDisplayText: {
				type: 'advanced',
				name: 'Show app display text',
				description:
					"Overrides this button's own text with something the controller app itself is currently " +
					'showing — a Timer\'s time/period, a Label\'s text, a File Path\'s current path — as opposed ' +
					'to vMix\'s own state. An alternative to referencing the equivalent Variable directly in the ' +
					'button text.',
				options: [
					{
						id: 'field',
						type: 'dropdown',
						label: 'Field',
						choices: appTextChoices,
						default: appTextChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				affectedProperties: ['text'],
				callback: (feedback) => {
					const id = String(feedback.options.field ?? '')
					const f = this.appText.find((x) => appFieldKey(x) === id)
					return { text: f?.value ?? '' }
				},
			},
			timerStageActive: {
				type: 'boolean',
				name: 'Timer stage active',
				description:
					'True while the selected Timer widget is currently on the selected stage — a regular period, ' +
					'Half Time/Break, Extra Time (or its own break), After Extra Time, or Final Play. Useful for ' +
					'highlighting a "Jump to Period"/"Start Extra Time" button while that stage is the active one.',
				options: [
					{
						id: 'stage',
						type: 'dropdown',
						label: 'Timer & stage',
						choices: timerStageChoices,
						default: timerStageChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(0, 140, 186), color: combineRgb(255, 255, 255) },
				callback: (feedback) => {
					const raw = String(feedback.options.stage ?? '')
					const sep = raw.indexOf('|')
					if (sep === -1) return false
					const widgetId = raw.slice(0, sep)
					const stage = raw.slice(sep + 1)
					const t = this.timerStages.find((x) => x.widgetId === widgetId)
					if (!t) return false
					if (stage === 'break') return t.inBreak
					if (stage === 'etBreak') return t.inExtraTime && t.etInBreak
					if (stage === 'extraTime') return t.inExtraTime && !t.etInBreak
					if (stage.startsWith('extraTime:')) {
						const etPeriod = parseInt(stage.replace('extraTime:', ''), 10)
						return t.inExtraTime && !t.etInBreak && t.etCurrentPeriod === etPeriod
					}
					if (stage === 'afterEt') return t.inAfterEt
					if (stage === 'finalPlay') return t.inFinalPlay
					const period = parseInt(stage.replace('period:', ''), 10)
					return !t.inBreak && !t.inExtraTime && !t.inAfterEt && !t.inFinalPlay && t.currentPeriod === period
				},
			},
			timerRunning: {
				type: 'boolean',
				name: 'Timer running',
				description:
					'True while the selected Timer widget is running — regardless of which stage it\'s currently on ' +
					'(regular period, break, Extra Time, After Extra Time, or Final Play all share the same running/' +
					'paused state). Useful for a Start/Pause button that should reflect the real state even when it ' +
					'changed some other way (the widget\'s own controls, another Companion button, natural period end).',
				options: [
					{
						id: 'widgetId',
						type: 'dropdown',
						label: 'Timer',
						choices: timerChoices,
						default: timerChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(46, 204, 113), color: combineRgb(0, 0, 0) },
				callback: (feedback) => {
					const widgetId = String(feedback.options.widgetId ?? '')
					const t = this.timerStages.find((x) => x.widgetId === widgetId)
					return t?.running ?? false
				},
			},
			scoreTypeArmed: {
				type: 'boolean',
				name: 'Score type armed',
				description: 'True while the selected score type is the one "Arm score type" last set.',
				options: [
					{
						id: 'type',
						type: 'dropdown',
						label: 'Score type',
						choices: scoreTypeChoices,
						default: scoreTypeChoices[0]?.id ?? '',
						allowCustom: false,
						minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(255, 140, 0), color: combineRgb(0, 0, 0) },
				callback: (feedback) => {
					const id = String(feedback.options.type ?? '')
					return this.armedScoreType?.id === id
				},
			},
			playerTargetArmed: {
				type: 'boolean',
				name: 'Player target armed',
				description: 'True while the selected Player Stats/Head to Head target is the one "Arm player target" last set.',
				options: [
					{
						id: 'target', type: 'dropdown', label: 'Target',
						choices: armPlayerTargetChoices, default: armPlayerTargetChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(255, 140, 0), color: combineRgb(0, 0, 0) },
				callback: (feedback) => this.armedPlayerTarget?.id === String(feedback.options.target ?? ''),
			},
			slotArmed: {
				type: 'boolean',
				name: 'Slot armed',
				description: 'True while the selected Player List slot is the one "Arm player list slot" last set.',
				options: [
					{
						id: 'slot', type: 'dropdown', label: 'Slot',
						choices: armSlotChoices, default: armSlotChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(255, 140, 0), color: combineRgb(0, 0, 0) },
				callback: (feedback) => this.armedSlot?.id === String(feedback.options.slot ?? ''),
			},
			cardTypeArmed: {
				type: 'boolean',
				name: 'Card type armed',
				description: 'True while the selected card type is the one "Arm card type" last set.',
				options: [
					{
						id: 'cardType', type: 'dropdown', label: 'Card type',
						choices: cardTypeChoices, default: cardTypeChoices[0]?.id ?? '',
						allowCustom: false,
					},
				],
				defaultStyle: { bgcolor: combineRgb(255, 140, 0), color: combineRgb(0, 0, 0) },
				callback: (feedback) => this.armedCardType === String(feedback.options.cardType ?? ''),
			},
			highlightTargetArmed: {
				type: 'boolean',
				name: 'Highlight target armed',
				description: 'True while the selected Player Lower Third link is the one "Arm highlight target" last set.',
				options: [
					{
						id: 'target', type: 'dropdown', label: 'Target',
						choices: armHighlightTargetChoices, default: armHighlightTargetChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				defaultStyle: { bgcolor: combineRgb(255, 140, 0), color: combineRgb(0, 0, 0) },
				callback: (feedback) => this.armedHighlightTarget?.id === String(feedback.options.target ?? ''),
			},
			teamScore: {
				type: 'advanced',
				name: 'Show team score',
				description: "Overrides this button's own text with a team's live score — same data as the board{n}_a_score/board{n}_b_score variables, as a feedback instead.",
				options: [
					{
						id: 'target', type: 'dropdown', label: 'Team',
						choices: teamScoreChoices, default: teamScoreChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				affectedProperties: ['text'],
				callback: (feedback) => {
					const raw = String(feedback.options.target ?? '')
					const [widgetId, side] = raw.split('|')
					const board = this.scoreboards.find((b) => b.widgetId === widgetId)
					if (!board) return {}
					return { text: String(side === 'A' ? board.scoreA : board.scoreB) }
				},
			},
			teamLogo: {
				type: 'advanced',
				name: 'Show team logo',
				description:
					"Shows a team's logo image on this button, fetched from the same URL vMix itself uses. Only " +
					'PNG logos are supported currently — other formats log a warning in this connection\'s log and ' +
					'show nothing.',
				options: [
					{
						id: 'target', type: 'dropdown', label: 'Team',
						choices: teamLogoChoices, default: teamLogoChoices[0]?.id ?? '',
						allowCustom: false, minChoicesForSearch: 1,
					},
				],
				affectedProperties: ['png64'],
				callback: async (feedback) => {
					const raw = String(feedback.options.target ?? '')
					const [widgetId, side] = raw.split('|')
					if (side !== 'A' && side !== 'B') return {}
					const board = this.scoreboards.find((b) => b.widgetId === widgetId)
					if (!board) return {}
					const url = side === 'A' ? board.teamALogo : board.teamBLogo
					if (!url) return {}
					const base64 = await this.getLogoBase64(widgetId, side, url)
					return base64 ? { png64: base64 } : {}
				},
			},
		}
		this.setFeedbackDefinitions(feedbacks)
	}
}

export default ModuleInstance
