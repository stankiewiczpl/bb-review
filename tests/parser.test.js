import { describe, it } from 'node:test'
import assert, { strictEqual } from 'node:assert'
import { parseDiffFiles, getDiffContext } from '../src/parser.js'

// Blank context lines have a space prefix per unified diff spec
const SAMPLE_DIFF = [
  'diff --git a/src/Cart.vue b/src/Cart.vue',
  'index abc1234..def5678 100644',
  '--- a/src/Cart.vue',
  '+++ b/src/Cart.vue',
  '@@ -10,6 +10,8 @@ export default {',
  '   const items = ref([])',
  '   const total = computed(() => items.value.reduce((s, i) => s + i.price, 0))',
  ' ',
  '+  const handleClick = () => {',
  '+    emit(\'click\', { items: items.value })',
  '+  }',
  '+',
  '   return { items, total }',
  ' }',
  'diff --git a/src/utils.js b/src/utils.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/utils.js',
  '@@ -0,0 +1,5 @@',
  '+export function formatPrice(price) {',
  '+  return price.toFixed(2)',
  '+}',
  '+',
  '+export const TAX_RATE = 0.23',
].join('\n')

const DELETED_FILE_DIFF = [
  'diff --git a/old-file.js b/old-file.js',
  'deleted file mode 100644',
  '--- a/old-file.js',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-export const OLD = true',
  '-export const UNUSED = false',
  '-export const LEGACY = \'yes\'',
].join('\n')

describe('parseDiffFiles', () => {

  it('parsuje diff z dwoma plikami', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    strictEqual(files.length, 2)
    strictEqual(files[0].path, 'src/Cart.vue')
    strictEqual(files[1].path, 'src/utils.js')
  })

  it('oblicza maxNewLine dla zmodyfikowanego pliku', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    const cart = files.find(f => f.path === 'src/Cart.vue')
    // @@ +10,8 → lines 10-17 in new version (8 lines)
    // 10(ctx), 11(ctx), 12(ctx blank), 13(+), 14(+), 15(+), 16(+), 17(ctx), 18(ctx)
    assert.ok(cart.maxNewLine >= 17)
  })

  it('oblicza maxNewLine dla nowego pliku', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    const utils = files.find(f => f.path === 'src/utils.js')
    strictEqual(utils.maxNewLine, 5)
  })

  it('parsuje usunięty plik', () => {
    const files = parseDiffFiles(DELETED_FILE_DIFF)
    strictEqual(files.length, 1)
    strictEqual(files[0].path, 'old-file.js')
    strictEqual(files[0].maxNewLine, 0)
  })

  it('zwraca pustą tablicę dla pustego diff', () => {
    const files = parseDiffFiles('')
    strictEqual(files.length, 0)
  })

  it('zachowuje pełny diff w polu diff', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    assert.ok(files[0].diff.includes('+  const handleClick'))
    assert.ok(files[0].diff.includes('+++ b/src/Cart.vue'))
  })

})

describe('getDiffContext', () => {

  it('zwraca kontekst wokół wskazanej linii', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    const ctx = getDiffContext(files, 'src/Cart.vue', 13, 2)
    assert.ok(ctx.length > 0)
    assert.ok(ctx.some(l => l.lineNum === 13 && l.type === 'add'))
  })

  it('oznacza typy linii poprawnie', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    const ctx = getDiffContext(files, 'src/Cart.vue', 13, 5)
    const types = ctx.map(l => l.type)
    assert.ok(types.includes('add'))
    assert.ok(types.includes('context'))
  })

  it('zwraca pustą tablicę dla nieistniejącego pliku', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    const ctx = getDiffContext(files, 'nieistnieje.js', 1, 3)
    strictEqual(ctx.length, 0)
  })

  it('obsługuje linię na początku pliku', () => {
    const files = parseDiffFiles(SAMPLE_DIFF)
    const ctx = getDiffContext(files, 'src/utils.js', 1, 3)
    assert.ok(ctx.length > 0)
    assert.ok(ctx.some(l => l.lineNum === 1))
  })

})
