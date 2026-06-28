const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
  }).outputText

  module._compile(output, filename)
}

const {
  getBoardMovementSteps,
  getBoardMovementDurationMs,
} = require(path.join(__dirname, '..', 'src', 'lib', 'board-movement.ts'))

test('walks forward across the start cell', () => {
  assert.deepEqual(getBoardMovementSteps({ from: 34, to: 2, boardSize: 36, direction: 'forward' }), [35, 0, 1, 2])
})

test('walks backward for negative movement cards', () => {
  assert.deepEqual(getBoardMovementSteps({ from: 7, to: 4, boardSize: 36, direction: 'backward' }), [6, 5, 4])
})

test('uses shortest route for forced relocation such as police-to-jail', () => {
  assert.deepEqual(getBoardMovementSteps({ from: 27, to: 18, boardSize: 36, direction: 'shortest' }), [26, 25, 24, 23, 22, 21, 20, 19, 18])
})

test('keeps a turn open until movement animation has time to settle', () => {
  assert.equal(getBoardMovementDurationMs({ from: 27, to: 18, boardSize: 36 }), 2770)
})
