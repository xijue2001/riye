'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeConfig}=require('../core/dav.cjs');
const {AutoSync}=require('../desktop/auto-sync.cjs');
const connection={primary:'http://127.0.0.1:6086',directory:'/riye',auto:true};

test('old connections default to five minutes; all dropdown intervals normalize and invalid values fail',()=>{
  assert.equal(normalizeConfig(connection).syncIntervalMinutes,5);
  for(const n of [5,10,15,30,60,120,240,360,480,720,1440])assert.equal(normalizeConfig({...connection,syncIntervalMinutes:String(n)}).syncIntervalMinutes,n);
  for(const n of [0,1,4,7,1441,NaN,Infinity,'invalid',null])assert.throws(()=>normalizeConfig({...connection,syncIntervalMinutes:n}),/自动同步间隔/);
});

test('automatic sync waits for the chosen interval; changing it cancels the earlier timer',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const calls=[],sync={running:null,run:async c=>{calls.push(c);}},timer=new AutoSync(sync);
  timer.configure(connection);
  t.mock.timers.tick(299999);assert.equal(calls.length,0);
  t.mock.timers.tick(1);assert.equal(calls.length,1);
  timer.configure({...connection,syncIntervalMinutes:1440});
  t.mock.timers.tick(1440*60000-1);assert.equal(calls.length,1);
  t.mock.timers.tick(1);assert.equal(calls.length,2);assert.equal(calls[1].syncIntervalMinutes,1440);
  timer.stop();t.mock.timers.tick(2*1440*60000);assert.equal(calls.length,2);
});

test('disabled or unconfigured auto sync never runs; manual sync remains immediate',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let calls=0;const sync={running:null,run:async()=>{calls++;}},timer=new AutoSync(sync);
  timer.configure(connection);timer.configure({...connection,auto:false});
  t.mock.timers.tick(1440*60000);assert.equal(calls,0);
  await sync.run(connection);assert.equal(calls,1);
  timer.configure({...connection,primary:''});t.mock.timers.tick(1440*60000);assert.equal(calls,1);
  timer.configure(connection);t.mock.timers.tick(5*60000);assert.equal(calls,2);timer.stop();
});

test('an active manual sync is skipped and a failed auto sync retries at the next interval',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let calls=0;const sync={running:Promise.resolve(),run:async()=>{calls++;throw Error('NAS offline');}},timer=new AutoSync(sync);
  timer.configure(connection);t.mock.timers.tick(5*60000);assert.equal(calls,0);
  sync.running=null;t.mock.timers.tick(5*60000);await Promise.resolve();assert.equal(calls,1);
  t.mock.timers.tick(5*60000);await Promise.resolve();assert.equal(calls,2);timer.stop();
});
