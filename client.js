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
.sfb-hidden { display: none !important; }
.sfb-open { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06)); }
@media (prefers-reduced-motion: reduce) { .sfb-acc { animation: none; } }
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
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block', opacity: active ? 1 : 0.72 },
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M6 6.5 12 12 18 6.5' }),
      h('path', { d: 'M5 17h14' }))
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
      }
    }

    const inject = ['slots']

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
      guard('apply', () => ctx.inject(['slots'], (pageCtx) => guard('init', () => {
        const slots = pageCtx.slots
        const stops = []

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
              const keepFirst = kids[0] === ownChild ? null : kids[0]
              const collected = []
              for (const el of kids) {
                if (el === ownChild || el === keepFirst) continue
                el.classList.add('sfb-hidden')
                hidden.push(el)
                const info = readRow(el)
                const isHostMenu = !!(info.btn && info.btn.getAttribute && info.btn.getAttribute('aria-haspopup'))
                if (info.label && !isHostMenu) collected.push(info)
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

            document.addEventListener('click', onClickCapture, true)
            document.addEventListener('keydown', onKeyDownCapture, true)
            document.addEventListener('pointerover', onPointerOver, true)
            document.addEventListener('pointerout', onPointerOut, true)

            sync()
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
                  setOpen(false)
                  try { it.btn.click() } catch { /* 忽略 */ }
                })
                a.appendChild(item)
              })
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

        stops.push(slots.inject(SLOT, () =>
          slots.register(
            { name: SLOT, id: ROW_ID, order: 9, label: () => (ZH ? '工具' : 'Tools') },
            FoldRow,
          )))

        const styleId = 'dsh-sidebar-fold-style'
        if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
          const el = document.createElement('style')
          el.id = styleId
          el.textContent = css
          document.head.appendChild(el)
        }

        return () => { for (const stop of stops) { try { stop() } catch { /* 忽略 */ } } }
      })))
    }

    return { name: 'dsh-sidebar-fold', inject, apply }
  },
})
