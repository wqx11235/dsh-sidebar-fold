// 在 jsdom 里跑真实组件：模拟宿主侧栏的面板列表，验证「收起 + 行内向下展开」
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

let mod = null
const errors = []
const windowStub = {
  __ModuleLoader__: { load: (o) => { mod = o.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require ' + n) }) } },
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
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

let Comp = null
mod.apply({ inject: (svc, cb) => cb({ slots: { inject: (n, f) => f(), register: (o, c) => { Comp = c; return () => {} } } }) })
if (!Comp) throw new Error('组件没注册上')

const root = createRoot(document.getElementById('slot'))
await act(async () => { root.render(React.createElement(Comp, { size: 16, active: false })) })

const nav = document.querySelector('nav')
const toolBtn = nav.querySelector('button[aria-label="工具"]')
const wait = async (ms) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
const pointer = (type, target, related) => target.dispatchEvent(new dom.window.PointerEvent(type, { bubbles: true, relatedTarget: related }))

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) pass++
  else fail++
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''))
}

// ① 收起其余面板行（保留第一行插件、排除宿主的「更多」）
const hiddenLabels = [...nav.children]
  .filter((el) => el.classList.contains('sfb-hidden'))
  .map((el) => (el.tagName === 'BUTTON' ? el : el.querySelector('button')).getAttribute('aria-label'))
check('收起其余面板行', JSON.stringify(hiddenLabels) === JSON.stringify(['插件市场', '自动化任务', '经验库', 'AstBot', '更多']), hiddenLabels.join(','))

// ② 悬停展开（120ms 延迟）
await act(async () => { pointer('pointerover', toolBtn) })
await wait(200)
let acc = nav.querySelector('.sfb-acc')
check('悬停后行内展开', !!acc)
check('展开块插在「工具」后面', acc && acc.previousElementSibling === toolBtn.parentElement)
check('展开块没有被自己隐藏', acc && !acc.classList.contains('sfb-hidden'))
check('条目正确', acc && acc.querySelectorAll('.sfb-acc-item').length === 4)

// ③ 移开收起（150ms 延迟）
await act(async () => { pointer('pointerout', toolBtn, document.body) })
await wait(250)
check('移开后收起', !nav.querySelector('.sfb-acc'))

// ④ 点击也能展开，点外面收起
await act(async () => { toolBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await wait(80)
check('点击展开', !!nav.querySelector('.sfb-acc'))
await act(async () => { document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await wait(80)
check('点外面收起', !nav.querySelector('.sfb-acc'))

// ⑤ 点展开项 → 转发给原面板行并收起
let fired = 0
const targetWrap = [...nav.children].find((el) => (el.tagName === 'BUTTON' ? el : el.querySelector('button'))?.getAttribute('aria-label') === '经验库')
const targetBtn = targetWrap.tagName === 'BUTTON' ? targetWrap : targetWrap.querySelector('button')
targetBtn.addEventListener('click', () => { fired++ })
await act(async () => { toolBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await wait(80)
acc = nav.querySelector('.sfb-acc')
const item = acc && [...acc.querySelectorAll('.sfb-acc-item')].find((el) => el.querySelector('.sfb-name').textContent === '经验库')
if (item) await act(async () => { item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await wait(80)
check('点展开项 → 原面板行收到 click', fired === 1)
check('点展开项后收起', !nav.querySelector('.sfb-acc'))

check('没有运行时错误', errors.length === 0, errors.join(' | '))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
