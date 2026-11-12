/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
import { describePointer, pointerTarget } from './screen-layout.js'
/**
 * Voice chat: a short spoken conversation with OpenAI's GPT-Live (`gpt-live-1`) about the text on
 * the overlay, started and ended by the Voice chat shortcut (`voiceChat`).
 *
 * The call runs here over WebRTC: the microphone goes out and the model's voice comes back
 * straight between this webview and OpenAI. Native does only the handshake
 * (`voice_chat_connect`, src-tauri/src/voice_chat.rs), so the OpenAI key never reaches a page.
 * Events on the `oai-events` data channel drive a card that says what is happening and shows the
 * last thing said each way: GPT-Live sends both sides' transcripts as fragments with no turns
 * marked, so a fragment from the other side starts a new line.
 *
 * What is on screen goes as text, not a picture: a rough map of the game's window with each
 * block of text numbered, a legend, and what the pointer is on (`ui/screen-layout.js`). While the
 * chat runs, each move of the pointer to another word is told to the model quietly (`pointer`).
 *
 * The session has no backend (client delegation). Should GPT-Live ask for help anyway
 * (`session.delegation.created`), it is answered at once with "answer from what you know", so it
 * never waits on a backend that isn't there.
 *
 * It is meant for a question or two, so it ends by itself after a quiet spell (`QUIET_MS`) or at a
 * hard cap (`MAX_MS`), as well as when the shortcut is pressed again; GPT-Live bills by the second.
 *
 * The card takes no clicks: the overlay never has the pointer, and the shortcut is the control.
 */

/** Nothing has been said either way for this long: the questions are answered. */
const QUIET_MS = 25_000
/** However lively, a chat ends here; it is for a question or two, and it is billed by the second. */
const MAX_MS = 3 * 60_000
/** How long the last word (ended, or an error) stays on the card. */
const LINGER_MS = 2_500
const ERROR_MS = 6_000
/**
 * The offer waits this long at most for its network candidates. Without STUN servers they are
 * this computer's own addresses, gathered in about 0.1 s; the cap keeps an odd network adapter
 * from holding the chat up (the docs' example waits up to 10 s).
 */
const ICE_MS = 1_500
/** After `session.close`, how long to wait for `session.closed` before hanging up anyway. */
const CLOSE_MS = 2_000
/** The reply to a delegation: there is no backend, so the model answers itself. */
const NO_BACKEND = 'No backend is available. Answer from your own knowledge.'
/** The pointer has to rest on another word this long before the model is told. */
const POINTER_SETTLE_MS = 400

const make = (tag, className, text) => {
  const element = document.createElement(tag)
  element.className = className
  if (text) element.textContent = text
  return element
}

/** An accelerator (`Shift+F7`, `CommandOrControl+Shift+7`) as this platform's keyboards name it. */
export function acceleratorLabel(accelerator, mac) {
  return String(accelerator || '')
    .split('+')
    .filter(Boolean)
    .map((part) => {
      if (/^(CommandOrControl|CmdOrCtrl)$/i.test(part)) return mac ? '⌘' : 'Ctrl'
      if (/^(Command|Cmd|Super|Meta)$/i.test(part)) return mac ? '⌘' : 'Super'
      if (/^(Control|Ctrl)$/i.test(part)) return mac ? '⌃' : 'Ctrl'
      if (/^(Alt|Option)$/i.test(part)) return mac ? '⌥' : 'Alt'
      if (/^Shift$/i.test(part)) return mac ? '⇧' : 'Shift'
      return part.replace(/^Digit/, '')
    })
    .join(mac ? '' : '+')
}

/** The end of a long answer, which is the part being said now. */
export function tail(text, max = 320) {
  if (text.length <= max) return text
  const cut = text.slice(-max)
  // Start on a word where there is one near.
  const space = cut.indexOf(' ')
  return `…${space > 0 && space < 40 ? cut.slice(space + 1) : cut}`
}

/** How many words of earlier lines a chat is given. */
const MAX_PAST_WORDS = 200

/** A line's letters, digits and kana/kanji: what stays the same between two readings of it. */
const letters = (text) => (String(text ?? '').match(/[\p{L}\p{N}]/gu) ?? []).join('')

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null

/** How many words `text` has, Japanese (no spaces between them) included. */
export function wordCount(text) {
  // Without a word splitter, a Japanese word runs about two characters.
  if (!segmenter) return Math.ceil(letters(text).length / 2)
  let count = 0
  for (const segment of segmenter.segment(String(text ?? ''))) if (segment.isWordLike) count++
  return count
}

const splitLines = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * A scan's lines in reading order, each with its place in its block of text ("line 2 of 3") when
 * the scan kept its blocks (`groups`); without them, the lines alone.
 * @param {{ text?: string, groups?: { text?: string }[] }} entry
 */
function entryLines(entry) {
  const groups = (entry?.groups ?? []).map((group) => splitLines(group?.text)).filter((lines) => lines.length)
  if (!groups.length) return splitLines(entry?.text).map((text) => ({ text, place: null }))
  return groups.flatMap((lines) => lines.map((text, i) => ({ text, place: `line ${i + 1} of ${lines.length}` })))
}

/**
 * The lines that were on screen before and are gone from it now, each once wherever it was on
 * screen, oldest first: a dialog box's earlier lines, without the menus and names that stayed put.
 * Each is marked with its place in its block, `(line 2 of 3) …`, where the scan kept its blocks.
 * `entries` are the earlier scans, newest first; `current` the texts on screen now. A line is left
 * out when the screen still shows it, or when a newer line already kept holds it (the box was
 * scanned while its text was still typing out); an older line that holds a kept one replaces it.
 * Stops at the line that brings it to `max` words.
 * @param {{ text?: string, groups?: { text?: string }[] }[]} entries
 * @param {(string | undefined)[]} current
 */
export function pastLines(entries, current, max = MAX_PAST_WORDS) {
  const shown = current.map(letters).filter(Boolean)
  /** Newest first. */
  const kept = []
  let words = 0
  const result = () =>
    kept
      .reverse()
      .map((k) => (k.place ? `(${k.place}) ${k.text}` : k.text))
      .join('\n')
  for (const entry of entries) {
    // An entry's own lines read top to bottom: walk them backwards, as the entries are walked.
    for (const { text, place } of entryLines(entry).reverse()) {
      const key = letters(text)
      if (!key || shown.some((s) => s.includes(key)) || kept.some((k) => k.key.includes(key))) continue
      for (let i = kept.length - 1; i >= 0; i--) {
        if (!key.includes(kept[i].key)) continue
        words -= kept[i].words
        kept.splice(i, 1)
      }
      const line = { text, place, key, words: wordCount(text) }
      kept.push(line)
      words += line.words
      if (words >= max) return result()
    }
  }
  return result()
}

/** What a microphone failure means for the reader. */
export function microphoneProblem(error) {
  const name = error?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Kimochi can’t use the microphone. Allow it in your system’s privacy settings.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.'
  if (name === 'NotReadableError') return 'The microphone is busy in another app.'
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined')
    return 'Voice chat isn’t available on this desktop yet.'
  return `The microphone couldn’t start: ${error?.message ?? error}`
}

/** Why GPT-Live closed the session, for the card; null when there is nothing to explain. */
export function closedProblem(reason) {
  if (reason === 'expired') return null
  if (reason === 'content') return 'OpenAI ended the voice chat over its content.'
  if (reason === 'connection_lost') return 'The connection to OpenAI dropped.'
  return null
}

/** What a pointer target says, to tell one word from another. */
const pointerKey = (target) =>
  target ? `${target.number}|${target.on}|${target.under?.lineNumber ?? 0}|${target.under?.marked ?? ''}` : 'off'

/** Resolves once the offer has gathered its network candidates, or after `ms` regardless. */
function iceGathered(peer, ms) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => {
      if (peer.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, ms)
    peer.addEventListener('icegatheringstatechange', check)
  })
}

/**
 * Start WebRTC once ahead of a chat: the first peer connection in a page takes about 0.4 s to come
 * up, which the first press would otherwise wait for. No microphone and no network: an offer is
 * built and thrown away.
 */
let prewarmed = false
export async function prewarmWebRtc() {
  if (prewarmed || typeof RTCPeerConnection === 'undefined') return
  prewarmed = true
  const peer = new RTCPeerConnection()
  try {
    peer.addTransceiver('audio', { direction: 'sendrecv' })
    await peer.createOffer()
  } catch {
    /* the chat itself reports what does not work */
  } finally {
    peer.close()
  }
}

/**
 * @param {HTMLElement} parent
 * @param {{
 *   connect: (sdp: string, screen: string, context: string) => Promise<string>,
 *   warm?: () => Promise<void>,
 *   endKey: () => Promise<string>,
 *   log: (value: object) => void,
 * }} hooks
 */
export function createVoiceChat(parent, hooks) {
  const card = make('div', 'voice-chat')
  card.hidden = true
  card.setAttribute('role', 'status')
  card.setAttribute('aria-live', 'polite')
  // Kimochi's own words, never looked up (host/frontend-mode.js).
  card.setAttribute('data-no-scan', '')
  const head = make('div', 'voice-chat-head')
  const dot = make('span', 'voice-chat-dot')
  const status = make('span', 'voice-chat-status')
  const hint = make('span', 'voice-chat-hint')
  head.append(dot, status, hint)
  const you = make('p', 'voice-chat-you')
  const reply = make('p', 'voice-chat-reply')
  card.append(head, you, reply)
  parent.prepend(card)

  /** The chat in progress, or null. A new one (or an end) makes any older one's events moot. */
  let call = null
  let hideTimer = 0

  const show = (state, text) => {
    clearTimeout(hideTimer)
    card.hidden = false
    card.dataset.state = state
    status.textContent = text
  }
  const hideAfter = (ms) => {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      card.hidden = true
      you.textContent = ''
      reply.textContent = ''
      hint.textContent = ''
    }, ms)
  }

  const send = (current, event) => {
    if (current.channel?.readyState !== 'open') return false
    current.channel.send(JSON.stringify(event))
    return true
  }

  /** Hang up: the peer, the microphone and the speaker. */
  function hangUp(current) {
    clearInterval(current.watch)
    clearTimeout(current.pointerTimer)
    try {
      current.channel?.close()
    } catch {
      /* already closed */
    }
    try {
      current.peer?.close()
    } catch {
      /* already closed */
    }
    for (const track of current.microphone?.getTracks() ?? []) track.stop()
    current.audio.srcObject = null
  }

  /**
   * End the chat on the card at once; the session is closed politely (`session.close`, then
   * `session.closed` or `CLOSE_MS`) before hanging up, so its seconds stop being billed.
   */
  function end(reason, message) {
    const current = call
    if (!current) return
    call = null
    hooks.log({
      check: 'voice-chat',
      event: 'end',
      reason,
      seconds: Math.round((Date.now() - current.startedAt) / 1000)
    })
    hint.textContent = ''
    if (message) {
      show('error', message)
      hideAfter(ERROR_MS)
    } else {
      show('ended', reason === 'time' ? 'Voice chat ended (time’s up)' : 'Voice chat ended')
      hideAfter(LINGER_MS)
    }
    if (current.started && !current.closed && send(current, { type: 'session.close' })) {
      current.hangUpTimer = setTimeout(() => hangUp(current), CLOSE_MS)
    } else {
      hangUp(current)
    }
  }

  /** Server events: transcripts on the card, delegations answered, the session's end. */
  function onEvent(current, event) {
    // A chat already ended on the card still hears its `session.closed`, to hang up.
    if (event?.type === 'session.closed') {
      current.closed = true
      clearTimeout(current.hangUpTimer)
      hangUp(current)
      if (call === current) end(event.reason ?? 'closed', closedProblem(event.reason))
      return
    }
    if (call !== current) return
    const now = Date.now()
    switch (event?.type) {
      case 'session.started':
        current.started = true
        current.lastActivity = now
        show('ready', 'Ask away')
        break
      case 'session.input_transcript.delta':
        current.lastActivity = now
        if (current.lastFrom !== 'you') {
          current.lastFrom = 'you'
          current.heard = ''
          show('listening', 'Listening…')
        }
        current.heard += event.delta ?? ''
        you.textContent = tail(current.heard.trim(), 200)
        break
      case 'session.output_transcript.delta':
        current.lastActivity = now
        if (current.lastFrom !== 'ai') {
          current.lastFrom = 'ai'
          current.said = ''
          show('speaking', 'Speaking')
        }
        current.said += event.delta ?? ''
        reply.textContent = tail(current.said.trim())
        break
      case 'session.delegation.created': {
        const id = event.delegation?.id
        hooks.log({ check: 'voice-chat', event: 'delegation' })
        if (id) send(current, { type: 'session.thinking.append', delegation_id: id, content: NO_BACKEND })
        break
      }
      case 'error':
        hooks.log({ check: 'voice-chat', event: 'error', code: event.error?.code ?? '' })
        // A refused client event is not the end of the chat; a dead session closes on its own.
        if (event.error?.client_event_id) break
        end('error', event.error?.message || 'OpenAI ended the voice chat.')
        break
      default:
        break
    }
  }

  /**
   * Start a chat. What can run at once does: the microphone opens, the offer is built (its audio
   * slot first, the microphone put in it once open) and native opens its connection to OpenAI
   * (`warm`), all together. Only the session request waits for both, so a refused microphone
   * never starts a billed session. Each step's time is logged (`ready`), never what is said.
   */
  async function start(screen, context) {
    const begun = performance.now()
    const current = {
      startedAt: Date.now(),
      lastActivity: Date.now(),
      started: false,
      closed: false,
      /** Who the last transcript fragment was from: 'you', 'ai' or null. */
      lastFrom: null,
      heard: '',
      said: '',
      audio: new Audio(),
      microphone: null,
      peer: null,
      channel: null,
      watch: 0,
      hangUpTimer: 0,
      /** Milliseconds from the press to each step. */
      timings: {},
      /** The screen's boxes in their numbered order, for the pointer updates. */
      boxes: screen.boxes ?? [],
      /** The game's window, outside which the pointer is off the game. */
      area: screen.area ?? null,
      /** What the model was last told the pointer is on, and the move waiting to be told. */
      pointerSaid: pointerKey(screen.target ?? null),
      pointerTimer: 0
    }
    const mark = (step) => {
      current.timings[step] ??= Math.round(performance.now() - begun)
    }
    call = current
    you.textContent = ''
    reply.textContent = ''
    show('connecting', 'Starting voice chat…')
    void hooks.endKey().then((key) => {
      if (call === current && key) hint.textContent = `${key} to end`
    })
    hooks.log({ check: 'voice-chat', event: 'start' })
    void hooks.warm?.().catch(() => {})

    const microphone = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
      : Promise.reject(new Error('getUserMedia is unavailable'))
    void microphone.then(
      () => mark('microphone'),
      () => {}
    )
    /** A microphone that opens after the chat gave up is closed straight away. */
    const release = () =>
      void microphone.then(
        (stream) => stream.getTracks().forEach((t) => t.stop()),
        () => {}
      )

    let peer = null
    let slot = null
    try {
      peer = new RTCPeerConnection()
      current.peer = peer
      current.audio.autoplay = true
      peer.addEventListener('track', (event) => {
        current.audio.srcObject = new MediaStream([event.track])
        void current.audio.play().catch(() => {})
      })
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'connected') mark('connected')
        if (call !== current) return
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')
          end('connection', 'The connection to OpenAI dropped.')
      })
      // Both before the offer, so the offer carries them.
      slot = peer.addTransceiver('audio', { direction: 'sendrecv' })
      const channel = peer.createDataChannel('oai-events')
      current.channel = channel
      channel.addEventListener('open', () => mark('channel'))
      channel.addEventListener('message', (message) => {
        let event = null
        try {
          event = JSON.parse(message.data)
        } catch {
          return
        }
        if (event?.type === 'session.started') {
          mark('started')
          hooks.log({ check: 'voice-chat', event: 'ready', ...current.timings })
        }
        onEvent(current, event)
      })
      await peer.setLocalDescription(await peer.createOffer())
      mark('offer')
      await iceGathered(peer, ICE_MS)
      mark('candidates')
    } catch (error) {
      release()
      if (call === current)
        end(
          'connect',
          typeof RTCPeerConnection === 'undefined' ? microphoneProblem(error) : String(error?.message ?? error)
        )
      else hangUp(current)
      return
    }

    try {
      current.microphone = await microphone
    } catch (error) {
      if (call === current) end('microphone', microphoneProblem(error))
      else hangUp(current)
      return
    }
    if (call !== current) return hangUp(current)

    try {
      const [track] = current.microphone.getAudioTracks()
      await slot.sender.replaceTrack(track ?? null)
      const answer = await hooks.connect(peer.localDescription?.sdp ?? '', screen.text, context)
      mark('answer')
      if (call !== current) return hangUp(current)
      await peer.setRemoteDescription({ type: 'answer', sdp: answer })
    } catch (error) {
      if (call === current) end('connect', String(error?.message ?? error))
      else hangUp(current)
      return
    }

    current.watch = setInterval(() => {
      if (call !== current) return
      const now = Date.now()
      if (now - current.startedAt >= MAX_MS) end('time')
      else if (now - current.lastActivity >= QUIET_MS) end('quiet')
    }, 1000)
  }

  return {
    get active() {
      return call !== null
    },
    /**
     * Start a chat about `screen` (`{text, boxes, target}`: the map and legend from
     * `describeScreen`, or just the line's text), with the lines read before as `context`; or end
     * the one going.
     */
    toggle(screen, context) {
      if (call) return end('shortcut')
      return start(screen, context)
    },
    /**
     * The pointer moved (overlay coordinates, or null when it is off the game). Once it has rested
     * on another word for `POINTER_SETTLE_MS`, the model is told quietly (`session.thinking.append`:
     * context, not something to answer), so "what's this?" means what it is on.
     */
    pointer(point) {
      const current = call
      if (!current?.started || !current.boxes.length) return
      const target = pointerTarget(current.boxes, point, current.area)
      const key = pointerKey(target)
      clearTimeout(current.pointerTimer)
      if (key === current.pointerSaid) return
      current.pointerTimer = setTimeout(() => {
        if (call !== current) return
        const content = `Context only, not a question; don't reply to it.\n${describePointer(target)}`
        if (send(current, { type: 'session.thinking.append', delegation_id: null, content })) current.pointerSaid = key
      }, POINTER_SETTLE_MS)
    },
    /** Say why there is nothing to start, briefly. */
    notice(text) {
      if (call) return
      hint.textContent = ''
      you.textContent = ''
      reply.textContent = ''
      show('error', text)
      hideAfter(ERROR_MS)
    },
    end: () => end('closed'),
    element: card
  }
}
