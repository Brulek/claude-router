import { test, expect } from 'claude-code/testing'
import { EDIT_CAP, UNCHECKED_RE, editCapReason, isCheckCommand, uncheckedReason } from './guard'

test('the edit cap is three distinct files', () => {
  expect(EDIT_CAP).toBe(3)
})

test('isCheckCommand knows test runners, build checks, linters and type checkers, anywhere in the command', () => {
  for (const c of [
    'python3 -m unittest -q', 'cd skills/spick/scripts && python3 -m unittest -q', 'pytest -x tests/', 'uv run pytest',
    'npx vitest run', 'npx jest', 'mocha', 'cargo test', 'cargo check --all', 'cargo clippy -- -D warnings', 'go test ./...', 'go vet ./...',
    'npm test', 'npm run test', 'pnpm run lint', 'yarn typecheck', 'bun test', 'npm run check',
    'claude plugin test mod/spick-dashboard', 'claude plugin validate .', 'npx tsc --noEmit', 'make test', 'make check',
    'swift test', 'xcodebuild -scheme App -destination x test', 'ruff check .', 'eslint src', 'flake8', 'mypy src', 'shellcheck a.sh',
    'bash -n setup.sh', 'git status\nnpm test 2>&1 | tail -5',
  ]) expect(isCheckCommand(c)).toBe(true)
})

test('isCheckCommand leaves ordinary commands out, and matches on word boundaries only', () => {
  for (const c of [
    'ls -la', 'cat a.py', 'git diff', 'npm install', 'cargo build', 'go build ./...', 'make', 'python3 a.py', 'grep -rn foo .',
    'rm -rf .pytest_cache', 'cat test_unittest_helpers.py', 'bash setup.sh', 'npm run build', 'echo testing', '',
  ]) expect(isCheckCommand(c)).toBe(false)
})

test('UNCHECKED_RE takes a line starting with Unchecked: or 未验证:, nothing mid-line', () => {
  expect(UNCHECKED_RE.test('Done.\nUnchecked: this repo has no tests.')).toBe(true)
  expect(UNCHECKED_RE.test('Unchecked: no tests here')).toBe(true)
  expect(UNCHECKED_RE.test('改完了。\n未验证：本项目没有测试。')).toBe(true)
  expect(UNCHECKED_RE.test('the result is Unchecked: maybe')).toBe(false)
  expect(UNCHECKED_RE.test('All checks ran.')).toBe(false)
})

test('editCapReason lists the files edited and sends the rest to a coder', () => {
  const r = editCapReason(['/r/a.py', '/r/b.py', '/r/c.py'])
  expect(r).toContain('(/r/a.py, /r/b.py, /r/c.py)')
  expect(r).toContain('the cap is 3 distinct files per turn')
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
