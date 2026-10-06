import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test('pages and components do not depend on the legacy global business store', () => {
  const files = [...sourceFiles('app/[locale]'), ...sourceFiles('components'), ...sourceFiles('hooks')]
  assert.ok(files.length > 100)
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /from\s*['"]@\/lib\/store['"]/, path)
    assert.doesNotMatch(source, /\bhydrate\s*\(/, path)
  }
})

test('successful login clears legacy cached business data before storing the new session', () => {
  const source = readFileSync('app/[locale]/enter/page.tsx', 'utf8')
  const clearPosition = source.indexOf("localStorage.removeItem('veggie_demo_store')")
  const tokenPosition = source.indexOf("localStorage.setItem('veggie_token'")
  assert.ok(clearPosition >= 0 && clearPosition < tokenPosition)
})

test('logout clears legacy cached business data without recreating the store', () => {
  const source = readFileSync('lib/session.ts', 'utf8')
  assert.match(source, /localStorage\.removeItem\('veggie_demo_store'\)/)
  for (const path of ['components/classic/OdooNav.tsx', 'components/shared/nav.tsx']) {
    const navigation = readFileSync(path, 'utf8')
    assert.doesNotMatch(navigation, /StoreAPI/)
    assert.match(navigation, /clearSession\(\)/)
  }
})
