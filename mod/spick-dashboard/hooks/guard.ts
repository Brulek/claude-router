// The guard: an edit cap per turn for the main session and a check before the turn ends. Pure functions; register.tsx
// keeps the per-turn state and decides when they apply (the guard on, routing in force, the main loop for the cap).

/**
 * The most distinct source files the main session edits itself in one turn; the next one is refused, to go to a coder.
 * One: a one-file change is the main session's own (not dispatching is the default for small work), a second file
 * means a change that is a coder's.
 */
export const EDIT_CAP = 1

/**
 * The checks: a test runner, a build, a linter or a type checker, matched at the command word of the line's one command
 * (after the prefixes below and with a path cut to its base name), so `echo pytest` and `grep pytest README` are not
 * checks. A project can add its own in spick.json (`guard.check_commands`, see declaredChecks); those are matched
 * against the command the same way.
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
 * The check a Bash command runs, as the command text from its runner on, or null when it runs none. The line must be
 * ONE simple command: after the prefixes (env, npx, sudo, time, uv run, assignments) and at most one leading
 * `cd <dir> &&`, the runner and its arguments, with redirections (`2>&1`, `> out.txt`) allowed. Any `|`, `;`, `&&`,
 * `||`, `&` or newline elsewhere disqualifies it: the engine reports the whole line's status only, so `true || pytest`,
 * `pytest; true`, `pytest | cat` and `npm test | tail -5` prove nothing about the check. Quoted text is masked so
 * nothing inside it splits or matches. A runner asked about itself (`pytest --version`) runs no check.
 */
export function checkCommand(command: string, declared: readonly RegExp[] = []): string | null {
  return checkOf(command, declared)?.command ?? null
}

/**
 * Control operators and grouping outside quotes: any one means several commands. Tested before redirections are
 * stripped, on the line with the `&` of `>&`, `<&` and `&>` taken out, so a redirection target can never swallow an
 * operator (`pytest >/dev/null||true`).
 */
const SEPARATOR = /\|\||&&|;|\||&|\n|\$\(|\(|\)|`/
/** the `&` inside a redirection operator (`2>&1`, `<&0`, `&>log`), which is not a background `&` */
const REDIRECT_AMP = /[<>]&|&>/g
/** a redirection with its target (`> out.txt`, `2>>log`, `< in`, `2>&1`), so a target is no check target */
const REDIRECT = /\d*(?:>>?|<)\s*(?:&[12]\b|[^\s;&|<>]+)|&>>?\s*[^\s;&|<>]+/g
/** whether the line holds a control operator outside a redirection */
const chained = (s: string): boolean => SEPARATOR.test(s.replace(REDIRECT_AMP, '>'))

/** the line as one simple command (see oneCommand) */
export type OneCommand = {
  /** from the command word on, the word cut to its base name, redirections out, quoted text masked */
  text: string
  /** the same with the command word as typed */
  raw: string
  /** the command as typed from its command word on, redirections kept, quoted text restored */
  typed: string
  /** where a leading `cd` moved, '' when none */
  dir: string
  isTestScript: boolean
  /** masked quoted text back in place */
  restore: (t: string) => string
}

/**
 * The line as ONE simple command, or null when it holds several: after at most one leading `cd <dir> &&`, no `|`, `;`,
 * `&&`, `||`, `&`, newline, subshell or backquote outside quotes; redirections (`2>&1`, `> out.txt`) are allowed. With
 * `feedIn`, commands piped INTO it are allowed too (`git diff | codex exec "..."`): a pipeline's exit status and output
 * are its last command's, so what feeds it hides nothing about it; anything after it, or any other separator, still
 * disqualifies the line.
 */
export function oneCommand(command: string, feedIn = false): OneCommand | null {
  const quoted: string[] = []
  let masked = (command ?? '').replace(QUOTED, m => `"${quoted.push(m) - 1}"`).replace(/\\\n/g, ' ').trim()
  // one leading `cd <dir> &&` moves where it runs; it is not a second command (cd's own failure stops the line)
  let dir = ''
  const cd = masked.match(/^cd\s+([^\s;&|<>()`$]+)\s*&&\s*/)
  if (cd) { dir = cd[1]!; masked = masked.slice(cd[0].length) }
  // control operators first, then redirections: a redirection's target must not hide a `||` or `;` behind it
  // a pipeline of plain pipes only (no ||, no other separator): keep its last command, redirections and all
  if (feedIn && masked.includes('|') && !masked.includes('||') && !chained(masked.replace(/\|/g, ' '))) {
    masked = masked.slice(masked.lastIndexOf('|') + 1).trim()
  }
  if (chained(masked)) return null
  // 2>&1, >&2, &> and &>> are redirections, not a background & or a second command
  const bare = masked.replace(REDIRECT, ' ')
  // a redirection this does not take apart (`>&3`, `>&-`) leaves an & behind: refuse rather than guess
  if (SEPARATOR.test(bare)) return null
  const { text, raw, isTestScript } = commandText(bare)
  if (!text) return null
  const restore = (t: string) => t.replace(/"(\d+)"/g, (_, n) => quoted[Number(n)] ?? '')
  return { text, raw, typed: restore(commandText(masked).raw), dir, isTestScript, restore }
}

/** whether a command only asks its program about itself (`--version`, `--help`): it runs nothing */
export const asksAboutItself = (text: string): boolean => NOT_A_RUN.test(` ${text}`)

/**
 * The check a Bash command runs and its identity: `key` is the directory a leading `cd` moved to, the runner's
 * command word and its targets (the arguments that are not flags or redirections), so `pytest -q tests/a.py` and
 * `pytest tests/a.py -x` are the same check and `pytest tests/b.py` another. Null unless the line is one simple
 * command (see checkCommand).
 */
export function checkOf(command: string, declared: readonly RegExp[] = []): { command: string; key: string } | null {
  const one = oneCommand(command)
  if (!one || asksAboutItself(one.text)) return null
  const { text, raw, isTestScript, restore, dir } = one
  // the project's own patterns see the command word as typed, path included (bin/verify)
  if (!isTestScript && !RUNNERS.some(re => re.test(text)) && !declared.some(re => re.test(raw))) return null
  const [word, ...args] = text.split(' ')
  return { command: one.typed, key: restore([dir, word, ...args.filter(a => !a.startsWith('-'))].join(' ')) }
}

/** the failures of one check in a turn after which the main session is told to escalate */
export const ESCALATE_AFTER = 2

/**
 * The line appended to the second failing result of the same check: escalate on the fact, not on confidence (a
 * small model that keeps fixing either loops or stops on the calls it gets wrong). What the model reads beside the
 * tool's own result.
 */
export function escalationLine(command: string): string {
  return `spick: this check failed ${ESCALATE_AFTER} times this turn (${command}). Escalate on that fact instead of a third fix of your own: dispatch Agent(coder) at effort high with the failing output, what was tried and what is left; or Agent(deep) if the cause is unknown.`
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
