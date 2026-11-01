/**
 * Inline: select a passage in a reply, right-click, and type a question. The
 * passage becomes a link (grey while the answer is on its way, accent when
 * it's ready). Hover a link and its answer opens in a card at the link, the
 * way Obsidian's page preview does; links inside a card open their own cards.
 * Clicking a link, or pressing inside its card, keeps the card open.
 *
 * Each question is a real turn of the main conversation: it is sent with
 * `prompt.submit` and `display_kind: 'hidden'`, so the agent keeps it (and its
 * answer) in context for everything after. Only the display differs: the
 * hidden user row never renders, and this plugin hides the reply bubble and
 * shows the answer at the passage instead.
 *
 * Links are drawn with the CSS Custom Highlight API, so the transcript DOM is
 * never modified. Cards reuse the app's menu surface classes.
 */
import { COMPOSER_AREAS, host, Streamdown, atom, useValue } from '@hermes/plugin-sdk'
import { useEffect } from 'react'
import { jsx } from 'react/jsx-runtime'

const THREAD = '[data-slot="aui_thread-content"]'
const PAGE_ATTR = 'data-hm-page'
const OWN_MENU_ATTR = 'data-hermes-context-menu-trigger'
const CONTEXT_CHARS = 40
const TURN_TIMEOUT_MS = 10 * 60 * 1000
const HOVER_OPEN_MS = 300
const HOVER_SWITCH_MS = 100
const HOVER_CLOSE_MS = 300
const ANSWER_CLASS = 'preview-markdown text-sm text-foreground'
const ASK_HINTS = ['Dig into this…', 'Pull on this thread…', 'What about this?', 'Go deeper…']
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, div'
const PAIRS = { '(': ')', '[': ']', '{': '}', '“': '”', '‘': '’', '"': '"' }
const CLOSERS = Object.fromEntries(Object.entries(PAIRS).map(([open, close]) => [close, open]))

// The app's floating-list surface (src/components/ui/menu.ts), so popovers
// read like its own menus.
const SURFACE =
  'rounded-lg border border-(--ui-stroke-secondary) bg-[color-mix(in_srgb,var(--ui-bg-elevated)_96%,transparent)] text-popover-foreground shadow-md backdrop-blur-md'

const CSS_TEXT = `
/* Wikipedia-style links: blue text, underline on hover. */
::highlight(hm-link) { color: var(--ui-accent); }
::highlight(hm-current) {
  color: var(--ui-accent);
  background-color: color-mix(in srgb, var(--ui-accent) 12%, transparent);
}
::highlight(hm-pending) {
  color: var(--ui-text-tertiary);
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-thickness: 1px;
  text-decoration-color: var(--ui-text-tertiary);
}
::highlight(hm-hover) {
  color: var(--ui-accent);
  text-decoration-line: underline;
  text-decoration-thickness: 1px;
  text-decoration-color: var(--ui-accent);
}
::highlight(hm-draft) { background-color: color-mix(in srgb, var(--ui-accent) 18%, transparent); }
/* A link whose answer just arrived glows once; --hm-ready-a is driven from JS. */
::highlight(hm-ready) { background-color: color-mix(in srgb, var(--ui-accent) var(--hm-ready-a, 0%), transparent); }
.hm-hover, .hm-hover * { cursor: pointer !important; }
.hm-layer { position: fixed; inset: 0; pointer-events: none; z-index: 60; }
.hm-pop { position: fixed; pointer-events: auto; box-sizing: border-box;
  font-size: var(--conversation-text-font-size, 13px); }
/* Appear like the app's own popovers: a short fade with a slight scale. */
.hm-card, .hm-ask { animation: hm-pop-in 140ms ease-out; transform-origin: top left; }
@keyframes hm-pop-in { from { opacity: 0; transform: translateY(-2px) scale(0.98); } }
@media (prefers-reduced-motion: reduce) { .hm-card, .hm-ask { animation: none; } }
.hm-card { width: 440px; display: flex; flex-direction: column; padding: 10px 0 4px; }
/* Same shape as the app's activity rows ("Searched …"): codicon + muted text. */
.hm-card-question { display: flex; align-items: center; gap: 6px; padding: 0 14px 8px; font-size: 0.8125rem; line-height: 1.4;
  color: var(--ui-text-tertiary); }
.hm-card-question .codicon { flex: none; font-size: 14px; }
.hm-card-question-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-card-body { max-height: min(50vh, 420px); overflow-y: auto; padding: 0 14px; scrollbar-width: thin; }
.hm-card-body .hm-plain { white-space: pre-wrap; }
/* List markers sit outside the text; keep them inside the card. */
.hm-card-body ul, .hm-card-body ol { padding-inline-start: 1.15em; }
.hm-card-wait { height: 2px; margin: 10px 0 12px; border-radius: 1px;
  background: linear-gradient(90deg, transparent, var(--ui-accent), transparent) no-repeat;
  background-size: 40% 100%; animation: hm-wait 1.1s ease-in-out infinite; }
@keyframes hm-wait { from { background-position: -60% 0; } to { background-position: 160% 0; } }
.hm-card-error { padding: 2px 0 6px; font-size: 12px; color: var(--ui-text-tertiary); }
.hm-card-actions { display: flex; gap: 12px; padding: 4px 14px 2px; }
.hm-card-actions:empty { display: none; }
.hm-card-action { all: unset; cursor: pointer; font-size: 11px; line-height: 20px; color: var(--ui-text-tertiary); }
.hm-card-action:hover { color: var(--ui-text-secondary); }
.hm-src { position: absolute; left: -10000px; top: 0; width: 412px; visibility: hidden; pointer-events: none; }
.hm-ask { width: 340px; padding: 7px 10px 6px; }
.hm-ask-field { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 20px; max-height: 120px;
  overflow-y: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.5; color: var(--ui-text-primary); }
.hm-ask-field:empty::before { content: attr(data-placeholder); color: var(--ui-text-tertiary); }
.hm-ask-hint { margin-top: 2px; font-size: 11px; color: var(--ui-text-tertiary); }
`

// ---------- text index: whitespace-collapsed text ↔ DOM positions ----------

function buildIndex(root) {
  const chars = []
  const posNode = []
  const posOff = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n =>
      n.parentElement && !n.parentElement.closest('[data-hm-hidden], style, script')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
  })
  let prevSpace = true
  let prevNode = null
  let prevBlock = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const s = node.data
    const block = node.parentElement.closest(BLOCKS)

    // Adjacent blocks (list items, paragraphs) have no space in the DOM.
    if (prevNode && block !== prevBlock && !prevSpace) {
      chars.push(' ')
      posNode.push(prevNode)
      posOff.push(prevNode.data.length)
      prevSpace = true
    }
    prevNode = node
    prevBlock = block

    for (let i = 0; i < s.length; i++) {
      const space = /\s/.test(s[i])

      if (space && prevSpace) continue
      chars.push(space ? ' ' : s[i])
      posNode.push(node)
      posOff.push(i)
      prevSpace = space
    }
  }

  return { text: chars.join(''), posNode, posOff }
}

/** First index whose character sits at or after a DOM boundary point. */
function indexAt(idx, container, offset) {
  const probe = document.createRange()

  probe.setStart(container, offset)
  probe.collapse(true)
  let lo = 0
  let hi = idx.posNode.length

  while (lo < hi) {
    const mid = (lo + hi) >> 1

    if (probe.comparePoint(idx.posNode[mid], idx.posOff[mid]) < 0) lo = mid + 1
    else hi = mid
  }

  return lo
}

function rangeFor(idx, start, end) {
  const r = document.createRange()

  const last = idx.posNode[end - 1]

  r.setStart(idx.posNode[start], idx.posOff[start])
  // The space added between blocks sits just past its node's last character.
  r.setEnd(last, Math.min(idx.posOff[end - 1] + 1, last.length))

  return r
}

function sharedSuffix(a, b) {
  let n = 0

  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++

  return n
}

function sharedPrefix(a, b) {
  let n = 0

  while (n < a.length && n < b.length && a[n] === b[n]) n++

  return n
}

/** Where the anchor's text sits in the index; prefix/suffix pick between repeats. */
function locate(idx, anchor) {
  if (!anchor?.exact) return null
  let best = null
  let bestScore = -1

  for (let at = idx.text.indexOf(anchor.exact); at >= 0; at = idx.text.indexOf(anchor.exact, at + 1)) {
    const end = at + anchor.exact.length
    const score =
      sharedSuffix(idx.text.slice(Math.max(0, at - CONTEXT_CHARS), at), anchor.prefix) +
      sharedPrefix(idx.text.slice(end, end + CONTEXT_CHARS), anchor.suffix)

    if (score > bestScore) {
      best = [at, end]
      bestScore = score
    }
  }

  return best && rangeFor(idx, best[0], best[1])
}

/** The text at [s, t) with enough context around it to find it again later. */
function anchorFor(idx, s, t) {
  return {
    exact: idx.text.slice(s, t),
    prefix: idx.text.slice(Math.max(0, s - CONTEXT_CHARS), s),
    suffix: idx.text.slice(t, t + CONTEXT_CHARS)
  }
}

function rectHit(range, x, y) {
  for (const r of range.getClientRects()) {
    if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return true
  }

  return false
}

/** Place a popover under (or above) a rect, inside the window. */
function place(pop, rect) {
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 8)
  let top = rect.bottom + 6

  if (top + h > window.innerHeight - 8) top = rect.top - h - 6
  pop.style.left = `${left}px`
  pop.style.top = `${Math.max(8, top)}px`
}

/** First few sentences of an answer, as plain text; its start identifies the reply bubble. */
function extract(markdownText) {
  const plain = String(markdownText || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

  if (plain.length <= 320) return plain
  const cut = plain.slice(0, 320)
  const stop = cut.lastIndexOf('. ')

  return stop > 160 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`
}

/** Letters and digits only (any script), so rendered Markdown and its source compare equal. */
function textKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Letters and digits; `.`/`,` inside a number and `'` inside a word too. */
function wordAt(text, i) {
  const c = text[i]

  if (!c) return false
  if (/[\p{L}\p{N}_]/u.test(c)) return true
  if (c === '.' || c === ',') return /\p{N}/u.test(text[i - 1] ?? '') && /\p{N}/u.test(text[i + 1] ?? '')
  if (c === "'" || c === '’') return /\p{L}/u.test(text[i - 1] ?? '') && /\p{L}/u.test(text[i + 1] ?? '')

  return false
}

/**
 * Tidy a selection's ends: grow partial words to whole ones; drop spaces,
 * trailing punctuation and a bracket or quote whose partner isn't selected.
 */
function snapSpan(text, s, t) {
  while (s < t) {
    const before = s + ':' + t

    while (s > 0 && wordAt(text, s - 1) && wordAt(text, s)) s--
    while (t < text.length && wordAt(text, t - 1) && wordAt(text, t)) t++
    while (s < t && /[\s.,;:…–—-]/.test(text[s]) && !wordAt(text, s)) s++
    while (t > s && /[\s.,;:…–—-]/.test(text[t - 1]) && !wordAt(text, t - 1)) t--
    if (PAIRS[text[s]] && !text.slice(s + 1, t).includes(PAIRS[text[s]])) s++
    if (t > s && CLOSERS[text[t - 1]] && !text.slice(s, t - 1).includes(CLOSERS[text[t - 1]])) t--
    if (before === s + ':' + t) break
  }

  return [s, t]
}

/** Roots on screen: the app keeps chats you switched away from mounted in
 *  hidden panes, and a link must never land in one of those. */
const shownRoots = selector =>
  [...document.querySelectorAll(selector)].filter(el => !el.closest('[inert], [aria-hidden="true"], [data-pane-hidden]'))

// ---------- the plugin ----------

export default {
  id: 'inline',
  name: 'Inline',
  description: 'Select text in a reply, right-click and ask about it: the answer becomes a link on the passage.',

  register(ctx) {
    const state = host.state
    let notes = ctx.storage.get('notes', [])
    // One link turn runs at a time, and only while its chat is idle: sent
    // mid-turn, Hermes would queue it and could merge it with a message the
    // user queued.
    const queue = [] // { note, turn, sid }
    let active = null // { note, turn, sid, responded, admission, userRow, starts, started, root, before, last }
    const busy = sid => Boolean(state.busyBySession.get()[sid])
    const $render = atom([]) // note ids the hidden renderer should draw
    const htmlCache = new Map() // note id -> { answer, html }
    let anchored = [] // { note, range }
    let ask = null // { pop, range }
    let hovered = null
    // Cards open at their links, deepest last: cards[d] answers a link that
    // sits in the chat (d = 0) or in cards[d - 1].
    const cards = [] // { note, range, pop, body, actions, pinned }
    let lastFocus = { stored: null, runtime: null }
    let threadCache = new WeakMap() // thread root -> text index, until the DOM changes

    // Questions asked before a restart will never be answered.
    for (const note of notes) {
      note.parentId ??= null
      for (const turn of note.turns) {
        if (turn.status === 'pending') {
          Object.assign(turn, { status: 'error', answer: 'No answer arrived (the app restarted while waiting).' })
        }
      }
    }

    const byId = id => notes.find(n => n.id === id)
    const rootOf = note => (note.parentId ? rootOf(byId(note.parentId) ?? { ...note, parentId: null }) : note)
    const save = () => ctx.storage.set('notes', notes)

    const style = document.createElement('style')
    const layer = document.createElement('div')

    style.textContent = CSS_TEXT
    layer.className = 'hm-layer'
    document.head.append(style)
    document.body.append(layer)

    const HL = ['hm-link', 'hm-current', 'hm-pending', 'hm-hover', 'hm-draft', 'hm-ready']
    const hl = Object.fromEntries(HL.map(name => [name, new Highlight()]))

    hl['hm-hover'].priority = 1
    for (const name of HL) CSS.highlights.set(name, hl[name])

    // ----- which chat is on screen -----

    function trackFocus() {
      const stored = state.focusedStoredSessionId.get()
      const runtime = state.focusedSessionId.get()

      if (runtime) lastFocus = { stored: stored || null, runtime }
    }

    trackFocus()

    function inChat(note) {
      if (note.parentId) return false
      if (note.storedSessionId) return note.storedSessionId === lastFocus.stored
      if (note.sessionId === lastFocus.runtime && lastFocus.stored) note.storedSessionId = lastFocus.stored

      return note.sessionId === lastFocus.runtime
    }

    /** Live runtime session to ask through: the chat a note's tree hangs off. */
    function sessionFor(note) {
      const root = rootOf(note)

      return root.storedSessionId && root.storedSessionId === lastFocus.stored ? lastFocus.runtime : root.sessionId
    }

    // ----- painting links + hiding the reply bubbles of our turns -----

    /** The thread on screen for a runtime session: only when it is the one chat shown. */
    function threadFor(sid) {
      if (sid !== lastFocus.runtime) return null
      const roots = shownRoots(THREAD)

      return roots.length === 1 ? roots[0] : null
    }

    function hideBubble(el) {
      el.dataset.hmHidden = ''
      el.style.display = 'none'
    }

    /**
     * While our turn streams, every assistant bubble that appears in its
     * thread after the last one present at its start is ours. Once answered
     * (and after a reload) a bubble is ours when its text contains the start
     * of one of this chat's answers.
     */
    function hideLiveReply() {
      const run = active?.started && active.root?.isConnected ? active : null

      if (!run || run.root !== threadFor(run.sid) || (run.last && !run.last.isConnected)) return
      for (const el of run.root.querySelectorAll('[data-role="assistant"]:not([data-hm-hidden])')) {
        if (!run.before.has(el) && (!run.last || run.last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          hideBubble(el)
        }
      }
    }

    function hideOwnReplies() {
      hideLiveReply()
      const keys = []

      for (const note of notes) {
        if (!inChat(rootOf(note))) continue
        for (const turn of note.turns) if (turn.status === 'done' && turn.key?.length >= 20) keys.push(turn.key)
      }
      if (!keys.length) return
      for (const root of shownRoots(THREAD)) {
        for (const el of root.querySelectorAll('[data-role="assistant"]:not([data-hm-hidden])')) {
          const text = textKey(el.textContent)

          if (keys.some(key => text.includes(key))) hideBubble(el)
        }
      }
    }

    function threadIndex(root) {
      let idx = threadCache.get(root)

      if (!idx) {
        idx = buildIndex(root)
        threadCache.set(root, idx)
      }

      return idx
    }

    function paint() {
      hideOwnReplies()
      threadCache = new WeakMap()
      anchored = []
      const chatNotes = notes.filter(inChat)

      if (chatNotes.length) {
        for (const root of shownRoots(THREAD)) {
          const idx = threadIndex(root)

          for (const note of chatNotes) {
            if (anchored.some(a => a.note === note)) continue
            const range = locate(idx, note.anchor)

            if (range) anchored.push({ note, range })
          }
        }
      }
      // Each answer on screen (in a card) is its own root; a child link lives in one.
      for (const root of shownRoots(`[${PAGE_ATTR}]`)) {
        const children = notes.filter(n => n.parentId === root.getAttribute(PAGE_ATTR))

        if (!children.length) continue
        const idx = buildIndex(root)

        for (const note of children) {
          const range = locate(idx, note.anchor)

          if (range) anchored.push({ note, range })
        }
      }
      for (const name of ['hm-link', 'hm-current', 'hm-pending']) hl[name].clear()
      const open = new Set(cards.map(c => c.note))

      for (const { note, range } of anchored) {
        const pending = note.turns[0]?.status !== 'done'

        hl[pending ? 'hm-pending' : open.has(note) ? 'hm-current' : 'hm-link'].add(range)
      }
      hl['hm-ready'].clear()
      for (const { note, range } of anchored) if (readyIds.has(note.id)) hl['hm-ready'].add(range)
      hovered = (hovered && anchored.find(a => a.note === hovered.note)) || null
      setHover(hovered)
    }

    // The "it's ready" glow: in quickly, out slowly, once.
    const readyIds = new Set()
    let readyFrame = 0

    function flashReady(id) {
      readyIds.add(id)
      paint()
      const start = performance.now()

      cancelAnimationFrame(readyFrame)
      const step = now => {
        const t = (now - start) / 1600
        const a = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85)

        document.documentElement.style.setProperty('--hm-ready-a', `${Math.round(a * 30)}%`)
        if (t < 1) readyFrame = requestAnimationFrame(step)
        else {
          readyIds.clear()
          document.documentElement.style.removeProperty('--hm-ready-a')
          paint()
        }
      }

      readyFrame = requestAnimationFrame(step)
    }

    ctx.onDispose(() => {
      cancelAnimationFrame(readyFrame)
      document.documentElement.style.removeProperty('--hm-ready-a')
    })

    let paintTimer = null
    const schedulePaint = () => {
      if (paintTimer) return
      paintTimer = setTimeout(() => {
        paintTimer = null
        paint()
      }, 150)
    }

    const observer = new MutationObserver(records => {
      if (records.every(r => layer.contains(r.target))) return
      // Before the frame is drawn, so our reply never shows in the chat.
      if (active?.started) hideLiveReply()
      threadCache = new WeakMap()
      schedulePaint()
    })

    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    // ----- asking -----

    // What the model reads: an ordinary quote-reply. The user never sees it
    // (the row is hidden).
    function compose(note, turn) {
      return `${note.quote.replace(/^/gm, '> ')}\n\n${turn.question}`
    }

    function settle(turn, fields) {
      Object.assign(turn, fields)
      save()
      paint()
      for (const card of cards) if (card.note.turns.includes(turn)) fillCard(card)
    }

    function finish(run, payload) {
      const answer = String(payload?.text || payload?.rendered || '').trim()
      const status = payload?.status

      // A provider error or a press of Stop: no answer, so no link; Retry asks again.
      if (status && status !== 'complete') {
        settle(run.turn, { status: 'error', answer: status === 'interrupted' ? 'Stopped before it finished.' : answer || `The agent stopped (${status}).` })

        return
      }
      if (!answer) {
        settle(run.turn, { status: 'error', answer: 'The agent returned no text.' })

        return
      }
      requestRender(run.note, answer)
      settle(run.turn, { status: 'done', answer, key: textKey(extract(answer)).slice(0, 60) })
      flashReady(run.note.id)
    }

    function release(run) {
      if (active !== run) return
      active = null
      void pump()
    }

    async function pump() {
      if (active) return
      const next = queue.findIndex(q => !busy(q.sid))

      if (next < 0) return
      const run = { ...queue.splice(next, 1)[0], responded: false, admission: null, userRow: null, starts: [], started: false }

      active = run
      ctx.setTimeout(() => {
        if (active !== run) return
        settle(run.turn, { status: 'error', answer: 'No answer after 10 minutes.' })
        release(run)
      }, TURN_TIMEOUT_MS)
      try {
        const res = await host.request('prompt.submit', {
          session_id: run.sid,
          text: compose(run.note, run.turn),
          display_kind: 'hidden',
          // If a turn started meanwhile, wait behind it rather than steer it.
          queued: true
        })

        if (active !== run) return
        // How we know our turn: a gateway that owns the chat answers with an
        // admission id its stream events repeat; an idle chat starts the turn
        // at once ('streaming') and names its stored question row.
        Object.assign(run, {
          responded: true,
          admission: res?.admission_id || null,
          userRow: typeof res?.user_row_id === 'number' ? res.user_row_id : null
        })
        if (!run.admission && res?.status !== 'streaming') {
          // Queued with nothing to follow it by: never guess which reply is ours.
          settle(run.turn, { status: 'error', answer: 'Hermes was busy, so the question waited in its queue; its answer shows in the chat.' })
          release(run)

          return
        }
        const seen = run.admission ? run.starts.find(start => start.id === run.admission) : run.starts.at(-1)

        if (seen) adopt(run, seen)
      } catch (err) {
        if (active !== run) return
        settle(run.turn, { status: 'error', answer: String(err?.message || err) })
        release(run)
      }
    }

    const adopt = (run, start) => Object.assign(run, { started: true, root: start.root, before: start.before, last: start.last })

    // A chat going idle is the moment to ask its waiting questions.
    ctx.onDispose(state.busyBySession.listen(() => void pump()))

    function send(note, turn) {
      const sid = sessionFor(note)

      if (!sid) {
        settle(turn, { status: 'error', answer: 'Open the chat this came from to ask.' })

        return
      }
      settle(turn, { status: 'pending', at: Date.now(), answer: undefined, key: undefined })
      queue.push({ note, turn, sid })
      void pump()
    }

    const admissionOf = event => event?.admission_id ?? event?.payload?.admission_id ?? null

    ctx.onEvent('message.start', event => {
      const run = active

      if (!run || run.sid !== event?.session_id || run.started) return
      // Bubbles present when the turn starts are not ours; only in its own
      // thread, and only when that chat is on screen.
      const root = threadFor(run.sid)
      const before = root ? [...root.querySelectorAll('[data-role="assistant"]')] : []
      const start = { id: admissionOf(event), root, before: new Set(before), last: before.at(-1) ?? null }

      // Before the submit reply we can't tell whose turn this is yet.
      if (!run.responded) run.starts.push(start)
      else if (run.admission ? start.id === run.admission : true) adopt(run, start)
    })

    ctx.onEvent('message.complete', event => {
      const run = active

      if (!run?.responded || run.sid !== event?.session_id) return
      const row = event.payload?.persisted_turn?.user_row_id
      const ours = run.admission
        ? admissionOf(event) === run.admission
        : run.started && (run.userRow === null || typeof row !== 'number' || row === run.userRow)

      if (!ours) return
      // Hide the finished bubble before clearing `active`, which tracks it.
      hideOwnReplies()
      finish(run, event.payload)
      release(run)
    })

    // ----- rendering answers -----

    // The answer is drawn by the app's own Markdown renderer, out of sight in
    // a composer slot, and its HTML copied into the card: same typography as
    // a chat message, without a React root of our own.
    function Renderer() {
      const ids = useValue($render)

      useEffect(() => {
        if (!ids.length) return
        const harvest = () => {
          for (const id of ids) {
            const el = document.querySelector(`[data-hm-src="${id}"]`)
            const answer = byId(id)?.turns[0]?.answer

            if (!el || !answer || !el.childElementCount) continue
            htmlCache.set(id, { answer, html: el.innerHTML })
            // The rendered text is what the reply bubble shows (code included):
            // the surest key for finding that bubble again after a reload.
            const turn = byId(id).turns[0]
            const key = textKey(el.textContent).slice(0, 60)

            if (turn.status === 'done' && key.length >= 20 && turn.key !== key) {
              turn.key = key
              save()
            }
            for (const card of cards) if (card.note.id === id) fillCard(card)
          }
        }

        harvest()
        // Highlighted code arrives a moment later; take it too, then let go.
        // (ctx.setTimeout returns its own cancel function: the effect's cleanup.)
        return ctx.setTimeout(() => {
          harvest()
          $render.set($render.get().filter(id => !ids.includes(id)))
        }, 400)
      }, [ids])

      return jsx('div', {
        className: 'hm-src',
        'aria-hidden': 'true',
        children: ids.map(id => {
          const answer = byId(id)?.turns[0]?.answer

          return answer
            ? jsx(
                'div',
                {
                  className: ANSWER_CLASS,
                  'data-hm-src': id,
                  children: jsx(Streamdown, { controls: false, mode: 'static', parseIncompleteMarkdown: false, children: answer })
                },
                id
              )
            : null
        })
      })
    }

    ctx.register({ id: 'renderer', area: COMPOSER_AREAS.underside, render: () => jsx(Renderer, {}) })

    function cachedHtml(note) {
      const hit = htmlCache.get(note.id)

      return hit && hit.answer === note.turns[0]?.answer ? hit.html : null
    }

    function requestRender(note, answer = note.turns[0]?.answer) {
      if (!answer || cachedHtml(note) !== null || $render.get().includes(note.id)) return
      $render.set([...$render.get(), note.id])
    }

    // ----- cards: the answer, at its link -----

    function element(tag, className, text) {
      const el = document.createElement(tag)

      el.className = className
      if (text !== undefined) el.textContent = text

      return el
    }

    function action(label, run) {
      const button = element('button', 'hm-card-action', label)

      button.type = 'button'
      button.addEventListener('click', e => {
        e.stopPropagation()
        run()
      })

      return button
    }

    function fillCard(card) {
      const { note, body, actions } = card
      const turn = note.turns[0]

      body.replaceChildren()
      actions.replaceChildren()
      if (!turn || turn.status === 'pending') {
        body.append(element('div', 'hm-card-wait'))
      } else if (turn.status === 'error') {
        body.append(element('div', 'hm-card-error', `No answer: ${turn.answer}`))
        actions.append(action('Retry', () => send(note, turn)))
      } else {
        const content = element('div', ANSWER_CLASS)
        const html = cachedHtml(note)

        content.setAttribute(PAGE_ATTR, note.id)
        content.dataset.selectableText = 'true'
        if (html !== null) content.innerHTML = html
        else {
          // Plain text until the rendered version is ready (a frame or two).
          content.classList.add('hm-plain')
          content.textContent = turn.answer
          requestRender(note)
        }
        body.append(content)
      }
      if (card.pop.isConnected) {
        place(card.pop, card.range.getBoundingClientRect())
        paint()
      }
    }

    function closeCards(from = 0) {
      if (cards.length <= from) return
      for (const card of cards.splice(from)) card.pop.remove()
      paint()
    }

    function openCard(depth, hit) {
      closeCards(depth)
      const pop = element('div', `hm-pop hm-card ${SURFACE}`)
      const body = element('div', 'hm-card-body')
      const actions = element('div', 'hm-card-actions')
      const card = { note: hit.note, range: hit.range, pop, body, actions, pinned: false }

      // The answer is the card; the question is the angle it was seen from,
      // so it sits above it as a quiet label rather than a heading.
      const question = element('div', 'hm-card-question')
      const questionText = element('span', 'hm-card-question-text', hit.note.turns[0]?.question ?? '')

      question.title = hit.note.turns[0]?.question ?? ''
      question.append(element('span', 'codicon codicon-comment'), questionText)
      pop.append(question, body, actions)
      cards.push(card)
      layer.append(pop)
      fillCard(card)
      place(pop, hit.range.getBoundingClientRect())
      paint()

      return card
    }

    /** 0 for a link in the chat, d + 1 for a link inside cards[d]. */
    function depthOf(hit) {
      const node = hit.range.startContainer

      return cards.findIndex(c => c.body.contains(node)) + 1
    }

    function reposition() {
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].range.getBoundingClientRect()

        // Its link scrolled away: the card goes with it.
        if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) {
          closeCards(i)
          break
        }
        place(cards[i].pop, rect)
      }
      if (ask) place(ask.pop, ask.range.getBoundingClientRect())
    }

    // ----- hover: open after a pause, close after leaving -----

    let openTimer = null
    let openFor = null
    let closeTimer = null
    let closeTo = -1

    function cancelOpen() {
      if (openTimer) clearTimeout(openTimer)
      openTimer = null
      openFor = null
    }

    function scheduleOpen(depth, hit) {
      if (openFor === hit.note) return
      cancelOpen()
      if (hit.note.turns[0]?.status === 'done') requestRender(hit.note)
      openFor = hit.note
      // Quicker once a card is up: moving between links is browsing.
      openTimer = setTimeout(
        () => {
          openTimer = null
          openFor = null
          openCard(depth, hit)
        },
        cards.length ? HOVER_SWITCH_MS : HOVER_OPEN_MS
      )
    }

    function cancelClose() {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = null
      closeTo = -1
    }

    function scheduleClose(keep) {
      if (closeTimer && closeTo === keep) return
      cancelClose()
      closeTo = keep
      closeTimer = setTimeout(() => {
        closeTimer = null
        closeTo = -1
        closeCards(keep)
      }, HOVER_CLOSE_MS)
    }

    function hitAt(x, y) {
      let best = null

      // Nested links: the innermost (shortest) one wins.
      for (const a of anchored) {
        if (rectHit(a.range, x, y) && (!best || a.range.toString().length < best.range.toString().length)) best = a
      }

      return best
    }

    function setHover(hit) {
      hl['hm-hover'].clear()
      if (hit) hl['hm-hover'].add(hit.range)
      document.documentElement.classList.toggle('hm-hover', Boolean(hit))
    }

    function pointer(x, y, target) {
      if (ask) return
      const hit = hitAt(x, y)
      const inCard = cards.findLastIndex(c => c.pop.contains(target))
      let keep = inCard + 1

      if (hit?.note !== hovered?.note) {
        hovered = hit
        setHover(hit)
      }
      if (hit) {
        const depth = depthOf(hit)

        if (cards[depth]?.note === hit.note) keep = Math.max(keep, depth + 1)
        else {
          keep = Math.max(keep, depth)
          scheduleOpen(depth, hit)
        }
      } else cancelOpen()
      keep = Math.max(keep, cards.findLastIndex(c => c.pinned) + 1)
      if (cards.length > keep) scheduleClose(keep)
      else cancelClose()
    }

    let moveFrame = 0

    ctx.addEventListener(document, 'mousemove', e => {
      if (moveFrame) return
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0
        pointer(e.clientX, e.clientY, e.target)
      })
    })

    // Pressing inside a card keeps it (and the cards under it) open, so text
    // in it can be selected; pressing anywhere else closes them all.
    ctx.addEventListener(
      document,
      'mousedown',
      e => {
        if (ask?.pop.contains(e.target)) return
        closeAsk()
        // A press on a link is a click on it; the click handler decides.
        if (e.button === 0 && hitAt(e.clientX, e.clientY)) return
        const inCard = cards.findLastIndex(c => c.pop.contains(e.target))

        if (inCard >= 0) {
          for (const card of cards.slice(0, inCard + 1)) card.pinned = true
          closeCards(inCard + 1)
          cancelClose()

          return
        }
        cancelOpen()
        closeCards(0)
      },
      true
    )

    // Clicking a link opens its card at once and keeps it open.
    ctx.addEventListener(
      document,
      'click',
      e => {
        if (e.button !== 0 || e.target.closest?.('.hm-card-action')) return
        const sel = window.getSelection()

        if (sel && !sel.isCollapsed) return
        const hit = hitAt(e.clientX, e.clientY)

        if (!hit) return
        e.preventDefault()
        e.stopPropagation()
        cancelOpen()
        cancelClose()
        const depth = depthOf(hit)
        const card = cards[depth]?.note === hit.note ? cards[depth] : openCard(depth, hit)

        for (const c of cards.slice(0, depth + 1)) c.pinned = true
        card.pinned = true
      },
      true
    )

    ctx.addEventListener(
      document,
      'keydown',
      e => {
        if (e.key !== 'Escape' || ask || !cards.length) return
        e.preventDefault()
        e.stopPropagation()
        closeCards(cards.length - 1)
      },
      true
    )

    ctx.addEventListener(document, 'scroll', reposition, true)
    ctx.addEventListener(window, 'resize', reposition)

    // ----- ask box (right-click on a selection) -----

    function closeAsk() {
      if (!ask) return
      ask.pop.remove()
      hl['hm-draft'].clear()
      ask = null
    }

    function openAsk({ anchor, quote, range, parentId }) {
      closeAsk()
      cancelOpen()
      cancelClose()
      const pop = element('div', `hm-pop hm-ask ${SURFACE}`)
      const field = element('div', 'hm-ask-field')
      const hint = element('div', 'hm-ask-hint', '↵ send  ·  ⇧↵ new line  ·  esc')

      field.contentEditable = 'plaintext-only'
      // Rotating, like the app's own composer hints ("Push it further").
      field.dataset.placeholder = ASK_HINTS[Math.floor(Math.random() * ASK_HINTS.length)]
      field.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          closeAsk()
        } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          const question = field.innerText.trim()

          if (!question) return
          const parent = parentId && byId(parentId)

          if (!parent && !lastFocus.runtime) {
            host.notify({ kind: 'error', message: 'No live session for this chat.' })

            return
          }
          const note = {
            id: Math.random().toString(36).slice(2, 10),
            parentId: parent ? parent.id : null,
            sessionId: parent ? null : lastFocus.runtime,
            storedSessionId: parent ? null : lastFocus.stored,
            anchor,
            quote,
            createdAt: Date.now(),
            turns: []
          }
          const turn = { question }

          notes.push(note)
          note.turns.push(turn)
          closeAsk()
          window.getSelection()?.removeAllRanges()
          send(note, turn)
        }
      })
      pop.append(field, hint)
      layer.append(pop)
      hl['hm-draft'].add(range)
      ask = { pop, range }
      place(pop, range.getBoundingClientRect())
      field.focus()
    }

    /** The selection under (x, y) inside the transcript or a card, if any. */
    function selectionAt(x, y) {
      const sel = window.getSelection()

      if (!sel || sel.isCollapsed || !sel.rangeCount) return null
      const range = sel.getRangeAt(0)
      const start = range.commonAncestorContainer
      const startEl = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement
      const root = startEl?.closest(`${THREAD}, [${PAGE_ATTR}]`)

      if (!root || startEl.closest('[contenteditable], textarea, input')) return null

      return rectHit(range, x, y) ? { sel, range, root } : null
    }

    // The app's window-level contextmenu handler opens its own menu (just
    // "Copy" for a selection) and stops the event before it reaches us. It
    // steps aside for elements marked as owning their menu, so mark the
    // element under the pointer on the right-button mousedown that precedes
    // contextmenu, and only when that press is on a selection we handle.
    let marked = null
    const unmark = () => {
      marked?.removeAttribute(OWN_MENU_ATTR)
      marked = null
    }

    ctx.addEventListener(
      window,
      'mousedown',
      e => {
        unmark()
        const secondary = e.button === 2 || (e.button === 0 && e.ctrlKey)

        if (!secondary || !(e.target instanceof Element) || e.target.hasAttribute(OWN_MENU_ATTR)) return
        if (!selectionAt(e.clientX, e.clientY)) return
        marked = e.target
        marked.setAttribute(OWN_MENU_ATTR, '')
        ctx.setTimeout(unmark, 1000)
      },
      true
    )
    ctx.onDispose(unmark)

    ctx.addEventListener(
      document,
      'contextmenu',
      e => {
        unmark()
        const hit = selectionAt(e.clientX, e.clientY)

        if (!hit) return
        const { sel, range, root } = hit
        const idx = buildIndex(root)
        const [s, t] = snapSpan(
          idx.text,
          indexAt(idx, range.startContainer, range.startOffset),
          indexAt(idx, range.endContainer, range.endOffset)
        )

        if (t <= s) return
        const snapped = rangeFor(idx, s, t)

        e.preventDefault()
        e.stopPropagation()
        sel.removeAllRanges()
        sel.addRange(snapped)
        // Read after re-selecting: the selection's text keeps line breaks.
        const quote = sel.toString().trim().replace(/\n{3,}/g, '\n\n')

        openAsk({ quote, range: snapped.cloneRange(), parentId: root.getAttribute(PAGE_ATTR), anchor: anchorFor(idx, s, t) })
      },
      true
    )

    for (const store of [state.focusedStoredSessionId, state.focusedSessionId]) {
      ctx.onDispose(
        store.listen(() => {
          const before = lastFocus.stored

          trackFocus()
          if (lastFocus.stored !== before) {
            closeAsk()
            closeCards(0)
          }
          schedulePaint()
        })
      )
    }

    ctx.onDispose(() => {
      observer.disconnect()
      if (paintTimer) clearTimeout(paintTimer)
      cancelOpen()
      cancelClose()
      if (moveFrame) cancelAnimationFrame(moveFrame)
      // Only ours: during a reload the next copy may have registered these names already.
      for (const name of HL) if (CSS.highlights.get(name) === hl[name]) CSS.highlights.delete(name)
      document.documentElement.classList.remove('hm-hover')
      layer.remove()
      style.remove()
    })

    paint()
  }
}
