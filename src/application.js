var FolderSyncApplication = class {
  constructor({ id, version, rootURI }) { Object.assign(this, { id, version, rootURI }); this.windows = new Map(); this.endpoints = []; this.cancellations = new Set(); }
  async startup() {
    const chromeRegistry = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
    this.chromeHandle = chromeRegistry.registerChrome(Services.io.newURI(this.rootURI + "manifest.json"), [["content", "folder-sync", "ui/"]]);
    this.directory = PathUtils.join(Services.dirsvc.get("ProfD", Ci.nsIFile).path, "zotero-folder-sync");
    this.store = new FolderSyncAdapters.LocalStore(this.directory); await this.store.open();
    this.library = new FolderSyncAdapters.Library();
    this.engine = new FolderSyncCore.Engine({ fs: FolderSyncAdapters.filesystem, library: this.library, store: this.store });
    this.preferenceId = await Zotero.PreferencePanes.register({ pluginID: this.id, src: this.rootURI + "ui/preferences.xhtml", label: "Folder Sync", image: this.rootURI + "ui/icon.svg" });
    for (const window of Zotero.getMainWindows()) this.loadWindow(window);
    if (Zotero.Prefs.get("extensions.folderSync.apiEnabled", true) === true) {
      try { await this.enableAPI(); } catch (error) { this.apiError = String(error); Zotero.logError(error); }
    }
  }
  loadWindow(window) {
    if (this.windows.has(window)) return;
    const menu = window.document.getElementById("menu_ToolsPopup"); if (!menu) return;
    const item = window.document.createXULElement("menuitem"); item.id = "folder-sync-manager"; item.setAttribute("label", "Folder Sync · 文件夹同步");
    item.addEventListener("command", () => this.openManager(window)); menu.appendChild(item); this.windows.set(window, item);
  }
  unloadWindow(window) { this.windows.get(window)?.remove(); this.windows.delete(window); }
  openManager(window = Zotero.getMainWindow()) {
    if (this.managerWindow && !this.managerWindow.closed) { this.managerWindow.focus(); return this.managerWindow; }
    this.managerWindow = window.openDialog("chrome://folder-sync/content/manager.xhtml", "folder-sync-manager", "chrome,centerscreen,resizable,width=1050,height=760", this);
    return this.managerWindow;
  }
  async pickFolder(window) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(window.browsingContext, "Choose source folder / 选择源文件夹", Ci.nsIFilePicker.modeGetFolder);
    const result = await new Promise(resolve => picker.open(resolve));
    return result === Ci.nsIFilePicker.returnOK ? picker.file.path : null;
  }
  async migrateLegacy() {
    const root = Zotero.Prefs.get("extensions.phdProjectSync.projectRoot", true);
    const name = Zotero.Prefs.get("extensions.phdProjectSync.rootCollection", true);
    if (!root || !name) throw Error("No legacy configuration exists in this Profile.");
    const candidates = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, false, false).filter(c => !c.parentID && c.name === name);
    if (candidates.length !== 1) throw Error("The legacy root collection is missing or ambiguous. Select it manually.");
    const settings = await this.engine.settings();
    if (settings.rules.some(r => r.id === "legacy-kb")) throw Error("Legacy rule already exists.");
    const rule = { id: "legacy-kb", name: "旧版科研知识库 / Legacy knowledge bases", enabled: false,
      target: { library: "user", collectionKey: candidates[0].key }, scan: { mode: "knowledge-base", entry: "project-tree" },
      layout: { profile: "research-kb/v1", mode: "mirror" }, recognition: { enabled: Zotero.Prefs.get("extensions.phdProjectSync.recognize", true) !== false } };
    settings.rules.push(rule); settings.bindings[rule.id] = { sourceRoot: root };
    await this.engine.saveSettings(settings); return { root, collectionKey: candidates[0].key, enabled: false };
  }
  async startJob(planId) {
    const job = { id: FolderSyncCore.id(), planId, status: "queued", createdAt: new Date().toISOString() };
    await this.store.change(state => {
      state.jobs[job.id] = job;
      const keys = Object.keys(state.jobs); for (const key of keys.slice(0, Math.max(0, keys.length - 50))) if (!["running", "queued"].includes(state.jobs[key].status)) delete state.jobs[key];
    });
    const operation = this.engine.apply(planId, {
      cancelled: () => this.cancellations.has(job.id),
      progress: result => { job.progress = result; }
    });
    job.status = "running";
    operation.then(async result => {
      job.status = result.status; job.result = result; job.completedAt = new Date().toISOString();
      await this.store.change(state => { state.jobs[job.id] = FolderSyncCore.clone(job); });
    }).catch(async error => {
      job.status = "failed"; job.error = FolderSyncCore.errorInfo(error);
      await this.store.change(state => { state.jobs[job.id] = FolderSyncCore.clone(job); });
    }).finally(() => this.cancellations.delete(job.id));
    return job;
  }
  async enableAPI() {
    if (this.endpoints.length) return;
    const tokenPath = PathUtils.join(this.directory, "token");
    this.token = await IOUtils.exists(tokenPath) ? (await IOUtils.readUTF8(tokenPath)).trim() : Zotero.Utilities.randomString(64);
    await IOUtils.writeUTF8(tokenPath, this.token + "\n");
    Zotero.File.pathToFile(tokenPath).permissions = 0o600;
    const port = Zotero.Prefs.get("httpServer.port") || 23119;
    this.connectionPath = PathUtils.join(this.directory, "connection.json");
    await IOUtils.writeUTF8(this.connectionPath, JSON.stringify({ plugin: "zotero-folder-sync", protocol: 2, base: `http://127.0.0.1:${port}/folder-sync/v2`, tokenPath }, null, 2));
    Zotero.Prefs.set("extensions.folderSync.apiEnabled", true, true);
    const app = this, response = (status, body) => [status, "application/json", JSON.stringify(body)];
    const register = (suffix, methods, handler) => {
      const route = "/folder-sync/v2" + suffix;
      if (Zotero.Server.Endpoints[route]) throw Error("Folder Sync endpoint is already registered.");
      function Endpoint() {}
      Endpoint.prototype = { supportedMethods: methods, supportedDataTypes: ["application/json"], async init(request) {
        if (request.headers.authorization !== `Bearer ${app.token}`) return response(401, { error: { code: "UNAUTHORIZED", message: "Token required." } });
        try { return response(200, await handler(request)); }
        catch (error) { return response(400, { error: FolderSyncCore.errorInfo(error) }); }
      } };
      Zotero.Server.Endpoints[route] = Endpoint; this.endpoints.push(route);
    };
    try {
      register("/health", ["GET"], () => ({ plugin: "zotero-folder-sync", protocol: 2, version: this.version }));
      register("/rules", ["GET"], () => this.engine.settings());
      register("/plans", ["POST"], request => this.engine.createPlan(request.data || {}));
      register("/jobs", ["POST"], request => this.startJob(request.data?.planId));
      register("/imports", ["POST"], async request => {
        const data = request.data || {};
        if (typeof data.path !== "string") throw FolderSyncCore.fail("INVALID_REQUEST", "A file path is required.");
        const plan = await this.engine.createPlan({ filePath: data.path, ruleIds: data.ruleId ? [data.ruleId] : null, recognize: data.recognize ?? null });
        return this.startJob(plan.id);
      });
      register("/jobs/:id", ["GET"], async request => {
        const job = (await this.store.read()).jobs[request.pathParams.id]; if (!job) throw FolderSyncCore.fail("JOB_MISSING", "Job not found."); return job;
      });
      register("/jobs/:id/cancel", ["POST"], async request => {
        const job = (await this.store.read()).jobs[request.pathParams.id];
        if (!job) throw FolderSyncCore.fail("JOB_MISSING", "Job not found.");
        if (!["queued", "running"].includes(job.status)) return { requested: false, status: job.status };
        this.cancellations.add(job.id); return { requested: true };
      });
      this.apiError = null;
    } catch (error) { this.disableAPI(); throw error; }
  }
  disableAPI() {
    for (const route of this.endpoints) delete Zotero.Server.Endpoints[route]; this.endpoints = [];
    Zotero.Prefs.set("extensions.folderSync.apiEnabled", false, true);
  }
  async shutdown() {
    this.engine.closed = true;
    if (this.managerWindow && !this.managerWindow.closed) this.managerWindow.close();
    for (const route of this.endpoints) delete Zotero.Server.Endpoints[route]; this.endpoints = [];
    for (const window of [...this.windows.keys()]) this.unloadWindow(window);
    if (this.preferenceId) Zotero.PreferencePanes.unregister(this.preferenceId);
    await this.engine.queue;
    this.chromeHandle?.destruct();
  }
};
