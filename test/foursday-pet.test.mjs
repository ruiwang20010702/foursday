import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("macOS pet build is preview-first and remains an optional local companion", async () => {
  const { stdout } = await run(process.execPath, ["scripts/构建Foursday桌宠.mjs"], {
    cwd: new URL("../", import.meta.url),
  });
  const result = JSON.parse(stdout);
  assert.equal(result.apply, false);
  assert.equal(result.installed, false);
  assert.equal(result.productionWrite, false);
  assert.equal(result.messagesSent, 0);
  assert.match(result.output, /\.runtime\/foursday-pet\/Foursday Pet\.app$/u);
});

test("pet build refuses arbitrary output paths", async () => {
  await assert.rejects(
    run(process.execPath, ["scripts/构建Foursday桌宠.mjs", "--output", "/Applications/Other.app"], {
      cwd: new URL("../", import.meta.url),
    }),
    /Usage: 构建Foursday桌宠/u,
  );
});

test("pet reads only the loopback task projection and reuses Codex pet assets", async () => {
  const source = await readFile(new URL("../distribution/pet/macos/FoursdayPet.swift", import.meta.url), "utf8");
  assert.match(source, /127\.0\.0\.1:9466\/api\/status/u);
  for (const endpoint of ["status", "tasks", "schedules", "memory", "evidence"]) {
    assert.match(source, new RegExp(`read\\("${endpoint}"\\)`, "u"));
  }
  assert.match(source, /\.codex\/pets/u);
  assert.match(source, /FOURSDAY_PET_ID/u);
  assert.match(source, /\.codex\/config\.toml/u);
  assert.match(source, /selected-avatar-id/u);
  assert.match(source, /value\.hasPrefix\("custom:"\)/u);
  for (const state of [
    "idle",
    "runningRight",
    "runningLeft",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "working",
    "review",
  ]) {
    assert.match(source, new RegExp(`case ${state}\\b`, "u"));
  }
  assert.match(source, /\.onHover \{ model\.setHovering\(\$0\) \}/u);
  assert.match(source, /\.onTapGesture \{ model\.petTapped\(\) \}/u);
  assert.match(source, /func petTapped\(\) \{\s*expanded\.toggle\(\)\s*\}/u);
  assert.doesNotMatch(source, /func petTapped\(\) \{[\s\S]{0,120}trigger\(\.jumping/u);
  assert.match(source, /DragGesture\(minimumDistance: 4/u);
  assert.match(source, /translation\.width < 0 \? \.runningLeft : \.runningRight/u);
  assert.match(source, /let mouse = NSEvent\.mouseLocation/u);
  assert.match(source, /dragMouseOrigin = NSPoint/u);
  assert.match(source, /panelOrigin\.x \+ mouse\.x - mouseOrigin\.x/u);
  assert.match(source, /panelOrigin\.y \+ mouse\.y - mouseOrigin\.y/u);
  assert.doesNotMatch(source, /origin\.x \+ translation\.width/u);
  assert.doesNotMatch(source, /origin\.y - translation\.height/u);
  assert.match(source, /lifecycle == "accepted"/u);
  assert.doesNotMatch(source, /guard status\?\.ready == true/u);
  assert.match(source, /status\.gateway\.mode != "active" \|\| !status\.gateway\.sendEnabled/u);
  assert.match(source, /item\.state != "taken_over"/u);
  assert.match(source, /status\.gateway\.sendBlocked == true \|\| status\.gateway\.modeConsistent == false/u);
  assert.match(source, /case \.idle: 1/u);
  assert.match(source, /case \.waving: 4/u);
  assert.match(source, /case \.jumping: 5/u);
  assert.match(source, /case \.waiting, \.working, \.review: 6/u);
  assert.match(source, /reduceMotion \|\| state == \.idle/u);
  assert.match(source, /display: false, animate: false/u);
  assert.doesNotMatch(source, /transition\(\.move\(edge:/u);
  assert.doesNotMatch(source, /\.animation\([^\n]*value: model\.expanded/u);
  assert.doesNotMatch(source, /\.regularMaterial/u);
  assert.match(source, /Color\(nsColor: \.windowBackgroundColor\)\.opacity\(0\.98\)/u);
  assert.match(source, /scanPopulatedColumns\(in: cgImage, rows: rows\)/u);
  assert.match(source, /CGImageAlphaInfo\.premultipliedLast/u);
  assert.match(source, /stride\(from: 3, to: rgba\.count, by: 4\)/u);
  assert.match(source, /populatedColumns\[state\.row\]\.filter \{ \$0 < state\.frameLimit \}/u);
  assert.match(source, /% animationColumns\.count/u);
  assert.match(source, /frame\(column: animationColumns\[index\]\)/u);
  assert.match(source, /let entered = hovering && !isHovering/u);
  assert.match(source, /trigger\(\.waving, for: \.milliseconds\(840\)\)/u);
  assert.doesNotMatch(source, /interactionState = isHovering \? \.waving : nil/u);
  assert.doesNotMatch(source, /https:\/\//u);
  assert.doesNotMatch(source, /DWS|token|password|DATABASE_URL/u);
});

test("pet worksite groups tasks and reuses revision-fenced local controls", async () => {
  const source = await readFile(new URL("../distribution/pet/macos/FoursdayPet.swift", import.meta.url), "utf8");
  assert.match(source, /Foursday 工作现场/u);
  assert.match(source, /case \.working: "AI负责"/u);
  assert.match(source, /case \.recent: "最近完成"/u);
  assert.match(source, /历史任务 ·/u);
  assert.match(source, /projectGroupName/u);
  assert.match(source, /未归档记录/u);
  assert.match(source, /正在识别 ·/u);
  assert.match(source, /assignmentState == "legacy_unassigned" \{ return "未归档" \}/u);
  assert.match(source, /WorksiteProjectList/u);
  assert.match(source, /projectGroups\(\)/u);
  assert.match(source, /toggleProject\(project\.id\)/u);
  assert.match(source, /collapsedProjectIds\.contains\(project\.id\)/u);
  assert.match(source, /"chevron\.right" : "chevron\.down"/u);
  assert.doesNotMatch(source, /model\.selectedGroup == group/u);
  assert.match(source, /dateFormat = "M月d日 HH:mm"/u);
  assert.match(source, /case needsMe = "needs_me"/u);
  assert.match(source, /case working/u);
  assert.match(source, /case recent/u);
  for (const command of ["pause-task", "resume-task", "communication-takeover", "takeover-task"]) {
    assert.match(source, new RegExp(`"${command}"`, "u"));
  }
  assert.match(source, /"--revision", String\(tasksRevision\)/u);
  assert.match(source, /"--task", task\.taskId/u);
  assert.match(source, /codex:\/\/threads\//u);
  assert.match(source, /责任关系/u);
  assert.match(source, /请求人：历史记录未保留联系人/u);
  assert.match(source, /执行者：/u);
  assert.match(source, /任务计划尚未生成，验收证据暂未开始统计/u);
  assert.match(source, /Codex 会话已经建立，但这条历史任务尚未生成目标、交付物与验收计划/u);
  assert.match(source, /复制独立会话编号/u);
  assert.match(source, /不会出现在主 Codex 侧边栏/u);
  assert.doesNotMatch(source, /历史任务没有可展示的 Codex 活动/u);
  assert.match(source, /activityTrail/u);
  assert.match(source, /missingEvidence/u);
  assert.match(source, /后台继续处理/u);
  assert.match(source, /当前会话内处理/u);
  assert.match(source, /item\.userState\?\.title/u);
  assert.match(source, /status\.experience/u);
  assert.match(source, /后台排队/u);
  assert.match(source, /同一 Codex Thread 正在后台继续执行/u);
  assert.match(source, /设置与系统诊断/u);
  assert.match(source, /返回工作现场/u);
  assert.match(source, /SystemDiagnosticsView/u);
  assert.match(source, /process\.environment = foursdayProcessEnvironment\(\)/u);
  assert.match(source, /process\.executableURL = node/u);
  assert.match(source, /process\.arguments = \[executable\.path, "dashboard", "--port", "9466"\]/u);
  assert.match(source, /process\.arguments = \[executable\.path\] \+ arguments/u);
  assert.match(source, /private func locateNode\(\)/u);
  assert.match(source, /resolvingSymlinksInPath\(\)/u);
  assert.match(source, /process\.standardOutput = FileHandle\.nullDevice/u);
  assert.match(source, /process\.standardError = FileHandle\.nullDevice/u);
  assert.match(source, /home \+ "\/\.local\/bin"/u);
  assert.match(source, /"\/opt\/homebrew\/opt\/node@24\/bin"/u);
  assert.match(source, /"\/opt\/homebrew\/bin"/u);
  assert.doesNotMatch(source, /process\.environment\s*=\s*ProcessInfo\.processInfo\.environment/u);
  assert.match(source, /DisclosureGroup\("技术详情"/u);
  assert.match(source, /@State private var technicalDetailsExpanded = false/u);
  assert.match(source, /试用中，不会自动回复|当前不会自动回复钉钉消息/u);
  assert.match(source, /钉钉连接/u);
  assert.match(source, /Codex工作环境/u);
  assert.match(source, /消息同步/u);
  assert.match(source, /个人记忆/u);
  assert.match(source, /当前版本/u);
  assert.match(source, /运行证据/u);
  assert.match(source, /主动工作/u);
  assert.match(source, /在Codex中检查Foursday状态/u);
  assert.match(source, /浏览器页面只在桌宠不可用或非macOS环境/u);
  assert.match(source, /if !expanded \{ showingDiagnostics = false \}/u);
  assert.match(source, /正在重新连接Foursday工作服务/u);
  assert.match(source, /SchedulesEnvelope\? = try\? read\("schedules"\)/u);
  assert.match(source, /MemoryEnvelope\? = try\? read\("memory"\)/u);
  assert.match(source, /EvidenceEnvelope\? = try\? read\("evidence"\)/u);
  assert.doesNotMatch(source, /URLRequest\([\s\S]*httpMethod\s*=\s*"POST"/u);
  assert.doesNotMatch(source, /raw reasoning|chain.?of.?thought/iu);
});
