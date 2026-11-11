/* Shared application core. File and library access are supplied by adapters. */
var FolderSyncCore = (() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const relativeParts = value => String(value).replace(/\\/g, "/").split("/").filter(Boolean);
  const key = value => String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  const inside = (root, file) => key(file) === key(root) || key(file).startsWith(key(root) + "/");
  const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const initialState = () => ({ schemaVersion: 2, revision: 0, rules: [], bindings: {}, mappings: {}, plans: {}, jobs: {} });
  const errorInfo = error => ({ code: typeof error.code === "string" ? error.code : "OPERATION_FAILED", message: String(error.message || error) });

  function normalizeRule(input) {
    const rule = clone(input);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rule.id || "")) throw fail("RULE_INVALID", "A rule needs a stable ID.");
    if (!String(rule.name || "").trim()) throw fail("RULE_INVALID", "A rule needs a name.");
    if (rule.target?.library !== "user" || !/^[A-Z0-9]{8}$/.test(rule.target.collectionKey || "")) {
      throw fail("RULE_INVALID", "Select a collection in My Library.");
    }
    rule.enabled = rule.enabled !== false;
    rule.scan ||= {};
    if (!["directory-tree", "knowledge-base"].includes(rule.scan.mode)) throw fail("RULE_INVALID", "Choose a directory mode.");
    rule.scan.entry = rule.scan.entry || "project-tree";
    if (!["project-tree", "knowledge-base"].includes(rule.scan.entry)) throw fail("RULE_INVALID", "Invalid entry type.");
    rule.scan.marker = rule.scan.marker || "raw";
    if (!rule.scan.marker || /[\\/\0]/.test(rule.scan.marker) || [".", ".."].includes(rule.scan.marker)) throw fail("RULE_INVALID", "The content marker must be a directory name.");
    rule.scan.excludeDirectoryNames ||= ["tmp", "node_modules", "__pycache__"];
    if (!Array.isArray(rule.scan.excludeDirectoryNames) || rule.scan.excludeDirectoryNames.some(n => typeof n !== "string" || /[\\/]/.test(n))) throw fail("RULE_INVALID", "Exclusions must be directory names.");
    rule.layout ||= {};
    rule.layout.mode ||= "mirror";
    if (!["mirror", "flat"].includes(rule.layout.mode)) throw fail("RULE_INVALID", "Invalid collection layout.");
    rule.layout.profile ||= rule.scan.mode === "knowledge-base" ? "research-kb/v1" : "directory/v1";
    if (rule.layout.profile === "research-kb/v1") {
      if (rule.scan.mode !== "knowledge-base" || rule.scan.marker !== "raw" || rule.layout.mode !== "mirror") throw fail("RULE_INVALID", "The standard knowledge-base profile preserves raw and the full tree.");
      rule.layout.includeEmptyDirectories = true;
    } else rule.layout.includeEmptyDirectories = rule.layout.includeEmptyDirectories === true;
    rule.recognition = { enabled: rule.recognition?.enabled === true };
    return rule;
  }

  class Engine {
    constructor({ fs, library, store }) {
      Object.assign(this, { fs, library, store });
      this.queue = Promise.resolve();
      this.closed = false;
      this.active = 0;
    }
    async settings() {
      const state = await this.store.read();
      return { schemaVersion: 2, revision: state.revision, rules: state.rules, bindings: state.bindings };
    }
    async saveSettings({ rules, bindings, revision }) {
      if (!Array.isArray(rules) || !bindings || typeof bindings !== "object") throw fail("RULE_INVALID", "Rules and local directory bindings are required.");
      rules = rules.map(normalizeRule);
      if (new Set(rules.map(r => r.id)).size !== rules.length) throw fail("RULE_INVALID", "Rule IDs must be unique.");
      const enabled = rules.filter(r => r.enabled);
      const resolved = [];
      for (const rule of rules) {
        const root = bindings[rule.id]?.sourceRoot;
        if (typeof root !== "string" || !this.fs.isAbsolute(root)) throw fail("RULE_INVALID", `Choose an absolute source folder for ${rule.name}.`);
        bindings[rule.id] = { sourceRoot: this.fs.normalize(root) };
        // Offline bindings can be saved. A reachable alias is canonicalized for conflict detection.
        let canonical = bindings[rule.id].sourceRoot;
        try { canonical = await this.fs.realPath(canonical); } catch (_) {}
        resolved.push([rule.id, canonical]);
        if (rule.enabled) await this.library.getTarget(rule.target.collectionKey);
      }
      for (let i = 0; i < enabled.length; i++) for (let j = i + 1; j < enabled.length; j++) {
        const a = enabled[i], b = enabled[j];
        const ar = resolved.find(([v]) => v === a.id)[1], br = resolved.find(([v]) => v === b.id)[1];
        if (inside(ar, br) || inside(br, ar)) throw fail("RULE_OVERLAP", `${a.name} and ${b.name} have overlapping source folders.`);
        if (await this.library.targetsOverlap(a.target.collectionKey, b.target.collectionKey)) throw fail("TARGET_OVERLAP", "Enabled rules require independent target collections.");
      }
      await this.store.change(state => {
        if (revision !== undefined && revision !== state.revision) throw fail("SETTINGS_STALE", "Settings changed; reload before saving.");
        state.rules = clone(rules);
        state.bindings = Object.fromEntries(rules.map(r => [r.id, clone(bindings[r.id])]));
        state.revision++;
      });
      return this.settings();
    }

    async scan(rule, sourceRoot, onlyPath = null) {
      const result = { ruleId: rule.id, root: null, knowledgeBases: [], directories: [], files: [], warnings: [], errors: [], skipped: [] };
      let root;
      try {
        root = await this.fs.realPath(sourceRoot);
        if (!(await this.fs.stat(root)).isDirectory) throw fail("SOURCE_UNAVAILABLE", "Source is not a directory.");
        result.root = root;
      } catch (error) {
        result.errors.push({ path: sourceRoot, ...errorInfo(fail("SOURCE_UNAVAILABLE", error.message)) });
        return result;
      }
      const dirs = new Map();
      const ignore = name => name.startsWith(".") || rule.scan.excludeDirectoryNames.includes(name);
      const rel = path => key(this.fs.relative(root, path));
      const parts = path => relativeParts(this.fs.relative(root, path));
      const addDirectory = path => {
        if (rule.layout.mode === "flat") { dirs.set("", []); return; }
        const pathParts = parts(path);
        for (let i = 0; i <= pathParts.length; i++) dirs.set(JSON.stringify(pathParts.slice(0, i)), pathParts.slice(0, i));
      };
      const entries = async directory => {
        try { return (await this.fs.list(directory)).sort((a, b) => a.name.localeCompare(b.name)); }
        catch (error) { result.errors.push({ path: directory, ...errorInfo(error) }); return []; }
      };
      const safe = async entry => {
        if (entry.isSymlink) { result.skipped.push({ path: entry.path, reason: "SYMLINK_SKIPPED" }); return false; }
        try {
          const physical = await this.fs.realPath(entry.path);
          if (!inside(root, physical) || key(physical) !== key(this.fs.normalize(entry.path))) throw fail("PATH_OUTSIDE_ROOT", "A path resolves outside its declared directory tree.");
          return true;
        } catch (error) { result.errors.push({ path: entry.path, ...errorInfo(error) }); return false; }
      };
      const visitContent = async (directory, kbRoot) => {
        if (rule.layout.includeEmptyDirectories) addDirectory(directory);
        for (const entry of await entries(directory)) {
          if (ignore(entry.name)) { if (entry.isDirectory) result.skipped.push({ path: entry.path, reason: "EXCLUDED" }); continue; }
          if (!await safe(entry)) continue;
          if (entry.isDirectory) await visitContent(entry.path, kbRoot);
          else if (/\.pdf$/i.test(entry.name) && (!onlyPath || key(entry.path) === key(onlyPath))) {
            try {
              const stat = await this.fs.stat(entry.path);
              if (!stat.size || await this.fs.header(entry.path) !== "%PDF-") throw fail("INVALID_PDF", "File is empty or lacks a PDF header.");
              addDirectory(directory);
              result.files.push({ ruleId: rule.id, path: entry.path, relativePath: rel(entry.path), kbRoot,
                kbRelativePath: kbRoot ? key(this.fs.relative(kbRoot, entry.path)) : null,
                collectionParts: rule.layout.mode === "flat" ? [] : parts(directory), size: stat.size, modified: stat.modified });
            } catch (error) { result.errors.push({ path: entry.path, ...errorInfo(error) }); }
          }
        }
      };
      const discover = async directory => {
        const children = await entries(directory);
        const marker = children.find(e => e.name === rule.scan.marker && e.isDirectory && !e.isSymlink);
        const abnormalMarker = children.find(e => e.name === rule.scan.marker && (e.isSymlink || !e.isDirectory));
        if (abnormalMarker) result.skipped.push({ path: abnormalMarker.path, reason: abnormalMarker.isSymlink ? "SYMLINK_SKIPPED" : "CONTENT_DIRECTORY_NOT_DIRECTORY" });
        if (!marker && children.some(e => e.isDirectory && ["manifest", "kb"].includes(e.name))) result.warnings.push({ path: directory, code: "KB_STRUCTURE_INCOMPLETE" });
        if (marker && await safe(marker)) {
          result.knowledgeBases.push({ path: directory, relativePath: rel(directory), reason: "DIRECT_CONTENT_DIRECTORY" });
          const content = await entries(marker.path);
          if (!content.some(e => e.name === "papers" && e.isDirectory && !e.isSymlink)) result.warnings.push({ path: directory, code: "PAPERS_DIRECTORY_MISSING" });
          await visitContent(marker.path, directory);
        }
        if (rule.scan.entry === "knowledge-base" && directory === root) {
          if (!marker) result.errors.push({ path: root, code: "KB_ROOT_REQUIRED", message: "Select a knowledge-base folder containing its content directory." });
          return;
        }
        for (const entry of children) {
          if (!entry.isDirectory || entry.name === rule.scan.marker || ignore(entry.name)) continue;
          if (await safe(entry)) await discover(entry.path);
        }
      };
      if (rule.scan.mode === "knowledge-base") {
        const name = this.fs.basename(root), parent = this.fs.parent(root);
        if (name === rule.scan.marker || (name === "papers" && this.fs.basename(parent) === rule.scan.marker)) {
          result.errors.push({ path: root, code: "KB_CONTENT_SELECTED", message: "Select the knowledge-base root or use ordinary directory mode." });
          return result;
        }
        await discover(root);
      } else await visitContent(root, null);
      result.directories = [...dirs.values()].sort((a, b) => a.length - b.length || JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (onlyPath) result.directories = result.directories.filter(d => result.files.some(f => d.every((part, n) => f.collectionParts[n] === part)));
      result.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      return result;
    }

    async createPlan({ ruleIds = null, filePath = null, recognize = null } = {}) {
      if (this.closed) throw fail("SHUTTING_DOWN", "The plugin is stopping.");
      const state = await this.store.read();
      let rules = state.rules.filter(r => r.enabled && (!ruleIds || ruleIds.includes(r.id)));
      if (ruleIds && ruleIds.some(value => !rules.some(r => r.id === value))) throw fail("RULE_INVALID", "A requested rule is disabled or missing.");
      if (!rules.length) throw fail("NO_MATCHING_RULE", "Add or enable a synchronization rule first.");
      let canonicalFile = null;
      if (filePath) {
        canonicalFile = await this.fs.realPath(filePath);
        const matches = [];
        for (const rule of rules) {
          try { if (inside(await this.fs.realPath(state.bindings[rule.id].sourceRoot), canonicalFile)) matches.push(rule); } catch (_) {}
        }
        if (matches.length !== 1) throw fail("NO_MATCHING_RULE", "The file must belong to exactly one enabled rule.");
        rules = matches;
      }
      const index = await this.library.linkedIndex();
      const plan = { id: id(), revision: state.revision, createdAt: new Date().toISOString(), ruleIds: rules.map(r => r.id), scans: [], actions: [], errors: [], status: "planned" };
      const canonicalRoots = [];
      for (const rule of rules) {
        try {
          await this.library.getTarget(rule.target.collectionKey);
          const scan = await this.scan(rule, state.bindings[rule.id].sourceRoot, canonicalFile);
          plan.scans.push(scan); plan.errors.push(...scan.errors);
          if (!scan.root) continue;
          if (canonicalRoots.some(root => inside(root, scan.root) || inside(scan.root, root))) throw fail("RULE_OVERLAP", "Source roots now overlap; review the rules.");
          canonicalRoots.push(scan.root);
          for (const directory of scan.directories) plan.actions.push({ type: "ensure-collection", ruleId: rule.id, parts: directory });
          for (const file of scan.files) {
            const found = index.get(key(file.path)) || [];
            plan.actions.push({ type: found.length > 1 ? "conflict" : found.length ? "reuse-link" : "create-link", ...file,
              targetKey: rule.target.collectionKey, recognize: recognize === null ? rule.recognition.enabled : recognize === true });
          }
        } catch (error) {
          if (error.code === "RULE_OVERLAP") throw error;
          plan.errors.push({ ruleId: rule.id, ...errorInfo(error) });
        }
      }
      if (canonicalFile && !plan.actions.some(a => key(a.path || "") === key(canonicalFile))) throw fail("FILE_NOT_IN_SCOPE", "This PDF is outside the rule's content tree or is excluded/invalid.");
      await this.store.change(current => {
        current.plans[plan.id] = clone(plan);
        const old = Object.keys(current.plans);
        for (const value of old.slice(0, Math.max(0, old.length - 50))) delete current.plans[value];
      });
      return clone(plan);
    }

    apply(planId, { cancelled = () => false, progress = () => {} } = {}) {
      const run = () => this._apply(planId, { cancelled, progress });
      const promise = this.queue.then(run, run);
      this.queue = promise.catch(() => {});
      return promise;
    }
    async _apply(planId, { cancelled, progress }) {
      if (this.closed) throw fail("SHUTTING_DOWN", "The plugin is stopping.");
      this.active++;
      try {
        const state = await this.store.read(), plan = state.plans[planId];
        if (!plan) throw fail("PLAN_MISSING", "The plan is no longer available. Create a new preview.");
        if (plan.revision !== state.revision) throw fail("PLAN_STALE", "Rules changed after this preview.");
        const result = { planId, status: "succeeded", created: 0, reused: 0, collectionsAdded: 0, metadataPending: 0, items: [], errors: clone(plan.errors), completedAt: null };
        const index = await this.library.linkedIndex();
        const roots = new Map(), unavailable = new Set();
        for (const scan of plan.scans) {
          const rule = state.rules.find(r => r.id === scan.ruleId);
          try {
            const root = await this.fs.realPath(state.bindings[rule.id].sourceRoot);
            if (!scan.root || key(root) !== key(scan.root) || !(await this.fs.stat(root)).isDirectory) throw fail("SOURCE_UNAVAILABLE", "Source root changed or is unavailable.");
            await this.library.getTarget(rule.target.collectionKey);
            roots.set(rule.id, root);
          } catch (error) { unavailable.add(scan.ruleId); result.errors.push({ ruleId: scan.ruleId, ...errorInfo(error) }); }
        }
        for (const action of plan.actions) {
          if (cancelled() || this.closed) { result.status = "cancelled"; break; }
          if (unavailable.has(action.ruleId)) continue;
          const latest = this.store.revision ? await this.store.revision() : (await this.store.read()).revision;
          if (latest !== plan.revision) { result.errors.push({ code: "PLAN_STALE", message: "Rules changed during execution." }); break; }
          const rule = state.rules.find(r => r.id === action.ruleId);
          try {
            if (action.type === "ensure-collection") {
              await this._collection(rule, action.parts);
              continue;
            }
            const physical = await this.fs.realPath(action.path);
            if (!inside(roots.get(rule.id), physical) || key(physical) !== key(action.path)) throw fail("PATH_OUTSIDE_ROOT", "File path changed.");
            const stat = await this.fs.stat(physical);
            if (stat.size !== action.size || stat.modified !== action.modified || await this.fs.header(physical) !== "%PDF-") throw fail("FILE_CHANGED", "File changed since preview; create a new plan.");
            const existing = index.get(key(physical)) || [];
            if (existing.length > 1) throw fail("PATH_CONFLICT", "Multiple attachments already reference this file.");
            const collection = await this._collection(rule, action.collectionParts);
            const reused = existing.length === 1;
            const attachment = reused ? existing[0] : await this.library.createLink(physical, collection);
            if (key(await this.fs.realPath(await this.library.filePath(attachment))) !== key(physical)) throw fail("LINK_PATH_MISMATCH", "The created attachment does not resolve to the input file.");
            if (!reused) index.set(key(physical), [attachment]);
            const added = await this.library.addCollection(attachment, collection);
            const item = { ruleId: rule.id, path: physical, attachmentKey: attachment.key, collectionKey: collection.key, status: reused ? "reused" : "created", classificationAdded: added, metadata: "not-requested" };
            result[reused ? "reused" : "created"]++;
            if (added) result.collectionsAdded++;
            result.items.push(item);
            // Persist the link before recognition so an interrupted retry can reuse it.
            if (this.store.recordEvent) await this.store.recordEvent(planId, { type: "link-confirmed", item });
            if (action.recognize) {
              try { item.metadata = await this.library.recognize(attachment, collection); }
              catch (_) { item.metadata = "pending"; }
              if (item.metadata === "pending") result.metadataPending++;
            }
          } catch (error) { result.errors.push({ path: action.path, ruleId: action.ruleId, ...errorInfo(error) }); }
          progress(clone({ ...result, items: result.items.slice(-10), errors: result.errors.slice(-10) }));
        }
        if (result.status !== "cancelled" && result.errors.length) result.status = result.created || result.reused ? "partial" : "failed";
        result.completedAt = new Date().toISOString();
        await this.store.change(current => { current.plans[planId].status = result.status; current.plans[planId].lastResult = clone(result); });
        return result;
      } finally { this.active--; }
    }
    async _collection(rule, parts) {
      let parent = await this.library.getTarget(rule.target.collectionKey);
      for (let i = 0; i < parts.length; i++) {
        const mappingId = JSON.stringify([rule.id, rule.target.collectionKey, parts.slice(0, i + 1)]);
        const known = this.store.getMapping ? await this.store.getMapping(mappingId) : (await this.store.read()).mappings[mappingId];
        let collection = known ? await this.library.getMappedCollection(known, parent.key) : null;
        if (known && !collection) throw fail("MAPPED_COLLECTION_MISSING", "A mapped collection moved or was deleted. Repair its binding first.");
        if (!collection) collection = await this.library.ensureChild(parent, parts[i]);
        if (!known) {
          if (this.store.setMapping) await this.store.setMapping(mappingId, collection.key);
          else await this.store.change(current => { current.mappings[mappingId] = collection.key; });
        }
        parent = collection;
      }
      return parent;
    }
    async importFile(filePath, ruleId = null, recognize = null) {
      const plan = await this.createPlan({ filePath, ruleIds: ruleId ? [ruleId] : null, recognize });
      return this.apply(plan.id);
    }
  }
  return { Engine, normalizeRule, initialState, clone, fail, key, inside, id, errorInfo };
})();
if (typeof module !== "undefined" && module.exports) module.exports = FolderSyncCore;
