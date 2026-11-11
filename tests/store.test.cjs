const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const core=require('../src/engine.js');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'folder-sync-store-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let failNext=false;
 const context={FolderSyncCore:core,PathUtils:{join:path.join},Zotero:{File:{pathToFile:()=>({})},logError:()=>{}},IOUtils:{
  exists:async p=>{try{await fs.access(p);return true;}catch(_){return false;}},
  makeDirectory:(p)=>fs.mkdir(p,{recursive:true}),readUTF8:p=>fs.readFile(p,'utf8'),
  writeUTF8:async(p,text,options={})=>{
   if(failNext){failNext=false;throw Error('simulated disk failure');}
   // Gecko append requires an existing file, unlike Node's appendFile.
   if(options.mode==='append')await fs.access(p);
   await fs.writeFile(p,text,{flag:options.mode==='append'?'a':'w'});
  }
 }};
 vm.createContext(context);vm.runInContext(await fs.readFile(path.join(__dirname,'../src/zotero-adapters.js'),'utf8'),context);
 return {root,Store:context.FolderSyncAdapters.LocalStore,fail:()=>{failNext=true;}};
}
test('new journals are created before Gecko append and replay on restart',async t=>{
 const f=await fixture(t),store=new f.Store(f.root);await store.open();await store.setMapping('directory','COLL0001');await store.recordEvent('plan-1',{type:'link-confirmed'});
 assert.equal((await fs.readFile(path.join(f.root,'operations/plan-1.jsonl'),'utf8')).trim().split('\n').length,1);
 const fresh=new f.Store(f.root);await fresh.open();assert.equal(await fresh.getMapping('directory'),'COLL0001');
});
test('incomplete final mapping record is recovered before future appends',async t=>{
 const f=await fixture(t),store=new f.Store(f.root);await store.open();await store.setMapping('one','COLL0001');
 await fs.appendFile(path.join(f.root,'mappings.jsonl'),'{"mappingId":');
 const fresh=new f.Store(f.root);await fresh.open();await fresh.setMapping('two','COLL0002');
 const next=new f.Store(f.root);await next.open();assert.equal(await next.getMapping('one'),'COLL0001');assert.equal(await next.getMapping('two'),'COLL0002');
});
test('failed configuration write preserves the last in-memory version',async t=>{
 const f=await fixture(t),store=new f.Store(f.root);await store.open();f.fail();await assert.rejects(store.change(s=>{s.revision=5;}));assert.equal(await store.revision(),0);
});
test('restart marks unfinished jobs interrupted without losing completed jobs',async t=>{
 const f=await fixture(t),store=new f.Store(f.root);await store.open();await store.change(s=>{s.jobs.a={status:'running'};s.jobs.b={status:'succeeded'};});
 const fresh=new f.Store(f.root);await fresh.open();const state=await fresh.read();assert.equal(state.jobs.a.status,'interrupted');assert.equal(state.jobs.b.status,'succeeded');
});
