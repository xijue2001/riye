'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {Store}=require('../core/store.cjs');const {localDate}=require('../core/model.cjs');
const project=path.resolve(__dirname,'..');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwYQAAAAASUVORK5CYII=','base64');
async function check(mobile){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'riye-manual-ui-')),day=localDate(),intent='note:'+day+':intent',diary='note:'+day+':diary';let app,p;
 const selector=id=>`[data-document="${id}"]`,saved=()=>new Store(root).checkpointList(diary).filter(c=>c.kind==='save');
 try{
 app=await _electron.launch({executablePath:process.env.ELECTRON_BINARY||path.join(project,'.runtime/linux/electron'),args:['--no-sandbox','--ozone-platform=headless','--disable-gpu',mobile?path.join(__dirname,'mobile-host.cjs'):project],env:{...process.env,RIYE_TEST_MODE:'1',RIYE_DATA_DIR:root,RIYE_TEST_DIR:root},timeout:30000});
 p=await app.firstWindow();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.setViewportSize({width:mobile?393:1440,height:1000});await p.waitForSelector(selector(intent));
 if(!mobile){const file=path.join(root,'picker.png');fs.writeFileSync(file,png);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);}
 const doc=p.locator(selector(intent)),textButton=p.locator(`[data-action=insert-text][data-doc="${intent}"]`),imageButton=p.locator(`[data-action=insert-image][data-doc="${intent}"]`);
 assert.equal(await doc.locator('[contenteditable]').count(),1);await textButton.click();assert.equal(await doc.locator('[contenteditable]').count(),2);
 await doc.locator('[contenteditable]').first().fill('插入测试正文');await doc.locator('[contenteditable]').last().click();await imageButton.click();await p.waitForFunction(id=>document.querySelectorAll(`[data-document="${id}"] .image-block`).length===1,intent);
 assert.equal(await doc.locator('[contenteditable]').count(),2);assert.equal(await doc.locator('.block').count(),3);
 await imageButton.click();await p.waitForFunction(id=>document.querySelectorAll(`[data-document="${id}"] .image-block`).length===2,intent);assert.equal(await doc.locator('[contenteditable]').count(),2);
 // Dropping multiple images inserts them together, with one continuation row.
 await p.evaluate(({id,bytes})=>{const dt=new DataTransfer();for(let i=0;i<2;i++)dt.items.add(new File([new Uint8Array(bytes)],'fictional-'+i+'.png',{type:'image/png'}));document.querySelector(`[data-document="${id}"]`).dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));},{id:intent,bytes:[...png]});
 await p.waitForFunction(id=>document.querySelectorAll(`[data-document="${id}"] .image-block`).length===4,intent);assert.equal(await doc.locator('[contenteditable]').count(),2);
 // Inserting in the middle preserves the text on both sides, without an empty tail.
 await doc.locator('[contenteditable]').first().fill('甲乙丙丁');await p.evaluate(id=>{const el=document.querySelector(`[data-document="${id}"] [contenteditable]`);el.focus();const r=document.createRange();r.setStart(el.firstChild,2);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r);},intent);
 await textButton.click();assert.deepEqual(await doc.locator('[contenteditable]').allTextContents(),['甲乙','','丙丁','']);
 const diaryEditor=p.locator(selector(diary)+' [contenteditable]').first();await diaryEditor.fill('虚构日记初稿');await p.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存在本机');
 for(const text of ['虚构日记改写','删除后重写','第一次手动保存']){await diaryEditor.fill(text);await p.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存在本机');assert.equal((await p.evaluate(id=>window.daybook.versions(id),diary)).length,1);assert.equal(saved().length,0);}
 await p.keyboard.press('Control+s');await p.waitForFunction(()=>document.querySelector('#toast').textContent==='已保存版本。');assert.equal(saved().length,1);
 const before=new Store(root).get(diary).firstEditedAt;
 await diaryEditor.fill('自动保存的另一份草稿');await p.locator('[data-action=day-prev]').click();await p.locator('[data-action=day-next]').click();await p.waitForSelector(selector(diary));
 assert.equal(await p.locator(selector(diary)+' [contenteditable]').first().innerText(),'自动保存的另一份草稿');assert.equal(saved().length,1);
 let versions=await p.evaluate(id=>window.daybook.versions(id),diary);assert.equal(versions.length,2);assert.equal(versions.filter(r=>r.saved).length,1);
 await p.locator(`[data-action=save-version][data-doc="${diary}"]`).click();await p.waitForFunction(()=>document.querySelector('#toast').textContent==='已保存版本。');assert.equal(saved().length,2);
 await p.keyboard.press('Control+s');await p.waitForFunction(()=>document.querySelector('#toast').textContent==='内容未变化，无需新增版本。');assert.equal(saved().length,2);
 await p.locator(selector(diary)+' [contenteditable]').first().fill('最后手动保存的一段');await p.keyboard.press('Control+s');await p.waitForFunction(()=>document.querySelector('#toast').textContent==='已保存版本。');assert.equal(saved().length,3);
 await p.locator(`[data-action=versions][data-doc="${diary}"]`).click();await p.waitForSelector('.version');assert.equal(await p.locator('.version').count(),3);assert.equal(await p.locator('.current-version').count(),1);assert((await p.locator('.current-version').innerText()).includes('已保存版本'));
 await p.screenshot({path:path.join(project,mobile?'.qa-manual-history-mobile.png':'.qa-manual-history-desktop.png'),fullPage:true});
 await p.locator('[data-action=version-restore]').last().click();await p.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(new Store(root).get(diary).revision.payload.blocks[0].text,'第一次手动保存');assert.equal(new Store(root).get(diary).firstEditedAt,before);
 assert.deepEqual(errors,[]);console.log('PASS: '+(mobile?'mobile':'desktop')+' single-row insertion, grouped photos, safe text split, explicit save, no-op Ctrl+S, draft navigation and checkpoint restore.');
 }catch(error){if(p)console.log('UI failure',mobile,await p.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,save:document.querySelector('#save-state')?.textContent})),new Store(root).checkpointList().map(c=>({kind:c.kind,entityId:c.entityId})));throw error;}finally{if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{await check(false);await check(true);})().catch(e=>{console.error(e);process.exitCode=1;});
