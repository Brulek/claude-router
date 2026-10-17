import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'
import type { LanesState } from './checklist'
import type { Controls, Gate, Guard, LaneInfo, LaneRow, LaneTotals, Quota, QuotaWindows, Review, RunningAgent, Routing, TurnRecord } from '../types'
import { ARGUMENT_HINT, DEFAULT_CONTROLS, LANE_KEYS, MANUAL_TOAST, USAGE, checklist, drawsBand, effectiveRouting, isDelivery, laneName, migrateRouting, parseGate, parseGuard, parseLaneText, parseReview, parseRouting, parseSpick } from './checklist'
import { BAND_BUTTON_CHROME, BAND_SWITCH_GAP, HOTKEY_W, LABEL_W, MAIN_LANE, NARROW_BELOW, NARROW_RECENT_ROWS, STALE_MS, bandSegments, clip, colWidths, contextNote, estimateCost, fmtAge, isSourcePath, modelName, noteParts, parseCli, promptTokens, sampleNote, quotaBar, quotaMeters, quotaWindows, recentRows, runningRows, tagLine, usageRows, wrapWords } from './format'
import type { Align, BandView, Cells, Seg } from './format'
import { EDIT_CAP, ESCALATE_AFTER, UNCHECKED_RE, checkOf, declaredChecks, editCapReason, escalationLine, uncheckedReason } from './guard'
import { KEPT_RE, gateFiring, gateOutcome, keptLine, roleDone, sendBackText } from './gate'
import type { DelegateStatus } from './gate'
import { findHints, lineOf } from './hint'
import type { Hint } from './hint'
import { readQuota } from './quota'
import { ZERO_USAGE, addUsage, appendLines, lateLine, lineText, turnLine, usageEntry } from './turnlog'
import type { CheckEntry, DelegateEntry, GateEvent, UsageEntry } from './turnlog'
import { lanesFromCache, quotaLineFromCache } from './quotaline'
import { markerPath, spickPaths, turnsFile } from './paths'
import { DEFAULT_EFFORTS, effortToFill, effortsFrom } from './efforts'
import type { Efforts } from './efforts'
import type { SpickPaths } from './paths'

const P = 'spick-dashboard'
const current = atom({ plugin: 'spick-dashboard', key: 'current' } as const, null)
const running = atom({ plugin: 'spick-dashboard', key: 'running' } as const, [])
const last = atom({ plugin: 'spick-dashboard', key: 'last' } as const, null)
const turns = atom({ plugin: 'spick-dashboard', key: 'turns' } as const, [])
const totals = atom({ plugin: 'spick-dashboard', key: 'totals' } as const, {})
const quota = atom({ plugin: 'spick-dashboard', key: 'quota' } as const, null)
const hidden = atom({ plugin: 'spick-dashboard', key: 'hidden' } as const, false)
const controls = atom({ plugin: 'spick-dashboard', key: 'controls' } as const, DEFAULT_CONTROLS)
const sessionModel = atom({ plugin: 'spick-dashboard', key: 'sessionModel' } as const, '')
const laneRows = atom({ plugin: 'spick-dashboard', key: 'laneRows' } as const, null)
const page = atom({ plugin: 'spick-dashboard', key: 'page' } as const, 'main')
const laneNote = atom({ plugin: 'spick-dashboard', key: 'laneNote' } as const, { change: '', error: '' })
const editSeq = atom({ plugin: 'spick-dashboard', key: 'editSeq' } as const, 0)

const QUOTA_TTL_MS = 600_000
const TICK_MS = 1_000
const PANE = 'spick'
const MARKER_REFRESH_MS = 3_600_000

// Helpers that take $ are top-level function declarations: the validator
// follows $ only into functions declared at the top of this file.
async function refreshQuota($: EngineInterface, force = false): Promise<Quota> {
  const now = await $.clock.now()
  const q = await read($, quota)
  if (!force && q && now - q.readAt < QUOTA_TTL_MS) return q
  // env names stay literal: the validator lists the variables a module reads
  const env = (name: 'HOME' | 'CODEX_HOME') => (name === 'CODEX_HOME' ? $.env.get('CODEX_HOME') : $.env.get('HOME'))
  const fresh: Quota = await readQuota({ env, read: path => $.fs.read(path), list: path => $.fs.list(path) }, now)
  await update($, quota, () => fresh)
  return fresh
}

/** spick's paths (paths.ts): CLAUDE_CONFIG_DIR, else HOME/.claude; null when neither is set */
async function pathsNow($: EngineInterface): Promise<SpickPaths | null> {
  return spickPaths(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
}

/**
 * The quota line, from the cache scripts/quota.py keeps at <state>/quota.json. One read, no run:
 * a missing, unreadable or empty cache gives null and the line is left out. The bash hook keeps the cache warm.
 */
async function quotaLineNow($: EngineInterface): Promise<string | null> {
  try {
    const p = await pathsNow($)
    if (!p) return null
    return quotaLineFromCache(await $.fs.read(p.quota), await $.clock.now())
  } catch { return null }
}

/** The lanes the user declared (lane_registry), from the same cache; null for a user without one, or when it cannot be read. */
async function lanesNow($: EngineInterface): Promise<LanesState | null> {
  try {
    const p = await pathsNow($)
    if (!p) return null
    return lanesFromCache(await $.fs.read(p.quota))
  } catch { return null }
}

/** The four remembered choices: routing, review, the gate and the guard. The lanes' on/off is not remembered here: it lives in spick.json. */
async function loadControls($: EngineInterface): Promise<void> {
  // routing under its new names (on, force, off) in spick:routing2; a value stored before the rename is migrated
  const stored = await $.store.get(ROUTING_KEY)
  const routing = stored === undefined || stored === null ? migrateRouting(await $.store.get('spick:routing')) : parseRouting(stored)
  const review = parseReview(await $.store.get('spick:review'))
  const gate = parseGate(await $.store.get('spick:gate'))
  const guard = parseGuard(await $.store.get('spick:guard'))
  // a manual model pick lasts one session only
  await update($, controls, () => ({ routing, review, gate, guard, manualModel: false }))
}

/** Change the switches and write the four remembered ones back to $.store. */
async function setControls($: EngineInterface, change: (c: Controls) => Controls): Promise<Controls> {
  const next = await update($, controls, change)
  try {
    await $.store.set(ROUTING_KEY, next.routing)
    await $.store.set('spick:review', next.review)
    await $.store.set('spick:gate', next.gate)
    await $.store.set('spick:guard', next.guard)
  } catch {}
  return next
}

// --- lanes: spick.json is written by scripts/set_lane.py only; this module never writes it ---------------------------
// $.process.run is called from command handlers and onPress closures, never from a render or a hook on the prompt path.

const firstLine = (s: string): string => s.split('\n').find(l => l.trim() !== '')?.trim() ?? ''

/** Run set_lane.py with the argv after the script path; ok is exit 0, err the first stderr line. */
async function runSetLane($: EngineInterface, args: string[]): Promise<{ ok: boolean; stdout: string; err: string }> {
  try {
    const p = await pathsNow($)
    if (!p) return { ok: false, stdout: '', err: 'HOME is not set' }
    const r = await $.process.run(['python3', `${p.scripts}/set_lane.py`, ...args])
    if (r.exitCode === 0) return { ok: true, stdout: r.stdout, err: '' }
    return { ok: false, stdout: r.stdout, err: firstLine(r.stderr) || `set_lane.py failed (exit ${r.exitCode})` }
  } catch {
    return { ok: false, stdout: '', err: 'could not run set_lane.py' }
  }
}

const isLaneRow = (r: unknown): r is LaneRow => !!r && typeof r === 'object' && typeof (r as LaneRow).id === 'string' && Array.isArray((r as LaneRow).tags)

/** The lanes as `set_lane.py --list` prints them (disabled ones included); keeps the pane's copy current when it succeeds. */
async function listLanes($: EngineInterface): Promise<{ rows: LaneRow[] | null; err: string }> {
  const r = await runSetLane($, ['--list'])
  if (!r.ok) return { rows: null, err: r.err }
  try {
    const doc = JSON.parse(r.stdout) as unknown
    if (!Array.isArray(doc)) return { rows: null, err: 'set_lane.py --list printed no list' }
    const rows = doc.filter(isLaneRow).map(x => ({ ...x, enabled: x.enabled !== false, data: x.data ?? null, notes: x.notes ?? null, kind: x.kind ?? null }))
    await update($, laneRows, () => rows)
    return { rows, err: '' }
  } catch {
    return { rows: null, err: 'set_lane.py --list printed no JSON' }
  }
}

/** a field as the lanes list shows it, or null for a field the list does not carry (base_url, model, key_ref ...) */
function laneField(row: LaneRow | undefined, field: string): string | null {
  if (!row) return null
  switch (field) {
    case 'name': return row.name
    case 'enabled': return row.enabled ? 'yes' : 'no'
    case 'tags': return row.tags.length > 0 ? row.tags.join(',') : '-'
    case 'data': return row.data ?? 'unset'
    case 'notes': return row.notes ?? '-'
    case 'kind': return row.kind ?? '-'
    default: return null
  }
}

/**
 * The one edit path (the command, the Input on the lanes page, the Controls buttons): set_lane.py changes the field,
 * then the lanes list is read again. The text is the one-line reply; the lanes page keeps it as its last change or last refusal.
 */
async function editLane($: EngineInterface, id: string, field: string, value: string): Promise<{ ok: boolean; text: string }> {
  const before = (await listLanes($)).rows
  const r = await runSetLane($, ['--id', id, '--field', field, '--value', value])
  if (!r.ok) {
    await update($, laneNote, n => ({ ...n, error: r.err }))
    return { ok: false, text: `spick: ${r.err}` }
  }
  const after = (await listLanes($)).rows
  const was = laneField(before?.find(l => l.id === id), field)
  const now = laneField(after?.find(l => l.id === id), field)
  const change = was !== null && now !== null ? `${id} ${field}: ${was} -> ${now}. Backup: spick.json.bak.` : `${id} ${field}: changed. Backup: spick.json.bak.`
  await update($, laneNote, () => ({ change, error: '' }))
  return { ok: true, text: `spick: ${change}` }
}

/** `/spick lane <id>`: the lane's whole record on one line */
async function laneRecordLine($: EngineInterface, id: string): Promise<string> {
  const { rows, err } = await listLanes($)
  if (!rows) return `spick: ${err}`
  const l = rows.find(x => x.id === id)
  if (!l) return `spick: unknown lane id ${id.length <= 40 && /^[a-z0-9-]+$/.test(id) ? id : '(not shown)'}`
  const f = (k: string) => laneField(l, k) ?? '-'
  return `spick: ${l.id} · enabled ${f('enabled')} · name ${f('name')} · tags ${f('tags')} · data ${f('data')} · kind ${f('kind')} · notes ${f('notes')}`
}

/** a lane's on or off Button: set enabled through set_lane.py, nothing when it already reads so; a refusal is a toast */
async function setLane($: EngineInterface, id: string, on: boolean): Promise<void> {
  const isOn = (await read($, laneRows))?.find(l => l.id === id)?.enabled ?? true
  if (isOn === on) return
  const r = await editLane($, id, 'enabled', on ? 'yes' : 'no')
  if (!r.ok) $.ui.toast(r.text)
}

/** the "[ Edit lanes ]" button: read the lanes, then show the page (a failed read shows on the page) */
async function openLanesPage($: EngineInterface): Promise<void> {
  const { err } = await listLanes($)
  if (err) await update($, laneNote, n => ({ ...n, error: err }))
  await update($, page, () => 'lanes')
}

/** the Input on the lanes page: "<lane> <field> <value>", the same handler as the command; a good edit clears the field */
async function submitLaneEdit($: EngineInterface, text: string): Promise<void> {
  const cmd = parseLaneText(text)
  if (!cmd || cmd.kind !== 'lane-set') {
    await update($, laneNote, n => ({ ...n, error: 'type <lane> <field> <value>' }))
    return
  }
  const r = await editLane($, cmd.lane, cmd.field, cmd.value)
  if (r.ok) await update($, editSeq, n => n + 1)
}

// --- the turn record: one file per session under <state>/turns/ (turnlog.ts); spend.py and audit.py read it ------------

/** the session's turn-record writer: lines not yet on disk, which part file, and the chain that keeps writes in order */
type TurnWriter = { sessionId: string; pending: string[]; part: number; chain: Promise<void> }

/** a part file this full is closed; the next line starts the next part, so a read never meets the 4 MiB limit */
const TURNS_PART_BYTES = 3_500_000

/**
 * Add lines to the session's file: read it, append, write it whole ($.fs.write writes a whole file only). Lines a
 * failed write left stay pending and land with the next write that goes through.
 */
function writeTurnLines($: EngineInterface, w: TurnWriter, lines: readonly string[]): Promise<void> {
  w.pending.push(...lines)
  const run = w.chain.then(async () => {
    // no session.start seen (a mod loaded mid-session): ask now
    if (!w.sessionId) w.sessionId = await $.session.id()
    const p = await pathsNow($)
    if (!p || !w.sessionId || w.pending.length === 0) return
    const batch = [...w.pending]
    const size = batch.reduce((n, l) => n + l.length, 0)
    let prev = ''
    for (;;) {
      try { prev = await $.fs.read(turnsFile(p, w.sessionId, w.part)) } catch { prev = '' }
      if (prev.length + size <= TURNS_PART_BYTES || prev.length === 0 || w.part >= 99) break
      w.part++
    }
    await $.fs.write(turnsFile(p, w.sessionId, w.part), appendLines(prev, batch))
    w.pending.splice(0, batch.length)
  })
  w.chain = run.catch(() => undefined)
  return run
}

/** run one of the skill's report scripts and answer its output, or one line saying why not */
async function reportOf($: EngineInterface, script: 'spend.py' | 'audit.py', empty: string): Promise<string> {
  try {
    const p = await pathsNow($)
    if (!p) return 'spick: HOME is not set'
    const r = await $.process.run(['python3', `${p.scripts}/${script}`, '--days', '7'])
    if (r.exitCode === 0) return r.stdout.trimEnd() || empty
    return `spick: ${firstLine(r.stderr) || `${script} failed (exit ${r.exitCode})`}`
  } catch {
    return `spick: could not run ${script}`
  }
}

/** The session model, read fresh where the engine answers, else the last one read. */
async function readSessionModel($: EngineInterface): Promise<string> {
  try {
    const m = await $.session.model()
    if (typeof m === 'string' && m) return await update($, sessionModel, () => m)
  } catch {}
  return await read($, sessionModel)
}

/**
 * Tell scripts/triage-hook.sh that the mod owns this session's checklist: the hook reads session_id from its stdin and
 * prints nothing while <state>/mod-active/<sessionId> is younger than 24 hours. Per session, so a session without the
 * mod (another surface, the mod disabled) still gets the hook's checklist.
 */
async function writeMarker($: EngineInterface): Promise<void> {
  const p = await pathsNow($)
  const id = await $.session.id()
  if (!p || !id) return
  await $.fs.write(markerPath(p, id), new Date(await $.clock.now()).toISOString())
}

/**
 * Whether the band is on screen: a surface that draws AbovePrompt and the band not hidden.
 * One test for both prompt.compose (its label-line section) and prompt.submit (the checklist's wording).
 */
async function bandShowing($: EngineInterface, surfaces: readonly RenderSurface[]): Promise<boolean> {
  return drawsBand(surfaces) && !(await read($, hidden))
}

/** the model now, or '' when the engine cannot say */
async function modelNow($: EngineInterface): Promise<string> {
  try {
    const m = await $.session.model()
    return typeof m === 'string' ? m : ''
  } catch {
    return ''
  }
}

/** A user's own model pick (a real change) turns routing off for the session; one toast. */
async function modelPickedByHand($: EngineInterface, model: string): Promise<void> {
  if (model) await update($, sessionModel, () => model)
  const before = await read($, controls)
  if (before.manualModel) return
  await update($, controls, c => ({ ...c, manualModel: true }))
  $.ui.toast(MANUAL_TOAST)
}

/** the reply to a routing change: the reason only where the value alone does not say it (on, a manual pick) */
async function routingLine($: EngineInterface): Promise<string> {
  const c = await read($, controls)
  if (c.routing !== 'on' && !c.manualModel) return `spick: routing ${c.routing}`
  return `spick: routing ${c.routing} · ${effectiveRouting(c, await readSessionModel($)).why}`
}

/** the quota meters as one line of text */
async function quotaLine($: EngineInterface, force: boolean): Promise<string> {
  const q = await refreshQuota($, force)
  const meters = quotaMeters(q).map(m => `${m.name} ${m.window} ${quotaBar(m.pct)} ${Math.round(m.pct)}%`)
  return meters.length > 0 ? `spick: quota ${meters.join('   ')}` : 'spick: quota unknown (no local data for claude or codex)'
}

/** `/spick` where nothing can draw a pane: one paragraph of status. */
async function statusParagraph($: EngineInterface): Promise<string> {
  const c = await read($, controls)
  const eff = effectiveRouting(c, await readSessionModel($))
  const rows = await read($, laneRows)
  const lanes = (rows ?? LANE_KEYS.map(id => ({ id, enabled: true }))).map(l => `${laneName(l.id)} ${l.enabled ? 'on' : 'off'}`).join(', ')
  const quotaText = await quotaLine($, false).catch(() => 'spick: quota not read')
  return `spick: routing ${c.routing}, ${eff.why}; review ${c.review}; gate ${c.gate}; guard ${c.guard}; lanes: ${lanes}; band ${(await read($, hidden)) ? 'hidden' : 'shown'}; ${quotaText.replace(/^spick: /, '')}.`
}

async function setCurrent($: EngineInterface, patch: Partial<TurnRecord>): Promise<void> {
  await update($, current, c => (c ? { ...c, ...patch } : c))
}

/** who works on the band: the main session, a subagent call or a CLI call */
type Lane = {
  lane: string; model: string; effort?: string; agentIndex?: number; isReview?: boolean
  /** when the call began; set on every call in flight */
  startedAt?: number
  /** on the lane `showing` returns: how many calls of that lane run, and when the oldest began */
  count?: number
  since?: number
}

/**
 * Put a lane on the current turn. `pick` runs inside the update, so calls that
 * finish in parallel never write back a lane read before the other one landed.
 */
async function showLane($: EngineInterface, pick: () => Lane, extra: (c: TurnRecord) => Partial<TurnRecord> = () => ({})): Promise<void> {
  await update($, current, c => {
    if (!c) return c
    const l = pick()
    return { ...c, ...extra(c), lane: l.lane, model: l.model, effort: l.effort, agentIndex: l.agentIndex, isReview: l.isReview, laneCount: l.count, laneSince: l.since }
  })
}

/** The Running section's state: the calls in flight (oldest first), then those that timed out. */
async function publishRunning($: EngineInterface, inFlight: Map<string, Lane>, timedOut: Map<string, RunningAgent>): Promise<void> {
  const live: RunningAgent[] = [...inFlight].map(([id, l]) => ({ id, lane: l.lane, model: l.model, effort: l.effort, startedAt: l.startedAt ?? 0 }))
  await update($, running, () => [...live, ...timedOut.values()])
}

/** What the band bookkeeping reads: the calls in flight, the timed-out ones, who shows now, whether the main turn is open. */
/** a delegate of the main turn (an Agent call or an outside CLI call) and how it stands; the turn record lists them */
type DelegateRec = {
  id: string; lane: string; model: string; effort?: string; isReview?: boolean; startedAt: number; endedAt?: number; status: DelegateStatus
  /** the main turn that started it, and whether that turn's line is written (a later end then adds a late line) */
  turnId: string; isRecorded?: boolean
  /** a subagent's usage, summed over its turn.complete events; null for an outside CLI and until it reports */
  usage: UsageEntry | null
}

/** a delegate as the turn record lists it */
const delegateEntry = (d: DelegateRec): DelegateEntry => ({
  id: d.id, lane: d.lane, model: d.model, ...(d.effort ? { effort: d.effort } : {}), ...(d.isReview ? { isReview: true } : {}),
  status: d.status, ok: d.status === 'completed', startedAt: new Date(d.startedAt).toISOString(),
  ms: d.endedAt === undefined ? null : Math.max(0, d.endedAt - d.startedAt), usage: d.usage, costUsd: d.usage?.costUsd ?? null,
})

/** a check as the turn record lists it; `editCount` is the turn's source edits at the end */
const checkEntry = (c: CheckRun, editCount: number): CheckEntry => ({
  command: c.command, startedAt: new Date(c.startedAt).toISOString(), finishedAt: c.finishedAt === undefined ? null : new Date(c.finishedAt).toISOString(),
  exitOk: c.exitOk ?? null, editsDuring: c.editsDuring ?? null, coversTurn: c.exitOk === true && c.editsDuring === 0 && c.editsAtStart === editCount,
  ...(c.agentId ? { agentId: c.agentId } : {}),
})

/** how a call that returned stands: refused, failed (an error result) or completed */
const statusOf = (r: { deny?: string; isError?: true } | undefined): DelegateStatus => (r === undefined ? 'failed' : r.deny ? 'refused' : r.isError ? 'failed' : 'completed')

/** `onTimeout` hears each call that timed out, so its delegate record reads failed */
type Tracker = { inFlight: Map<string, Lane>; timedOut: Map<string, RunningAgent>; showing: () => Lane; isMainTurnOpen: () => boolean; onTimeout: (id: string) => void }

/** put the lane that works now on the band and publish the Running list */
async function refreshBand($: EngineInterface, t: Tracker, extra?: (c: TurnRecord) => Partial<TurnRecord>): Promise<void> {
  await showLane($, t.showing, extra)
  await publishRunning($, t.inFlight, t.timedOut)
}

/** Move calls with no completion signal for STALE_MS out of flight into `timedOut`. True when any moved. */
async function sweepStale($: EngineInterface, inFlight: Map<string, Lane>, timedOut: Map<string, RunningAgent>, onTimeout: (id: string) => void = () => {}): Promise<boolean> {
  const now = await $.clock.now()
  let moved = false
  for (const [id, l] of [...inFlight]) {
    if (l.startedAt === undefined || now - l.startedAt < STALE_MS) continue
    inFlight.delete(id)
    timedOut.set(id, { id, lane: l.lane, model: l.model, effort: l.effort, startedAt: l.startedAt, timedOutAt: now })
    onTimeout(id)
    moved = true
  }
  return moved
}

/** Drop calls that have gone 30 minutes without a completion signal; the band follows. */
async function sweep($: EngineInterface, t: Tracker): Promise<void> {
  if (!(await sweepStale($, t.inFlight, t.timedOut, t.onTimeout))) return
  // nothing left running after the main turn ended: the band goes idle
  if (!t.isMainTurnOpen() && t.inFlight.size === 0) await update($, current, () => null)
  else await showLane($, t.showing)
  await publishRunning($, t.inFlight, t.timedOut)
}

/**
 * Stamp the current turn with the time, so the band's elapsed time moves.
 * At most one write per TICK_MS: returns the stamp to compare the next call with.
 */
async function tick($: EngineInterface, lastMs: number): Promise<number> {
  const now = await $.clock.now()
  if (now - lastMs < TICK_MS) return lastMs
  if (!(await read($, current))) return lastMs
  // parallel streams may tick from the same old stamp: never move the clock back
  await update($, current, c => (c ? { ...c, nowMs: Math.max(c.nowMs ?? 0, now) } : c))
  return now
}

const ZERO_TOTALS: LaneTotals = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }

/** a Haiku main session editing source itself is the attention case the band flags */
async function noteEdit($: EngineInterface, mainModel: string, agentId: string | undefined, filePath: string, cwd: string): Promise<void> {
  try {
    if (!agentId && /haiku/.test(mainModel) && isSourcePath(filePath, cwd)) {
      const name = filePath.split('/').slice(-2).join('/')
      await setCurrent($, { note: { kind: 'error', text: `edited ${name}` } })
    }
  } catch {}
}

/**
 * One check a Bash call ran in the turn, any loop's: the command from its runner on, when it started and finished,
 * whether the tool result came back without an error, and the source-edit count at its start and how many edits
 * landed while it ran. It covers the turn only when it passed and no source edit came after it started.
 */
type CheckRun = { command: string; key: string; startedAt: number; finishedAt?: number; exitOk?: boolean; editsAtStart: number; editsDuring?: number; agentId?: string }

/**
 * the guard's state for the main turn: the source files the main session edited itself, those any loop edited, how
 * many source edits went through, the checks run; `cwd` is the session's, which isSourcePath judges paths against
 */
type GuardTurn = {
  mainEdits: Set<string>; agentEdits: Set<string>; sourceEdits: Set<string>; editCount: number; checks: CheckRun[]; cwd: string
  /** the main loop's failures per check (checkOf's key), and the escalation they raised: once per turn */
  failures: Map<string, number>; escalation: { command: string; at: number } | null
}

/** a check that passed after the last source edit of the turn, with none landing while it ran */
const isChecked = (g: GuardTurn): boolean => g.checks.some(c => checkEntry(c, g.editCount).coversTurn)

/**
 * The guard's edit cap, in front of an Edit, Write or NotebookEdit: the main session's own edit of a source file past
 * EDIT_CAP distinct ones this turn is refused (a toast, `edit cap` on the band) while the guard is on and routing is in
 * force. Returns the refusal, or null to let the edit through. A file already edited, a subagent's edit, and a path that
 * is not source (notes, data, .claude/) never count against the cap; every source edit that goes through, a subagent's
 * too, counts for the check before the turn ends.
 */
async function guardEdit($: EngineInterface, g: GuardTurn, mainModel: string, agentId: string | undefined, path: string): Promise<string | null> {
  if (!isSourcePath(path, g.cwd)) return null
  if (!agentId && !g.mainEdits.has(path) && g.mainEdits.size >= EDIT_CAP) {
    const c = await read($, controls)
    if (c.guard === 'on' && effectiveRouting(c, (await read($, sessionModel)) || mainModel).on) {
      $.ui.toast('spick: guard — edit cap: one source file per turn; the next one goes to a coder')
      await setCurrent($, { note: { kind: 'error', text: 'edit cap' } })
      return editCapReason([...g.mainEdits])
    }
  }
  if (!agentId) g.mainEdits.add(path)
  else g.agentEdits.add(path)
  g.sourceEdits.add(path)
  g.editCount++
  return null
}

// The .catch on the gating hooks: should one throw past its own try/catch or
// overrun its budget, its call passes through. In a .catch, next is
// replay-safe: when the hook had already called it, nothing beneath runs again.
function passThrough<E, R>($: unknown, e: E, next: (e: E) => R): R {
  return next(e)
}

const routingOptions: readonly Routing[] = ['on', 'force', 'off']
const reviewOptions: readonly Review[] = ['auto', 'off']
const gateOptions: readonly Gate[] = ['on', 'off']
const guardOptions: readonly Guard[] = ['on', 'off']
/** an answer at least this long, with no tool call, counts as a verdict delivered rather than a question back */
const LONG_ANSWER = 400
const nextRouting = (r: Routing): Routing => (r === 'on' ? 'force' : r === 'force' ? 'off' : 'on')
/**
 * A switch's value in force, in its own colour: on success green (routing's and a lane's alike), force and review's
 * auto the brand's, off subtle (off is not an error).
 */
const VALUE_COLORS: Record<string, 'claude' | 'success' | 'subtle'> = { on: 'success', force: 'claude', auto: 'claude', off: 'subtle' }
/** after the band switch's `on` while on routes nothing (a model that is not Haiku), in the warning colour */
const NOT_HAIKU_NOTE = ' (not Haiku)'
/** where routing is remembered, under its names since 2026-10-14 (on, force, off); spick:routing held auto, on, off */
const ROUTING_KEY = 'spick:routing2'
const LANE_HOTKEYS: Record<string, string> = { gemini: 'g', grok: 'k', codex: 'c' }
/** the lanes page's field help, two lines at 80 columns (the fields set_lane.py takes) */
const LANE_HELP = ['name tags data enabled notes kind base_url api model max_tokens', 'key_ref meter_type meter_preset health_url · enabled yes|no']

// Every hook here only observes, except the gate and the guard: its own work sits in try/catch so a failure
// still ends in next(e), and next's own result is never swallowed.
export const register: Register = on => {
  /** agentId -> lane name, for attributing subagent turn.complete usage */
  const laneOfAgent = new Map<string, string>()
  /** agentId -> the Agent call that started it, so a background agent's lane leaves the band when it finishes */
  const callOfAgent = new Map<string, string>()
  /** tool_use_id -> lane of every Agent or CLI call in flight, oldest first; the band shows the most recent */
  const inFlight = new Map<string, Lane>()
  /** Agent calls whose spawn said background: the call's run_in_background may be left out, background being the default */
  const backgroundCalls = new Set<string>()
  /** whether the main session's turn is open: a background agent outlives it, and the band must not read idle meanwhile */
  let mainTurnOpen = false
  /** true for an Agent call whose subagent has spawned and not yet finished (a background agent, or a foreground one still running) */
  const isRunningAgentCall = (id: string): boolean => { for (const c of callOfAgent.values()) if (c === id) return true; return false }
  /** forget every call in flight except the ones whose subagent is still running */
  const dropFinishedCalls = (): void => { for (const id of [...inFlight.keys()]) if (!isRunningAgentCall(id)) inFlight.delete(id) }
  /** the turn's latest delegate (Agent or CLI call), kept after the call ends: the closed turn is recorded under it */
  let delegate: Lane | null = null
  /** every delegate of the main turn and how it stands; the gate asks them whether the required role completed */
  let delegatesOfTurn: DelegateRec[] = []
  /** tool_use_id -> its record, until it settles (a background agent's settles at its own turn.complete) */
  const delegateOfCall = new Map<string, DelegateRec>()
  const settle = (id: string, status: DelegateStatus, at: number): void => {
    const d = delegateOfCall.get(id)
    if (!d) return
    // a refusal or failure the call reported stands; completion is never taken back
    if (d.status === 'running') d.status = status
    d.endedAt = at
    delegateOfCall.delete(id)
  }
  let agentsThisTurn = 0
  /** the Hint line's findings for the prompt just submitted, then for the turn it started (a delivery carries none) */
  let pendingHints: Hint[] = []
  let hintsOfTurn: Hint[] = []
  /** the main session's own tool calls this turn (its delegates' calls are not counted) */
  let mainToolCalls = 0
  let mainTurnId = ''
  /** the turn the gate or the guard's check already sent back once (one send-back per turn, for both) */
  let gateAskedTurn = ''
  /** the gate's firing this turn, until a later stop logs what became of it (kept or delegated) */
  let gateFired: { turnId: string; kind: string; words: string[]; roles: ('deep' | 'review')[] } | null = null
  /** the gate's firings this turn and what followed, for the turn record */
  let gateEvents: GateEvent[] = []
  /** the session's turn record (<state>/turns/<sessionId>.jsonl) and its cwd */
  const turnWriter: TurnWriter = { sessionId: '', pending: [], part: 0, chain: Promise.resolve() }
  let sessionCwd = ''
  /** the project's own check commands (spick.json guard.check_commands), read once at session.start */
  let declared: RegExp[] = []
  /** the efforts an Agent call of coder, planner or deep gets when it names none (spick.json efforts) */
  let efforts: Efforts = DEFAULT_EFFORTS
  /** the guard's per-turn state, cleared at turn.start */
  const guardTurn: GuardTurn = { mainEdits: new Set(), agentEdits: new Set(), sourceEdits: new Set(), editCount: 0, checks: [], cwd: '', failures: new Map(), escalation: null }
  let mainModel = ''
  let mainEffort: string | undefined
  /** the main loop's last prompt size in tokens, from its latest step's usage; undefined until one reported it */
  let mainLastInput: number | undefined
  /** the last elapsed-time stamp written to `current` */
  let lastTickMs = 0
  /** when the mod-active marker was last written */
  let markerAt = 0
  /** the model before a user's /model that changed nothing yet (a picker may still be open) */
  let modelBeforePick: string | null = null

  const mainLane = (): Lane => ({ lane: MAIN_LANE, model: modelName(mainModel), effort: mainEffort })
  /** the most recent call still in flight; the main session only when none is */
  const showing = (): Lane => {
    let top: Lane | undefined
    for (const l of inFlight.values()) top = l
    if (!top) return mainLane()
    // calls of the same lane aggregate: how many run, and when the oldest began
    let count = 0
    let since: number | undefined
    for (const l of inFlight.values()) {
      if (l.lane !== top.lane) continue
      count++
      if (l.startedAt !== undefined) since = since === undefined ? l.startedAt : Math.min(since, l.startedAt)
    }
    return { ...top, count, since }
  }
  /** calls that timed out (no completion signal for 30 minutes), listed in the pane until the next prompt drops them */
  const timedOut = new Map<string, RunningAgent>()
  // a call with no completion signal for 30 minutes is a failed delegate
  const tracker: Tracker = { inFlight, timedOut, showing, isMainTurnOpen: () => mainTurnOpen, onTimeout: id => settle(id, 'failed', Date.now()) }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'spick', description: 'Spick dashboard and switches: routing, review, gate, guard, lanes, band, quota, spend, audit', argumentHint: ARGUMENT_HINT, immediate: true })
      void refreshQuota($).catch(() => undefined)
    } catch {}
    try { await loadControls($) } catch {}
    try { await readSessionModel($) } catch {}
    guardTurn.cwd = e.cwd
    sessionCwd = e.cwd
    try { turnWriter.sessionId = await $.session.id() } catch {}
    // the project's own check commands, once per session; a pattern that does not compile is ignored, with one toast
    try {
      const p = await pathsNow($)
      const cfg = p ? await $.fs.read(p.spickJson).catch(() => '') : ''
      efforts = effortsFrom(cfg)
      const d = declaredChecks(cfg)
      declared = d.patterns
      if (d.bad.length) $.ui.toast(`spick: guard.check_commands — ignored ${d.bad.length} pattern(s) that do not compile: ${d.bad.join(', ')}`)
    } catch {}
    // unawaited: a slow write must not hold the session's start
    try {
      markerAt = await $.clock.now()
      void writeMarker($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  // The per-prompt checklist: exactly one block, built from the switches, worded for
  // whether the band shows. Rewrites only the context it attaches; any failure
  // (the session model unreadable included) passes the prompt on unchanged.
  on('prompt.submit', async ($, e, next) => {
    let block: string | null = null
    try {
      if (!isDelivery(e.origin.kind)) {
        // rows that timed out before this prompt leave the pane now; any that time out from here on stay one more prompt
        if (timedOut.size > 0) { timedOut.clear(); await publishRunning($, inFlight, timedOut) }
        await sweep($, tracker)
        // an unreadable model ('') falls back to the last one read, then the main loop's
        const fresh = await modelNow($)
        if (fresh) await update($, sessionModel, () => fresh)
        // a /model whose picker answered after the command returned: compare now
        if (modelBeforePick !== null) {
          const before = modelBeforePick
          modelBeforePick = null
          if (fresh && fresh !== before) await modelPickedByHand($, fresh)
        }
        const surfaces = await $.session.surfaces().catch(() => [] as readonly RenderSurface[])
        // the Hint line is a pure function of the prompt's text: the keywords found and the default route they imply;
        // the findings are kept for the turn this prompt starts, where the gate reads them at stop time
        const hints = findHints(e.text)
        pendingHints = hints
        block = checklist(await read($, controls), fresh || (await read($, sessionModel)) || mainModel, !(await bandShowing($, surfaces)), (await quotaLineNow($)) ?? undefined, (await lanesNow($)) ?? undefined, lineOf(hints))
        // keep the bash hook silent through long sessions: refresh the marker hourly
        const now = await $.clock.now()
        if (now - markerAt >= MARKER_REFRESH_MS) {
          markerAt = now
          void writeMarker($).catch(() => undefined)
        }
      }
    } catch {
      block = null
    }
    return next(block ? { ...e, context: [...(e.context ?? []), block] } : e)
  }).catch(passThrough)

  // A model the user picks by hand (/model, or the model setting) turns routing off for
  // the session, only when the model really changed.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const before = isUser ? await modelNow($) : ''
    const r = await next(e)
    try {
      if (isUser && before) {
        const after = await modelNow($)
        if (after && after !== before) { modelBeforePick = null; await modelPickedByHand($, after) }
        // unchanged: maybe a picker still open; the next prompt compares again
        else modelBeforePick = before
      }
    } catch {}
    return r
  }).catch(passThrough)
  on('config.set', { key: 'model' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const isUser = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      if (isUser && !r.deny && e.value !== e.previous) { modelBeforePick = null; await modelPickedByHand($, await modelNow($)) }
    } catch {}
    return r
  }).catch(passThrough)

  // Tell the model the band is showing so it omits the label line. Only where a
  // band is drawn (terminal, desktop) and not hidden; elsewhere the label stays.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!(await bandShowing($, e.surfaces))) return r
      return { sections: [...r.sections, { id: `${P}:band`, scope: 'session' as const, text: 'The Spick status band is showing above the prompt. Do not print the [Model: ... | Effort: ...] label line at the end of replies; this overrides any note that asks for it.' }] }
    } catch {
      return r
    }
  })

  on('turn.start', async ($, e, next) => {
    try {
      const startedAt = await $.clock.now()
      mainTurnOpen = true
      dropFinishedCalls()
      delegate = null
      delegatesOfTurn = []
      agentsThisTurn = 0
      mainTurnId = e.turnId
      mainToolCalls = 0
      hintsOfTurn = pendingHints
      pendingHints = []
      guardTurn.mainEdits.clear()
      guardTurn.agentEdits.clear()
      guardTurn.sourceEdits.clear()
      gateEvents = []
      guardTurn.editCount = 0
      guardTurn.checks = []
      guardTurn.failures.clear()
      guardTurn.escalation = null
      // a mod loaded mid-session saw no session.start: ask for the cwd once
      if (!guardTurn.cwd) guardTurn.cwd = await $.session.cwd().catch(() => '')
      lastTickMs = startedAt
      await update($, current, () => ({ turnId: e.turnId, startedAt, nowMs: startedAt, lane: MAIN_LANE, model: modelName(mainModel), effort: mainEffort, agents: 0, contextTokens: mainLastInput }))
      await sweep($, tracker)
      await refreshBand($, tracker)
      // the TTL gates it: at most one read per ten minutes, so the band's quota meters stay current
      void refreshQuota($).catch(() => undefined)
    } catch {}
    return next(e)
  })

  // Every chunk passes up unchanged; each one (main loop or subagent) may tick the elapsed time.
  on('turn.step', async function* ($, e, next) {
    try {
      if (!e.agentId) {
        mainModel = e.model
        mainEffort = typeof e.effort === 'string' ? e.effort : undefined
        await sweep($, tracker)
        await refreshBand($, tracker)
      }
    } catch {}
    const stream = next(e)
    for await (const chunk of stream) {
      yield chunk
      try { lastTickMs = Math.max(lastTickMs, await tick($, lastTickMs)) } catch {}
    }
    const result = await stream.result
    // the main loop's prompt size, from the step's own usage: the band shows it, and warns a Haiku session past 80k
    try {
      if (!e.agentId && result.usage) {
        mainLastInput = promptTokens(result.usage)
        await setCurrent($, { contextTokens: mainLastInput })
      }
    } catch {}
    return result
  })

  // any tool call, from any loop, ticks the elapsed time; the main session's own calls are counted for the gate
  on('tool.call', async ($, e, next) => {
    try { if (!e.agentId) mainToolCalls++ } catch {}
    try { lastTickMs = Math.max(lastTickMs, await tick($, lastTickMs)) } catch {}
    try { await sweep($, tracker) } catch {}
    return next(e)
  }).catch(passThrough)

  on('tool.call', { tool: 'Agent' }, async ($, e0, next) => {
    // a coder, planner or deep call that names no effort runs at the default: the call is passed on with it filled
    // (next takes the rewritten envelope; tool, tool_use_id and agentId are the engine's and stay as they were)
    let e = e0
    try {
      const fill = e0.agentId ? null : effortToFill(e0.subagent_type, e0.effort, efforts)
      if (fill) e = { ...e0, effort: fill as typeof e0.effort }
    } catch {}
    const id = e.tool_use_id
    try {
      const entry: Lane = { lane: e.subagent_type ?? 'agent', model: e.model ? modelName(e.model) : '', effort: e.effort, agentIndex: ++agentsThisTurn, startedAt: await $.clock.now() }
      inFlight.set(id, entry)
      delegate = entry
      if (!e.agentId) {
        const d: DelegateRec = { id, lane: entry.lane, model: e.model ?? '', effort: e.effort, startedAt: entry.startedAt!, status: 'running', turnId: mainTurnId, usage: null }
        delegatesOfTurn.push(d)
        delegateOfCall.set(id, d)
      }
      await refreshBand($, tracker, () => ({ agents: agentsThisTurn }))
    } catch {}
    // finally: an interrupted call must not leave the subagent's lane on the band
    let r: Awaited<ReturnType<typeof next>> | undefined
    try {
      r = await next(e)
      return r
    } finally {
      try {
        // a foreground call that returned is over (its subagent's turn.complete came first); a background one runs on
        // until its own turn.complete, unless the call itself was refused or failed
        const status = statusOf(r)
        const isBackground = (e.run_in_background === true || backgroundCalls.has(id)) && status === 'completed'
        if (!isBackground) settle(id, status, await $.clock.now())
      } catch {}
      try {
        // a background agent returns at once but its subagent still runs: its lane stays until turn.complete. Background
        // is the default, so a call that leaves run_in_background out is one too; agent.spawn reports what was decided.
        const isBackground = e.run_in_background === true || backgroundCalls.has(id)
        backgroundCalls.delete(id)
        if (!isBackground) {
          inFlight.delete(id)
          await refreshBand($, tracker)
        }
      } catch {}
    }
  }).catch(passThrough)

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (r.agentId) {
        laneOfAgent.set(r.agentId, e.subagentType)
        callOfAgent.set(r.agentId, e.tool_use_id)
      }
      if (e.background && !r.deny) backgroundCalls.add(e.tool_use_id)
      const d = delegateOfCall.get(e.tool_use_id)
      if (d && r.deny) settle(e.tool_use_id, 'refused', await $.clock.now())
      else if (d) { d.lane = e.subagentType; if (r.model) d.model = r.model }
      // the resolved type and model replace what the Agent call named (it may have named neither)
      const entry = inFlight.get(e.tool_use_id)
      if (entry && !r.deny) {
        entry.lane = e.subagentType
        if (r.model) entry.model = modelName(r.model)
        await refreshBand($, tracker)
      }
    } catch {}
    return r
  }).catch(passThrough)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // a check run by any loop, a subagent's included, counts for the guard's check before the turn ends, once its
    // result is in: bound to the edit count at its start, so an edit while it ran or after it leaves the turn unchecked
    let run: CheckRun | null = null
    try {
      const check = checkOf(e.command, declared)
      if (check) {
        run = { ...check, startedAt: await $.clock.now(), editsAtStart: guardTurn.editCount, ...(e.agentId ? { agentId: e.agentId } : {}) }
        guardTurn.checks.push(run)
      }
    } catch {}
    const id = e.tool_use_id
    let isCli = false
    if (!e.agentId) try {
      const cli = parseCli(e.command)
      if (cli) {
        isCli = true
        const entry: Lane = { lane: cli.lane, model: cli.model ?? '', effort: cli.effort, isReview: cli.isReview, startedAt: await $.clock.now() }
        inFlight.set(id, entry)
        delegate = entry
        // a review call: Codex with a review prompt, or a declared lane tagged review (invoke.py --lane <id>)
        const isReview = cli.isReview || ((await lanesNow($))?.lanes ?? []).some(l => l.id === cli.lane && l.tags.includes('review'))
        const d: DelegateRec = { id, lane: cli.lane, model: cli.model ?? '', effort: cli.effort, isReview, startedAt: entry.startedAt!, status: 'running', turnId: mainTurnId, usage: null }
        delegatesOfTurn.push(d)
        delegateOfCall.set(id, d)
        await refreshBand($, tracker, () => (cli.isReview ? { note: { kind: 'warning' as const, text: 'review: codex' } } : {}))
        // outside CLIs report no usage: count the call, leave it unpriced
        await update($, totals, t => {
          const cur = t[cli.lane] ?? ZERO_TOTALS
          return { ...t, [cli.lane]: { ...cur, turns: cur.turns + 1 } }
        })
      }
    } catch {}
    let r: Awaited<ReturnType<typeof next>> | undefined
    try {
      r = await next(e)
      // the main loop's second failure of the same check: the escalation line rides on that result itself, so the
      // model reads it before its next step (once per turn)
      try {
        if (run && !e.agentId && r.isError && !guardTurn.escalation) {
          const n = (guardTurn.failures.get(run.key) ?? 0) + 1
          guardTurn.failures.set(run.key, n)
          if (n >= ESCALATE_AFTER) {
            guardTurn.escalation = { command: run.command, at: await $.clock.now() }
            return { ...r, context: [...(r.context ?? []), escalationLine(run.command)] }
          }
        }
      } catch {}
      return r
    } finally {
      if (run) {
        try {
          run.finishedAt = await $.clock.now()
          // the exit status as the tool result carries it: a non-zero exit, a refusal or an interrupt is an error
          run.exitOk = r !== undefined && !r.deny && !r.isError
          run.editsDuring = guardTurn.editCount - run.editsAtStart
        } catch {}
      }
      if (isCli) {
        try {
          settle(id, statusOf(r), await $.clock.now())
          inFlight.delete(id)
          await refreshBand($, tracker)
        } catch {}
      }
    }
  }).catch(passThrough)

  // The guard's edit cap sits in front of each edit tool; a failure in it lets the edit through.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await guardEdit($, guardTurn, mainModel, e.agentId, e.file_path).catch(() => null)
    if (deny) return { deny }
    await noteEdit($, mainModel, e.agentId, e.file_path, guardTurn.cwd)
    return next(e)
  }).catch(passThrough)
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await guardEdit($, guardTurn, mainModel, e.agentId, e.file_path).catch(() => null)
    if (deny) return { deny }
    await noteEdit($, mainModel, e.agentId, e.file_path, guardTurn.cwd)
    return next(e)
  }).catch(passThrough)
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const deny = await guardEdit($, guardTurn, mainModel, e.agentId, e.notebook_path).catch(() => null)
    if (deny) return { deny }
    return next(e)
  }).catch(passThrough)

  // Stop time, where the gate and the guard's check intervene (with the guard's edit cap, the only places this module
  // does). They send a turn back at most once between them, with every reason in one block, never while routing is
  // off; the block is what Claude Code hands the model as the reason to continue.
  // The gate, by required role: judgement words need deep, review words the review lane or deep (gate.ts). When that
  // role did not complete this turn (a deep subagent that finished or still runs in the background, a review call
  // that returned cleanly), the reply has no `Kept:` line and the turn was substantive (a tool call, or 400+
  // characters), the turn is sent back. Design words never gate; /spick gate off switches it off.
  // The guard's check: a turn in which any loop (a subagent too) edited source and no check passed after the last
  // edit is sent back to run one, hand the user a /goal line, or say in one line (`Unchecked:`) why there is none.
  // A delegate does not excuse it. /spick guard off switches it off, with the edit cap.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    try {
      const answer = e.last_assistant_message ?? ''
      // a turn the gate sent back: log, once, whether the required role then completed or the reply kept it with Kept:
      if (gateFired && gateFired.turnId === mainTurnId) {
        const roles = gateFired.roles
        const outcome = gateOutcome(answer, roles.every(role => roleDone(role, delegatesOfTurn)))
        if (outcome) {
          gateEvents.push({ at: new Date(await $.clock.now()).toISOString(), kind: gateFired.kind, words: gateFired.words, outcome })
          gateFired = null
        }
      }
      if (r.block || e.stop_hook_active || gateAskedTurn === mainTurnId) return r
      const c = await read($, controls)
      if (!effectiveRouting(c, (await read($, sessionModel)) || mainModel).on) return r
      // a short reply with no tool call is a question back, not a delivered verdict
      const isSubstantive = mainToolCalls > 0 || answer.length >= LONG_ANSWER
      const g = c.gate === 'on' && isSubstantive && !KEPT_RE.test(answer) ? gateFiring(hintsOfTurn, delegatesOfTurn) : null
      const isUnchecked = c.guard === 'on' && guardTurn.sourceEdits.size > 0 && !isChecked(guardTurn) && !UNCHECKED_RE.test(answer)
      if (!g && !isUnchecked) return r
      // one send-back per turn, carrying every reason at once
      gateAskedTurn = mainTurnId
      const reasons: string[] = []
      if (g) {
        const kind = g.kinds.join('+')
        gateFired = { turnId: mainTurnId, kind, words: g.words, roles: g.roles }
        gateEvents.push({ at: new Date(await $.clock.now()).toISOString(), kind, words: g.words, outcome: 'sent-back' })
        $.ui.toast('spick: gate — verdict kept by the triage session; sent back once')
        reasons.push(g.text)
      }
      if (isUnchecked) {
        $.ui.toast('spick: guard — source edited, no passing check after it; sent back once')
        reasons.push(uncheckedReason([...guardTurn.sourceEdits]))
      }
      await setCurrent($, { note: { kind: 'warning', text: g ? `gate: ${g.roles.join('+')} missing` : 'guard: unchecked' } })
      return { ...r, block: sendBackText(reasons) }
    } catch {
      return r
    }
  }).catch(passThrough)

  on('turn.complete', async ($, e, next) => {
    try {
      const lane = e.agentId ? (laneOfAgent.get(e.agentId) ?? 'agent') : MAIN_LANE
      const usage = e.usage
      if (usage) {
        const cost = estimateCost(usage.model, usage)
        await update($, totals, t => {
          const cur: LaneTotals = t[lane] ?? ZERO_TOTALS
          return { ...t, [lane]: {
            turns: cur.turns + 1,
            inputTokens: cur.inputTokens + usage.input_tokens,
            outputTokens: cur.outputTokens + usage.output_tokens,
            cacheReadTokens: cur.cacheReadTokens + usage.cache_read_input_tokens,
            cacheCreationTokens: (cur.cacheCreationTokens ?? 0) + usage.cache_creation_input_tokens,
            costUsd: cost === null ? cur.costUsd : (cur.costUsd ?? 0) + cost,
          } }
        })
        // a subagent's usage goes on its delegate, for the turn record
        const call = e.agentId ? callOfAgent.get(e.agentId) : undefined
        const d = call !== undefined ? delegateOfCall.get(call) : undefined
        if (d) d.usage = addUsage(d.usage ?? ZERO_USAGE, usageEntry(usage, cost))
      }
      if (e.agentId) {
        laneOfAgent.delete(e.agentId)
        const call = callOfAgent.get(e.agentId)
        // the subagent's own end decides its delegate's status: an answer completed it, anything else failed it
        const d = call !== undefined ? delegateOfCall.get(call) : undefined
        if (call !== undefined) settle(call, e.reason === 'answer' && !e.isAborted ? 'completed' : 'failed', await $.clock.now())
        // a background agent that outlived its main turn's line: one late line with the same turnId and its usage
        if (d?.isRecorded) {
          const at = await $.clock.now()
          await writeTurnLines($, turnWriter, [lineText(lateLine({ at, sessionId: turnWriter.sessionId, turnId: d.turnId, delegate: delegateEntry(d) }))]).catch(() => undefined)
        }
        callOfAgent.delete(e.agentId)
        // a background agent's Agent call returned long ago; its lane leaves the band now
        if (call !== undefined && inFlight.delete(call)) {
          // the main turn already ended and this was the last agent: the band goes idle (last stays as written)
          if (!mainTurnOpen && inFlight.size === 0) await update($, current, () => null)
          else await showLane($, showing)
          await publishRunning($, inFlight, timedOut)
        } else if (call !== undefined && timedOut.delete(call)) {
          // it did finish after all: its "timed out" row goes
          await publishRunning($, inFlight, timedOut)
        }
      } else {
        const endedAt = await $.clock.now()
        mainTurnOpen = false
        dropFinishedCalls()
        // the turn record: one line per main turn, whatever it delivered (an interrupted turn too, its usage null)
        try {
          if (!turnWriter.sessionId) turnWriter.sessionId = await $.session.id().catch(() => '')
          const ctl = await read($, controls)
          const line = turnLine({
            at: endedAt, sessionId: turnWriter.sessionId, turnId: e.turnId, cwd: sessionCwd || guardTurn.cwd, mainModel: usage?.model ?? mainModel,
            routing: ctl.manualModel ? 'off' : ctl.routing, hint: hintsOfTurn.map(h => h.kind), kept: keptLine(e.answer), gateEvents,
            delegates: delegatesOfTurn.map(delegateEntry), mainFiles: [...guardTurn.mainEdits], agentFiles: [...guardTurn.agentEdits], files: [...guardTurn.sourceEdits],
            checks: guardTurn.checks.map(c => checkEntry(c, guardTurn.editCount)), escalation: guardTurn.escalation,
            usage: usage ? usageEntry(usage, estimateCost(usage.model, usage)) : null, lastInput: mainLastInput, ms: e.durationMs,
          })
          for (const d of delegatesOfTurn) d.isRecorded = true
          await writeTurnLines($, turnWriter, [lineText(line)]).catch(() => undefined)
        } catch {}
        const c = await read($, current)
        if (c) {
          // the turn is recorded under its latest delegate, the main session when it had none
          const who = delegate ?? mainLane()
          const done: TurnRecord = { ...c, lane: who.lane, model: who.model, effort: who.effort, endedAt, costUsd: usage ? estimateCost(usage.model, usage) : null }
          delete done.agentIndex
          delete done.isReview
          delete done.laneCount
          delete done.laneSince
          delete done.nowMs
          await update($, last, () => done)
          await update($, turns, list => [done, ...list].slice(0, 50))
          // a background agent still running keeps the band on its lane (turnId and start time kept, so the
          // elapsed time goes on) until its own turn.complete clears it
          if (inFlight.size > 0) await showLane($, showing, () => ({ note: undefined }))
          else await update($, current, () => null)
        }
        await sweep($, tracker)
        await publishRunning($, inFlight, timedOut)
      }
    } catch {}
    return next(e)
  })

  // Every change answers one line; the pane redraws from the state it reads.
  on('command.run', { command: 'spick' }, async ($, e) => {
    // /spick audit: what the turn records say about the last seven days (checklist.ts's parser does not know it yet)
    if (e.args.trim() === 'audit') return { text: await reportOf($, 'audit.py', 'spick audit: no records') }
    const cmd = parseSpick(e.args)
    switch (cmd.kind) {
      case 'band':
        await update($, hidden, () => cmd.hidden)
        return { text: cmd.hidden ? 'spick: band hidden · /spick show restores it' : 'spick: band shown' }
      case 'routing':
        // the user has decided: a /model still pending comparison no longer counts
        modelBeforePick = null
        await setControls($, c => ({ ...c, routing: cmd.value, manualModel: false }))
        return { text: await routingLine($) }
      case 'review':
        await setControls($, c => ({ ...c, review: cmd.value }))
        return { text: `spick: review ${cmd.value}` }
      case 'gate':
        await setControls($, c => ({ ...c, gate: cmd.value }))
        return { text: `spick: gate ${cmd.value}` }
      case 'guard':
        await setControls($, c => ({ ...c, guard: cmd.value }))
        return { text: `spick: guard ${cmd.value}` }
      case 'lane-show':
        return { text: await laneRecordLine($, cmd.lane) }
      case 'lane-set':
        return { text: (await editLane($, cmd.lane, cmd.field, cmd.value)).text }
      case 'quota':
        return { text: await quotaLine($, true).catch(() => 'spick: quota not read') }
      case 'spend':
        return { text: await reportOf($, 'spend.py', 'spick spend: no records') }
      case 'usage':
        return { text: USAGE }
      case 'open': {
        await refreshQuota($, true).catch(() => undefined)
        await listLanes($)
        await update($, page, () => 'main')
        const surfaces = await $.session.surfaces().catch(() => [] as const)
        if (surfaces.length === 0) return { text: await statusParagraph($) }
        const placed = await $.ui.open({ id: PANE, title: 'SPICK', closeOnEscape: true })
        return { text: placed.isPlaced ? 'spick: pane opened' : `spick: pane not placed: ${placed.reason}` }
      }
    }
  })

  // The band: one line, a short sentence about who is working now. Slot order
  // never changes; the right group holds at most one item: an attention cause or a hint.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hidden))) return next(e)
    const c = await read($, current)
    const l = await read($, last)
    // a Haiku session past 80k gets the context warning where no other cause holds the right group
    const ctxNote = contextNote(c ? c.contextTokens : l?.contextTokens, mainModel) ?? undefined
    const view: BandView | null = c
      ? { lane: c.lane, model: c.model, agents: c.agents, agentIndex: c.agentIndex, isReview: c.isReview, isIdle: false, count: c.laneCount,
          // several of one lane: the time is the oldest of them; one agent or none: the turn's, as before
          durationMs: Math.max(0, (c.nowMs ?? c.startedAt) - (c.laneCount !== undefined && c.laneCount > 1 && c.laneSince !== undefined ? c.laneSince : c.startedAt)), note: c.note ?? ctxNote, mainModel: mainModel ? modelName(mainModel) : undefined, contextTokens: c.contextTokens }
      : l
        ? { lane: l.lane, model: l.model, agents: 0, isIdle: true, note: ctxNote, contextTokens: l.contextTokens }
        : null
    // routing off is shown once the model is known (under auto it depends on it)
    const ctl = await read($, controls)
    const model = (await read($, sessionModel)) || mainModel
    const routingOff = (model !== '' || ctl.routing !== 'on' || ctl.manualModel) && !effectiveRouting(ctl, model).on
    const shownRouting: Routing = ctl.manualModel ? 'off' : ctl.routing
    // The routing switch: one plain Button after the wordmark that reads the setting (`on`, `force`, `off`) and moves
    // it on when clicked, on -> force -> off -> on. `on` while it routes nothing is followed by ` (not Haiku)`, outside
    // the Button. A desktop draws a Button's label without the colour of its text, so routing off is also drawn dim there
    // (dimColor). Its width (the gap after the wordmark, the value, the note, and on a desktop the Button's frame) is
    // taken from the band before the segments are fitted; the width tiers still go by the band's columns.
    const s = e.surface === 'desktop' ? 'desktop' : 'terminal'
    const offNote = shownRouting === 'on' && routingOff
    const switchW = BAND_SWITCH_GAP[s] + shownRouting.length + (offNote ? NOT_HAIKU_NOTE.length : 0) + BAND_BUTTON_CHROME[s]
    const { left, right } = view
      ? bandSegments(view, e.props.bodyColumns, switchW)
      // before the first turn: the wordmark and the switch
      : { left: [{ text: 'SPICK', style: 'brand' } as Seg], right: [] as Seg[] }
    const { Box, Text, Button } = $.ui.resolve(e)
    const routingSwitch: RenderElement[] = [
      ...(BAND_SWITCH_GAP[s] > 0 ? [<Box width={BAND_SWITCH_GAP[s]} flexShrink={0} />] : []),
      <Button key="band-routing" plain dimColor={routingOff} onPress={() => {
        // as /spick on|force|off: the user has decided, a /model still pending comparison no longer counts
        modelBeforePick = null
        void setControls($, c => ({ ...c, routing: nextRouting(shownRouting), manualModel: false })).catch(() => undefined)
      }}>
        <Text bold color={VALUE_COLORS[shownRouting] ?? 'claude'} wrap="truncate-end">{shownRouting}</Text>
      </Button>,
      ...(offNote ? [<Text color="warning" wrap="truncate-end">{NOT_HAIKU_NOTE}</Text>] : []),
    ]
    const paint = (s: Seg) => {
      switch (s.style) {
        case 'brand': return <Text bold color="claude" wrap="truncate-end">{s.text}</Text>
        case 'lane': return <Text bold wrap="truncate-end">{s.text}</Text>
        case 'dim': return <Text color="subtle" wrap="truncate-end">{s.text}</Text>
        case 'plain': return <Text wrap="truncate-end">{s.text}</Text>
        default: return <Text color={s.style} wrap="truncate-end">{s.text}</Text>
      }
    }
    return (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2} width="100%">
        <Box flexDirection="row" flexShrink={1}>{paint(left[0]!)}{routingSwitch}{left.slice(1).map(paint)}</Box>
        {right.length > 0 ? <Box flexDirection="row" flexShrink={1}>{right.map(paint)}</Box> : null}
      </Box>
    )
  })

  // The pane: two columns of fixed-width Boxes, no borders, no chips: a label column (LABEL_W cells) and a value
  // column. Nothing lines up by spaces: a table's cells are Boxes as wide as their column (numbers to the right,
  // justifyContent flex-end), so a desktop's proportional font aligns them as the terminal does. Each row you can
  // act on holds one plain Button, the engine drawing its hotkey in front of the label (`l: edit lanes`); a switch
  // (Routing, Review, a lane) is radio buttons, one per value (`radio`).
  // Below NARROW_BELOW columns a section's label sits on its own line and its content is indented two.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // no Input on mobile: its table has none
    const Input = e.surface !== 'mobile' && 'Input' in ui ? ui.Input : undefined
    const ctl = await read($, controls)
    const rowsNow = await read($, laneRows)
    const isNarrow = e.props.bodyColumns < NARROW_BELOW
    // the pane pads one column each side
    const W = Math.max(20, e.props.bodyColumns - 2)
    const contentW = W - (isNarrow ? 2 : LABEL_W)
    const rows = e.props.scroll?.bodyRows || e.viewport?.rows || 30
    // lines drawn so far, so the Recent list never scrolls past the bottom
    let used = 0

    const sub = (text: string) => <Text color="subtle">{text}</Text>
    const strong = (text: string) => <Text bold color="claude">{text}</Text>
    /** a subtle note that gives way at the right edge */
    const note = (text: string) => <Text color="subtle" wrap="truncate-end">{text}</Text>
    /** `n` empty cells */
    const gap = (n: number): RenderElement => <Box width={n} flexShrink={0} />
    /** the label column: the section's name on its first row, an empty cell of the same width under it */
    const labelCell = (label?: string): RenderElement => <Box width={LABEL_W} flexShrink={0}>{label ? <Text bold>{label}</Text> : null}</Box>
    /**
     * A table row as cells: each column a Box as wide as the column (two cells of left padding from the second
     * column on), its text to the left or, for a number, to the right; the text gives way before the Box does.
     */
    const cols = (row: readonly string[], widths: readonly number[], align: readonly Align[], style: (text: string) => RenderElement = text => <Text wrap="truncate-end">{text}</Text>): RenderElement[] =>
      widths.map((w, i) => (
        <Box width={w + (i > 0 ? 2 : 0)} paddingLeft={i > 0 ? 2 : 0} flexShrink={0} justifyContent={align[i] === 'r' ? 'flex-end' : 'flex-start'}>
          {style(row[i] ?? '')}
        </Box>
      ))
    /** a table: every column as wide as its longest cell; with `head`, the first row is the column heads, subtle */
    const grid = (cells: Cells, head: boolean): RenderElement[][] => {
      const widths = colWidths(cells.rows)
      return cells.rows.map((r, i) => (head && i === 0 ? cols(r, widths, cells.align, sub) : cols(r, widths, cells.align)))
    }
    /**
     * A choice as radio buttons: each value a one-glyph Button (`●` the value in force, `○` the others) that sets it,
     * then the value as Text beside it, outside the Button, since a desktop draws a Button's label without colour: the
     * value in force bold in its own colour (VALUE_COLORS), the others subtle. The row's hotkey sits on the value it
     * would move to (the next one, wrapping), so a key press and a click on that Button do the same; the other values
     * keep the hotkey's room empty, and nothing shifts when the value changes.
     */
    const radio = (row: string, all: readonly string[], inForce: string, hotkey: string, set: (v: string) => void): RenderElement[] => {
      const next = all[(all.indexOf(inForce) + 1) % all.length]
      return all.flatMap((v, i) => [
        ...(i > 0 ? [gap(2)] : []),
        ...(v === next ? [] : [gap(HOTKEY_W)]),
        <Button key={`${row}-${v}`} plain {...(v === next ? { hotkey } : {})} onPress={() => set(v)}>{v === inForce ? '●' : '○'}</Button>,
        gap(1),
        v === inForce ? <Text bold color={VALUE_COLORS[v] ?? 'claude'}>{v}</Text> : sub(v),
      ])
    }
    /** a section: its label in the label column on the first row (own line when narrow), one row per entry */
    const part = (label: string, lines: RenderElement[][]): RenderElement => {
      used += lines.length + (isNarrow ? 1 : 0)
      return (
        <Box flexDirection="column">
          {isNarrow ? <Text bold>{label}</Text> : null}
          {lines.map((cells, i) => (
            <Box flexDirection="row">
              {isNarrow ? gap(2) : labelCell(i === 0 ? label : undefined)}
              {cells}
            </Box>
          ))}
        </Box>
      )
    }
    /** sections set apart from the one above by one blank line */
    const block = (...parts: RenderElement[]): RenderElement => {
      used += 1
      return <Box flexDirection="column" marginTop={1}>{parts}</Box>
    }
    const line = (text: string) => [<Text wrap="truncate-end">{clip(text, contentW)}</Text>]

    /** the title row: SPICK and its group on the left, the controls pinned to the right edge */
    const titleRow = (left: RenderElement[], right: RenderElement[]): RenderElement => {
      used += 1
      return (
        <Box flexDirection="row" width="100%" justifyContent="space-between">
          <Box flexDirection="row" flexShrink={1}>{left}</Box>
          <Box flexDirection="row" flexShrink={0}>{right}</Box>
        </Box>
      )
    }

    if ((await read($, page)) === 'lanes') {
      const laneNoteNow = await read($, laneNote)
      const seq = await read($, editSeq)
      const header = titleRow(
        [<Text bold color="claude">SPICK</Text>, gap(2), <Text>lanes</Text>],
        [
          <Button key="back" plain label="back" onPress={() => { void update($, page, () => 'main').catch(() => undefined) }} />,
          gap(2),
          <Button key="close" plain label="close" role="dismiss" onPress={() => { void $.ui.close({ id: PANE }).catch(() => undefined) }} />,
        ])

      // lane, tags, data, enabled: every declared lane, the disabled ones too, cells cut so a line fits
      const idMax = isNarrow ? 12 : 16
      const laneTable: Cells = {
        rows: [
          ['lane', 'tags', 'data', isNarrow ? 'on' : 'enabled'],
          ...(rowsNow ?? []).map(l => [clip(l.id, idMax), l.tags.length > 0 ? tagLine(l.tags, isNarrow ? 12 : 30) : '-', l.data ?? 'unset', l.enabled ? 'yes' : 'no']),
        ],
        align: ['l', 'l', 'l', 'l'],
      }
      const help = isNarrow ? wrapWords(LANE_HELP.join(' '), contentW) : LANE_HELP
      // the lanes page has no hotkeys: a letter typed into the field must not press anything
      const editRow = Input
        ? [<Input key={`lane-edit-${seq}`} label="> " placeholder="<lane> <field> <value>  (- clears)" submitLabel="apply" autoFocus onSubmit={value => { void submitLaneEdit($, value).catch(() => undefined) }} />]
        : [<Text>{'To change a lane, type /spick lane <lane> <field> <value> in the prompt.'}</Text>]
      return (
        <Box flexDirection="column" paddingX={1}>
          {header}
          {block(part('Lanes', rowsNow === null ? [[sub('lanes not read')]] : grid(laneTable, true)))}
          {block(part('Edit', [editRow, ...help.map(h => [sub(h)])]))}
          {laneNoteNow.change || laneNoteNow.error
            ? block(...[
                laneNoteNow.change ? part('Changed', [line(laneNoteNow.change)]) : null,
                laneNoteNow.error ? part('Refused', [[<Text color="error" wrap="truncate-end">{clip(laneNoteNow.error, contentW)}</Text>]]) : null,
              ].filter((x): x is RenderElement => x !== null))
            : null}
        </Box>
      )
    }

    const eff = effectiveRouting(ctl, (await read($, sessionModel)) || mainModel)
    const t = await read($, totals)
    const runningNow = await read($, running)
    const q = await read($, quota)
    const list = await read($, turns)
    const isHidden = await read($, hidden)
    // a manual model pick shows as off: the switch's value for this session
    const shownRouting: Routing = ctl.manualModel ? 'off' : ctl.routing
    const now = await $.clock.now()

    const header = titleRow(
      [
        <Text bold color="claude">SPICK</Text>,
        gap(2),
        eff.on ? sub('routing on') : <Text color="warning">routing off</Text>,
        sub(' · '),
        <Button key="band" plain hotkey="b" onPress={() => { void update($, hidden, v => !v) }}>{sub(isHidden ? 'band hidden' : 'band shown')}</Button>,
      ],
      [<Button key="close" plain hotkey="x" role="dismiss" onPress={() => { void $.ui.close({ id: PANE }).catch(() => undefined) }}>close</Button>])

    // routing and review sit together; the note under routing says why it reads as it does
    const controlsBlock = block(
      part('Routing', [
        // a click sets that value; r presses the next one: on -> force -> off -> on
        radio('routing', routingOptions, shownRouting, 'r', v => { void setControls($, c => ({ ...c, routing: v as Routing, manualModel: false })).catch(() => undefined) }),
        // the reason sits under the values, past the hotkey's room
        [gap(HOTKEY_W), note(clip(eff.why, contentW - HOTKEY_W))],
      ]),
      part('Review', [
        // a click sets that value; v presses the other one
        radio('review', reviewOptions, ctl.review, 'v', v => { void setControls($, c => ({ ...c, review: v as Review })).catch(() => undefined) }),
      ]),
      part('Gate', [
        // a click sets that value; e presses the other one
        radio('gate', gateOptions, ctl.gate, 'e', v => { void setControls($, c => ({ ...c, gate: v as Gate })).catch(() => undefined) }),
      ]),
      part('Guard', [
        // a click sets that value; d presses the other one
        radio('guard', guardOptions, ctl.guard, 'd', v => { void setControls($, c => ({ ...c, guard: v as Guard })).catch(() => undefined) }),
      ]))

    // a built-in lane's switch (spick.json's lane_registry.<id>.enabled, read from set_lane.py --list; on until that has been
    // read): the name a label, then on and off as the Routing row's radio buttons (g k c press the other one). No tags
    // here: the lanes page lists them
    const nameW = Math.max(...LANE_KEYS.map(k => laneName(k).length))
    const laneOptions = ['on', 'off'] as const
    const laneLines = LANE_KEYS.map(k => {
      const isOn = rowsNow?.find(l => l.id === k)?.enabled ?? true
      return [
        <Box width={nameW + 2} flexShrink={0}><Text>{laneName(k)}</Text></Box>,
        ...radio(`lane-${k}`, laneOptions, isOn ? 'on' : 'off', LANE_HOTKEYS[k]!, v => { void setLane($, k, v === 'on').catch(() => undefined) }),
      ]
    })
    laneLines.push([
      <Button key="edit-lanes" plain hotkey="l" onPress={() => { void openLanesPage($).catch(() => undefined) }}>
        {[<Text>edit lanes</Text>, ...(isNarrow ? [] : [sub(' · every field, every declared lane')])]}
      </Button>,
    ])
    const lanesBlock = block(part('Lanes', laneLines))

    const runningView = runningRows(runningNow, now)
    const runningBlock = runningNow.length > 0
      ? block(part('Running', [...grid(runningView, false), ...(runningView.more > 0 ? [[sub(`and ${runningView.more} more`)]] : [])]))
      : null

    // lanes with turns, most turns first; the head row sits right of the label, the lane names under it
    const entries = Object.entries(t).sort((a, b) => b[1].turns - a[1].turns)
    const usageBlock = block(part('Usage', entries.length === 0 ? [[sub('none yet')]] : grid(usageRows(entries), true)))

    // only claude and codex; a provider with no window data gets no row. The bars sit in no fixed cell (a glyph's
    // width is the font's); every row draws the same count of cells, so they end together
    const barCells = isNarrow ? 5 : 10
    const quotaRows = ([['claude', q?.claude], ['codex', q?.codex]] as [string, QuotaWindows | null | undefined][])
      .map(([name, w]) => ({ name, windows: quotaWindows(w, barCells) }))
      .filter(r => r.windows.length > 0)
    const quotaBlock = block(part('Quota', [
      ...(q && quotaRows.length === 0 ? [[sub('unknown')]] : []),
      ...quotaRows.map(r => [
        <Box width={8} flexShrink={0}><Text>{r.name}</Text></Box>,
        ...r.windows.flatMap((c, i) => [
          ...(i > 0 ? [gap(3)] : []),
          <Box width={3} flexShrink={0}><Text>{c.label}</Text></Box>,
          <Text>{c.bar}</Text>,
          <Box width={5} flexShrink={0} justifyContent="flex-end"><Text>{c.pct}</Text></Box>,
        ]),
      ]),
      [<Button key="refresh" plain hotkey="q" onPress={() => { void refreshQuota($, true).catch(() => undefined) }}>
        <Text>refresh</Text>{sub(` · ${sampleNote(q, now, isNarrow)}`)}
      </Button>],
    ]))

    // what is left of the viewport after everything above and the blank line before Recent
    const room = Math.max(1, rows - used - 1 - (isNarrow ? 1 : 0))
    const recent = list.slice(0, Math.min(room, isNarrow ? NARROW_RECENT_ROWS : list.length))
    const recentCells = recentRows(recent, isNarrow)
    const recentWidths = colWidths(recentCells.rows)
    const recentW = recentWidths.reduce((a, b) => a + b, 0) + 2 * Math.max(0, recentWidths.length - 1)
    const recentBlock = recent.length > 0
      ? block(part('Recent', recentCells.rows.map((r, i) => {
          const cells = cols(r, recentWidths, recentCells.align)
          const cause = recent[i]?.note
          if (!cause) return cells
          // the attention cause follows the row, two cells on, in its colours, when at least six cells are left
          const fits = contentW - recentW - 2
          if (fits < 6) return cells
          const parts = noteParts({ ...cause, text: clip(cause.text, fits) })
          return [...cells, gap(2), ...parts.map(p => (p.style === 'warning' || p.style === 'error' ? <Text color={p.style}>{p.text}</Text> : <Text>{p.text}</Text>))]
        })))
      : null

    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        {controlsBlock}
        {lanesBlock}
        {runningBlock}
        {usageBlock}
        {quotaBlock}
        {recentBlock}
      </Box>
    )
  })
}
