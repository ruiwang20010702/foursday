import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FoursdayControlService, controlServicePaths } from "./foursday-control-service.mjs";
import { foursdayNativeHermesLayout } from "./foursday-hermes-native-install.mjs";
import { isMainModule } from "./main-module.mjs";

const html = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foursday 状态</title><style nonce="NONCE">
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#17211d;background:#f4f6f4}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1080px;margin:auto;padding:32px 20px}header{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:20px}h1{font-size:28px;margin:0}.muted{color:#69736e}.pill{padding:7px 11px;border-radius:999px;background:#e1e8e4}.ok{color:#126443;background:#dff1e8}.paused{color:#72541a;background:#fff1ce}.bad{color:#8b352e;background:#f7e3e0}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{background:white;border:1px solid #dce2de;border-radius:14px;padding:16px;box-shadow:0 2px 10px #17211d0a}.card h2{font-size:14px;color:#69736e;margin:0 0 8px}.metric{font-size:28px;font-weight:700}.wide{grid-column:span 2}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-top:1px solid #e5e9e6;padding:9px 6px;overflow-wrap:anywhere}th{color:#69736e}button{border:1px solid #cfd7d2;background:white;border-radius:9px;padding:8px 11px;cursor:pointer}@media(max-width:760px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:span 2}}@media(max-width:480px){header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:12px}h1{white-space:nowrap}.grid{grid-template-columns:1fr}.wide{grid-column:span 1}th:first-child,td:first-child{width:58%}th:nth-child(n+3),td:nth-child(n+3){display:none}}
</style></head><body><main class="wrap"><header><div><h1>Foursday 状态</h1><div class="muted">Codex / Claude 的可选只读投影，不保存第二套状态</div></div><button id="refresh">刷新</button></header><section class="grid"><div class="card"><h2>整体</h2><div id="ready" class="pill">读取中</div></div><div class="card"><h2>DWS检查点</h2><div id="checkpoint" class="pill">读取中</div></div><div class="card"><h2>控制版本</h2><div id="revision" class="metric">—</div></div><div class="card"><h2>任务</h2><div id="tasksCount" class="metric">—</div></div><div class="card"><h2>已启用定时/主动</h2><div id="scheduleCount" class="metric">—</div></div><div class="card wide"><h2>任务</h2><table><thead><tr><th>项目</th><th>状态</th><th>Thread</th><th>更新</th></tr></thead><tbody id="tasks"></tbody></table></div><div class="card wide"><h2>运行证据</h2><div id="evidence" class="muted">—</div><h2 style="margin-top:18px">记忆</h2><div id="memory" class="muted">—</div></div></section></main><script nonce="NONCE">
const text=(id,value)=>document.getElementById(id).textContent=value;const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const taskStateLabels={active:'运行中',paused:'已暂停',taken_over:'已接管'};async function read(path){const r=await fetch(path,{headers:{accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error(path);return r.json()}function memoryLabel(m){const fixed=m.fixedBindings||{projectCount:Array.isArray(m.projects)?m.projects.length:0,pageCount:Array.isArray(m.projects)?new Set(m.projects.flatMap(x=>x.pages||[])).size:0};const discovery=m.discovery||{enabled:m.readEnabled,state:'unavailable',projectCount:null,truncated:false};const discovered=discovery.state==='ready'?(discovery.truncated?'至少 ':'')+discovery.projectCount+' 个项目':discovery.state==='disabled'?'未开启':'暂不可用';return (m.readEnabled?'读取开启':'读取关闭')+' · 固定绑定 '+fixed.projectCount+' 个范围 / '+fixed.pageCount+' 页 · gbrain 可发现 '+discovered}async function load(){try{const [s,t,c,m,e]=await Promise.all(['/api/status','/api/tasks','/api/schedules','/api/memory','/api/evidence'].map(read));const ready=document.getElementById('ready');const paused=s.control.state==='paused';ready.className='pill '+(paused?'paused':s.ready?'ok':'bad');ready.textContent=paused?'已暂停':s.ready?'运行正常':'需要处理';const checkpoint=document.getElementById('checkpoint');const checkpointLabels={healthy:'健康',busy_but_bounded:'检查中（有界）',stale:'已过期',failed:'失败'};const checkpointState=s.gateway.checkpointState||'stale';checkpoint.className='pill '+(checkpointState==='healthy'?'ok':checkpointState==='busy_but_bounded'?'paused':'bad');checkpoint.textContent=(checkpointLabels[checkpointState]||'未知')+' · 第'+(s.gateway.checkpointGeneration||0)+'代';text('revision',s.control.revision);text('tasksCount',t.items.length);text('scheduleCount',c.items.filter(x=>x.enabled).length+' / '+c.items.length);document.getElementById('tasks').innerHTML=t.items.slice(0,30).map(x=>'<tr><td>'+esc(x.projectId||'—')+'</td><td>'+esc(taskStateLabels[x.state]||x.state)+'</td><td>'+esc(x.codexThreadId?x.codexThreadId.slice(0,12):'—')+'</td><td>'+esc(x.updatedAt||'—')+'</td></tr>').join('')||'<tr><td colspan="4">暂无任务</td></tr>';text('evidence',e.count+'条 · '+(e.lastEventAt||'无近期事件'));text('memory',memoryLabel(m));}catch{const ready=document.getElementById('ready');ready.className='pill bad';ready.textContent='读取失败';const checkpoint=document.getElementById('checkpoint');checkpoint.className='pill bad';checkpoint.textContent='读取失败'}}document.getElementById('refresh').onclick=load;load();setInterval(load,30000);
</script></body></html>`;

function headers(nonce, type) {
  return {
    "cache-control": "no-store",
    "content-type": type,
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

export function createFoursdayControlSite({ service, host = "127.0.0.1", port = 9466 } = {}) {
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("Foursday status site must use a loopback host and valid port");
  }
  const nonce = randomBytes(18).toString("base64url");
  const routes = new Map([
    ["/api/status", () => service.status()],
    ["/api/tasks", () => service.tasks()],
    ["/api/schedules", () => service.schedules()],
    ["/api/memory", () => service.memory()],
    ["/api/evidence", () => service.evidence()],
  ]);
  const server = createServer(async (request, response) => {
    const hostHeader = String(request.headers.host ?? "");
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(hostHeader) || request.method !== "GET") {
      response.writeHead(403, headers(nonce, "text/plain; charset=utf-8"));
      response.end("forbidden");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${hostHeader}`);
    if (url.pathname === "/") {
      response.writeHead(200, headers(nonce, "text/html; charset=utf-8"));
      response.end(html.replaceAll("NONCE", nonce));
      return;
    }
    const route = routes.get(url.pathname);
    if (!route || url.search) {
      response.writeHead(404, headers(nonce, "application/json; charset=utf-8"));
      response.end('{"error":"not_found"}');
      return;
    }
    try {
      const value = await route();
      response.writeHead(200, headers(nonce, "application/json; charset=utf-8"));
      response.end(`${JSON.stringify(value)}\n`);
    } catch {
      response.writeHead(503, headers(nonce, "application/json; charset=utf-8"));
      response.end('{"error":"unavailable"}');
    }
  });
  return {
    async start() {
      await new Promise((accept, reject) => {
        server.once("error", reject);
        server.listen(port, host, accept);
      });
      const address = server.address();
      return { host, port: address.port, url: `http://${host}:${address.port}/`, readOnly: true };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}

export async function runFoursdayControlSite({
  projectRoot = fileURLToPath(new URL("../", import.meta.url)),
  environment = process.env,
  port = Number(environment.FOURSDAY_DASHBOARD_PORT ?? 9466),
} = {}) {
  const layout = foursdayNativeHermesLayout({ projectRoot });
  const service = new FoursdayControlService({ layout, ...controlServicePaths({ layout, environment }) });
  const site = createFoursdayControlSite({ service, port });
  const status = await site.start();
  const stop = async () => { await site.stop(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return status;
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runFoursdayControlSite())}\n`);
}
