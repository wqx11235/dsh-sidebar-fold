// 本地诊断接收端：插件在渲染进程里用 <img> 打一个 GET 过来，这里落盘。
// 用途：宿主/沙箱里读不到 localStorage，用它把插件内部状态带出来。
import http from 'node:http'
import fs from 'node:fs'

const LOG = new URL('./diag.log', import.meta.url)
fs.writeFileSync(LOG, '# sfb diag log\n')

http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1')
    const raw = u.searchParams.get('d') || ''
    let parsed = raw
    try { parsed = JSON.stringify(JSON.parse(raw)) } catch { /* 原样记 */ }
    fs.appendFileSync(LOG, new Date().toISOString() + '\t' + parsed + '\n')
  } catch { /* 忽略 */ }
  res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
  res.end()
}).listen(18555, '127.0.0.1', () => console.log('sfb diag server listening on 127.0.0.1:18555'))
