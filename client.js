// dsh-sidebar-fold —— 把侧栏里插件注册的面板行折叠成一行，**点击**在行内向下展开
// 客户端插件必须是 factory-CJS：唯一合法出口是 window.__ModuleLoader__.load({ id, factory })
//
// 教训（都踩过，别重犯）：
//  · 绝不读 ctx.config —— ctx 是服务 Proxy，读未声明属性会抛错，apply 被打断 → web boot 门禁整站失败。
//  · inject 只声明真正用到的 service，多一个悬空依赖 = fiber 永远 pending。
//  · 「同 id 注册替换单元格」在真实装配下不生效（原行照旧渲染），所以改为 DOM 层面收起。
//  · 我们的行在宿主里仍是 <button>，点它会让宿主 selectPanel('sidebar-fold')（没有对应主面板，会抛错）。
//    点击必须在**捕获阶段**截下来，否则冒泡到 React root 已经晚了。
//  · 监听器不要挂在宿主那一行的 <button> 上：宿主重渲染会换掉那个节点，监听器跟着死。
//    改为挂 document（capture），每次事件现场 closest('button') 重新解析。
//  · 展开块必须是**行内向下**的普通 DOM（插入 nav），像 Workspace 展开那样把下面的内容顶下去，不要浮层。
//  · 交互按用户要求只保留点击展开，不做悬停展开。
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-fold',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useRef, useEffect } = React

    const ROW_ID = 'sidebar-fold'
    const SLOT = 'sidebar.panellist'
    const ZH = (typeof navigator !== 'undefined' && String(navigator.language || '').toLowerCase().startsWith('zh'))
    const DIAG_URL = 'http://127.0.0.1:18555/r'

    const css = `
.sfb-glyph { display: inline-flex; align-items: center; justify-content: center; }
.sfb-glyph > svg { transition: transform 140ms ease; }
.sfb-open .sfb-glyph > svg { transform: rotate(180deg); }
.sfb-acc {
  display: flex; flex-direction: column; gap: 2px; padding: 2px 0 6px 0;
  animation: sfb-in 90ms ease-out;
}
@keyframes sfb-in { from { opacity: 0; transform: translateY(-2px) } to { opacity: 1; transform: none } }
.sfb-acc-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px;
  padding: 5px 10px 5px 30px; box-sizing: border-box;
  border: none; border-radius: var(--dsw-radius-sm, 8px); background: transparent;
  cursor: pointer; font-family: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary, #0f1115); text-align: left;
}
.sfb-acc-item:hover, .sfb-acc-item.sfb-focus, .sfb-acc-item.sfb-current, .sfb-acc-item.sfb-current:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06));
}
.sfb-ic {
  display: inline-flex; flex: none; width: 14px; height: 14px;
  align-items: center; justify-content: center;
  color: var(--dsw-alias-menu-icon, var(--dsw-alias-label-primary, #353638));
}
.sfb-ic > svg { width: 14px; height: 14px; display: block; }
.sfb-dot { width: 5px; height: 5px; border-radius: 3px; background: currentColor; opacity: .45; }
.sfb-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfb-acc-empty { padding: 6px 10px 6px 30px; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 13px; }
.sfb-acc-foot { margin-top: 2px; border-top: .5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); border-radius: 0; color: var(--dsw-alias-label-secondary, #61666b); }
.sfb-page { padding: 22px 26px 26px; max-width: 560px; color: var(--dsw-alias-label-primary, #0f1115); font-size: 14px; }
.sfb-page-title { font-size: 15px; font-weight: 600; line-height: 22px; }
.sfb-page-hint { margin: 6px 0 16px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #81858c); }
.sfb-page-list { display: flex; flex-direction: column; gap: 1px; }
.sfb-line { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer; }
.sfb-line:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
.sfb-line input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary, #0f1115); cursor: pointer; flex: none; }
.sfb-line-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfb-line-id { color: var(--dsw-alias-label-caption, #adb2b8); font-size: 11px; font-family: var(--ds-font-family-code, monospace); }
.sfb-page-foot { margin-top: 16px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #81858c); }
.sfb-hidden { display: none !important; }
.sfb-open { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
@media (prefers-reduced-motion: reduce) { .sfb-acc { animation: none; } .sfb-glyph > svg { transition: none; } }
`

    /* 诊断：渲染进程里 localStorage 读不到（dsh-app:// 协议），改用 <img> 打本地端口，由 diag-server.mjs 落盘 */
    let reportCount = 0
    function report(tag, extra) {
      try {
        if (reportCount > 80) return
        reportCount++
        const payload = Object.assign({ ev: tag }, extra || {})
        const img = new Image()
        img.src = DIAG_URL + '?d=' + encodeURIComponent(JSON.stringify(payload))
      } catch { /* 忽略 */ }
    }

    function FoldIcon({ size = 20, active = false }) {
      // 圆角方框 + 下箭头：一个形状一个箭头，16px 下不糊；展开时整枚旋转 180°（方框对称，只有箭头翻）
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block', opacity: active ? 1 : 0.78 },
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 3.6, y: 3.6, width: 16.8, height: 16.8, rx: 4.4 }),
      h('path', { d: 'M8.4 10.2 12 13.8l3.6-3.6' }))
    }

    function findRowList(ownEl) {
      const nav = ownEl.closest('nav')
      if (nav) return nav
      let node = ownEl
      for (let depth = 0; depth < 6 && node && node.parentElement; depth++) {
        const parent = node.parentElement
        const kids = Array.from(parent.children)
        const likeRows = kids.filter((el) => el.querySelector && (el.querySelector('svg') || el.tagName === 'BUTTON')).length
        if (kids.length >= 5 && likeRows >= 4) return parent
        node = parent
      }
      return null
    }

    function readRow(el) {
      const btn = el.tagName === 'BUTTON' ? el : el.querySelector('button')
      const label = (btn && (btn.getAttribute('aria-label') || '')) || (el.textContent || '').replace(/\s+/g, ' ').trim()
      const svg = (btn && btn.querySelector('svg')) || el.querySelector('svg')
      return {
        el,
        btn: btn || el,
        label,
        svgHTML: svg ? svg.outerHTML : '',
        current: !!(btn && btn.getAttribute('aria-current') === 'page'),
        // 宿主自己的「更多」：点它要弹宿主菜单，位置得先摆好
        menu: !!(btn && btn.getAttribute && btn.getAttribute('aria-haspopup')),
      }
    }

    /* ── 「留在外面」的面板名单：存在 localStorage（宿主自己的 client 插件也这么存 UI 偏好） ── */
    const KEEP_KEY = 'dsh-sidebar-fold.keep'
    let keepCache = null
    const keepListeners = new Set()

    function readKeep() {
      try {
        const v = JSON.parse(window.localStorage.getItem(KEEP_KEY) || '[]')
        return Array.isArray(v) ? v.map(String) : []
      } catch { return [] }
    }
    function getKeep() {
      if (keepCache === null) keepCache = readKeep()
      return keepCache
    }
    function setKeep(next) {
      const list = Array.from(new Set(next.map(String)))
      keepCache = list
      try { window.localStorage.setItem(KEEP_KEY, JSON.stringify(list)) } catch { /* 忽略 */ }
      for (const fn of keepListeners) { try { fn(list) } catch { /* 忽略 */ } }
    }
    function onKeepChange(fn) { keepListeners.add(fn); return () => keepListeners.delete(fn) }

    /* 宿主只把面板 id 留在 slot 注册里，DOM 里只有 aria-label —— 所以按 label 反查 id */
    function panelIdByLabel(slots) {
      const map = new Map()
      try {
        for (const entry of (slots.entriesOfSlot('sidebar.panellist') || [])) {
          const o = entry.options || {}
          if (!o.id) continue
          let label = o.label
          if (typeof label === 'function') { try { label = label() } catch { label = '' } }
          if (typeof label === 'string' && label) map.set(label, o.id)
        }
      } catch { /* 忽略 */ }
      return map
    }

    function panelList(slots) {
      const list = []
      try {
        for (const entry of (slots.entriesOfSlot('sidebar.panellist') || [])) {
          const o = entry.options || {}
          if (!o.id || o.id === ROW_ID) continue
          let label = o.label
          if (typeof label === 'function') { try { label = label() } catch { label = '' } }
          list.push({ id: o.id, label: label || o.id })
        }
      } catch { /* 忽略 */ }
      return list
    }

    const inject = ['slots', 'layout']

    /* 兜底：一个装饰插件绝不能把整个 UI 拖死（宿主 web boot 是全量门禁）。 */
    function guard(label, fn) {
      try {
        return fn()
      } catch (err) {
        try { console.error('[dsh-sidebar-fold] ' + label + ':', err) } catch { /* 忽略 */ }
        report('err', { where: label, msg: String(err && err.message ? err.message : err) })
        return undefined
      }
    }

    const reportOnce = { mounted: false }
    report('module')

    function apply(ctx) {
      report('apply')
      guard('apply', () => ctx.inject(['slots', 'layout'], (pageCtx) => guard('init', () => {
        const slots = pageCtx.slots
        const layout = pageCtx.layout
        const stops = []
        let mainReady = false

        /* 右键（或展开块底部的入口）跳到本插件自己的设置页 */
        const openSettingsPage = () => {
          if (!mainReady || !layout || typeof layout.selectPanel !== 'function') return
          try { layout.selectPanel(ROW_ID) } catch { /* 忽略 */ }
        }

        /* 设置页：勾选哪些面板留在侧栏外面，其余收进「工具」 */
        function FoldSettings() {
          const [panels, setPanels] = useState([])
          const [kept, setKept] = useState(getKeep())

          useEffect(() => {
            try {
              const tag = document.getElementById('dsh-sidebar-fold-style')
              const probe = document.createElement('div')
              probe.className = 'sfb-line'
              probe.style.position = 'absolute'
              probe.style.visibility = 'hidden'
              document.body.appendChild(probe)
              const computed = window.getComputedStyle(probe).display
              probe.remove()
              report('settings', { styleTag: !!tag, cssLen: tag ? tag.textContent.length : 0, lineDisplay: computed })
            } catch (err) { report('settings-err', { msg: String(err) }) }
            const refresh = () => setPanels(panelList(slots))
            refresh()
            const offKeep = onKeepChange((list) => setKept(list))
            let stop = null
            guard('settings-slot', () => {
              stop = slots.inject('sidebar.panellist', () => {
                refresh()
                return () => { /* 无需清理 */ }
              })
            })
            return () => {
              try { if (stop) stop() } catch { /* 忽略 */ }
              offKeep()
            }
          }, [])

          const toggle = (id, on) => {
            const next = new Set(getKeep())
            if (on) next.add(id)
            else next.delete(id)
            setKeep(Array.from(next))
          }

          // 同时写内联样式：面板页在宿主的主区域里，万一插件样式表没生效也不该变成一坨纯文本
          const S = {
            page: { padding: '22px 26px 26px', maxWidth: 560, color: 'var(--dsw-alias-label-primary, #0f1115)', fontSize: 14, lineHeight: '22px' },
            title: { fontSize: 15, fontWeight: 600, lineHeight: '22px' },
            hint: { margin: '6px 0 16px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #81858c)' },
            list: { display: 'flex', flexDirection: 'column', gap: 1 },
            line: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 8, cursor: 'pointer' },
            box: { width: 14, height: 14, margin: 0, flex: 'none', accentColor: 'var(--dsw-alias-brand-primary, #0f1115)', cursor: 'pointer' },
            label: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            id: { color: 'var(--dsw-alias-label-caption, #adb2b8)', fontSize: 11, fontFamily: 'var(--ds-font-family-code, monospace)' },
            foot: { marginTop: 16, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #81858c)' },
          }

          return h('div', { className: 'sfb-page', style: S.page },
            h('div', { className: 'sfb-page-title', style: S.title }, ZH ? '侧栏折叠' : 'Sidebar fold'),
            h('div', { className: 'sfb-page-hint', style: S.hint },
              ZH ? '勾选要在侧栏里保留的面板，其余会被收进「更多」那一行。' : 'Check the panels that should stay in the sidebar. The rest are folded into More.'),
            h('div', { className: 'sfb-page-list', style: S.list }, panels.map((p) => h('label', { key: p.id, className: 'sfb-line', style: S.line },
              h('input', {
                type: 'checkbox',
                className: 'sfb-line-box',
                style: S.box,
                checked: kept.includes(p.id),
                onChange: (e) => toggle(p.id, e.target.checked),
              }),
              h('span', { className: 'sfb-line-label', style: S.label }, p.label),
              h('span', { className: 'sfb-line-id', style: S.id }, p.id)))),
            h('div', { className: 'sfb-page-foot', style: S.foot },
              ZH ? '「插件」那一行固定保留；「更多」是本插件自己。' : 'The Plugins row is always kept; More is this plugin.'))
        }

        function FoldRow(props) {
          const [open, setOpen] = useState(false)
          const [items, setItems] = useState([])
          const [focusIdx, setFocusIdx] = useState(-1)

          const ownRef = useRef(null)
          const accRef = useRef(null)
          const navChildRef = useRef(null)
          const openTimer = useRef(null)
          const closeTimer = useRef(null)
          const cancelClose = () => {
            if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
          }
          const cancelTimers = () => {
            cancelClose()
            if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
          }

          const openRef = useRef(false)
          const focusRef = useRef(-1)
          const itemsRef = useRef([])
          openRef.current = open
          focusRef.current = focusIdx
          itemsRef.current = items

          /* ① 收起其余面板行 + 文档级点击委托 */
          useEffect(() => {
            const own = ownRef.current
            if (!own || typeof document === 'undefined') return
            let hidden = []
            let frame = 0
            let dead = false
            let reported = 0

            const rowBtn = () => {
              const node = ownRef.current
              if (!node || !node.isConnected) return null
              return node.closest('button')
            }
            const accEl = () => (accRef.current && accRef.current.isConnected ? accRef.current : null)

            const sync = () => {
              frame = 0
              if (dead) return
              const list = findRowList(own)
              if (!list) { if (!reported) { reported = 1; report('sync', { nav: 0 }) } return }
              // 展开块自己也是 nav 的一个子元素，而且里面有按钮——不清掉就会被当成'面板行'收回、加上 sfb-hidden，
              // 于是刚插进去就被自己隐藏（0.5.4~0.5.7「点不开」的真因）。
              const kids = Array.from(list.children).filter((el) => {
                if (el.classList && el.classList.contains('sfb-acc')) return false
                if (accRef.current && el === accRef.current) return false
                return el.tagName === 'BUTTON' || !!(el.querySelector && el.querySelector('button'))
              })
              const ownChild = kids.find((el) => el.contains(own))
              if (!ownChild) { report('sync', { ownChild: 0, kids: kids.length }); return }
              navChildRef.current = ownChild

              for (const el of hidden) el.classList.remove('sfb-hidden')
              hidden = []
              const keptSeen = []
              const keepFirst = kids[0] === ownChild ? null : kids[0]
              const idMap = panelIdByLabel(slots)
              const keptIds = getKeep()
              const collected = []
              for (const el of kids) {
                if (el === ownChild || el === keepFirst) continue
                const info = readRow(el)
                info.id = idMap.get(info.label) || info.label
                // 用户在设置页里勾了「留在外面」：不动它
                if (info.id && keptIds.includes(info.id)) { keptSeen.push(el); continue }
                el.classList.add('sfb-hidden')
                hidden.push(el)
                if (info.label) collected.push(info)
              }
              itemsRef.current = collected
              setItems(collected)
              if (!reported) { reported = 1; report('sync', { nav: 1, kids: kids.length, hidden: hidden.length, items: collected.length, btn: !!own.closest('button') }) }
            }

            const schedule = () => {
              if (frame) return
              frame = window.requestAnimationFrame(sync)
            }

            /* 点击：捕获阶段截停，宿主的 onClick 拿不到，也就不会去选不存在的主面板 */
            const onClickCapture = (e) => {
              const a = accEl()
              if (a && a.contains(e.target)) return // 展开项自己有 handler
              const b = rowBtn()
              if (!b || !b.contains(e.target)) {
                // 点到别处：收起
                if (openRef.current && !(a && a.contains(e.target))) setOpen(false)
                return
              }
              e.stopPropagation()
              e.preventDefault()
              report('click', { open: openRef.current, items: itemsRef.current.length })
              if (openRef.current) setOpen(false)
              else { setFocusIdx(-1); setOpen(true) }
            }

            const onKeyDownCapture = (e) => {
              if (!openRef.current) return
              const b = rowBtn()
              const a = accEl()
              const active = document.activeElement
              const inside = (b && (active === b || b.contains(active))) || (a && a.contains(active))
              if (e.key === 'Escape') {
                e.stopPropagation()
                setFocusIdx(-1)
                setOpen(false)
                return
              }
              if (!inside) return
              const list = itemsRef.current
              if (e.key === 'ArrowDown') {
                e.preventDefault(); e.stopPropagation()
                const i = Math.min(list.length - 1, focusRef.current + 1)
                focusRef.current = i; setFocusIdx(i)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault(); e.stopPropagation()
                const i = Math.max(-1, focusRef.current - 1)
                focusRef.current = i; setFocusIdx(i)
              } else if (e.key === 'Enter') {
                const it = list[focusRef.current]
                if (it) {
                  e.preventDefault(); e.stopPropagation()
                  setFocusIdx(-1); setOpen(false)
                  try { it.btn.click() } catch { /* 忽略 */ }
                }
              }
            }

            /* 悬停：停 120ms 才展开（路过不跳），移开 150ms 收起；展开块内部视为“还在里面” */
            const inArea = (node) => {
              if (!node || !node.nodeType) return false
              const b = rowBtn()
              if (b && b.contains(node)) return true
              const a = accEl()
              return !!(a && a.contains(node))
            }
            const openSoon = () => {
              cancelClose()
              if (openRef.current || openTimer.current) return
              openTimer.current = setTimeout(() => {
                openTimer.current = null
                setFocusIdx(-1)
                setOpen(true)
              }, 120)
            }
            const closeSoon = () => {
              cancelTimers()
              closeTimer.current = setTimeout(() => { closeTimer.current = null; setOpen(false) }, 150)
            }
            const onPointerOver = (e) => {
              const b = rowBtn()
              if (b && b.contains(e.target)) openSoon()
            }
            const onPointerOut = (e) => {
              if (!inArea(e.target)) return
              if (inArea(e.relatedTarget)) return
              closeSoon()
            }

            /* 右键：进插件自己的设置页（选择哪些面板留在外面） */
            const onContextMenu = (e) => {
              const b = rowBtn()
              if (!b || !b.contains(e.target)) return
              e.preventDefault()
              e.stopPropagation()
              report('contextmenu', { mainReady })
              openSettingsPage()
            }

            document.addEventListener('click', onClickCapture, true)
            document.addEventListener('keydown', onKeyDownCapture, true)
            document.addEventListener('pointerover', onPointerOver, true)
            document.addEventListener('pointerout', onPointerOut, true)
            document.addEventListener('contextmenu', onContextMenu, true)

            sync()
            const offKeep = onKeepChange(() => schedule())
            let observer = null
            try {
              observer = new MutationObserver((records) => {
                const relevant = records.some((r) => {
                  const t = r.target
                  if (own.contains(t) || t === own) return false
                  const a = accRef.current
                  if (a && (t === a || a.contains(t))) return false
                  return true
                })
                if (relevant) schedule()
              })
              const list = findRowList(own)
              if (list) observer.observe(list, { childList: true, subtree: true })
            } catch { /* 忽略 */ }

            return () => {
              dead = true
              if (frame) cancelAnimationFrame(frame)
              cancelClose()
              if (observer) observer.disconnect()
              document.removeEventListener('click', onClickCapture, true)
              document.removeEventListener('keydown', onKeyDownCapture, true)
              document.removeEventListener('pointerover', onPointerOver, true)
              document.removeEventListener('pointerout', onPointerOut, true)
              document.removeEventListener('contextmenu', onContextMenu, true)
              try { offKeep() } catch { /* 忽略 */ }
              const b = rowBtn()
              if (b && b.classList) b.classList.remove('sfb-open')
              for (const el of hidden) el.classList.remove('sfb-hidden')
            }
          }, [])

          /* ② 行内展开块：普通 DOM 插在「我们这一行」后面，跟着 nav 一起把下面顶下去 */
          useEffect(() => {
            guard('accordion', () => {
              const own = ownRef.current
              if (!own || typeof document === 'undefined') return
              const navChild = navChildRef.current
              const b = own.closest('button')
              if (b && b.classList) b.classList.toggle('sfb-open', !!open)
              if (!open) {
                if (accRef.current) { accRef.current.remove(); accRef.current = null }
                return
              }
              if (!navChild || !navChild.isConnected || !navChild.parentElement) {
                report('acc-skip', { navChild: !!navChild, connected: !!(navChild && navChild.isConnected) })
                return
              }
              report('acc-open', { items: items.length })
              let a = accRef.current
              if (!a || !a.isConnected) {
                a = document.createElement('div')
                a.className = 'sfb-acc'
                a.setAttribute('role', 'group')
                navChild.parentElement.insertBefore(a, navChild.nextSibling)
                accRef.current = a
                report('acc-insert', { parent: navChild.parentElement.tagName })
              }

              a.textContent = ''
              if (!items.length) {
                const empty = document.createElement('div')
                empty.className = 'sfb-acc-empty'
                empty.textContent = ZH ? '没有可折叠的面板' : 'Nothing to fold'
                a.appendChild(empty)
                return
              }
              items.forEach((it, i) => {
                const item = document.createElement('button')
                item.type = 'button'
                item.className = 'sfb-acc-item' + (it.current ? ' sfb-current' : '') + (i === focusIdx ? ' sfb-focus' : '')
                if (it.current) item.setAttribute('aria-current', 'page')
                item.tabIndex = i === focusIdx ? 0 : -1

                const ic = document.createElement('span')
                ic.className = 'sfb-ic'
                if (it.svgHTML) ic.innerHTML = it.svgHTML
                else { const d = document.createElement('span'); d.className = 'sfb-dot'; ic.appendChild(d) }

                const nm = document.createElement('span')
                nm.className = 'sfb-name'
                nm.textContent = it.label

                item.appendChild(ic)
                item.appendChild(nm)
                item.addEventListener('click', (e) => {
                  e.stopPropagation()
                  setFocusIdx(-1)
                  if (it.menu) {
                    // 宿主自己的「更多」：它被我们收起来了，先把它临时摆在这一项的位置（不可见），
                    // 再点它 —— 宿主的菜单是声明式的 portal，按触发按钮的 rect 定位，所以菜单会弹在这儿。
                    const saved = it.el.getAttribute('style') || ''
                    try {
                      const r = item.getBoundingClientRect()
                      it.el.classList.remove('sfb-hidden')
                      it.el.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;z-index:0;' +
                        'left:' + Math.round(r.left) + 'px;top:' + Math.round(r.top) + 'px;width:' + Math.round(r.width) + 'px'
                      it.btn.click()
                    } catch { /* 忽略 */ } finally {
                      setTimeout(() => {
                        try {
                          it.el.style.cssText = saved
                          it.el.classList.add('sfb-hidden')
                        } catch { /* 忽略 */ }
                      }, 0)
                    }
                    setOpen(false)
                    return
                  }
                  setOpen(false)
                  try { it.btn.click() } catch { /* 忽略 */ }
                })
                a.appendChild(item)
              })

              // 底部入口：进设置页挑「哪些留在外面」
              const foot = document.createElement('button')
              foot.type = 'button'
              foot.className = 'sfb-acc-item sfb-acc-foot'
              foot.innerHTML = '<span class="sfb-ic"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.2 13.5a7.6 7.6 0 0 0 0-3l1.6-1.2-1.6-2.8-1.9.7a7.7 7.7 0 0 0-2.6-1.5L14.4 3h-3.2l-.3 2.2a7.7 7.7 0 0 0-2.6 1.5l-1.9-.7L4.8 8.8 6.4 10a7.6 7.6 0 0 0 0 3l-1.6 1.2 1.6 2.8 1.9-.7a7.7 7.7 0 0 0 2.6 1.5l.3 2.2h3.2l.3-2.2a7.7 7.7 0 0 0 2.6-1.5l1.9.7 1.6-2.8z"/></svg></span><span class="sfb-name">' + (ZH ? '选择留在外面的面板…' : 'Choose panels to keep…') + '</span>'
              foot.addEventListener('click', (e) => {
                e.stopPropagation()
                setOpen(false)
                openSettingsPage()
              })
              a.appendChild(foot)
            })
          }, [open, items, focusIdx])

          /* ③ 卸载时把展开块摘掉 */
          useEffect(() => () => {
            if (accRef.current) { accRef.current.remove(); accRef.current = null }
          }, [])

          useEffect(() => { if (!reportOnce.mounted) { reportOnce.mounted = true; report('mounted') } }, [])

          return h('span', {
            className: 'sfb-glyph',
            ref: ownRef,
            onClick: (e) => e.stopPropagation(),
            onPointerDown: (e) => e.stopPropagation(),
          }, h(FoldIcon, props))
        }

        guard('main', () => {
          stops.push(slots.inject('main', () => slots.register({ name: 'main', key: ROW_ID }, FoldSettings)))
          mainReady = true
        })

        stops.push(slots.inject(SLOT, () =>
          slots.register(
            // order 取一个很大的值：不管以后装/删插件（它们的 order 都是几十以内），
            // 这一行永远排在所有面板行之后，动态收纳时也始终在最下面。
            { name: SLOT, id: ROW_ID, order: 1e6, label: () => (ZH ? '更多' : 'More') },
            FoldRow,
          )))

        /* 样式表：**存在也要比对内容**。
           宿主开了 HMR，插件热替换时页面并不会重载，旧的 <style> 会留在 head 里；
           如果只在"不存在"时注入，新加的规则（例如设置页那套）就永远不会生效 ——
           0.6.0 设置页渲染成一坨纯文本就是这个原因。 */
        const styleId = 'dsh-sidebar-fold-style'
        if (typeof document !== 'undefined' && document.head) {
          let el = document.getElementById(styleId)
          if (!el) {
            el = document.createElement('style')
            el.id = styleId
            document.head.appendChild(el)
          }
          if (el.textContent !== css) el.textContent = css
        }

        return () => { for (const stop of stops) { try { stop() } catch { /* 忽略 */ } } }
      })))
    }

    return { name: 'dsh-sidebar-fold', inject, apply }
  },
})
