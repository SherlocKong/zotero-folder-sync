var folderSync = null;
async function startup({ id, version, rootURI }) {
  for (const file of ["engine", "zotero-adapters", "application"]) Services.scriptloader.loadSubScript(rootURI + `src/${file}.js`);
  folderSync = new FolderSyncApplication({ id, version, rootURI });
  Zotero.FolderSync = folderSync;
  await folderSync.startup();
}
function onMainWindowLoad({ window }) { folderSync?.loadWindow(window); }
function onMainWindowUnload({ window }) { folderSync?.unloadWindow(window); }
async function shutdown() {
  const stopping = folderSync;
  if (stopping) await stopping.shutdown();
  if (Zotero.FolderSync === stopping) Zotero.FolderSync = null;
  if (folderSync === stopping) folderSync = null;
}
function install() {}
function uninstall() {}
