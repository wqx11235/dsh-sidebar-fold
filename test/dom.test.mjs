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
const windowStub = { __ModuleLoader__: { load: (o) => { mod = o.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require ' + n) }) } } }
const errors = []
vm.runInContext(code, vm.createContext({
  window: Object.assign(windowStub, { MutationObserver: dom.window.MutationObserver, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), matchMedia: dom.window.matchMedia?.bind(dom.window) }),
  navigator: { language: 'zh-CN' }, document: dom.window.document,
  setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), queueMicrotask,
  console: { error: (...a) => errors.push(String(a[0])), log: console.log },
}))

let Comp = null
mod.apply({ inject: (svc, cb) => cb({ slots: { inject: (n, f) => f(), register: (o, c) => { Comp = c; return () => {} } } }) })
if (!Comp) throw new Error('组件没注册上')

const root = createRoot(document.getElementById('slot'))
await act(async () => { root.render(React.createElement(Comp, { size: 16, active: false })) })

const nav = document.querySelector('nav')
const rows = [...nav.querySelectorAll('button[aria-label]')]
const hidden = rows.filter((b) => b.closest('.rowwrap, nav')?.classList?.contains('sfb-hidden') || b.parentElement?.classList?.contains('sfb-hidden'))
console.log('① 收起：被隐藏的行 =', [...nav.children].filter((el) => el.classList.contains('sfb-hidden')).map((el) => (el.tagName === 'BUTTON' ? el : el.querySelector('button')).getAttribute('aria-label')))

const toolBtn = nav.querySelector('button[aria-label="工具"]')

// ② 点击那一行 → 展开
await act(async () => { toolBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 250)) })   // 等 observer/sync 跑完一轮
const acc = nav.querySelector('.sfb-acc')
console.log('② 点击后展开块存在 =', !!acc)
if (acc) {
  console.log('   插在谁后面 =', acc.previousElementSibling?.querySelector('button')?.getAttribute('aria-label'))
  console.log('   条目 =', [...acc.querySelectorAll('.sfb-acc-item')].map((el) => el.querySelector('.sfb-name').textContent))
  console.log('   在 nav 里（计入布局） =', acc.parentElement === nav)
  console.log('   ⚠ 有没有被自己隐藏 =', acc.classList.contains('sfb-hidden'), '（必须是 false）')
  console.log('   ⚠ 条目数是否稳定 =', acc.querySelectorAll('.sfb-acc-item').length === 4, '（必须是 true）')
}

// ③ 点外面 → 收起
await act(async () => { document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
console.log('③ 点外面后展开块还在 =', !!nav.querySelector('.sfb-acc'))

// ④ 再点开，点展开项 → 转发给原面板行并收起
let fired = 0
const targetWrap = [...nav.children].find((el) => (el.tagName === 'BUTTON' ? el : el.querySelector('button'))?.getAttribute('aria-label') === '经验库')
const targetBtn = targetWrap.tagName === 'BUTTON' ? targetWrap : targetWrap.querySelector('button')
targetBtn.addEventListener('click', () => { fired++ })
await act(async () => { toolBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
const acc2 = nav.querySelector('.sfb-acc')
const item = acc2 && [...acc2.querySelectorAll('.sfb-acc-item')].find((el) => el.querySelector('.sfb-name').textContent === '经验库')
if (item) await act(async () => { item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
console.log('④ 点展开项 → 原面板行收到 click =', fired, '；展开块已收起 =', !nav.querySelector('.sfb-acc'))
console.log('运行时错误 =', errors)
