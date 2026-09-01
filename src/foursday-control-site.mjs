import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FoursdayControlService, controlServicePaths } from "./foursday-control-service.mjs";
import { foursdayNativeHermesLayout } from "./foursday-hermes-native-install.mjs";
import { isMainModule } from "./main-module.mjs";

const html = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foursday 只读应急状态</title><style nonce="NONCE">
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#17211d;background:#f1f3ef;--ink:#17211d;--muted:#6f7772;--line:#d8ded9;--paper:#fffefa;--green:#1f765d;--green-soft:#dcece5;--amber:#9b6b18;--amber-soft:#f8eccd;--red:#9b4238;--red-soft:#f4dfdc}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(180deg,#edf1ec 0,#f7f6f1 46%,#efeee8 100%)}button{font:inherit}.wrap{max-width:1120px;margin:auto;padding:42px 24px 96px}header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:24px;border-bottom:1px solid var(--line)}h1{font-size:clamp(30px,5vw,52px);line-height:.98;letter-spacing:-.055em;margin:0;max-width:650px}header p{max-width:520px;margin:12px 0 0;color:var(--muted);line-height:1.55}.refresh{border:1px solid #cbd3cd;background:var(--paper);border-radius:999px;padding:9px 15px;color:var(--ink);cursor:pointer}.refresh:hover{border-color:var(--green);color:var(--green)}.refresh:focus-visible,.pet:focus-visible,.close:focus-visible{outline:3px solid #67a892;outline-offset:3px}.metrics{display:grid;grid-template-columns:1.25fr repeat(3,1fr);border-bottom:1px solid var(--line)}.metric{padding:25px 18px 22px;border-right:1px solid var(--line)}.metric:first-child{padding-left:0}.metric:last-child{border-right:0}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:9px}.value{font-size:25px;font-weight:720;letter-spacing:-.03em}.pill{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:7px 11px;font-size:14px;background:#e4e8e4}.pill:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.ok{color:#176149;background:var(--green-soft)}.paused{color:#765513;background:var(--amber-soft)}.bad{color:#903b32;background:var(--red-soft)}.content{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.85fr);gap:34px;padding-top:34px}.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:14px}.section-head h2{margin:0;font-size:20px;letter-spacing:-.025em}.count{color:var(--muted);font-size:13px}.task-list{border-top:1px solid var(--line)}.task-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:18px 2px;border-bottom:1px solid var(--line)}.task-title{font-weight:680;letter-spacing:-.015em}.task-goal{margin-top:6px;color:var(--muted);font-size:14px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.task-meta{display:flex;flex-wrap:wrap;gap:7px 12px;margin-top:9px;font-size:12px;color:var(--muted)}.state{align-self:start;border:1px solid var(--line);border-radius:999px;padding:5px 9px;font-size:12px;white-space:nowrap}.aside{border-left:1px solid var(--line);padding-left:30px}.aside-block{padding:0 0 25px;margin-bottom:25px;border-bottom:1px solid var(--line)}.aside-block:last-child{border-bottom:0}.aside h2{font-size:14px;margin:0 0 10px;color:var(--muted)}.aside strong{display:block;font-size:18px;margin-bottom:5px}.muted{color:var(--muted);font-size:13px;line-height:1.55}.pet{position:fixed;right:26px;bottom:24px;width:82px;height:82px;border:1px solid #c9d2cc;border-radius:26px;background:var(--paper);box-shadow:0 16px 36px #17211d26;cursor:pointer;z-index:20;display:grid;place-items:center;transition:transform .2s ease,box-shadow .2s ease}.pet:hover{transform:translateY(-3px);box-shadow:0 20px 40px #17211d30}.pet-mark{width:46px;height:46px;display:grid;grid-template-columns:1fr 1fr;gap:7px}.pet-mark i{display:block;border-radius:8px;background:var(--green)}.pet-mark i:last-child{position:relative;background:#eef3f0;border:2px solid var(--green)}.pet-mark i:last-child:after{content:"→";position:absolute;inset:-4px 0 0;display:grid;place-items:center;color:var(--green);font-size:19px;font-style:normal;font-weight:800}.pet-badge{position:absolute;right:-5px;top:-5px;min-width:24px;height:24px;border-radius:12px;padding:0 6px;background:var(--red);color:white;border:3px solid #f1f3ef;font-size:11px;font-weight:700;display:grid;place-items:center}.pet[data-state="running"] .pet-mark{animation:work 1.6s ease-in-out infinite}.pet[data-state="waiting"]{animation:wait 2.4s ease-in-out infinite}.pet[data-state="review"]{box-shadow:0 0 0 6px var(--amber-soft),0 16px 36px #17211d26}.pet[data-state="failed"]{box-shadow:0 0 0 6px var(--red-soft),0 16px 36px #17211d26}.scrim{position:fixed;inset:0;background:#10201955;opacity:0;pointer-events:none;transition:opacity .22s ease;z-index:29}.drawer{position:fixed;right:0;top:0;width:min(440px,94vw);height:100vh;background:var(--paper);border-left:1px solid var(--line);box-shadow:-20px 0 55px #17211d24;transform:translateX(104%);transition:transform .25s ease;z-index:30;padding:28px 24px;overflow:auto}.drawer.open{transform:none}.scrim.open{opacity:1;pointer-events:auto}.drawer-head{display:flex;justify-content:space-between;align-items:start;gap:18px;padding-bottom:20px;border-bottom:1px solid var(--line)}.drawer h2{margin:0;font-size:28px;letter-spacing:-.045em}.close{border:0;background:#edf0ed;border-radius:50%;width:34px;height:34px;cursor:pointer}.drawer-list{display:grid;gap:0}.drawer-card{padding:18px 0;border-bottom:1px solid var(--line)}.drawer-card h3{font-size:16px;margin:0 0 6px}.drawer-card p{margin:0;color:var(--muted);font-size:13px;line-height:1.5}.drawer-card ul{margin:10px 0 0;padding-left:18px;font-size:12px;color:var(--muted)}.drawer-empty{padding:40px 0;color:var(--muted)}@keyframes work{50%{transform:translateY(-3px) scale(1.03)}}@keyframes wait{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.pet,.pet-mark,.drawer,.scrim{animation:none!important;transition:none!important}}@media(max-width:760px){.wrap{padding:28px 18px 100px}header{align-items:start}.metrics{grid-template-columns:1fr 1fr}.metric{border-bottom:1px solid var(--line)}.metric:nth-child(2){border-right:0}.content{grid-template-columns:1fr}.aside{border-left:0;padding-left:0}.pet{right:18px;bottom:18px}}
</style></head><body><main class="wrap"><header><div><h1>只读应急状态</h1><p>仅在桌宠不可用或非macOS环境下使用。此页读取与桌宠相同的Control服务，不维护第二套状态，也不提供控制写入口。</p></div><button class="refresh" id="refresh">刷新状态</button></header><section class="metrics"><div class="metric"><div class="eyebrow">运行状态</div><div id="ready" class="pill">读取中</div></div><div class="metric"><div class="eyebrow">当前任务</div><div id="tasksCount" class="value">—</div></div><div class="metric"><div class="eyebrow">需要关注</div><div id="attentionCount" class="value">—</div></div><div class="metric"><div class="eyebrow">控制版本</div><div id="revision" class="value">—</div></div></section><section class="content"><div><div class="section-head"><h2>任务流</h2><span id="taskHint" class="count">读取中</span></div><div id="tasks" class="task-list"></div></div><aside class="aside"><div class="aside-block"><h2>DWS 检查点</h2><strong id="checkpoint">读取中</strong><div class="muted">消息入口、历史恢复与发送边界使用同一检查点。</div></div><div class="aside-block"><h2>证据</h2><strong id="evidence">—</strong><div class="muted">任务结论仍需真实文件、工具、测试或投递回读。</div></div><div class="aside-block"><h2>个人记忆</h2><div id="memory" class="muted">—</div></div><div class="aside-block"><h2>主动工作</h2><div id="schedules" class="muted">—</div></div></aside></section></main><button id="pet" class="pet" type="button" aria-label="打开Foursday任务" aria-expanded="false" data-state="idle" hidden><span class="pet-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span id="petBadge" class="pet-badge" hidden>0</span></button><div id="scrim" class="scrim" hidden></div><aside id="drawer" class="drawer" aria-hidden="true" aria-labelledby="drawerTitle" hidden><div class="drawer-head"><div><div class="eyebrow">Foursday</div><h2 id="drawerTitle">现在由我负责</h2></div><button id="close" class="close" type="button" aria-label="关闭任务抽屉">×</button></div><div id="drawerList" class="drawer-list"></div></aside><script nonce="NONCE">
const byId=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lifecycleLabels={intake:'接单中',planning:'规划中',working:'执行中',verifying:'验证中',waiting_acceptance:'等待验收',rework_requested:'返工中',escalated:'需要协助',failed:'失败',accepted:'已验收'};
const controlLabels={active:'运行中',paused:'已暂停',taken_over:'已接管'};
const needsAttention=task=>task.state!=='taken_over'&&(Boolean(task.pendingIntervention)||['waiting_acceptance','escalated','rework_requested','failed'].includes(task.taskContract?.lifecycleState));
const gatewayFault=status=>status.gateway.sendBlocked===true||status.gateway.modeConsistent===false||['failed','error','blocked','unknown_send'].includes(status.gateway.checkpointState);
async function read(path){const response=await fetch(path,{headers:{accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error(path);return response.json()}
function taskTime(task){const date=new Date(task.taskContract?.updatedAt||task.updatedAt||'');return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date):'时间未知'}
function taskTitle(task){return task.taskContract?.title||task.summaryTitle||(task.projectName||'未识别项目')+' · '+taskTime(task)}
function taskLifecycle(task){return task.taskContract?.lifecycleState||task.state}
function taskLabel(task){return lifecycleLabels[taskLifecycle(task)]||controlLabels[task.state]||taskLifecycle(task)}
function taskRows(tasks){return tasks.map(task=>'<article class="task-row"><div><div class="task-title">'+esc(taskTitle(task))+'</div><div class="task-goal">'+esc(task.taskContract?.goal||task.execution?.planSummary||'历史任务尚无语义标题；新任务进入Codex后会自动补齐。')+'</div><div class="task-meta"><span>'+esc(task.projectName||'待选择项目')+'</span><span>'+esc(task.execution?.mode==='background'?'耐久后台 · '+task.execution.state:(task.taskContract?.updatedAt||task.updatedAt||'—'))+'</span><span>证据 '+esc(task.taskContract?.evidenceCounts?.verified||0)+' 已验证 / '+esc(task.taskContract?.evidenceCounts?.missing||0)+' 缺失</span></div></div><span class="state">'+esc(taskLabel(task))+'</span></article>').join('')||'<div class="drawer-empty">暂无活动任务</div>'}
function drawerRows(tasks){return tasks.map(task=>{const contract=task.taskContract;const criteria=contract?.acceptanceCriteria||[];return '<article class="drawer-card"><h3>'+esc(taskTitle(task))+'</h3><p>'+esc(contract?.goal||'等待Codex形成任务合同')+'</p><div class="task-meta"><span>'+esc(taskLabel(task))+'</span><span>'+esc(task.projectId||'待路由')+'</span></div>'+(criteria.length?'<ul>'+criteria.slice(0,4).map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul>':'')+'</article>'}).join('')||'<div class="drawer-empty">目前没有需要展示的任务。</div>'}
function memoryLabel(memory){const fixed=memory.fixedBindings||{projectCount:0,pageCount:0};const discovery=memory.discovery||{state:'unavailable'};const discovered=discovery.state==='ready'?(discovery.truncated?'至少 ':'')+discovery.projectCount+' 个项目':discovery.state==='disabled'?'未开启':'暂不可用';return (memory.readEnabled?'读取开启':'读取关闭')+' · 固定 '+fixed.projectCount+' 个范围 / '+fixed.pageCount+' 页 · 可发现 '+discovered}
function petState(status,tasks){if(gatewayFault(status)||tasks.some(task=>task.taskContract?.lifecycleState==='failed'))return'failed';if(tasks.some(needsAttention))return tasks.some(task=>task.taskContract?.lifecycleState==='waiting_acceptance')?'review':'waiting';if(status.gateway.mode!=='active'||status.gateway.sendEnabled!==true||status.gateway.running!==true)return'idle';if(tasks.some(task=>task.state==='active'))return'running';return'idle'}
async function load(){try{const [status,tasks,schedules,memory,evidence]=await Promise.all(['/api/status','/api/tasks','/api/schedules','/api/memory','/api/evidence'].map(read));const paused=status.control.state==='paused';const stopped=status.gateway.running!==true;const shadow=status.gateway.mode==='shadow';const fault=gatewayFault(status);const ready=byId('ready');ready.className='pill '+(paused||stopped||shadow?'paused':status.ready&&!fault?'ok':'bad');ready.textContent=paused?'已暂停':fault?'运行异常':stopped?'未运行':shadow?'影子运行':status.ready?'运行正常':'需要处理';const checkpointLabels={healthy:'健康',busy_but_bounded:'有界检查中',stale:stopped?'未运行':'已过期',failed:'失败'};byId('checkpoint').textContent=(checkpointLabels[status.gateway.checkpointState]||'未知')+' · 第'+(status.gateway.checkpointGeneration||0)+'代';byId('revision').textContent=status.control.revision;byId('tasksCount').textContent=tasks.items.length;const attention=tasks.items.filter(needsAttention).length;byId('attentionCount').textContent=attention;byId('taskHint').textContent=tasks.items.length+' 项 · '+attention+' 项需要关注';byId('tasks').innerHTML=taskRows(tasks.items);byId('drawerList').innerHTML=drawerRows(tasks.items);byId('evidence').textContent=evidence.count+' 条运行证据';byId('memory').textContent=memoryLabel(memory);byId('schedules').textContent=schedules.items.filter(item=>item.enabled).length+' 个启用 / '+schedules.items.length+' 个总计';const pet=byId('pet');pet.dataset.state=petState(status,tasks.items);const badge=byId('petBadge');badge.hidden=attention===0;badge.textContent=attention>99?'99+':attention}catch{const ready=byId('ready');ready.className='pill bad';ready.textContent='读取失败';byId('checkpoint').textContent='读取失败';byId('pet').dataset.state='failed'}}
function toggle(open){byId('drawer').classList.toggle('open',open);byId('scrim').classList.toggle('open',open);byId('drawer').setAttribute('aria-hidden',String(!open));byId('pet').setAttribute('aria-expanded',String(open));if(open)byId('close').focus()}
byId('pet').onclick=()=>toggle(true);byId('close').onclick=()=>toggle(false);byId('scrim').onclick=()=>toggle(false);document.addEventListener('keydown',event=>{if(event.key==='Escape')toggle(false)});byId('refresh').onclick=load;load();setInterval(load,30000);
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
