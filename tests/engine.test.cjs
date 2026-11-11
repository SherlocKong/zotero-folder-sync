const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Engine} = require('../src/engine.js');
const {filesystem,Store,Library} = require('./adapters.cjs');
async function fixture(t,mode='knowledge-base'){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'folder-sync-'));const root=await fs.realpath(temporary);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new Store(),library=new Library(),engine=new Engine({fs:filesystem,library,store});
 const rule={id:'test',name:'Test',target:{library:'user',collectionKey:'ROOT0001'},scan:{mode},recognition:{enabled:false}};
 const pdf=async rel=>{const p=path.join(root,rel);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,'%PDF-1.4\nsynthetic fixture\n');return p;};
 const configure=async()=>engine.saveSettings({rules:[rule],bindings:{test:{sourceRoot:root}}});
 return {root,store,library,engine,rule,pdf,configure};
}
test('root itself is a KB; full tree and empty nodes are preserved',async t=>{
 const f=await fixture(t);await f.pdf('raw/papers/方法 A/a.pdf');await fs.mkdir(path.join(f.root,'raw/standards/empty'),{recursive:true});await f.configure();
 const p=await f.engine.createPlan();assert.equal(p.scans[0].knowledgeBases.length,1);assert.equal(p.scans[0].knowledgeBases[0].relativePath,'');
 assert.deepEqual(p.scans[0].files[0].collectionParts,['raw','papers','方法 A']);assert(p.scans[0].directories.some(x=>x.join('/')==='raw/standards/empty'));
 assert.equal(f.library.creates,0);assert.equal(f.library.collections.size,2);
});
test('project ancestors and identical names remain separate',async t=>{
 const f=await fixture(t);await f.pdf('A/topic/raw/papers/a.pdf');await f.pdf('B/topic/raw/papers/a.pdf');await f.configure();
 const p=await f.engine.createPlan();assert.equal(p.scans[0].knowledgeBases.length,2);
 assert.deepEqual(p.scans[0].files.map(x=>x.collectionParts.join('/')),['A/topic/raw/papers','B/topic/raw/papers']);
 const r=await f.engine.apply(p.id);assert.equal(r.created,2);assert.notEqual(r.items[0].collectionKey,r.items[1].collectionKey);
});
test('inner raw is content; child KB outside parent raw has its own root',async t=>{
 const f=await fixture(t);await f.pdf('raw/archive/raw/papers/a.pdf');await f.pdf('child/raw/technical/b.pdf');await f.configure();
 const p=await f.engine.createPlan();assert.equal(p.scans[0].knowledgeBases.length,2);
 assert.equal(p.scans[0].files.find(x=>x.relativePath.startsWith('raw/')).kbRoot,f.root);
 assert.equal(p.scans[0].files.find(x=>x.relativePath.startsWith('child/')).kbRoot,path.join(f.root,'child'));
});
test('single and batch mapping match even when ancestor is named raw',async t=>{
 const f=await fixture(t);const p=await f.pdf('raw/outer/topic/raw/01_实验/papers/a.PDF');
 const root=path.join(f.root,'raw/outer');await f.engine.saveSettings({rules:[f.rule],bindings:{test:{sourceRoot:root}}});
 const batch=await f.engine.createPlan(),single=await f.engine.createPlan({filePath:p});
 const a=batch.actions.find(x=>x.path===p),b=single.actions.find(x=>x.path===p);
 assert.deepEqual(a.collectionParts,['topic','raw','01_实验','papers']);assert.deepEqual(a,b);
});
test('ordinary folder supports root PDFs and flat mode',async t=>{
 const f=await fixture(t,'directory-tree');await f.pdf('a.pdf');await f.pdf('papers/b.pdf');f.rule.layout={mode:'flat'};await f.configure();
 const p=await f.engine.createPlan();assert.equal(p.scans[0].files.length,2);assert(p.scans[0].files.every(x=>x.collectionParts.length===0));
});
test('raw-data, draw, excluded branches and generated KB assets are not KB content',async t=>{
 const f=await fixture(t);await f.pdf('raw-data/a.pdf');await f.pdf('draw/a.pdf');await f.pdf('tmp/topic/raw/papers/a.pdf');await f.pdf('topic/kb/research/generated.pdf');await f.pdf('topic/raw/standards/a.pdf');await f.configure();
 const p=await f.engine.createPlan();assert.equal(p.scans[0].files.length,1);assert.equal(p.scans[0].files[0].relativePath,'topic/raw/standards/a.pdf');
 assert(p.scans[0].warnings.some(x=>x.code==='PAPERS_DIRECTORY_MISSING'));
});
test('selected content folder requires a KB root, not silent scope expansion',async t=>{
 const f=await fixture(t);await f.pdf('topic/raw/papers/a.pdf');await f.engine.saveSettings({rules:[f.rule],bindings:{test:{sourceRoot:path.join(f.root,'topic/raw/papers')}}});
 const p=await f.engine.createPlan();assert.equal(p.actions.length,0);assert(p.errors.some(x=>x.code==='KB_CONTENT_SELECTED'));
});
test('symlinks and invalid PDFs are reported and never imported',async t=>{
 const f=await fixture(t,'directory-tree');await f.pdf('a.pdf');await fs.writeFile(path.join(f.root,'bad.pdf'),'not a PDF');
 if(process.platform!=='win32')await fs.symlink(path.join(f.root,'a.pdf'),path.join(f.root,'alias.pdf'));
 await f.configure();const p=await f.engine.createPlan();assert.equal(p.scans[0].files.length,1);assert(p.errors.some(x=>x.code==='INVALID_PDF'));
 if(process.platform!=='win32')assert(p.scans[0].skipped.some(x=>x.reason==='SYMLINK_SKIPPED'));
});
test('ten concurrent requests for one file create only one attachment',async t=>{
 const f=await fixture(t);const file=await f.pdf('topic/raw/papers/a.pdf');await f.configure();
 const results=await Promise.all(Array.from({length:10},()=>f.engine.importFile(file)));
 assert.equal(f.library.creates,1);assert.equal(results.reduce((n,r)=>n+r.created,0),1);assert.equal(results.reduce((n,r)=>n+r.reused,0),9);
});
test('reuses child attachments and preserves unrelated parent collections',async t=>{
 const f=await fixture(t);const file=await f.pdf('topic/raw/papers/a.pdf');await f.configure();
 f.library.items.push({key:'EXISTING',path:file,collections:[],parent:{collections:['ROOT0002']}});
 const result=await f.engine.importFile(file);assert.equal(result.reused,1);assert.equal(f.library.creates,0);assert.equal(result.collectionsAdded,1);
 assert(f.library.items[0].parent.collections.includes('ROOT0002'));assert.equal(f.library.items[0].parent.collections.length,2);
});
test('preexisting duplicate links remain a visible conflict',async t=>{
 const f=await fixture(t);const file=await f.pdf('raw/papers/a.pdf');await f.configure();f.library.items.push({key:'A1',path:file,collections:[]},{key:'A2',path:file,collections:[]});
 const result=await f.engine.importFile(file);assert.equal(result.status,'failed');assert(result.errors.some(x=>x.code==='PATH_CONFLICT'));assert.equal(f.library.creates,0);
});
test('configuration and file changes invalidate planned work',async t=>{
 const f=await fixture(t);const file=await f.pdf('raw/papers/a.pdf');await f.configure();const stale=await f.engine.createPlan();await f.configure();
 await assert.rejects(f.engine.apply(stale.id),{code:'PLAN_STALE'});
 const changed=await f.engine.createPlan();await fs.appendFile(file,'changed');const r=await f.engine.apply(changed.id);assert(r.errors.some(x=>x.code==='FILE_CHANGED'));assert.equal(f.library.creates,0);
});
test('source/target overlaps are rejected; aliases do not bypass source checks',async t=>{
 const f=await fixture(t,'directory-tree');await fs.mkdir(path.join(f.root,'child'));
 const second={...f.rule,id:'other',name:'Other',target:{library:'user',collectionKey:'ROOT0002'}};
 await assert.rejects(f.engine.saveSettings({rules:[f.rule,second],bindings:{test:{sourceRoot:f.root},other:{sourceRoot:path.join(f.root,'child')}}}),{code:'RULE_OVERLAP'});
});
test('independent rules work; an offline source does not suppress a healthy rule',async t=>{
 const f=await fixture(t,'directory-tree');const file=await f.pdf('one/a.pdf');await fs.mkdir(path.join(f.root,'two'));
 const second={...f.rule,id:'other',name:'Other',target:{library:'user',collectionKey:'ROOT0002'}};
 await f.engine.saveSettings({rules:[f.rule,second],bindings:{test:{sourceRoot:path.join(f.root,'one')},other:{sourceRoot:path.join(f.root,'two')}}});
 await fs.rm(path.join(f.root,'two'),{recursive:true});const p=await f.engine.createPlan();const r=await f.engine.apply(p.id);
 assert.equal(r.created,1);assert.equal(r.status,'partial');assert.equal(r.items[0].path,file);
});
test('target and mapped child renames preserve keys',async t=>{
 const f=await fixture(t);const file=await f.pdf('raw/papers/a.pdf');await f.configure();let r=await f.engine.importFile(file);const collection=f.library.collections.get(r.items[0].collectionKey);
 collection.name='Renamed';f.library.collections.get('ROOT0001').name='Renamed root';r=await f.engine.importFile(file);
 assert.equal(r.items[0].collectionKey,collection.key);assert.equal(f.library.creates,1);
});
test('cancellation stops before the next write',async t=>{
 const f=await fixture(t);await f.pdf('raw/papers/a.pdf');await f.configure();const p=await f.engine.createPlan();const r=await f.engine.apply(p.id,{cancelled:()=>true});assert.equal(r.status,'cancelled');assert.equal(f.library.creates,0);
});
test('custom KB marker is explicit and standard profile cannot flatten',async t=>{
 const f=await fixture(t);f.rule.layout={mode:'flat',profile:'research-kb/v1'};await assert.rejects(f.configure(),{code:'RULE_INVALID'});
 f.rule.layout={profile:'custom',mode:'mirror'};f.rule.scan.marker='originals';await f.pdf('topic/originals/papers/a.pdf');await f.configure();const p=await f.engine.createPlan();assert.equal(p.scans[0].files.length,1);
});
test('single-file import creates only its own ancestor collections',async t=>{
 const f=await fixture(t);const selected=await f.pdf('A/raw/papers/a.pdf');await f.pdf('B/raw/technical/b.pdf');await f.configure();
 const p=await f.engine.createPlan({filePath:selected});assert(p.actions.filter(a=>a.type==='ensure-collection').every(a=>a.parts[0]!=='B'));
 await f.engine.apply(p.id);assert(![...f.library.collections.values()].some(c=>c.name==='B'));assert.equal(f.library.creates,1);
});
test('progress stays bounded while the final result keeps every file',async t=>{
 const f=await fixture(t,'directory-tree');for(let n=0;n<25;n++)await f.pdf(`file-${n}.pdf`);await f.configure();
 const p=await f.engine.createPlan();let updates=0;
 const r=await f.engine.apply(p.id,{progress:s=>{updates++;assert(s.items.length<=10);}});
 assert.equal(updates,25);assert.equal(r.items.length,25);assert.equal(f.store.events.length,25);
});
