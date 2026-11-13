import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

const { acceleratorLabel, closedProblem, pastLines, tail, wordCount } = await load('voice-chat.js')

test('earlier lines are each line gone from the screen, once, oldest first', () => {
  // Newest first, as the history keeps them: a dialog box under a menu that stays put.
  const entries = [
    { text: 'メニュー　セーブ\nもう行かなきゃ。' },
    { text: 'メニュー　セーブ\nそうだね。' },
    { text: 'メニュー　セーブ\n今日は楽しかった！' }
  ]
  const now = ['メニュー　セーブ\n明日また会おう。']
  assert.equal(pastLines(entries, now), '今日は楽しかった！\nそうだね。\nもう行かなきゃ。')
})

test('a line still on screen, or seen again, is left out wherever it was', () => {
  const entries = [{ text: 'そうだね。\n明日また会おう。' }, { text: 'そうだね' }, { text: '「そうだね」' }]
  // The screen's box holds the new line among others; punctuation and brackets don't count.
  assert.equal(pastLines(entries, ['名前\n明日、また会おう！']), 'そうだね。')
  assert.equal(pastLines(entries, []), 'そうだね。\n明日また会おう。')
})

test('a line caught while it was still typing out gives way to the whole line', () => {
  // Newest first: the whole line, then the box caught halfway.
  assert.equal(pastLines([{ text: 'もう行かなきゃ。' }, { text: 'もう行' }], []), 'もう行かなきゃ。')
  // A newer fragment of an older line (a smaller scan of the same box) gives way to it too.
  assert.equal(pastLines([{ text: '行かなきゃ' }, { text: 'もう行かなきゃ。' }], []), 'もう行かなきゃ。')
})

test('earlier lines stop at the line that reaches the word limit, keeping the newest', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ text: `line ${10 - i} one two three` }))
  // Five words a line: the newest four make 20.
  assert.equal(
    pastLines(entries, [], undefined, 20),
    'line 7 one two three\nline 8 one two three\nline 9 one two three\nline 10 one two three'
  )
  assert.equal(pastLines([], ['x']), '')
  assert.equal(pastLines([{}, { text: '  \n' }], []), '')
})

test('each earlier line says which line of its block it was, where the scan kept its blocks', () => {
  const entries = [
    {
      text: 'メニュー\n今日は\n楽しかった！',
      groups: [{ text: 'メニュー' }, { text: '今日は\n楽しかった！' }, { text: '  ' }]
    }
  ]
  assert.equal(pastLines(entries, ['メニュー']), '(line 1 of 2) 今日は\n(line 2 of 2) 楽しかった！')
  // The box's other line still on screen: the line keeps its place in the box it was in.
  assert.equal(pastLines(entries, ['メニュー\n今日は']), '(line 2 of 2) 楽しかった！')
  assert.equal(pastLines([{ text: 'メニュー\n今日は', groups: [] }], []), 'メニュー\n今日は')
})

test('words are counted in Japanese too', () => {
  assert.equal(wordCount('one two three'), 3)
  assert.ok(wordCount('今日は楽しかった') >= 3)
  assert.equal(wordCount('。！'), 0)
  // In the language being learned: Spanish words by its spaces, Thai by its own word breaker.
  assert.equal(wordCount('¿Dónde está la estación?', 'es'), 4)
  assert.ok(wordCount('ฉันชอบกินข้าว', 'th') >= 3)
})

test('the card names the shortcut as the platform does', () => {
  assert.equal(acceleratorLabel('Shift+F7', false), 'Shift+F7')
  assert.equal(acceleratorLabel('CommandOrControl+Shift+7', true), '⌘⇧7')
  assert.equal(acceleratorLabel('CommandOrControl+Alt+Digit8', false), 'Ctrl+Alt+8')
  assert.equal(acceleratorLabel('', false), '')
  assert.equal(acceleratorLabel(undefined, true), '')
})

test('a long answer shows its end, from a word where one is near', () => {
  assert.equal(tail('short'), 'short')
  const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
  const shown = tail(words, 60)
  assert.ok(shown.startsWith('…word'), shown)
  assert.ok(shown.endsWith('word99'))
  assert.ok(shown.length <= 61)
  // No space near the cut (Japanese): cut where it falls.
  assert.equal(tail('あ'.repeat(100) + 'い', 10), `…${'あ'.repeat(9)}い`)
})

test('only a session closed for a reason worth saying puts a problem on the card', () => {
  assert.equal(closedProblem('close_requested'), null)
  assert.equal(closedProblem('expired'), null)
  assert.equal(closedProblem('remote_hangup'), null)
  assert.match(closedProblem('content'), /content/)
  assert.match(closedProblem('connection_lost'), /dropped/)
})
