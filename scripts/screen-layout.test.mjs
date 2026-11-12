import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describePointer,
  describeScreen,
  drawMap,
  markUnder,
  placeName,
  pointerTarget,
  readingOrder
} from '../ui/screen-layout.js'

const area = { x: 0, y: 0, width: 960, height: 540 }
/** A name box at the bottom left and the dialogue under it, with word boxes on the dialogue. */
const name = { x: 60, y: 380, width: 120, height: 30, text: 'アリス' }
const words = [
  { x: 60, y: 430, width: 80, height: 30, text: '今日は' },
  { x: 140, y: 430, width: 40, height: 30, text: 'いい' },
  { x: 180, y: 430, width: 60, height: 30, text: '天気' },
  { x: 240, y: 430, width: 60, height: 30, text: 'だね' }
]
const dialogue = {
  x: 60,
  y: 430,
  width: 240,
  height: 30,
  text: '今日はいい天気だね',
  lines: [{ x: 60, y: 430, width: 240, height: 30 }],
  lineSegments: [words]
}

test('boxes are numbered top to bottom, left to right, and vertical text right to left', () => {
  assert.deepEqual(
    readingOrder([dialogue, name]).map((b) => b.text),
    ['アリス', '今日はいい天気だね']
  )
  const right = { x: 800, y: 40, width: 30, height: 300, text: '右', isVertical: true }
  const left = { x: 700, y: 40, width: 30, height: 300, text: '左', isVertical: true }
  assert.deepEqual(
    readingOrder([left, right]).map((b) => b.text),
    ['右', '左']
  )
})

test('a box is placed in words', () => {
  assert.equal(placeName(name, area), 'bottom left')
  assert.equal(placeName({ x: 430, y: 250, width: 100, height: 40 }, area), 'middle')
  assert.equal(placeName({ x: 800, y: 10, width: 100, height: 40 }, area), 'top right')
})

test('the pointer marks the word it is on, with its line and place in it', () => {
  assert.deepEqual(markUnder(dialogue, { x: 200, y: 445 }), {
    lineNumber: 1,
    lineCount: 1,
    word: '天気',
    character: '天',
    line: '今日はいい天気だね',
    marked: '今日はいい【天気】だね',
    start: 6,
    end: 7,
    length: 9
  })
  // Just past the end of the line: the nearest word's last character, and its word.
  assert.equal(markUnder(dialogue, { x: 320, y: 445 }).character, 'ね')
})

test('with a box per character, the pointer still means the whole word', () => {
  const chars = [...'今日はいい天気だね'].map((text, i) => ({ x: i * 20, y: 0, width: 20, height: 30, text }))
  const line = {
    x: 0,
    y: 0,
    width: 180,
    height: 30,
    text: '今日はいい天気だね',
    lines: [{ x: 0, y: 0, width: 180, height: 30 }],
    lineSegments: [chars]
  }
  // On 気, the second character of 天気.
  const under = markUnder(line, { x: 130, y: 15 })
  assert.deepEqual(
    [under.word, under.character, under.marked, under.start, under.end],
    ['天気', '気', '今日はいい【天気】だね', 6, 7]
  )
  // Punctuation stays itself.
  const quoted = { x: 0, y: 0, width: 100, height: 20, text: '「お前」' }
  assert.equal(markUnder(quoted, { x: 2, y: 10 }).word, '「')
})

test('without word boxes the pointer finds the character at its share of the line, then its word', () => {
  const plain = { x: 0, y: 0, width: 100, height: 20, text: '今日はいい天気だね' }
  // 55% along nine characters: the fifth, い, inside いい.
  const under = markUnder(plain, { x: 50, y: 10 })
  assert.deepEqual([under.character, under.word, under.marked], ['い', 'いい', '今日は【いい】天気だね'])
  assert.deepEqual([under.start, under.end, under.length], [4, 5, 9])
  // Vertical text reads down.
  const tall = { x: 0, y: 0, width: 20, height: 100, text: 'かきくけこ', isVertical: true }
  assert.equal(markUnder(tall, { x: 10, y: 85 }).word, 'こ')
  // Two lines whose text is the box's, split at its line breaks: the second, counted on its own.
  const two = {
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    text: 'あいう\nかきくけ',
    lines: [
      { x: 0, y: 0, width: 60, height: 20 },
      { x: 0, y: 20, width: 80, height: 20 }
    ]
  }
  const second = markUnder(two, { x: 70, y: 30 })
  assert.deepEqual(
    [second.lineNumber, second.lineCount, second.marked, second.start, second.length],
    [2, 2, 'かきく【け】', 4, 4]
  )
})

test('the pointer is on a paragraph, beside the nearest one, or off the game', () => {
  const boxes = readingOrder([dialogue, name])
  const on = pointerTarget(boxes, { x: 200, y: 445 })
  assert.deepEqual([on.number, on.on, on.paragraph], [2, true, '今日はいい天気だね'])
  assert.equal(
    describePointer(on),
    [
      "The learner's pointer is on box [2].",
      'Paragraph: 今日はいい天気だね',
      'Line 1 of 1: 今日はいい【天気】だね',
      'Over the word 「天気」 (on its 「天」), characters 6–7 of 9 in that line.'
    ].join('\n')
  )
  const beside = pointerTarget(boxes, { x: 100, y: 300 })
  assert.deepEqual([beside.number, beside.on], [1, false])
  const said = describePointer(beside).split('\n')
  assert.equal(said[0], "The learner's pointer is not on any text; the nearest is box [1].")
  assert.equal(said[1], 'Paragraph: アリス')
  assert.match(said[3], /^Closest to the word 「.+」.*, characters? [\d–]+ of 3 in that line\.$/)
  assert.equal(pointerTarget(boxes, null), null)
  assert.equal(describePointer(null), 'The pointer is not over the game.')
})

test('the map draws each box where it is, labelled, with the pointer', () => {
  const boxes = readingOrder([dialogue, name])
  const map = drawMap(boxes, area, { x: 200, y: 445 }).split('\n')
  assert.equal(map.length, 16)
  assert.ok(
    map.every((row) => row.length === 50),
    'every row is the frame wide'
  )
  const labelRows = map.map((row, i) => [i, row]).filter(([, row]) => /\[\d\]/.test(row))
  assert.deepEqual(labelRows.map(([, row]) => row.match(/\[\d\]/g)).flat(), ['[1]', '[2]'])
  assert.ok(labelRows[0][0] < labelRows[1][0], 'the name box is drawn above the dialogue')
  assert.ok(map.some((row) => row.includes('@')))
  // A pointer outside the area is not drawn.
  assert.ok(!drawMap(boxes, area, { x: -50, y: 10 }).includes('@'))
})

test('the screen description has the map, the legend and the pointer; nothing without text', () => {
  const blank = { x: 0, y: 0, width: 10, height: 10, text: '  ' }
  const screen = describeScreen([dialogue, name, blank], area, { x: 200, y: 445 })
  assert.equal(screen.boxes.length, 2, 'blank boxes are left out')
  assert.match(screen.text, /^Map of the game window/)
  assert.match(screen.text, /\[1\] \(bottom left\) アリス/)
  assert.match(screen.text, /\[2\] \(bottom left\) 今日はいい天気だね/)
  assert.ok(screen.text.endsWith('Over the word 「天気」 (on its 「天」), characters 6–7 of 9 in that line.'))
  assert.equal(screen.target.number, 2)
  assert.equal(describeScreen([], area, null), null)
  // Without an area, the text's own extent frames the map.
  assert.ok(describeScreen([name], null, null).text.includes('[1]'))
})
