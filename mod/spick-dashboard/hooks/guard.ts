// The guard: an edit cap per turn for the main session and a check before the turn ends. Pure functions; register.tsx
// keeps the per-turn state and decides when they apply (the guard on, routing in force, the main loop for the cap).

/**
 * The most distinct source files the main session edits itself in one turn; the next one is refused, to go to a coder.
 * One: a one-file change is the main session's own (not dispatching is the default for small work), a second file
 * means a change that is a coder's.
 */
export const EDIT_CAP = 1

/**
 * The checks: a test runner, a build, a linter or a type checker, each matched at the start of one command of the line
 * (its command word, after the prefixes below and with a path cut to its base name), so `echo pytest` and
 * `grep pytest README` are not checks. A project can add its own in spick.json (`guard.check_commands`, see
 * declaredChecks); those are matched against each command the same way.
 */
const RUNNERS: readonly RegExp[] = [
  /^(pytest|py\.test|vitest|jest|mocha|tsc|ruff|eslint|flake8|mypy|pyright|shellcheck|xcodebuild|rspec|phpunit|ctest)\b/,
  /^node\s+(?:\S+\s+)*?--test\b/,
  // a python script whose name ends in test or tests, or a module whose name holds test (unittest, pytest included)
  /^python[\d.]*\s+(?:-\S+\s+)*\S*tests?\.py\b/,
  /^python[\d.]*\s+(?:-\S+\s+)*-m\s+(?:\S*test|mypy|ruff|flake8|pyright)/,
  /^(?:bash|sh|zsh)\s+-n\b/,
  /^(?:bash|sh|zsh)\s+\S*test/,
  /^cargo\s+(?:test|check|clippy|build|nextest)\b/,
  /^go\s+(?:test|vet|build)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build)\b/,
  /^dotnet\s+(?:test|build)\b/,
  /^gradlew?\s+(?:test|build|check)\b/,
  /^mvn\s+(?:-\S+\s+)*(?:test|verify|package)\b/,
  /^claude\s+plugin\s+(?:test|validate)\b/,
  /^make\s+(?:test|check)\b/,
  /^swift\s+(?:test|build)\b/,
]

/** words in front of the command word that run it: `env A=1`, `sudo -E`, `time`, `npx --yes` ... */
const PREFIX_WORDS = new Set(['env', 'sudo', 'time', 'nice', 'npx', 'bunx', 'command', 'exec', 'nohup'])
/** two-word launchers in front of the command word */
const PREFIX_PAIRS = new Set(['uv run', 'poetry run', 'pipenv run', 'hatch run', 'bundle exec', 'pnpm exec', 'yarn exec', 'pnpm dlx'])
/** asking a runner about itself runs no check */
const NOT_A_RUN = /\s(?:--version|--help|-V|-h)(?:\s|$)/
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g

/**
 * One command's text from its command word on: prefixes and assignments dropped, the command word cut to its base
 * name. `isTestScript`: a script run by its path whose name holds test (./run-tests.sh, scripts/test.sh).
 */
function commandText(seg: string): { text: string; raw: string; isTestScript: boolean } {
  const words = seg.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (PREFIX_PAIRS.has(`${w} ${words[i + 1] ?? ''}`)) i += 2
    else if (PREFIX_WORDS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (i > 0 && PREFIX_WORDS.has(words[i - 1]!) && w.startsWith('-'))) i++
    else break
  }
  const first = words[i]
  if (!first) return { text: '', raw: '', isTestScript: false }
  const base = first.slice(first.lastIndexOf('/') + 1)
  const rest = words.slice(i + 1)
  return { text: [base, ...rest].join(' '), raw: [first, ...rest].join(' '), isTestScript: first.includes('/') && /test/i.test(base) }
}

/**
 * The check a Bash command runs, as the command text from its runner on, or null when it runs none. Each command of
 * the line (split on && || ; | and newlines, quoted text masked so nothing inside it splits or matches) is matched
 * by its command word. A check whose exit status is thrown away (`pytest || true`) or that only asks the runner about
 * itself (`pytest --version`) does not count. A pipe into another command (`npm test | tail`) is taken as it is: the
 * exit status is then the last command's, a known blind spot.
 */
export function checkCommand(command: string, declared: readonly RegExp[] = []): string | null {
  const quoted: string[] = []
  const masked = (command ?? '').replace(QUOTED, m => `"${quoted.push(m) - 1}"`).replace(/\\\n/g, ' ')
    // redirections are not command separators: 2>&1, >&2, &> and &>> must not split on their &
    .replace(/\d*>&\d*-?|&>>?/g, ' ')
  const parts = masked.split(/(\|\||&&|;|\||\n|&|\(|\))/)
  for (let k = 0; k < parts.length; k += 2) {
    const { text, raw, isTestScript } = commandText(parts[k] ?? '')
    if (!text || NOT_A_RUN.test(` ${text}`)) continue
    // the project's own patterns see the command word as typed, path included (bin/verify)
    if (!isTestScript && !RUNNERS.some(re => re.test(text)) && !declared.some(re => re.test(raw))) continue
    if (parts[k + 1] === '||') continue
    return raw.replace(/"(\d+)"/g, (_, n) => quoted[Number(n)] ?? '')
  }
  return null
}

/** whether a Bash command runs a check (tests, a build, a linter, a type checker), the project's declared ones included */
export function isCheckCommand(command: string, declared: readonly RegExp[] = []): boolean {
  return checkCommand(command, declared) !== null
}

/** the longest declared pattern taken; a longer one is reported as bad */
const MAX_DECLARED = 300

/**
 * A project's own check commands: `guard.check_commands` in spick.json, an array of regex strings, each compiled on
 * its own. One that is not a string, is too long or does not compile goes to `bad` and is ignored; text that is not
 * JSON, or has no such array, declares nothing.
 */
export function declaredChecks(spickJson: string | null | undefined): { patterns: RegExp[]; bad: string[] } {
  const out = { patterns: [] as RegExp[], bad: [] as string[] }
  let cfg: unknown
  try { cfg = JSON.parse(spickJson ?? '') } catch { return out }
  const guard = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).guard : undefined
  const list = guard && typeof guard === 'object' ? (guard as Record<string, unknown>).check_commands : undefined
  if (!Array.isArray(list)) return out
  for (const s of list) {
    if (typeof s !== 'string' || !s || s.length > MAX_DECLARED) { out.bad.push(String(s).slice(0, 40)); continue }
    try { out.patterns.push(new RegExp(s)) } catch { out.bad.push(s.slice(0, 40)) }
  }
  return out
}

/** a reply whose one line starting with Unchecked: says why no check ran this turn */
export const UNCHECKED_RE = /(^|\n)\s*(Unchecked|未验证)[:：]/

/** the most file names a reason lists; the rest are counted */
const MAX_LISTED = 5
const listed = (files: readonly string[]): string =>
  files.length <= MAX_LISTED ? files.join(', ') : `${files.slice(0, MAX_LISTED).join(', ')} and ${files.length - MAX_LISTED} more`

/** Why an edit was refused: the cap is reached; the file(s) already edited, and what to do instead. What the model reads as the tool's error. */
export function editCapReason(files: readonly string[]): string {
  const done = files.length === 1 ? `already edited ${files[0]} itself this turn` : `already edited ${files.length} source files itself this turn (${listed(files)})`
  const cap = EDIT_CAP === 1 ? '1 source file per turn' : `${EDIT_CAP} distinct source files per turn`
  return `spick guard: the triage session ${done}; the cap is ${cap}, so this edit to a second file was refused. Dispatch Agent(coder) with the goal, the file above and this one, and the checks to run, and let it make the rest of the change. Further edits to the file above still go through.`
}

/**
 * Why a stop is sent back once: source was edited this turn and no check passed after the last edit. Three ways out, the last one for a
 * project with nothing to run. What Claude Code hands the model as the reason to continue.
 */
export function uncheckedReason(files: readonly string[]): string {
  return `spick guard: source files were edited this turn (${listed(files)}) and no check passed after the last edit (a test, build check, linter or type checker run as its own command, after the edits, with a clean exit; a failed one, or one an edit followed, does not count). Do one of three things now: run the project's check command and report its result; or hand the user one \`/goal <check command>; stop after 10 attempts\` line; or, if this project has no check to run, reply with one line starting with \`Unchecked:\` that says why, and stop.`
}
