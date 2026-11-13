// 在 jsdom 里跑真实组件：模拟宿主侧栏的面板列表，验证「收起 / 展开 / 右键进设置页 / 留外名单」
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import vm from 'node:vm'

const dom = new JSDOM(`<!doctype html><html><body>
<nav aria-label="全局面板">
  <button aria-label="插件"><svg viewBox="0 0 24 24"><rect/></svg></button>
  <div class="rowwrap"><button aria-label="插件市场"><svg viewBox="0 0 24 24"><rect/></svg></button></div>
  <div class="rowwrap"><button aria-label="自动化任务"><svg viewBox="0 0 24 24"><circle/></svg></button></div>
  <div class="rowwrap"><button aria-label="经验库"><svg viewBox="0 0 24 24"><path d="M4 4"/></svg></button></div>
  <div class="rowwrap" id="mount"><button aria-label="工具"><span id="slot"></span></button></div>
  <div class="rowwrap"><button aria-label="AstBot"><svg viewBox="0 0 24 24"><rect/></svg></button></div>
  <button aria-label="更多" aria-haspopup="menu"><svg viewBox="0 0 24 24"><rect/></svg></button>
</nav>
<div id="settings"></div>
<div id="workspace">工作区</div>
</body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' })

global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true })
global.MutationObserver = dom.window.MutationObserver
global.HTMLElement = dom.window.HTMLElement
global.Element = dom.window.Element
global.requestAnimationFrame = dom.window.requestAnimationFrame
global.IS_REACT_ACT_ENVIRONMENT = true

const here = new URL('.', import.meta.url)
const code = fs.readFileSync(new URL('../client.js', here), 'utf8')

// 宿主侧的面板注册表（id / label 对齐 DOM 里的 aria-label）
const panelEntries = [
  { id: 'plugins', label: '插件' },
  { id: 'market', label: '插件市场' },
  { id: 'schedules', label: '自动化任务' },
  { id: 'experience', label: '经验库' },
  { id: 'sidebar-fold', label: '工具' },
  { id: 'astbot', label: 'AstBot' },
]
const selected = []
let Comp = null
let Settings = null
const errors = []

let rowOptions = null
const slots = {
  inject: (name, fn) => fn(),
  register: (opts, component) => {
    if (opts.name === 'main') Settings = component
    else { Comp = component; rowOptions = opts }
    return () => {}
  },
  entriesOfSlot: (name) => (name === 'sidebar.panellist'
    ? panelEntries.map((p, i) => ({ options: { id: p.id, label: () => p.label, order: i } }))
    : []),
  subscribe: () => () => {},
}
const layout = { selectPanel: (id) => selected.push(id) }

let mod = null
const windowStub = {
  __ModuleLoader__: { load: (o) => { mod = o.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require ' + n) }) } },
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  localStorage: dom.window.localStorage,
}
vm.runInContext(code, vm.createContext({
  window: windowStub,
  navigator: { language: 'zh-CN' },
  document: dom.window.document,
  setTimeout: dom.window.setTimeout.bind(dom.window),
  clearTimeout: dom.window.clearTimeout.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  queueMicrotask,
  Image: class { set src(_v) { /* 诊断请求，测试里忽略 */ } },
  console: { error: (...a) => errors.push(String(a[0])), log: console.log },
}))

// 模拟 HMR：页面里已经留着上一版插件的 <style>（内容缺新规则）
const stale = dom.window.document.createElement('style')
stale.id = 'dsh-sidebar-fold-style'
stale.textContent = '.sfb-glyph{display:inline-flex}'
dom.window.document.head.appendChild(stale)

mod.apply({ inject: (svc, cb) => cb({ slots, layout }) })
if (!Comp) throw new Error('侧栏行组件没注册上')

// 样式表必须被"更新"，而不是"已存在就跳过"（否则 HMR 之后新规则永远不生效）
const styleRefreshed = dom.window.document.getElementById('dsh-sidebar-fold-style').textContent.includes('.sfb-page')

const root = createRoot(document.getElementById('slot'))
await act(async () => { root.render(React.createElement(Comp, { size: 16, active: false })) })

const nav = document.querySelector('nav')
const toolBtn = nav.querySelector('button[aria-label="工具"]')
const wait = async (ms) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
const pointer = (type, target, related) => target.dispatchEvent(new dom.window.PointerEvent(type, { bubbles: true, relatedTarget: related }))
const rowOf = (label) => [...nav.children].find((el) => (el.tagName === 'BUTTON' ? el : el.querySelector('button'))?.getAttribute('aria-label') === label)

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) pass++
  else fail++
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''))
}

// ⓪ 「更多」那一行的 order 必须足够大，永远排在所有面板行之后
check('「更多」排在最后（order 很大）', rowOptions && rowOptions.order >= 1000, rowOptions && String(rowOptions.order))

// ⓪ HMR 之后样式表要被更新，而不是"已存在就跳过"
check('热替换后样式表被更新', styleRefreshed)

// ① 收起其余面板行（保留第一行插件、排除宿主的「更多」）
const hiddenLabels = [...nav.children]
  .filter((el) => el.classList.contains('sfb-hidden'))
  .map((el) => (el.tagName === 'BUTTON' ? el : el.querySelector('button')).getAttribute('aria-label'))
check('收起其余面板行', JSON.stringify(hiddenLabels) === JSON.stringify(['插件市场', '自动化任务', '经验库', 'AstBot', '更多']), hiddenLabels.join(','))

// ② 悬停展开
await act(async () => { pointer('pointerover', toolBtn) })
await wait(200)
let acc = nav.querySelector('.sfb-acc')
check('悬停后行内展开', !!acc)
check('展开块没有被自己隐藏', acc && !acc.classList.contains('sfb-hidden'))
check('条目正确（4 个面板 + 宿主「更多」，没有设置入口）', acc && acc.querySelectorAll('.sfb-acc-item').length === 5,
  acc ? [...acc.querySelectorAll('.sfb-name')].map((el) => el.textContent).join(',') : '')

// ②b 指针从行滑到展开块（中间隔着 nav 的 2px 空隙）时，不能把展开块收掉
await act(async () => { pointer('pointerout', toolBtn, nav) })          // 经过空隙
const firstItem = acc && acc.querySelector('.sfb-acc-item')
if (firstItem) await act(async () => { pointer('pointerover', firstItem) })
await wait(350)
check('滑到展开项时不会自己收起', !!nav.querySelector('.sfb-acc'))

// ③ 移开收起
await act(async () => { pointer('pointerout', toolBtn, document.body) })
await wait(250)
check('移开后收起', !nav.querySelector('.sfb-acc'))

// ④ 右键 → 进插件自己的设置页
await act(async () => { toolBtn.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
check('右键选中插件自己的主页', selected[selected.length - 1] === 'sidebar-fold', selected.join(','))

// ⑤ 设置页：勾掉「经验库」→ 它留在外面，且写进 localStorage
if (!Settings) {
  check('设置页已注册到 main', false)
} else {
  check('设置页已注册到 main', true)
  const sroot = createRoot(document.getElementById('settings'))
  await act(async () => { sroot.render(React.createElement(Settings, {})) })
  const lines = [...document.querySelectorAll('#settings .sfb-line')]
  check('设置页列出所有面板', lines.length === 5, lines.map((l) => l.textContent).join(' | '))
  const line = lines.find((l) => l.textContent.includes('经验库'))
  const box = line && line.querySelector('input[type=checkbox]')
  check('经验库默认是收起的（未勾选）', box && box.checked === false)
  await act(async () => { box.click() })
  await wait(120)
  check('勾选后写入 localStorage', JSON.parse(dom.window.localStorage.getItem('dsh-sidebar-fold.keep') || '[]').includes('experience'))
  check('勾选后侧栏不再隐藏经验库', !rowOf('经验库').classList.contains('sfb-hidden'))
  check('其他面板仍然收起', rowOf('自动化任务').classList.contains('sfb-hidden'))
}

// ⑥ 列表里的「更多」= 宿主自己那一行：点它会触发宿主按钮，并且事后重新收起
await act(async () => { toolBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await wait(80)
acc = nav.querySelector('.sfb-acc')
const moreRow = nav.querySelector('button[aria-label="更多"]')
let moreFired = 0
moreRow.addEventListener('click', () => { moreFired++ })
const moreItem = acc && [...acc.querySelectorAll('.sfb-acc-item')].find((el) => el.querySelector('.sfb-name').textContent === '更多')
if (moreItem) await act(async () => { moreItem.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await wait(80)
const moreWrap = moreRow.closest('nav > *') || moreRow
check('点「更多」项会触发宿主按钮', moreFired === 1)
check('触发后宿主那一行重新收起', moreWrap.classList.contains('sfb-hidden') || moreRow.classList.contains('sfb-hidden'))

check('没有运行时错误', errors.length === 0, errors.join(' | '))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
