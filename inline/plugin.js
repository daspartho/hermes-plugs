/**
 * Inline: select a passage in a reply, right-click, and write a prompt. The
 * passage becomes a link; hover it and the agent's answer opens in a card at
 * the passage, the way Obsidian's page preview does. Links inside a card open
 * their own cards.
 *
 * Inline only changes how the chat is shown. A prompt is sent through the
 * message box as an ordinary quote-reply ("> passage", a blank line, the
 * prompt), so the agent keeps it in context and anyone without Inline sees
 * the chat as it really is. Inline reads its links back from the chat: a
 * quote-reply whose passage appears in an earlier reply is a link, and the
 * reply under it is the link's answer. Inline hides that turn in its own view
 * and shows the answer at the passage instead, so links appear on any device
 * and in any chat that has them. The only thing stored is a hint that tells
 * repeats of the same passage apart.

 *
 * Links are drawn with the CSS Custom Highlight API; the transcript DOM is
 * never modified beyond an attribute on each turn it hides.
 */
import { host } from '@hermes/plugin-sdk'

const THREAD = '[data-slot="aui_thread-content"]'
const GROUP = '[data-slot="aui_message-group"]'
const USER_ROOT = '[data-role="user"]'
const USER_TEXT = '[data-slot="aui_user-message-text"]'
const THINKING = '[data-slot="aui_thinking-disclosure"]'
const STREAMING = '[data-message-streaming="true"]'
const ALERT = '[data-slot="aui_assistant-message-content"] [role="alert"]'
const STOPPED = '[data-slot="aui_assistant-message-stopped"]'
const ASSISTANT = '[data-role="assistant"]'
// A chat surface: one chat and its own message box (the primary, or a tile).
const SURFACE_ROOT = '[data-composer-target]'
const ATTACHMENTS = '[data-slot="composer-attachments"]'
const TURN_ATTR = 'data-hm-turn'
const PAGE_ATTR = 'data-hm-page'
const OWN_MENU_ATTR = 'data-hermes-context-menu-trigger'
const CONTEXT_CHARS = 40
const MAX_HINTS = 500
const SEND_TIMEOUT_MS = 20 * 1000
const HOVER_OPEN_MS = 300
const HOVER_SWITCH_MS = 100
const HOVER_CLOSE_MS = 300
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, div'
const PAIRS = { '(': ')', '[': ']', '{': '}', '“': '”', '‘': '’', '"': '"' }
const CLOSERS = Object.fromEntries(Object.entries(PAIRS).map(([open, close]) => [close, open]))

// The app's floating-list surface (src/components/ui/menu.ts), so popovers
// read like its own menus.
const SURFACE =
  'rounded-lg border border-(--ui-stroke-secondary) bg-[color-mix(in_srgb,var(--ui-bg-elevated)_96%,transparent)] text-popover-foreground shadow-md backdrop-blur-md'

const CSS_TEXT = `
[${TURN_ATTR}] { display: none !important; }
/* Like a commented passage in Google Docs: the words themselves are tinted,
   more strongly while their card is open. Accent blue, so it never reads as a
   selection (the app selects in yellow) or as a web link (blue text). */
::highlight(hm-link) { background-color: color-mix(in srgb, var(--ui-accent) 22%, transparent); }
::highlight(hm-wait) { background-color: color-mix(in srgb, var(--ui-text-tertiary) 22%, transparent); }
::highlight(hm-open), ::highlight(hm-hover) { background-color: color-mix(in srgb, var(--ui-accent) 34%, transparent); }
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
.hm-card-body .aui-md + .aui-md { margin-top: var(--paragraph-gap, 0.75em); }
.hm-card-wait { height: 2px; margin: 10px 0 12px; border-radius: 1px;
  background: linear-gradient(90deg, transparent, var(--ui-accent), transparent) no-repeat;
  background-size: 40% 100%; animation: hm-wait 1.1s ease-in-out infinite; }
@keyframes hm-wait { from { background-position: -60% 0; } to { background-position: 160% 0; } }
.hm-card-note { padding: 6px 0 4px; font-size: 12px; color: var(--ui-text-tertiary); }
.hm-card-actions { display: flex; gap: 12px; padding: 4px 14px 2px; }
.hm-card-actions:empty { display: none; }
.hm-card-action { all: unset; cursor: pointer; font-size: 11px; line-height: 20px; color: var(--ui-text-tertiary); }
.hm-card-action:hover { color: var(--ui-text-secondary); }
/* The prompt box is the card's label row being written: same icon, same place. */
.hm-ask { width: 340px; display: flex; align-items: flex-start; gap: 6px; padding: 7px 10px; }
.hm-ask .codicon { flex: none; font-size: 14px; line-height: 1.5; color: var(--ui-text-tertiary); }
.hm-ask-field { all: unset; box-sizing: border-box; display: block; flex: 1; min-width: 0; min-height: 20px; max-height: 120px;
  overflow-y: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.5; color: var(--ui-text-primary); }
`

// ---------- text index: whitespace-collapsed text ↔ DOM positions ----------

/**
 * The visible text under `roots`, whitespace collapsed, with the DOM position
 * of each character. `breaks` holds the spaces that stand for a line or block
 * break, so a quote can keep its paragraphs.
 */
function buildIndex(roots) {
  const chars = []
  const posNode = []
  const posOff = []
  const breaks = new Set()
  let prevSpace = true
  let prevNode = null
  let prevBlock = null

  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        n.parentElement && !n.parentElement.closest('style, script') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    })

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const s = node.data
      const block = node.parentElement.closest(BLOCKS)

      // Adjacent blocks (list items, paragraphs) have no space in the DOM.
      if (prevNode && block !== prevBlock && !prevSpace) {
        breaks.add(chars.length)
        chars.push(' ')
        posNode.push(prevNode)
        posOff.push(prevNode.data.length)
        prevSpace = true
      }
      prevNode = node
      prevBlock = block

      for (let i = 0; i < s.length; i++) {
        const space = /\s/.test(s[i])

        if (space && prevSpace) {
          if (s[i] === '\n' && chars.length) breaks.add(chars.length - 1)
          continue
        }
        if (s[i] === '\n') breaks.add(chars.length)
        chars.push(space ? ' ' : s[i])
        posNode.push(node)
        posOff.push(i)
        prevSpace = space
      }
    }
  }

  return { text: chars.join(''), posNode, posOff, breaks }
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

/**
 * The best place for `quote` among `indexes` (in order of preference): the
 * occurrence whose surroundings match the hint best; without a hint, the
 * first one in the first index that has it.
 */
function findQuote(indexes, quote, hint) {
  const prefix = hint?.prefix ?? ''
  const suffix = hint?.suffix ?? ''
  const perfect = prefix.length + suffix.length
  let best = null

  for (let i = 0; i < indexes.length; i++) {
    const { text } = indexes[i]()

    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
      const end = at + quote.length
      const score =
        sharedSuffix(text.slice(Math.max(0, at - CONTEXT_CHARS), at), prefix) +
        sharedPrefix(text.slice(end, end + CONTEXT_CHARS), suffix)

      if (!best || score > best.score) best = { i, at, end, score }
      if (score === perfect) return best
    }
  }

  return best
}

/** The text at [s, t) with line breaks restored, for the quote the agent reads. */
function quoteOf(idx, s, t) {
  let out = ''

  for (let i = s; i < t; i++) out += idx.breaks.has(i) ? '\n' : idx.text[i]

  return out
}

const collapse = text => String(text || '').replace(/\s+/g, ' ').trim()

/**
 * A user bubble's text as it was sent. Hermes draws `code` and ``` fences as
 * elements without their backticks; put them back, so a quote of code in a
 * reply still matches the reply.
 */
function sentText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  if (node.matches('pre')) return `\`\`\`\n${node.textContent}\`\`\``
  if (node.matches('code')) {
    const fence = node.textContent.includes('`') ? '``' : '`'

    return `${fence}${node.textContent}${fence}`
  }

  return [...node.childNodes].map(sentText).join('')
}

/** "> passage" lines, a blank line, then the prompt; anything else is null. */
function parseQuoteReply(text) {
  const lines = String(text || '').trim().split('\n')
  let n = 0

  while (n < lines.length && lines[n].startsWith('>')) n++
  if (!n || n >= lines.length || lines[n].trim()) return null
  const quote = collapse(lines.slice(0, n).map(line => line.replace(/^> ?/, '')).join(' '))
  const prompt = lines.slice(n).join('\n').trim()

  return quote && prompt ? { quote, prompt } : null
}

/** One key for a prompt, however its whitespace and code were rendered. */
const promptKey = (quote, prompt) => [quote, prompt].map(part => collapse(part.replaceAll('`', ''))).join('\n')

function compose(quote, prompt) {
  return `${quote
    .split('\n')
    .map(line => `> ${line.trim()}`)
    .join('\n')}\n\n${prompt}`
}

function rectHit(rect, x, y) {
  return x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1
}

function rangeHit(range, x, y) {
  for (const r of range.getClientRects()) if (rectHit(r, x, y)) return true

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

/** Elements on screen: the app keeps chats you switched away from mounted in
 *  hidden panes, and a link must never land in one of those. */
const shown = el => !el.closest('[inert], [aria-hidden="true"], [data-pane-hidden]')

/** A reply's own text: its Markdown blocks, not its thinking or tool rows. */
const answerBlocks = group =>
  [...group.querySelectorAll('.aui-md')].filter(
    el => !el.closest(USER_ROOT) && !el.closest(THINKING) && !el.parentElement?.closest('.aui-md')
  )

// ---------- the plugin ----------

export default {
  id: 'inline',
  name: 'Inline',
  description: 'Select text in a reply, right-click and write a prompt: the answer opens at the passage.',

  register(ctx) {
    const state = host.state
    // Marks the turns this copy hid, so a copy being replaced (hot reload)
    // never un-hides the turns the new copy just hid.
    const instance = Math.random().toString(36).slice(2, 8)
    let hints = ctx.storage.get('hints', {}) // prompt key -> { prefix, suffix, at }
    let lastFocus = { stored: null, runtime: null }
    const busy = sid => Boolean(sid && state.busyBySession.get()[sid])

    // What the chat holds, read again from the page on every scan.
    let links = [] // { id, key, text, quote, prompt, group, shown, source, span, answer, userId, status, error, stopped }
    let linksById = new Map()
    let promptCounts = new Map() // prompt key -> quote-replies with it in the chats, links or not
    const replyCache = new WeakMap() // message group -> { group, blocks, index(), link }, until the group changes
    const statusSeen = new Map() // link id -> status at the last scan (for the ready glow)
    // Prompts on their way into the chat: waiting for it to go idle, or sent and not shown yet.
    const asks = [] // { text, key, range, sid, stored, sent, held, before, cancel }
    let anchored = [] // { link | ask, range }
    let ask = null // the ask box: { pop, range }
    let hovered = null
    // Cards open at their links, deepest last: cards[d] answers a link that
    // sits in the chat (d = 0) or in cards[d - 1].
    const cards = [] // { link, range, pop, body, actions, pinned, page, idx, sig }

    const style = document.createElement('style')
    const ticks = document.createElement('style')
    const layer = document.createElement('div')

    style.textContent = CSS_TEXT
    layer.className = 'hm-layer'
    document.head.append(style, ticks)
    document.body.append(layer)

    const HL = ['hm-link', 'hm-wait', 'hm-open', 'hm-hover', 'hm-draft', 'hm-ready']
    const hl = Object.fromEntries(HL.map(name => [name, new Highlight()]))

    hl['hm-hover'].priority = 1
    for (const name of HL) CSS.highlights.set(name, hl[name])

    function trackFocus() {
      const stored = state.focusedStoredSessionId.get()
      const runtime = state.focusedSessionId.get()

      if (runtime) lastFocus = { stored: stored || null, runtime }
    }

    trackFocus()

    // ----- reading the chat -----

    function replyOf(group) {
      let reply = replyCache.get(group)

      if (!reply) {
        const blocks = answerBlocks(group)
        let idx = null

        reply = { group, blocks, index: () => (idx ??= buildIndex(blocks)), link: null }
        replyCache.set(group, reply)
      }

      return reply
    }

    /** Where a link's answer stands: 'wait', 'done' or 'error', read from its turn. */
    function stateOf(group, answer, last, rootBusy) {
      const text = answer.blocks.some(b => b.textContent.trim())
      const streaming = Boolean(group.querySelector(STREAMING))
      const error = group.querySelector(ALERT)?.textContent.trim() ?? ''
      const stopped = Boolean(group.querySelector(STOPPED))
      let status = 'error'

      if (text && !streaming) status = 'done'
      else if (streaming) status = 'wait'
      // Sent, and the agent hasn't started a reply yet.
      else if (!error && !stopped && last && rootBusy && !group.querySelector(ASSISTANT)) status = 'wait'

      return { status, error, stopped }
    }

    /**
     * Find every link in every mounted chat and hide its turn. A turn is a
     * link when its message is a quote-reply whose passage sits in an earlier
     * reply (an answer shown in a card counts: that makes a nested link).
     */
    function scan() {
      const found = []
      const counts = new Map()
      const roots = [...document.querySelectorAll(THREAD)]
      const onScreen = roots.filter(shown)

      for (const root of roots) {
        const groups = root.querySelectorAll(GROUP)
        // Replies above this turn, nearest first: the chat's own replies are
        // searched before link answers, which tend to repeat what they're about.
        const replies = []
        const answers = []
        const seen = new Map() // prompt key -> times in this chat
        // Only a lone chat on screen is known to be the focused session.
        const rootBusy = onScreen.length === 1 && onScreen[0] === root ? busy(lastFocus.runtime) : true

        groups.forEach((group, i) => {
          const bubble = group.querySelector(USER_TEXT)
          const text = bubble ? sentText(bubble).trim() : ''
          const parsed = text ? parseQuoteReply(text) : null
          const reply = replyOf(group)
          let link = null

          if (parsed) {
            const key = promptKey(parsed.quote, parsed.prompt)
            const n = (seen.get(key) ?? 0) + 1
            const earlier = [...replies, ...answers]
            const hit = findQuote(
              earlier.map(r => r.index),
              parsed.quote,
              hints[key]
            )

            seen.set(key, n)
            counts.set(key, (counts.get(key) ?? 0) + 1)
            if (hit) {
              link = {
                id: `${n}:${key}`,
                key,
                text,
                quote: parsed.quote,
                prompt: parsed.prompt,
                group,
                shown: onScreen.includes(root),
                source: earlier[hit.i],
                span: [hit.at, hit.end],
                answer: reply,
                userId: group.querySelector(USER_ROOT)?.dataset.messageId ?? null,
                ...stateOf(group, reply, i === groups.length - 1, rootBusy)
              }
              found.push(link)
            }
          }
          if (link) {
            if (group.getAttribute(TURN_ATTR) !== instance) group.setAttribute(TURN_ATTR, instance)
          } else if (group.hasAttribute(TURN_ATTR)) group.removeAttribute(TURN_ATTR)
          reply.link = link
          if (reply.blocks.length) (link ? answers : replies).unshift(reply)
        })
      }

      links = found
      linksById = new Map(found.map(link => [link.id, link]))
      promptCounts = counts

      // A prompt that reached the chat is a link now (or, if its passage
      // can't be found, an ordinary message).
      let arrived = false

      for (const a of [...asks]) {
        if (a.sent && (counts.get(a.key) ?? 0) > a.before) {
          asks.splice(asks.indexOf(a), 1)
          a.cancel?.()
          arrived = true
        }
      }
      if (arrived) pumpSoon()

      for (const link of found) {
        if (statusSeen.get(link.id) === 'wait' && link.status === 'done') glow(link.id)
        statusSeen.set(link.id, link.status)
      }

      // The timeline's tick for each hidden turn goes too.
      const tickIds = found.filter(l => l.userId).map(l => `[data-timeline-id="${CSS.escape(l.userId)}"]`)
      const tickCss = tickIds.length ? `${tickIds.join(',\n')} { visibility: hidden; pointer-events: none; }` : ''

      if (ticks.textContent !== tickCss) ticks.textContent = tickCss
    }

    // ----- painting -----

    function paint() {
      scan()
      // Cards follow their links: refreshed while an answer streams, closed
      // when the link is gone (its turn was removed by a restore or an edit).
      for (let i = 0; i < cards.length; i++) {
        const link = linksById.get(cards[i].link.id)

        if (!link) {
          dropCards(i)
          break
        }
        cards[i].link = link
        if (signature(link) !== cards[i].sig) fillCard(cards[i])
      }

      anchored = []
      // Of links on the same passage, the latest wins.
      const taken = new Map()
      const claim = (source, span) => {
        const spans = taken.get(source) ?? new Set()

        taken.set(source, spans)
        if (spans.has(`${span}`)) return false
        spans.add(`${span}`)

        return true
      }
      const newestFirst = [...links].reverse()

      for (const link of newestFirst) {
        if (!link.shown || link.source.link || !claim(link.source, link.span)) continue
        anchored.push({ link, range: rangeFor(link.source.index(), ...link.span) })
      }
      // A passage in an answer is drawn in that answer's card, when it is open.
      for (const card of cards) {
        if (!card.page) continue
        const idx = (card.idx ??= buildIndex([card.page]))

        for (const link of newestFirst) {
          if (link.source.group !== card.link.group || !claim(link.source, link.span)) continue
          const [s, t] = link.span

          if (idx.text.slice(s, t) === link.quote) anchored.push({ link, range: rangeFor(idx, s, t) })
        }
      }
      for (const a of asks) if (a.range?.toString()) anchored.push({ ask: a, range: a.range })

      for (const name of ['hm-link', 'hm-wait', 'hm-open', 'hm-ready']) hl[name].clear()
      const open = new Set(cards.map(c => c.link.id))

      for (const a of anchored) {
        if (a.ask) hl['hm-wait'].add(a.range)
        else hl[open.has(a.link.id) ? 'hm-open' : a.link.status === 'done' ? 'hm-link' : 'hm-wait'].add(a.range)
        if (a.link && readyIds.has(a.link.id)) hl['hm-ready'].add(a.range)
      }
      for (const card of cards) card.range = anchored.find(a => a.link?.id === card.link.id)?.range ?? card.range
      hovered = (hovered && anchored.find(a => a.link && a.link.id === hovered.link.id)) || null
      setHover(hovered)
      if (asks.some(a => !a.sent)) pumpSoon()
    }

    // The "it's ready" glow: in quickly, out slowly, once.
    const readyIds = new Set()
    let readyFrame = 0

    function glow(id) {
      readyIds.add(id)
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

    let paintTimer = null
    const schedulePaint = () => {
      if (paintTimer) return
      paintTimer = setTimeout(() => {
        paintTimer = null
        paint()
      }, 150)
    }

    /** A record that adds a turn (or a user bubble) to a chat. */
    const addsTurn = record =>
      [...record.addedNodes].some(
        n => n.nodeType === Node.ELEMENT_NODE && (n.matches(`${GROUP}, ${USER_TEXT}`) || n.querySelector(`${GROUP}, ${USER_TEXT}`))
      )

    const observer = new MutationObserver(records => {
      if (records.every(r => layer.contains(r.target))) return
      for (const r of records) {
        const el = r.target.nodeType === Node.ELEMENT_NODE ? r.target : r.target.parentElement
        const group = el?.closest(GROUP)

        if (group) replyCache.delete(group)
      }
      // Before the frame is drawn, so a new link turn never shows in the chat.
      if (records.some(addsTurn)) scan()
      schedulePaint()
    })

    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    // ----- sending prompts -----

    function rememberHint(key, hint) {
      hints = { ...ctx.storage.get('hints', {}), [key]: { ...hint, at: Date.now() } }
      const keys = Object.keys(hints)

      if (keys.length > MAX_HINTS) {
        keys.sort((a, b) => hints[a].at - hints[b].at)
        for (const k of keys.slice(0, keys.length - MAX_HINTS)) delete hints[k]
      }
      ctx.storage.set('hints', hints)
    }

    function queueAsk(text, key, range) {
      if (!lastFocus.runtime) {
        host.notify({ kind: 'error', message: 'No live session for this chat.' })

        return
      }
      asks.push({ text, key, range, sid: lastFocus.runtime, stored: lastFocus.stored, sent: false })
      paint()
      pump()
    }

    function dropAsk(a, message) {
      const i = asks.indexOf(a)

      if (i < 0) return
      asks.splice(i, 1)
      a.cancel?.()
      if (message) host.notify({ kind: 'error', message })
      paint()
    }

    /** The chat surface (a chat and its message box) a prompt goes through: its tile, else the main one. */
    const surfaceOf = a =>
      (a.stored && document.querySelector(`${SURFACE_ROOT}[data-session-anchor="session-tile:${CSS.escape(a.stored)}"]`)) ||
      document.querySelector(`${SURFACE_ROOT}[data-composer-target="main"]`)

    /**
     * Send the next prompt through its chat's own message box, exactly as if
     * it were typed. Only while the chat is idle: sent mid-turn, Hermes would
     * fold it into the running turn instead of giving it a turn of its own.
     */
    function pump() {
      if (asks.some(a => a.sent)) return
      for (const next of [...asks]) {
        if (busy(next.sid)) continue
        // Hermes sends whatever is attached in the message box along with a
        // message, so a prompt waits until the box has no attachments.
        if (surfaceOf(next)?.querySelector(ATTACHMENTS)) {
          if (!next.held) host.notify({ kind: 'info', message: 'Your Inline prompt goes once the attachment in the message box is sent or removed.' })
          next.held = true
          continue
        }
        const before = promptCounts.get(next.key) ?? 0

        if (!host.composer?.submit(next.sid, next.text)) {
          // Its chat isn't on screen: it goes when the chat is back.
          if (next.sid === lastFocus.runtime) dropAsk(next, "Inline couldn't reach this chat's message box.")
          continue
        }
        Object.assign(next, { sent: true, before })
        next.cancel = ctx.setTimeout(() => {
          dropAsk(next, "Hermes didn't take the prompt.")
          pump()
        }, SEND_TIMEOUT_MS)

        return
      }
    }

    // After the app has re-rendered for the change that called it (a chat
    // going idle, another chat coming into view): the message box acts on
    // its last render, and before that it would still see the old state.
    let pumpFrame = 0

    function pumpSoon() {
      cancelAnimationFrame(pumpFrame)
      pumpFrame = requestAnimationFrame(() => {
        pumpFrame = 0
        pump()
      })
    }

    // A chat going idle is the moment to send its waiting prompt; it also
    // settles links (no reply came = no answer).
    ctx.onDispose(
      state.busyBySession.listen(() => {
        pumpSoon()
        schedulePaint()
      })
    )

    /** The message for a prompt, and its hint for telling repeats of the passage apart. */
    function prepare(quote, prompt, hint) {
      const text = compose(quote, prompt)
      const parsed = parseQuoteReply(text)
      const key = promptKey(parsed.quote, parsed.prompt)

      rememberHint(key, hint)

      return { text, key }
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

    const signature = link =>
      `${link.status}|${link.error}|${link.stopped}|${link.answer.blocks.map(b => b.textContent.length).join(',')}`

    /** The card shows the reply Hermes already drew: a copy of its Markdown. */
    function fillCard(card) {
      const { link, body, actions } = card
      const blocks = link.answer.blocks.filter(b => b.textContent.trim())

      body.replaceChildren()
      actions.replaceChildren()
      Object.assign(card, { page: null, idx: null, sig: signature(link) })
      if (blocks.length) {
        const page = element('div', '')

        page.setAttribute(PAGE_ATTR, '')
        page.dataset.selectableText = 'true'
        for (const block of blocks) page.append(block.cloneNode(true))
        body.append(page)
        card.page = page
      }
      if (link.status === 'wait') body.append(element('div', 'hm-card-wait'))
      else if (link.status === 'error') {
        body.append(element('div', 'hm-card-note', link.error ? `No answer: ${link.error}` : 'No answer arrived.'))
        actions.append(action('Retry', () => queueAsk(link.text, link.key, null)))
      } else if (link.error) body.append(element('div', 'hm-card-note', link.error))
      else if (link.stopped) body.append(element('div', 'hm-card-note', 'Stopped before it finished.'))
      if (card.pop.isConnected) place(card.pop, card.range.getBoundingClientRect())
    }

    function dropCards(from = 0) {
      for (const card of cards.splice(from)) card.pop.remove()
    }

    function closeCards(from = 0) {
      if (cards.length <= from) return
      dropCards(from)
      paint()
    }

    function openCard(depth, hit) {
      dropCards(depth)
      const pop = element('div', `hm-pop hm-card ${SURFACE}`)
      // Hermes's own edge fade (the utility behind FadeScroll): a clipped edge
      // fades out while there is more to scroll, and a short answer shows none.
      const body = element('div', 'hm-card-body scroll-fade-y')
      const actions = element('div', 'hm-card-actions')
      const card = { link: hit.link, range: hit.range, pop, body, actions, pinned: false, page: null, idx: null, sig: '' }

      // The answer is the card; the prompt is the angle it was seen from,
      // so it sits above it as a quiet label rather than a heading.
      const question = element('div', 'hm-card-question')

      question.title = hit.link.prompt
      question.append(element('span', 'codicon codicon-comment'), element('span', 'hm-card-question-text', hit.link.prompt))
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
      if (openFor === hit.link.id) return
      cancelOpen()
      openFor = hit.link.id
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
        if (a.link && rangeHit(a.range, x, y) && (!best || a.range.toString().length < best.range.toString().length)) best = a
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

      if (hit?.link.id !== hovered?.link.id) {
        hovered = hit
        setHover(hit)
      }
      if (hit) {
        const depth = depthOf(hit)

        if (cards[depth]?.link.id === hit.link.id) keep = Math.max(keep, depth + 1)
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
        // A press on a link leaves its card as it is.
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

    function openAsk({ quote, range, hint }) {
      closeAsk()
      cancelOpen()
      cancelClose()
      const pop = element('div', `hm-pop hm-ask ${SURFACE}`)
      const field = element('div', 'hm-ask-field')

      field.contentEditable = 'plaintext-only'
      field.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          closeAsk()
        } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          const prompt = field.innerText.trim()

          if (!prompt) return
          const { text, key } = prepare(quote, prompt, hint)

          closeAsk()
          window.getSelection()?.removeAllRanges()
          queueAsk(text, key, range)
        }
      })
      pop.append(element('span', 'codicon codicon-comment'), field)
      layer.append(pop)
      hl['hm-draft'].add(range)
      ask = { pop, range }
      place(pop, range.getBoundingClientRect())
      field.focus()
    }

    /** Where selectable reply text lives: a reply in a chat, or an answer in a card. */
    function textRoot(node) {
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement

      if (!el || el.closest('[contenteditable], textarea, input')) return null
      const page = el.closest(`[${PAGE_ATTR}]`)

      if (page) return { scope: page, index: () => buildIndex([page]) }
      const group = el.closest(GROUP)

      if (!group?.closest(THREAD) || !replyOf(group).blocks.some(b => b.contains(el))) return null

      return { scope: group, index: () => replyOf(group).index() }
    }

    /** The selection under (x, y) inside one reply or one card, if any. */
    function selectionAt(x, y) {
      const sel = window.getSelection()

      if (!sel || sel.isCollapsed || !sel.rangeCount) return null
      const range = sel.getRangeAt(0)
      const root = textRoot(range.startContainer)

      if (!root || !root.scope.contains(range.endContainer)) return null

      return rangeHit(range, x, y) ? { sel, range, ...root } : null
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
        const { sel, range } = hit
        const idx = hit.index()
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
        openAsk({
          quote: quoteOf(idx, s, t),
          range: snapped.cloneRange(),
          hint: { prefix: idx.text.slice(Math.max(0, s - CONTEXT_CHARS), s), suffix: idx.text.slice(t, t + CONTEXT_CHARS) }
        })
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
            dropCards(0)
          }
          schedulePaint()
          pumpSoon()
        })
      )
    }

    ctx.onDispose(() => {
      observer.disconnect()
      if (paintTimer) clearTimeout(paintTimer)
      cancelOpen()
      cancelClose()
      if (moveFrame) cancelAnimationFrame(moveFrame)
      cancelAnimationFrame(readyFrame)
      cancelAnimationFrame(pumpFrame)
      document.documentElement.style.removeProperty('--hm-ready-a')
      for (const a of asks) a.cancel?.()
      // Only ours: during a reload the next copy may have taken these over already.
      for (const name of HL) if (CSS.highlights.get(name) === hl[name]) CSS.highlights.delete(name)
      for (const group of document.querySelectorAll(`[${TURN_ATTR}="${instance}"]`)) group.removeAttribute(TURN_ATTR)
      document.documentElement.classList.remove('hm-hover')
      layer.remove()
      style.remove()
      ticks.remove()
    })

    paint()
  }
}
