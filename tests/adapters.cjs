const fs = require('node:fs/promises');
const path = require('node:path');
const { initialState, clone, key } = require('../src/engine.js');
const filesystem = {
  normalize: path.normalize, isAbsolute: path.isAbsolute, join: path.join,
  parent: path.dirname, basename: path.basename, relative: path.relative,
  realPath: p => fs.realpath(p),
  stat: async p => { const s = await fs.stat(p); return {size:s.size, modified:s.mtimeMs,isDirectory:s.isDirectory()}; },
  list: async p => Promise.all((await fs.readdir(p,{withFileTypes:true})).map(d=>({name:d.name,path:path.join(p,d.name),isDirectory:d.isDirectory(),isSymlink:d.isSymbolicLink()}))),
  header: async p => { const h=await fs.open(p);try{const b=Buffer.alloc(5);await h.read(b,0,5,0);return b.toString();}finally{await h.close();} }
};
class Store {
  constructor(){this.state=initialState();this.queue=Promise.resolve();}
  async read(){await this.queue;return clone(this.state);}
  async revision(){await this.queue;return this.state.revision;}
  async getMapping(id){await this.queue;return this.state.mappings[id];}
  setMapping(id,key){const p=this.queue.then(()=>{this.state.mappings[id]=key;});this.queue=p.catch(()=>{});return p;}
  async recordEvent(planId,event){(this.events||=[]).push({planId,...clone(event)});}
  change(fn){const operation=this.queue.then(()=>{const next=clone(this.state);fn(next);this.state=next;});this.queue=operation.catch(()=>{});return operation;}
}
class Library {
  constructor(){this.collections=new Map([['ROOT0001',{id:1,key:'ROOT0001',parentKey:null,name:'Target'}],['ROOT0002',{id:2,key:'ROOT0002',parentKey:null,name:'Other'}]]);this.items=[];this.counter=2;this.creates=0;}
  async getTarget(k){const c=this.collections.get(k);if(!c)throw Error('Missing target');return c;}
  async targetsOverlap(a,b){const walk=k=>{for(let c=this.collections.get(k);c;c=this.collections.get(c.parentKey))if(c.key===b)return true;return false;};return walk(a)||a===b||(()=>{for(let c=this.collections.get(b);c;c=this.collections.get(c.parentKey))if(c.key===a)return true;return false;})();}
  async linkedIndex(){const m=new Map();for(const item of this.items){const p=key(await filesystem.realPath(item.path));if(!m.has(p))m.set(p,[]);m.get(p).push(item);}return m;}
  async getMappedCollection(k,parent){const c=this.collections.get(k);return c&&c.parentKey===parent?c:null;}
  async ensureChild(parent,name){const existing=[...this.collections.values()].filter(c=>c.parentKey===parent.key&&c.name===name);if(existing.length>1)throw Error('Ambiguous collection');if(existing.length)return existing[0];const c={key:'C'+String(++this.counter).padStart(7,'0'),id:this.counter,parentKey:parent.key,name};this.collections.set(c.key,c);return c;}
  async createLink(p,c){await new Promise(r=>setTimeout(r,1));const item={key:'A'+(++this.creates),path:p,collections:[c.key]};this.items.push(item);return item;}
  filePath(item){return item.path;}
  async addCollection(item,c){const owner=item.parent||item;if(owner.collections.includes(c.key))return false;owner.collections.push(c.key);return true;}
  async recognize(){return 'pending';}
}
module.exports={filesystem,Store,Library};
