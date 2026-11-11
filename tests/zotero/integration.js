var FolderSyncIntegration = async function(base) {
  const report = { startedAt: new Date().toISOString(), checks: [] };
  const check = (name, valid, details = null) => { report.checks.push({ name, passed: Boolean(valid), details }); if (!valid) throw Error(name + ": " + JSON.stringify(details)); };
  return (async () => {
    try {
      await Zotero.initializationPromise;
      report.zoteroVersion = Zotero.version;
      check("test_fixture_marker", (await IOUtils.readUTF8(base + "/.isolated-test-marker")).trim() === "folder-sync-test-only");
      check("isolated_profile",PathUtils.normalize(Services.dirsvc.get("ProfD",Ci.nsIFile).path)===PathUtils.join(base,"profile"));
      await Zotero.Items.erase((await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,false,false)).map(i=>i.id));
      await Zotero.Collections.erase(Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID,false,false).map(c=>c.id));
      for(const name of ["unset","equal","ancestor","different"])await IOUtils.remove(base+"/fixture/ordinary/"+name+".pdf",{ignoreAbsent:true});
      for (let n = 0; n < 300 && !Zotero.FolderSync?.engine; n++) await Zotero.Promise.delay(200);
      const app = Zotero.FolderSync;
      check("candidate_loaded", Boolean(app?.engine), app?.version);
      check("version", app.version === "0.2.0-beta.1");
      const makeTarget = async name => { const c = new Zotero.Collection(); c.libraryID = Zotero.Libraries.userLibraryID; c.name = name; await c.saveTx(); return c; };
      const target = await makeTarget("Knowledge fixture"), ordinary = await makeTarget("Ordinary fixture");
      const root = PathUtils.join(base,"fixture");
      const rules = [
        { id: "kb", name: "Knowledge", target: {library:"user",collectionKey:target.key}, scan:{mode:"knowledge-base"} },
        { id: "ordinary", name: "Ordinary", target: {library:"user",collectionKey:ordinary.key}, scan:{mode:"directory-tree"} }
      ];
      await app.engine.saveSettings({rules,bindings:{kb:{sourceRoot:root+"/knowledge"},ordinary:{sourceRoot:root+"/ordinary"}}});
      const preview = await app.engine.createPlan();
      check("two_knowledge_bases",preview.scans.find(s=>s.ruleId==="kb").knowledgeBases.length===2);
      check("six_pdf_files",preview.scans.reduce((n,s)=>n+s.files.length,0)===6);
      check("preview_is_read_only",(await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,false,false)).length===0);
      const result = await app.engine.apply(preview.id);
      check("all_six_imported",result.created===6 && result.status==="succeeded",result);
      const again = await app.engine.apply((await app.engine.createPlan()).id);
      check("repeat_is_idempotent",again.created===0 && again.reused===6,again);
      const file = PathUtils.join(root,"knowledge","主题","raw","papers","方法 A","a.pdf");
      const concurrent = await Promise.all(Array.from({length:10},()=>app.engine.importFile(file)));
      check("concurrent_reuses_existing",concurrent.every(r=>r.reused===1 && !r.created));
      const all = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,false,false);
      check("still_six_attachments",all.filter(i=>i.isFileAttachment()).length===6);
      const batch = preview.scans.find(s=>s.ruleId==="kb").files.find(f=>f.path===file);
      check("exact_tree",batch.collectionParts.join("/") === "主题/raw/papers/方法 A",batch.collectionParts);
      for (const [label,attachmentBase] of [["unset",""],["equal",root+"/knowledge"],["ancestor",root],["different",base+"/unrelated-base"]]) {
        if (attachmentBase) await IOUtils.makeDirectory(attachmentBase,{ignoreExisting:true,createAncestors:true});
        Zotero.Prefs.set("baseAttachmentPath",attachmentBase);Zotero.Prefs.set("saveRelativeAttachmentPath",Boolean(attachmentBase));
        const extra=root+"/ordinary/"+label+".pdf";await IOUtils.copy(root+"/ordinary/root.pdf",extra);
        const imported=await app.engine.importFile(extra,"ordinary",false);
        check("base_"+label,imported.status==="succeeded" && imported.created===1,imported);
        const item=Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID,imported.items[0].attachmentKey);
        check("resolved_"+label,PathUtils.normalize(await item.getFilePathAsync())===PathUtils.normalize(extra) && await IOUtils.exists(await item.getFilePathAsync()));
      }
      // Keep relative test attachments resolvable after the base-directory matrix.
      Zotero.Prefs.set("baseAttachmentPath",root);Zotero.Prefs.set("saveRelativeAttachmentPath",true);
      await app.enableAPI();
      check("local_api_enabled",app.endpoints.length===7);
      report.connectionPath=app.connectionPath;
      report.profileState=app.directory;
      const manager=app.openManager();
      if(manager.document.readyState!=="complete")await Promise.race([new Promise(resolve=>manager.addEventListener("load",resolve,{once:true})),Zotero.Promise.delay(2000)]);
      await Zotero.Promise.delay(700);
      check("manager_rendered",manager.document.getElementById("rules").children.length===2,manager.document.getElementById("message").textContent);
      manager.document.getElementById("add").click();
      check("rule_editor_visible",manager.document.getElementById("details").style.display==="block");
      report.managerOpen=true;
      report.passed=true;
    } catch(error) { report.passed=false;report.error=String(error)+"\n"+String(error.stack||"");Zotero.logError(error); }
    report.completedAt=new Date().toISOString();
    await IOUtils.writeUTF8(base+"/zotero-results.json",JSON.stringify(report,null,2));
  })();
};
