/* Privileged window; its application object is passed through window.arguments. */
window.addEventListener("DOMContentLoaded", () => {
const app = window.arguments[0];
const element = id => document.getElementById(id);
let settings, plan = null, task = null, timer = null;
const show = value => { element("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
function readablePlan(value) {
  const targetNames = new Map(app.library.listTargets().map(t => [t.key, t.label]));
  const labels = { "create-link": "新增 / New", "reuse-link": "复用 / Reuse", conflict: "冲突 / Conflict" };
  const lines = [];
  for (const scan of value.scans) {
    const rule = settings.rules.find(r => r.id === scan.ruleId);
    const target = targetNames.get(rule.target.collectionKey) || "Missing collection / 分类失效";
    lines.push(`规则 / Rule: ${rule.name}`, `源 / Source: ${scan.root || settings.bindings[rule.id].sourceRoot}`, `目标 / Target: ${target}`, "");
    for (const kb of scan.knowledgeBases) lines.push(`知识库 / Knowledge base: ${kb.path}`);
    lines.push("分类树 / Collection tree:");
    for (const parts of scan.directories) lines.push(`  ${target}${parts.length ? " / " + parts.join(" / ") : ""}`);
    lines.push("文件 / Files:");
    for (const action of value.actions.filter(a => a.ruleId === rule.id && a.path)) {
      lines.push(`  [${labels[action.type] || action.type}] ${action.relativePath}`, `    → ${target}${action.collectionParts.length ? " / " + action.collectionParts.join(" / ") : ""}`);
      if (action.kbRoot) lines.push(`    知识库 / KB: ${action.kbRoot}`);
    }
    for (const warning of scan.warnings) lines.push(`提示 / Note: ${warning.path} — ${warning.code === "PAPERS_DIRECTORY_MISSING" ? "raw/papers 尚未创建 / paper folder not yet created" : "知识库结构未完整 / incomplete KB structure"}`);
    for (const skip of scan.skipped) lines.push(`跳过 / Skipped: ${skip.path} (${({ SYMLINK_SKIPPED: "符号链接 / symbolic link", EXCLUDED: "排除目录 / excluded folder", CONTENT_DIRECTORY_NOT_DIRECTORY: "内容标记不是目录 / content marker is not a folder" })[skip.reason] || skip.reason})`);
    lines.push("");
  }
  for (const error of value.errors) lines.push(`错误 / Error: ${error.path || error.ruleId || ""} — ${error.message}`);
  return lines.join("\n");
}
function readableJob(job) {
  const result = job.result || job.progress;
  const lines = [`开始时间 / Started: ${job.createdAt}`, `状态 / Status: ${job.status}`];
  if (result) {
    lines.push(`新增 / Created: ${result.created} · 复用 / Reused: ${result.reused} · 补充分类 / Added classifications: ${result.collectionsAdded}`, `元数据待处理 / Metadata pending: ${result.metadataPending}`);
    for (const item of result.items) lines.push(`${item.status === "created" ? "新增 / Created" : "复用 / Reused"}: ${item.path}`);
    for (const error of result.errors) lines.push(`错误 / Error: ${error.path || error.ruleId || ""} — ${error.message}`);
  }
  if (job.error) lines.push(job.error.message);
  return lines.join("\n");
}
const guarded = fn => async () => { try { element("message").textContent = ""; await fn(); } catch (error) { element("message").textContent = `${error.code || "ERROR"}: ${error.message}`; } };
function invalidate() { plan = null; element("apply").disabled = true; }
async function refresh() {
  settings = await app.engine.settings();
  const targets = app.library.listTargets();
  element("rules").replaceChildren(); element("target").replaceChildren();
  for (const target of targets) { const option = document.createElement("option"); option.value = target.key; option.textContent = target.label; element("target").append(option); }
  for (const rule of settings.rules) {
    const row = document.createElement("tr"), enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = rule.enabled;
    const checkbox = document.createElement("td"); checkbox.append(enabled); row.append(checkbox);
    for (const value of [rule.name, settings.bindings[rule.id].sourceRoot, targets.find(t => t.key === rule.target.collectionKey)?.label || "Missing target / 分类失效", rule.scan.mode]) {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    }
    const actions = document.createElement("td");
    for (const [label, handler] of [
      ["Edit / 编辑", () => edit(rule)],
      ["Preview / 预览", () => preview([rule.id])],
      ["Remove / 移除", async () => {
        if (!window.confirm(`Remove rule ${rule.name}? Zotero items and files stay in place. / 移除规则？文件与条目保留。`)) return;
        settings.rules = settings.rules.filter(r => r.id !== rule.id); delete settings.bindings[rule.id];
        await app.engine.saveSettings(settings); invalidate(); await refresh();
      }]
    ]) { const button = document.createElement("button"); button.textContent = label; button.onclick = guarded(handler); actions.append(button); }
    enabled.onchange = guarded(async () => { rule.enabled = enabled.checked; await app.engine.saveSettings(settings); invalidate(); await refresh(); });
    row.append(actions); element("rules").append(row);
  }
  const state = await app.store.read();
  element("connection").textContent = app.endpoints.length ? `Connection file / 连接文件:\n${app.connectionPath}` : app.apiError || "Local service disabled / 本地服务关闭";
  if (!task && Object.keys(state.jobs).length) show(Object.values(state.jobs).slice(-10).map(readableJob).join("\n\n"));
}
function edit(rule = null) {
  element("details").style.display = "block";
  element("rule-id").value = rule?.id || `rule-${Date.now().toString(36)}`;
  element("name").value = rule?.name || ""; element("source").value = rule ? settings.bindings[rule.id].sourceRoot : "";
  element("mode").value = rule?.scan.mode || "directory-tree"; element("entry").value = rule?.scan.entry || "project-tree";
  element("layout").value = rule?.layout.mode || "mirror"; element("empty").checked = rule?.layout.includeEmptyDirectories === true;
  element("recognize").checked = rule?.recognition.enabled === true; element("exclude").value = rule?.scan.excludeDirectoryNames.join(",") || "tmp,node_modules,__pycache__";
  if (rule) element("target").value = rule.target.collectionKey;
  modeChanged();
}
function modeChanged() {
  const kb = element("mode").value === "knowledge-base";
  element("entry").disabled = !kb; element("layout").disabled = kb; element("empty").disabled = kb;
  if (kb) { element("layout").value = "mirror"; element("empty").checked = true; }
}
async function preview(ruleIds = null) {
  invalidate(); plan = await app.engine.createPlan({ ruleIds });
  // Each file displays its exact KB root and collection chain in this preview.
  show(readablePlan(plan)); element("apply").disabled = false;
  element("message").textContent = `${plan.scans.reduce((n, s) => n + s.files.length, 0)} PDF · ${plan.errors.length} errors / 个错误`;
}
async function poll() {
  if (!task) return;
  const job = (await app.store.read()).jobs[task.id]; if (!job) return;
  show(readableJob(job));
  if (["queued", "running"].includes(job.status)) timer = window.setTimeout(() => guarded(poll)(), 500);
  else { task = null; element("cancel").disabled = true; element("preview").disabled = false; }
}
element("add").onclick = guarded(() => edit()); element("reload").onclick = guarded(refresh);
element("choose").onclick = guarded(async () => { const path = await app.pickFolder(window); if (path) element("source").value = path; });
element("mode").onchange = modeChanged; element("discard").onclick = () => { element("details").style.display = "none"; };
element("save").onclick = guarded(async () => {
  const id = element("rule-id").value, old = settings.rules.find(r => r.id === id);
  const mode = element("mode").value;
  const rule = { id, name: element("name").value, enabled: old?.enabled ?? true,
    target: { library: "user", collectionKey: element("target").value },
    scan: { mode, entry: element("entry").value, excludeDirectoryNames: element("exclude").value.split(",").map(s => s.trim()).filter(Boolean) },
    layout: { mode: element("layout").value, profile: mode === "knowledge-base" ? "research-kb/v1" : "directory/v1", includeEmptyDirectories: element("empty").checked },
    recognition: { enabled: element("recognize").checked } };
  settings.rules = [...settings.rules.filter(r => r.id !== id), rule]; settings.bindings[id] = { sourceRoot: element("source").value };
  await app.engine.saveSettings(settings); invalidate(); element("details").style.display = "none"; await refresh();
});
element("preview").onclick = guarded(() => preview());
element("apply").onclick = guarded(async () => {
  if (!plan) return;
  if (!window.confirm("Apply the displayed plan? / 执行当前显示的预览计划？")) return;
  task = await app.startJob(plan.id); invalidate(); element("cancel").disabled = false; element("preview").disabled = true; await poll();
});
element("cancel").onclick = guarded(() => { if (task) app.cancellations.add(task.id); });
element("legacy").onclick = guarded(async () => { show(await app.migrateLegacy()); invalidate(); await refresh(); element("message").textContent = "Imported as a paused rule. Review its directory and collection before enabling. / 已导入暂停规则，请核对目录和分类后启用。"; });
element("api").onclick = guarded(async () => { await app.enableAPI(); await refresh(); });
element("api-off").onclick = guarded(async () => { app.disableAPI(); await refresh(); });
window.addEventListener("unload", () => window.clearTimeout(timer));
guarded(refresh)();
}, { once: true });
