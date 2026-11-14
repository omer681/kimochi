// The voice chat's session lifecycle against a fake WebRTC: whatever ends a chat, the session
// OpenAI bills for is closed and the peer hung up.
import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'

class FakeTarget {
  listeners = {}
  addEventListener(type, fn, options) {
    ;(this.listeners[type] ??= []).push({ fn, once: options?.once })
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l.fn !== fn)
  }
  emit(type, event = {}) {
    for (const l of [...(this.listeners[type] ?? [])]) {
      if (l.once) this.removeEventListener(type, l.fn)
      l.fn(event)
    }
  }
}
class FakeChannel extends FakeTarget {
  readyState = 'connecting'
  sent = []
  send(text) {
    this.sent.push(JSON.parse(text))
  }
  close() {
    this.readyState = 'closed'
  }
  open() {
    this.readyState = 'open'
    this.emit('open')
  }
  server(event) {
    this.emit('message', { data: JSON.stringify(event) })
  }
}
const peers = []
class FakePeer extends FakeTarget {
  connectionState = 'new'
  closed = false
  remote = null
  constructor() {
    super()
    peers.push(this)
  }
  addTransceiver() {
    return { sender: { replaceTrack: async () => {} } }
  }
  createDataChannel() {
    return (this.channel = new FakeChannel())
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' }
  }
  async setLocalDescription(d) {
    this.localDescription = d
  }
  async setRemoteDescription(d) {
    this.remote = d
  }
  close() {
    this.closed = true
  }
}
const tracks = []
const element = () => {
  const el = {
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    setAttribute() {},
    append() {},
    prepend() {}
  }
  return el
}
globalThis.document = { createElement: element }
const pageHide = []
globalThis.addEventListener = (type, fn) => type === 'pagehide' && pageHide.push(fn)
globalThis.RTCPeerConnection = FakePeer
globalThis.MediaStream = class {}
globalThis.Audio = class {
  muted = false
  play = async () => {}
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        const track = { stopped: false, stop: () => (track.stopped = true) }
        tracks.push(track)
        return { getTracks: () => [track], getAudioTracks: () => [track] }
      }
    }
  }
})

const { createVoiceChat } = await load('voice-chat.js')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const screen = { text: '[1] (bottom) 行かなきゃ。', boxes: [], language: 'ja' }

function chat() {
  let answer = null
  const hooks = {
    connect: () =>
      new Promise((resolve) => {
        answer = resolve
      }),
    warm: async () => {},
    endKey: async () => '',
    log: () => {}
  }
  const voice = createVoiceChat(element(), hooks)
  return { voice, answer: (sdp = 'v=0 answer') => answer(sdp), requested: () => answer !== null }
}
async function untilRequested(c) {
  for (let i = 0; i < 20 && !c.requested(); i++) await tick()
  assert.ok(c.requested(), 'the session was requested')
}

test('ending a running chat sends session.close and hangs up on session.closed', async () => {
  const c = chat()
  void c.voice.toggle(screen, '')
  await untilRequested(c)
  c.answer()
  await tick()
  const peer = peers.at(-1)
  peer.channel.open()
  peer.channel.server({ type: 'session.started' })
  c.voice.toggle()
  assert.deepEqual(peer.channel.sent.at(-1), { type: 'session.close' })
  assert.ok(tracks.at(-1).stopped, 'the microphone stops at once')
  assert.equal(peer.closed, false, 'the peer waits for session.closed')
  peer.channel.server({ type: 'session.closed', reason: 'close_requested' })
  assert.ok(peer.closed)
})

test('a chat ended while OpenAI creates the session still closes that session', async () => {
  const c = chat()
  void c.voice.toggle(screen, '')
  await untilRequested(c)
  c.voice.toggle() // ended during the request
  assert.equal(c.voice.active, false)
  c.answer()
  await tick()
  const peer = peers.at(-1)
  assert.ok(peer.remote, 'the answer is set, to connect and close')
  assert.equal(peer.closed, false)
  peer.channel.open()
  assert.deepEqual(peer.channel.sent.at(-1), { type: 'session.close' })
  peer.channel.server({ type: 'session.closed' })
  assert.ok(peer.closed)
})

test('a chat ended before it connected waits to connect, then closes', async () => {
  const c = chat()
  void c.voice.toggle(screen, '')
  await untilRequested(c)
  c.answer()
  await tick()
  const peer = peers.at(-1)
  c.voice.end()
  assert.equal(peer.closed, false, 'not dropped while the session exists unconnected')
  peer.channel.open()
  assert.deepEqual(peer.channel.sent.at(-1), { type: 'session.close' })
})

test('a chat ended before its session was asked for just hangs up', async () => {
  const c = chat()
  void c.voice.toggle(screen, '')
  c.voice.end()
  for (let i = 0; i < 5; i++) await tick()
  const peer = peers.at(-1)
  assert.ok(peer.closed)
  assert.equal(c.requested(), false, 'no session is created after the chat ended')
})

test('hiding the overlay ends the chat and closes its session', async () => {
  const c = chat()
  assert.equal(typeof c.voice.end, 'function')
  c.voice.end() // nothing going: no error
  void c.voice.toggle(screen, '')
  await untilRequested(c)
  c.answer()
  await tick()
  const peer = peers.at(-1)
  peer.channel.open()
  peer.channel.server({ type: 'session.started' })
  c.voice.end()
  assert.equal(c.voice.active, false)
  assert.deepEqual(peer.channel.sent.at(-1), { type: 'session.close' })
})

test('the overlay going away closes the session and hangs up at once', async () => {
  const c = chat()
  void c.voice.toggle(screen, '')
  await untilRequested(c)
  c.answer()
  await tick()
  const peer = peers.at(-1)
  peer.channel.open()
  peer.channel.server({ type: 'session.started' })
  for (const fn of pageHide) fn()
  assert.equal(c.voice.active, false)
  assert.deepEqual(peer.channel.sent.at(-1), { type: 'session.close' })
  assert.ok(peer.closed, 'no waiting: the page is going')
})
