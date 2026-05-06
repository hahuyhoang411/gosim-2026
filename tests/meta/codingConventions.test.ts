import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

describe('coding convention gates', () => {
  test('root package exposes one-command quality gates', async () => {
    const pkg = JSON.parse(await readText('package.json')) as { scripts: Record<string, string> }

    expect(pkg.scripts.test).toBe('bun test')
    expect(pkg.scripts.typecheck).toContain('tsc --noEmit')
    expect(pkg.scripts.typecheck).toContain('webview-ui')
    expect(pkg.scripts['test:typecheck']).toBe('npm run typecheck')
    expect(pkg.scripts.lint).toBe('npm --prefix webview-ui run lint')
    expect(pkg.scripts.check).toBe('npm run test && npm run typecheck && npm run lint && npm run build')
    expect(pkg.scripts.build).toBe('npm run build:server && npm run build:ui')
    expect(pkg.scripts.start).toBe('node dist/server.js')
  })

  test('bun test stays scoped to first-party tests', async () => {
    const bunfig = await readText('bunfig.toml')

    expect(bunfig).toContain('root = "tests"')
    expect(bunfig).toContain('project-manager/**')
  })

  test('editor-level whitespace conventions are explicit', async () => {
    const editorconfig = await readText('.editorconfig')

    expect(editorconfig).toContain('root = true')
    expect(editorconfig).toContain('end_of_line = lf')
    expect(editorconfig).toContain('insert_final_newline = true')
    expect(editorconfig).toContain('indent_style = space')
    expect(editorconfig).toContain('indent_size = 2')
    expect(editorconfig).toContain('trim_trailing_whitespace = true')
  })

  test('eslint keeps hooks hygiene but disables rules incompatible with the imperative canvas engine', async () => {
    const eslintConfig = await readText('webview-ui/eslint.config.js')

    expect(eslintConfig).toContain('reactHooks.configs.flat.recommended')
    expect(eslintConfig).toContain("'react-hooks/exhaustive-deps': 'error'")
    expect(eslintConfig).toContain("'react-hooks/immutability': 'off'")
    expect(eslintConfig).toContain("'react-hooks/refs': 'off'")
    expect(eslintConfig).toContain("'react-hooks/set-state-in-effect': 'off'")
  })
})
