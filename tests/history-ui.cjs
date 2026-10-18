'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {Store}=require('../core/store.cjs');const {uuid,localDate}=require('../core/model.cjs');
const project=path.resolve(__dirname,'..');
async function check(mobile){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'riye-history-ui-')),s=new Store(root),date=localDate(),entityId='note:'+date+':diary';
 const write=text=>s.save({entityId,parents:s.get(entityId).heads.map(r=>r.id),payload:{blocks:[{id:uuid(),kind:'text',text}]}}).revision;
 write('虚构测试原句');const checkpoint=write('虚构测试原句，追加内容');write('已经修改过的测试文字');const latest=write('已经修改过的测试文字，继续追加');
 s.importRevision({...latest,id:uuid(),parents:[latest.id]});
 let app;try{
 app=await _electron.launch({executablePath:process.env.ELECTRON_BINARY||path.join(project,'.runtime/linux/electron'),args:['--no-sandbox','--ozone-platform=headless','--disable-gpu',mobile?path.join(__dirname,'mobile-host.cjs'):project],env:{...process.env,RIYE_TEST_MODE:'1',RIYE_DATA_DIR:root,RIYE_TEST_DIR:root},timeout:30000});
 const p=await app.firstWindow(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewportSize({width:mobile?393:1440,height:950});await p.waitForSelector(`[data-document="${entityId}"]`);
 await p.locator(`[data-action=versions][data-doc="${entityId}"]`).click();await p.waitForSelector('.version');
 assert.equal(await p.locator('.version').count(),2);assert.equal(await p.locator('.current-version').count(),1);assert.equal(await p.locator('[data-action=version-restore]').count(),1);
 assert((await p.locator('.current-version').innerText()).includes('当前内容'));assert.equal((await p.evaluate(id=>window.daybook.versions(id),entityId)).length,2);
 await p.locator(`[data-action=version-restore][data-id="${checkpoint.id}"]`).click();await p.waitForFunction(()=>!document.querySelector('#modal').open);
 const result=await p.evaluate(date=>window.daybook.day(date),date);assert.equal(result.diary.revision.payload.blocks[0].text,'虚构测试原句，追加内容');assert.equal(result.diary.conflict,false);assert.deepEqual(errors,[]);
 await p.locator(`[data-action=versions][data-doc="${entityId}"]`).click();await p.waitForSelector('.version');assert.equal(await p.locator('.version').count(),2);
 await p.screenshot({path:path.join(project,mobile?'.qa-history-mobile.png':'.qa-history-desktop.png'),fullPage:true});
 console.log('PASS: '+(mobile?'mobile':'desktop')+' compact history, current label, original checkpoint restore, no duplicate/append cards.');
 }finally{if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{await check(false);await check(true);})().catch(e=>{console.error(e);process.exitCode=1;});
