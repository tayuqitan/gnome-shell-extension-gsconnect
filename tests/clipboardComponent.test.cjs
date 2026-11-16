// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const timers = new Map(); let seq = 0;
class Base { _init() {} emit(name) { this.events.push(name); } notify(name) { this.events.push(`notify:${name}`); } }
class Proxy { async call(method, params) { this.calls.push([method, params?.value]); return this.handler(method, params?.value); } }
class Variant { constructor(type, value) { this.value = value; } deepUnpack() { return this.value; } }
const context = { Uint8Array, Promise, Error, debug() {},
 GObject: {Object: Base, registerClass: (_, C) => C, ParamSpec:{string(){}}, ParamFlags:{READWRITE:1}},
 Gio: {DBusProxy:Proxy, Cancellable: class {cancel(){this.canceled=true;} is_cancelled(){return !!this.canceled;}},bus_watch_name(){return 1;}, BusType:{SESSION:1},BusNameWatcherFlags:{NONE:0},DBusCallFlags:{NO_AUTO_START:0}, IOErrorEnum:{CANCELLED:1}},
 Gtk:{Clipboard:class{}}, Gdk:{}, GLib:{Variant,PRIORITY_DEFAULT:0,timeout_add_seconds(p,t,fn){timers.set(++seq,fn);return seq;},source_remove(id){timers.delete(id);},SOURCE_REMOVE:0},};
vm.createContext(context);
let code=fs.readFileSync('src/service/components/clipboard.js','utf8').replace(/^import .*;$/gm,'').replace('export default Clipboard;', 'globalThis.Clipboard = Clipboard;');
vm.runInContext(code,context);
function fresh(){const c = new context.Clipboard();c.events=[];c._init();c._clipboard=new Proxy();c._clipboard.calls=[];return c;}
const reply=x=>new Variant('',[x]);
(async()=>{
const c=fresh();c._clipboard.handler=async m=>reply(m==='GetOffer'?'':['image/png']);await c._onOwnerChange();assert.equal(c.richAvailable,true);assert.equal(c.mimetypes[0],'image/png');assert.deepEqual(c.events,['changed']);
c.events=[];c._clipboard.handler=async()=>reply('remote');await c._onOwnerChange();assert.deepEqual(c.events,[]);
c._clipboard.handler=async()=>reply('');await c.offer('r',['image/png'],async()=>new Uint8Array([1,2]));assert.equal(c._clipboard.calls.at(-1)[0],'Offer');await c._onValueRequested(c._clipboard,['r','q','image/png']);assert.equal(c._clipboard.calls.at(-1)[0],'Resolve');assert.deepEqual(Array.from(c._clipboard.calls.at(-1)[1][2]),[1,2]);assert.equal(timers.size,0);
await c.clearOffer('wrong');assert.equal(c._offer.id,'r');await c.clearOffer('r');assert.equal(c._offer,null);
c._mimetypes=['image/png'];let finish;c._clipboard.handler=()=>new Promise(r=>{finish=r;});const read=c.readValue('image/png');c._generation++;finish(reply([1]));await assert.rejects(read,/changed/);
c._clipboard.handler=async()=>reply('');await c.offer('r',['image/png'],()=>new Promise(()=>{}));const request=c._onValueRequested(c._clipboard,['r','q2','image/png']);await Promise.resolve();await c.clearOffer('r');await request;assert.equal(timers.size,0);assert.equal(c._requests.size,0);
console.log('PASS component mocks: local signal, remote echo suppression, offer/resolve, wrong-id clear, stale read, callback cancellation');
})().catch(e=>{console.error(e);process.exitCode=1;});
