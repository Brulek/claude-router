// The guard: an edit cap per turn for the main session and a check before the turn ends. Pure functions; register.tsx
// keeps the per-turn state and decides when they apply (the guard on, routing in force, the main loop for the cap).

/** the most distinct source files the main session edits itself in one turn; the next one is refused, to go to a coder */
export const EDIT_CAP = 3

/**
 * The command names that count as a check: a test runner, a build, a linter or a type checker. Each on word
 * boundaries, anywhere in the command (after `cd x &&`, in a pipeline, on a later line). A project can add its own
 * in spick.json (`guard.check_commands`, see declaredChecks).
 */
const CHECKS: readonly RegExp[] = [
  /\bpytest\b/,
  /\bunittest\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bnode\b.*\s--test\b/,
  // a python script whose name ends in test or tests, or a module whose name holds test
  /\bpython3?\s+(?:\S+\s+)*?\S*tests?\.py\b/,
  /\bpython3?\s+-m\s+\S*test/,
  // a script whose name holds test, run as ./x where a command starts, or as bash x or sh x
  /(?:^|[;&|(\n])\s*\.\/\S*test/,
  /\b(?:bash|sh)\s+\S*test/,
  /\bcargo\s+(test|check|clippy|build)\b/,
  /\bgo\s+(test|vet|build)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|build)\b/,
  /\bdotnet\s+(test|build)\b/,
  /\bgradlew?\s+(test|build)\b/,
  /\bmvn\s+(?:-\S+\s+)*(test|verify|package)\b/,
  /\bclaude\s+plugin\s+(test|validate)\b/,
  /\btsc\b/,
  /\bmake\s+(test|check)\b/,
  /\bswift\s+(test|build)\b/,
  /\bxcodebuild\b/,
  /\bruff\b/,
  /\beslint\b/,
  /\bflake8\b/,
  /\bmypy\b/,
  /\bshellcheck\b/,
  /\bbash\s+-n\b/,
]

/** whether a Bash command runs a check (tests, a build, a linter, a type checker), the project's declared ones included */
export function isCheckCommand(command: string, declared: readonly RegExp[] = []): boolean {
  const c = command ?? ''
  return CHECKS.some(re => re.test(c)) || declared.some(re => re.test(c))
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

/** Why an edit was refused: the cap is reached; the files already edited, and what to do instead. What the model reads as the tool's error. */
export function editCapReason(files: readonly string[]): string {
  return `spick guard: the triage session already edited ${files.length} source files itself this turn (${listed(files)}); the cap is ${EDIT_CAP} distinct files per turn, so this edit was refused. Dispatch Agent(coder) with the goal, the files above and this one, and the checks to run, and let it make the rest of the change. Further edits to the files above still go through.`
}

/**
 * Why a stop is sent back once: source was edited this turn and no check ran. Three ways out, the last one for a
 * project with nothing to run. What Claude Code hands the model as the reason to continue.
 */
export function uncheckedReason(files: readonly string[]): string {
  return `spick guard: source files were edited this turn (${listed(files)}) and no check ran (no test, build check, linter or type checker). Do one of three things now: run the project's check command and report its result; or hand the user one \`/goal <check command>; stop after 10 attempts\` line; or, if this project has no check to run, reply with one line starting with \`Unchecked:\` that says why, and stop. This gate fires once per turn.`
}
