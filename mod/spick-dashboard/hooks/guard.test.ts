import { test, expect } from 'claude-code/testing'
import { EDIT_CAP, ESCALATE_AFTER, UNCHECKED_RE, checkCommand, checkOf, declaredChecks, escalationLine, editCapReason, isCheckCommand, uncheckedReason } from './guard'

test('the edit cap is one source file per turn', () => {
  expect(EDIT_CAP).toBe(1)
})

test('isCheckCommand knows test runners, build checks, linters and type checkers, anywhere in the command', () => {
  for (const c of [
    'python3 -m unittest -q', 'cd skills/spick/scripts && python3 -m unittest -q', 'pytest -x tests/', 'uv run pytest',
    'npx vitest run', 'npx jest', 'mocha', 'cargo test', 'cargo check --all', 'cargo clippy -- -D warnings', 'go test ./...', 'go vet ./...',
    'npm test', 'npm run test', 'pnpm run lint', 'yarn typecheck', 'bun test', 'npm run check',
    'claude plugin test mod/spick-dashboard', 'claude plugin validate .', 'npx tsc --noEmit', 'make test', 'make check',
    'swift test', 'xcodebuild -scheme App -destination x test', 'ruff check .', 'eslint src', 'flake8', 'mypy src', 'shellcheck a.sh',
    'bash -n setup.sh', 'pytest -q 2>&1', 'npm test > out.txt 2>&1', 'cd x && cargo test &> log.txt',
  ]) expect(isCheckCommand(c)).toBe(true)
})

test('isCheckCommand knows node --test, python test scripts and modules, test scripts, and builds', () => {
  for (const c of [
    'node --test', 'node --experimental-strip-types --test src/', 'python3 run_tests.py', 'python test.py', 'python3 -u pkg/foo_test.py',
    'python3 -m mytests', 'python -m pkg.test_utils', './run-tests.sh', 'cd x && ./test.sh', 'bash scripts/test.sh', 'sh test_all.sh',
    'cargo build --release', 'swift build', 'go build ./...', 'xcodebuild -scheme App build', 'npm run build', 'pnpm build', 'yarn build',
    'bun run build', 'dotnet test', 'dotnet build App.sln', 'gradle test', './gradlew build', 'mvn test', 'mvn -q verify', 'mvn package',
  ]) expect(isCheckCommand(c)).toBe(true)
})

test('isCheckCommand leaves ordinary commands out, and matches on word boundaries only', () => {
  for (const c of [
    'ls -la', 'cat a.py', 'git diff', 'npm install', 'cargo run', 'go run .', 'make', 'python3 a.py', 'grep -rn foo .',
    'rm -rf .pytest_cache', 'cat test_unittest_helpers.py', 'bash setup.sh', 'npm run dev', 'echo testing', '', 'node server.js',
    'python3 attest.pyc', 'cat ./tests/data.json', 'mvn clean', 'dotnet run', 'gradle clean', 'sh ./deploy.sh',
  ]) expect(isCheckCommand(c)).toBe(false)
})

test('the runner must be the command word itself: a name in an argument, a quote or a pipe\'s reader is no check', () => {
  for (const c of [
    'echo pytest', 'grep pytest README', 'grep -rn "npm test" .', 'echo "cd x && pytest"', 'cat Makefile | grep test', 'git log --grep=pytest',
    'ls tests/ && echo cargo test', 'which pytest', 'pip install pytest',
  ]) expect(isCheckCommand(c)).toBe(false)
})

test('the command word is found after env, npx, sudo, time, assignments, uv run and cd x &&', () => {
  expect(checkCommand('cd /r/x && python3 -m unittest -q')).toBe('python3 -m unittest -q')
  expect(checkCommand('env CI=1 npx vitest run')).toBe('vitest run')
  expect(checkCommand('sudo -E make test')).toBe('make test')
  expect(checkCommand('time cargo test --all')).toBe('cargo test --all')
  expect(checkCommand('FOO=1 uv run pytest -q tests/')).toBe('pytest -q tests/')
  expect(checkCommand('/usr/local/bin/pytest -x')).toBe('/usr/local/bin/pytest -x')
  expect(checkCommand('npx tsc --noEmit')).toBe('tsc --noEmit')
})

test('a check whose exit status is thrown away, or that only asks the runner about itself, does not count', () => {
  for (const c of ['pytest || true', 'pytest 2>&1 || true', 'npm test &>/dev/null || :', 'npm test || echo failed', 'pytest --version', 'cargo --version', 'ruff --help', 'python3 -m pytest -V']) expect(isCheckCommand(c)).toBe(false)
})

test('only one simple command counts: a pipe, a list or a second line hides the check\'s own status (the engine reports the line\'s)', () => {
  for (const c of [
    'true || pytest', 'false || pytest', 'pytest; true', 'pytest | cat', 'npm test | tail -5', 'npm test 2>&1 | tail -5', 'pytest && echo ok',
    'git status\nnpm test', 'pytest &', '(pytest)', 'cd a && cd b && pytest', 'cd x; pytest', 'echo `pytest`',
  ]) expect([c, isCheckCommand(c)]).toEqual([c, false])
  // the command keeps its redirections, the key leaves them out
  expect(checkOf('cd pkg && pytest tests/a.py > out.txt 2>&1')).toEqual({ command: 'pytest tests/a.py > out.txt 2>&1', key: 'pkg pytest tests/a.py' })
})

test('declared check commands: each regex string compiled on its own, a bad one reported and ignored', () => {
  const d = declaredChecks(JSON.stringify({ version: 1, guard: { check_commands: ['^just check$', 'bin/verify\\b', '(unclosed', 7, ''] } }))
  expect(d.patterns.length).toBe(2)
  expect(d.bad).toEqual(['(unclosed', '7', ''])
  expect(isCheckCommand('just check', d.patterns)).toBe(true)
  expect(isCheckCommand('cd x && bin/verify --all', d.patterns)).toBe(true)
  expect(isCheckCommand('just build', d.patterns)).toBe(false)
  for (const t of [null, '', 'not json', '[]', '{"guard":{}}', '{"guard":{"check_commands":"x"}}']) expect(declaredChecks(t)).toEqual({ patterns: [], bad: [] })
})

test('UNCHECKED_RE takes a line starting with Unchecked: or 未验证:, nothing mid-line', () => {
  expect(UNCHECKED_RE.test('Done.\nUnchecked: this repo has no tests.')).toBe(true)
  expect(UNCHECKED_RE.test('Unchecked: no tests here')).toBe(true)
  expect(UNCHECKED_RE.test('改完了。\n未验证：本项目没有测试。')).toBe(true)
  expect(UNCHECKED_RE.test('the result is Unchecked: maybe')).toBe(false)
  expect(UNCHECKED_RE.test('All checks ran.')).toBe(false)
})

test('editCapReason names the file already edited and sends the change to a coder', () => {
  const r = editCapReason(['/r/a.py'])
  expect(r).toContain('already edited /r/a.py itself this turn')
  expect(r).toContain('the cap is 1 source file per turn')
  expect(r).toContain('Dispatch Agent(coder)')
})

test('uncheckedReason names the three ways out, the Unchecked: line among them, and cuts a long file list', () => {
  const r = uncheckedReason(['a.py', 'b.py'])
  expect(r).toContain('(a.py, b.py)')
  expect(r).toContain("run the project's check command")
  expect(r).toContain('`/goal <check command>; stop after 10 attempts`')
  expect(r).toContain('`Unchecked:`')
  expect(uncheckedReason(['1.py', '2.py', '3.py', '4.py', '5.py', '6.py', '7.py'])).toContain('(1.py, 2.py, 3.py, 4.py, 5.py and 2 more)')
})

test('checkOf names a check by the cd before it, its runner and its targets, flags left out', () => {
  expect(checkOf('pytest -q tests/a.py')?.key).toBe(checkOf('pytest tests/a.py -x')?.key)
  expect(checkOf('pytest tests/a.py')?.key).not.toBe(checkOf('pytest tests/b.py')?.key)
  expect(checkOf('cd pkg && pytest')?.key).not.toBe(checkOf('pytest')?.key)
  expect(checkOf('cd pkg && npm test')).toEqual({ command: 'npm test', key: 'pkg npm test' })
  expect(checkOf('echo pytest')).toBeNull()
})

test('the escalation line names the check and the two ways up', () => {
  expect(ESCALATE_AFTER).toBe(2)
  const t = escalationLine('pytest -q')
  expect(t).toContain('failed 2 times this turn (pytest -q)')
  expect(t).toContain('Agent(coder) at effort high')
  expect(t).toContain('Agent(deep) if the cause is unknown')
})
