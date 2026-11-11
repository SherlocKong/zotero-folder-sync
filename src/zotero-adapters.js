var FolderSyncAdapters = (() => {
  const core = FolderSyncCore;
  const filesystem = {
    normalize: path => PathUtils.normalize(path),
    isAbsolute: path => typeof path === "string" && (/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)),
    join: (...parts) => PathUtils.join(...parts),
    parent: path => PathUtils.parent(path),
    basename: path => PathUtils.filename(path),
    relative(root, path) {
      const a = core.key(PathUtils.normalize(root)), b = core.key(PathUtils.normalize(path));
      if (!core.inside(a, b)) throw core.fail("PATH_OUTSIDE_ROOT", "Path is outside the source root.");
      return b === a ? "" : b.slice(a.length + 1);
    },
    async realPath(path) {
      const file = Zotero.File.pathToFile(path);
      file.normalize();
      if (!file.exists()) throw core.fail("SOURCE_UNAVAILABLE", "The path does not exist.");
      return file.path;
    },
    async stat(path) { const value = await IOUtils.stat(path); return { size: value.size, modified: value.lastModified, isDirectory: value.type === "directory" }; },
    async list(path) {
      const entries = [];
      // stat(..., followSymlinks:false) is important: do not traverse a directory alias.
      for (const child of await IOUtils.getChildren(path)) {
        const info = await IOUtils.stat(child, { followSymlinks: false });
        entries.push({ path: child, name: PathUtils.filename(child), isDirectory: info.type === "directory", isSymlink: info.type === "symlink" });
      }
      return entries;
    },
    async header(path) { return String.fromCharCode(...await IOUtils.read(path, { maxBytes: 5 })); }
  };
  class LocalStore {
    constructor(directory) { this.directory = directory; this.queue = Promise.resolve(); this.state = null; }
    async open() {
      await IOUtils.makeDirectory(this.directory, { createAncestors: true, ignoreExisting: true });
      this.path = PathUtils.join(this.directory, "state.json");
      if (await IOUtils.exists(this.path)) {
        this.state = JSON.parse(await IOUtils.readUTF8(this.path));
        if (this.state.schemaVersion !== 2 || !Array.isArray(this.state.rules) || !this.state.bindings || !this.state.mappings || !this.state.plans || !this.state.jobs) throw Error("Unsupported or invalid Folder Sync configuration. Restore its backup before continuing.");
      } else this.state = core.initialState();
      this.mappingLog = PathUtils.join(this.directory, "mappings.jsonl");
      this.eventPaths = new Set();
      if (await IOUtils.exists(this.mappingLog)) {
        const lines = (await IOUtils.readUTF8(this.mappingLog)).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]) continue;
          try { const record = JSON.parse(lines[i]); this.state.mappings[record.mappingId] = record.key; }
          catch (error) {
            if (i < lines.length - 1) throw error;
            Zotero.logError(error);
            await IOUtils.writeUTF8(this.mappingLog, lines.slice(0, i).join("\n") + "\n", { tmpPath: this.mappingLog + ".tmp", backupFile: this.mappingLog + ".bak" });
          }
        }
      }
      if (!await IOUtils.exists(this.mappingLog)) await IOUtils.writeUTF8(this.mappingLog, "");
      await this.change(state => { for (const job of Object.values(state.jobs)) if (["queued", "running"].includes(job.status)) job.status = "interrupted"; });
    }
    async read() { await this.queue; return core.clone(this.state); }
    async revision() { await this.queue; return this.state.revision; }
    async getMapping(id) { await this.queue; return this.state.mappings[id]; }
    setMapping(mappingId, key) {
      const operation = this.queue.then(async () => {
        await IOUtils.writeUTF8(this.mappingLog, JSON.stringify({ mappingId, key }) + "\n", { mode: "append" });
        this.state.mappings[mappingId] = key;
      });
      this.queue = operation.catch(() => {}); return operation;
    }
    recordEvent(planId, event) {
      if (!/^[a-zA-Z0-9-]+$/.test(planId)) throw Error("Invalid operation journal ID.");
      const operation = this.queue.then(async () => {
        const directory = PathUtils.join(this.directory, "operations");
        const path = PathUtils.join(directory, planId + ".jsonl");
        if (!this.eventPaths.has(path)) {
          await IOUtils.makeDirectory(directory, { ignoreExisting: true });
          if (!await IOUtils.exists(path)) await IOUtils.writeUTF8(path, "");
          this.eventPaths.add(path);
        }
        await IOUtils.writeUTF8(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: "append" });
      });
      this.queue = operation.catch(() => {}); return operation;
    }
    change(callback) {
      const operation = this.queue.then(async () => {
        const next = core.clone(this.state);
        callback(next);
        await IOUtils.writeUTF8(this.path, JSON.stringify(next, null, 2), { tmpPath: this.path + ".tmp", backupFile: this.path + ".bak" });
        try { Zotero.File.pathToFile(this.path).permissions = 0o600; } catch (_) {}
        this.state = next;
      });
      this.queue = operation.catch(() => {});
      return operation;
    }
  }
  class Library {
    async getTarget(key) {
      const collection = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
      if (!collection || collection.deleted || collection.libraryID !== Zotero.Libraries.userLibraryID) throw core.fail("TARGET_MISSING", "Select an existing collection in My Library.");
      return collection;
    }
    async targetsOverlap(a, b) {
      const ancestry = async (from, to) => {
        for (let c = await this.getTarget(from); c; c = c.parentID ? Zotero.Collections.get(c.parentID) : null) if (c.key === to) return true;
        return false;
      };
      return await ancestry(a, b) || await ancestry(b, a);
    }
    async getMappedCollection(key, parentKey) {
      const c = Zotero.Collections.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
      return c && !c.deleted && c.parentID && Zotero.Collections.get(c.parentID)?.key === parentKey ? c : null;
    }
    async ensureChild(parent, name) {
      const found = Zotero.Collections.getByParent(parent.id, false, false).filter(c => c.name === name && !c.deleted);
      if (found.length > 1) throw core.fail("COLLECTION_CONFLICT", `Multiple child collections are named ${name}.`);
      if (found.length) return found[0];
      const child = new Zotero.Collection();
      child.libraryID = Zotero.Libraries.userLibraryID; child.parentID = parent.id; child.name = name;
      await child.saveTx({ skipSelect: true });
      return child;
    }
    async linkedIndex() {
      const result = new Map();
      for (const item of await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false)) {
        if (item.deleted || !item.isFileAttachment() || item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) continue;
        const path = await item.getFilePathAsync();
        if (!path) continue;
        let canonical;
        try { canonical = await filesystem.realPath(path); } catch (_) { continue; }
        const k = core.key(canonical); if (!result.has(k)) result.set(k, []); result.get(k).push(item);
      }
      return result;
    }
    async createLink(path, collection) {
      return Zotero.Attachments.linkFromFile({ file: path, title: PathUtils.filename(path), contentType: "application/pdf", collections: [collection.id], saveOptions: { skipSelect: true } });
    }
    filePath(attachment) { return attachment.getFilePathAsync(); }
    async addCollection(attachment, collection) {
      const owner = attachment.parentItem || attachment;
      const memberships = owner.getCollections();
      if (memberships.includes(collection.id)) return false;
      owner.setCollections([...memberships, collection.id]); await owner.saveTx({ skipSelect: true }); return true;
    }
    async recognize(attachment, collection) {
      if (attachment.parentItem) { await this.addCollection(attachment, collection); return "existing-parent"; }
      if (!Zotero.RecognizeDocument.canRecognize(attachment)) return "pending";
      await Zotero.RecognizeDocument.recognizeItems([attachment]);
      const updated = await Zotero.Items.getAsync(attachment.id);
      if (!updated.parentItem) return "pending";
      await this.addCollection(updated, collection); return "recognized";
    }
    listTargets() {
      return Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true, false).filter(c => !c.deleted).map(c => {
        const parts = []; for (let p = c; p; p = p.parentID ? Zotero.Collections.get(p.parentID) : null) parts.unshift(p.name);
        return { key: c.key, label: parts.join(" / ") };
      });
    }
  }
  return { filesystem, LocalStore, Library };
})();
