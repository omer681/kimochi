/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The text on screen as a voice chat's model can read it: instead of a screenshot, a rough map of
 * the game's window in characters, each block of text a numbered box, the pointer an `@`, with a
 * legend giving each box's text and, where the pointer is, the word it is on 【marked】.
 *
 * Plain functions of rectangles in one coordinate space (the overlay's), so they can be tested
 * without a page. `ui/voice-chat.js` sends the map when a chat starts and a pointer line
 * (`describePointer`) whenever the pointer moves to another word.
 *
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {Rect & { text: string }} Word
 * @typedef {Rect & {
 *   text: string,
 *   isVertical?: boolean,
 *   orientation?: 'horizontal' | 'vertical',
 *   lines?: Rect[],
 *   lineTexts?: string[],
 *   lineSegments?: Word[][],
 *   segments?: Word[],
 * }} TextBox
 */

const COLS = 48
const ROWS = 14
/** More boxes than this is a page of small print; the rest are left out of the map and legend. */
const MAX_BOXES = 24
const MAX_BOX_TEXT = 240

const inside = (r, p) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
/** Distance from a point to a rectangle (0 inside). */
const distance = (r, p) =>
  Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.width)), Math.max(r.y - p.y, 0, p.y - (r.y + r.height)))
const vertical = (box) => box.isVertical === true || box.orientation === 'vertical'
const clean = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()

/** Reading order: top to bottom, then left to right; right to left for vertical text. */
export function readingOrder(boxes) {
  const rows = (a, b) => Math.abs(a.y - b.y) < Math.min(a.height, b.height) / 2
  return [...boxes].sort((a, b) => {
    if (vertical(a) && vertical(b)) return b.x + b.width - (a.x + a.width)
    return rows(a, b) ? a.x - b.x : a.y - b.y
  })
}

/** Where a box sits in the area, in words: "top left", "middle", "bottom right"… */
export function placeName(box, area) {
  const cx = (box.x + box.width / 2 - area.x) / area.width
  const cy = (box.y + box.height / 2 - area.y) / area.height
  const v = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle'
  const h = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : ''
  if (v === 'middle') return h || 'middle'
  return h ? `${v} ${h}` : v
}

/** The lines of a box, each with its rectangle and words where the engine gave them. */
function linesOf(box) {
  // Each line's text: the engine's, or the box's own text when its line breaks match the lines.
  const split = String(box.text ?? '').split('\n')
  const texts = box.lineTexts?.length
    ? box.lineTexts
    : box.lines?.length > 1 && split.length === box.lines.length
      ? split
      : null
  if (box.lines?.length) {
    return box.lines.map((rect, i) => {
      const words = box.lineSegments?.[i] ?? []
      const text = texts?.[i] ?? (words.length ? words.map((w) => w.text).join('') : null)
      return { rect, words, text }
    })
  }
  return [{ rect: box, words: box.segments ?? [], text: null }]
}

/** The share (0–1) of `rect` the point is along, down for vertical text, across otherwise. */
const along = (rect, point, down) =>
  Math.max(0, Math.min(0.999, down ? (point.y - rect.y) / rect.height : (point.x - rect.x) / rect.width))

/**
 * The character the pointer is on in a line, as an index into its text. With the engine's word
 * boxes (often a box per character for Japanese), the box under the pointer and the pointer's
 * share of it; without, the pointer's share of the whole line.
 */
function characterAt(line, text, point, down) {
  const words = line.words.filter((w) => w.text)
  if (!words.length) return Math.floor(along(line.rect, point, down) * [...text].length)
  const word =
    words.find((w) => inside(w, point)) ??
    words.reduce((best, w) => (distance(w, point) < distance(best, point) ? w : best), words[0])
  const before = [
    ...words
      .slice(0, words.indexOf(word))
      .map((w) => w.text)
      .join('')
  ].length
  return before + Math.floor(along(word, point, down) * [...word.text].length)
}

/** Japanese word boundaries (the platform's dictionary-based word breaker), or null without one. */
const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null

/**
 * The word around character `at` of `chars`, as character indices [from, to): the word the
 * platform's Japanese word breaker finds there (天気, not 天), or the character alone where that
 * is punctuation or there is no word breaker.
 */
export function wordAround(chars, at) {
  if (!segmenter) return [at, at + 1]
  let index = 0
  for (const part of segmenter.segment(chars.join(''))) {
    const length = [...part.segment].length
    if (at < index + length) return part.isWordLike ? [index, index + length] : [at, at + 1]
    index += length
  }
  return [at, at + 1]
}

/**
 * What the pointer is on inside a box: the line it is on (or nearest), which line of the box that
 * is, and the word under it (widened from the character under it by `wordAround`), with its place
 * in the line in characters (`start`–`end` of `length`, from 1) and the line marked 【like this】.
 * `character` is the one the pointer is on itself. Null when the box has no usable line text.
 */
export function markUnder(box, point) {
  const lines = linesOf(box)
  const line =
    lines.find((l) => inside(l.rect, point)) ??
    lines.reduce((best, l) => (distance(l.rect, point) < distance(best.rect, point) ? l : best), lines[0])
  const place = { lineNumber: lines.indexOf(line) + 1, lineCount: lines.length }
  const words = line.words.filter((w) => w.text)
  const text = words.length
    ? words.map((w) => w.text).join('')
    : clean(line.text ?? (lines.length === 1 ? box.text : ''))
  const chars = [...text]
  if (!chars.length) return null
  const at = Math.max(0, Math.min(chars.length - 1, characterAt(line, text, point, vertical(box))))
  const [from, to] = wordAround(chars, at)
  const word = chars.slice(from, to).join('')
  return {
    ...place,
    word,
    character: chars[at],
    line: text,
    marked: `${chars.slice(0, from).join('')}【${word}】${chars.slice(to).join('')}`,
    start: from + 1,
    end: to,
    length: chars.length
  }
}

/**
 * Which box the pointer is on, or nearest to, and what it is over: null when there is no text or
 * no pointer. `on` is false when the pointer is beside the text rather than on it; `paragraph` is
 * the whole box's text.
 * @param {TextBox[]} boxes in reading order (their numbers are their places, from 1)
 * @param {{ x: number, y: number } | null} point
 * @param {Rect | null} [area] the game's window: a pointer outside it is not over the game
 */
export function pointerTarget(boxes, point, area = null) {
  if (!point || !boxes.length || (area && !inside(area, point))) return null
  let index = boxes.findIndex((b) => inside(b, point))
  const on = index >= 0
  if (!on) {
    index = 0
    for (let i = 1; i < boxes.length; i++) if (distance(boxes[i], point) < distance(boxes[index], point)) index = i
  }
  const box = boxes[index]
  return { number: index + 1, on, paragraph: clean(box.text), under: markUnder(box, point) }
}

/**
 * What the model is told about the pointer, at the start and on each move to another word: the
 * paragraph it is on or nearest, the line of it, and the word with its place in that line.
 */
export function describePointer(target) {
  if (!target) return 'The pointer is not over the game.'
  const where = target.on ? `on box [${target.number}]` : `not on any text; the nearest is box [${target.number}]`
  const lines = [`The learner's pointer is ${where}.`, `Paragraph: ${target.paragraph}`]
  const u = target.under
  if (u) {
    const chars = u.start === u.end ? `character ${u.start}` : `characters ${u.start}–${u.end}`
    const on = u.character && u.character !== u.word ? ` (on its 「${u.character}」)` : ''
    lines.push(
      `Line ${u.lineNumber} of ${u.lineCount}: ${u.marked}`,
      `${target.on ? 'Over' : 'Closest to'} the word 「${u.word}」${on}, ${chars} of ${u.length} in that line.`
    )
  }
  return lines.join('\n')
}

/**
 * The map: the area drawn in `COLS`×`ROWS` characters, each box filled with `=` and labelled
 * with its number at its top-left corner, `@` where the pointer is (when it is inside the area).
 */
export function drawMap(boxes, area, point) {
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(' '))
  const col = (x) => Math.max(0, Math.min(COLS - 1, Math.floor(((x - area.x) / area.width) * COLS)))
  const row = (y) => Math.max(0, Math.min(ROWS - 1, Math.floor(((y - area.y) / area.height) * ROWS)))
  const cells = boxes.map((b) => ({ c0: col(b.x), c1: col(b.x + b.width), r0: row(b.y), r1: row(b.y + b.height) }))
  for (const { c0, c1, r0, r1 } of cells) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c] = '='
  // Labels after every fill, so a neighbour's fill never hides one; and only where one fits whole
  // (at its box's corner or a little to the right), so labels never run into each other. A box
  // that is crowded out stays in the legend.
  const labelled = Array.from({ length: ROWS }, () => Array(COLS).fill(false))
  cells.forEach(({ c0, c1, r0 }, i) => {
    const label = `[${i + 1}]`
    const last = Math.min(Math.max(c0, c1 - label.length + 1), COLS - label.length)
    for (let start = Math.min(c0, COLS - label.length); start <= last; start++) {
      const free = [...label].every(
        (_, k) => !labelled[r0][start + k] && !labelled[r0][start + k - 1] && !labelled[r0][start + k + 1]
      )
      if (!free) continue
      for (let k = 0; k < label.length; k++) {
        grid[r0][start + k] = label[k]
        labelled[r0][start + k] = true
      }
      break
    }
  })
  if (point && inside(area, point)) grid[row(point.y)][col(point.x)] = '@'
  const edge = `+${'-'.repeat(COLS)}+`
  return [edge, ...grid.map((cells) => `|${cells.join('')}|`), edge].join('\n')
}

/**
 * Everything the model is given about the screen when a chat starts: the map, the legend and the
 * pointer, and the boxes in their numbered order (for the pointer updates that follow). Null when
 * there are no boxes.
 * @param {TextBox[]} boxes
 * @param {Rect | null} area the game's window (or the scanned area), same coordinates
 * @param {{ x: number, y: number } | null} point the pointer, same coordinates
 */
export function describeScreen(boxes, area, point) {
  const usable = boxes.filter((b) => clean(b.text) && b.width > 0 && b.height > 0)
  if (!usable.length) return null
  const frame = area && area.width > 0 && area.height > 0 ? area : union(usable)
  // A pointer off the game (another monitor, another window beside it) is no pointer.
  point = point && inside(frame, point) ? point : null
  const kept = keep(usable, point)
  const ordered = readingOrder(kept)
  const leftOut = usable.length - kept.length
  const legend = ordered.map((box, i) => {
    const lines = linesOf(box)
      .map((l) => clean(l.text))
      .filter(Boolean)
    const shape = [
      placeName(box, frame),
      vertical(box) ? 'vertical text' : null,
      lines.length > 1 ? `${lines.length} lines` : null
    ]
      .filter(Boolean)
      .join(', ')
    const text = clean(box.text)
    return `[${i + 1}] (${shape}) ${text.length > MAX_BOX_TEXT ? `${text.slice(0, MAX_BOX_TEXT)}…` : text}`
  })
  const target = pointerTarget(ordered, point, frame)
  const text = [
    'Map of the game window (each box is a block of text, numbered in reading order; @ is the pointer):',
    drawMap(ordered, frame, point),
    '',
    'The boxes:',
    ...legend,
    ...(leftOut
      ? [`(${leftOut} more boxes are left out: those without Japanese, then those farthest from the pointer.)`]
      : []),
    '',
    describePointer(target)
  ].join('\n')
  return { text, boxes: ordered, target, area: frame }
}

const JAPANESE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/

/**
 * At most `MAX_BOXES` of the boxes: with more, those with Japanese in them come first (a game's
 * menus, a browser's tabs and a desktop's icons are mostly not what is being read), then those
 * nearest the pointer, then the larger.
 */
function keep(boxes, point) {
  if (boxes.length <= MAX_BOXES) return boxes
  const rank = (b) => [JAPANESE.test(b.text) ? 0 : 1, point ? distance(b, point) : 0, -(b.width * b.height)]
  return boxes
    .map((box) => ({ box, rank: rank(box) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
    .slice(0, MAX_BOXES)
    .map(({ box }) => box)
}

function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x || 1,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y || 1
  }
}
