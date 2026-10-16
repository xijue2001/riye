'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {Store}=require('../core/store.cjs');
const project=path.resolve(__dirname,'..');
async function check(mobile){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'riye-organize-')),disk=new Store(root);
  const d=new Date(),day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const id=`note:${day}:diary`,intent=`note:${day}:intent`,image=disk.addAsset(fs.readFileSync(path.join(project,'renderer/icon.png')));
  const original=disk.save({entityId:id,parents:[],payload:{blocks:[{id:'first',kind:'text',text:'第一段日记'},{id:'check',kind:'check',text:'英语学习',checked:true},{id:'photo',kind:'image',assetId:image.assetId,caption:'保留图片说明'}]}});
  disk.save({entityId:intent,parents:[],payload:{blocks:[]}});
  let app;
  try{
    app=await _electron.launch({executablePath:path.join(project,'.runtime/linux/electron'),args:['--no-sandbox','--ozone-platform=headless','--disable-gpu',mobile?path.join(__dirname,'mobile-host.cjs'):project],env:{...process.env,RIYE_TEST_MODE:'1',RIYE_DATA_DIR:root,RIYE_TEST_DIR:root},timeout:20000});
    const p=await app.firstWindow(),errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.setViewportSize({width:mobile?393:1440,height:950});await p.waitForSelector(`[data-document="${id}"]`);
    if(mobile)await p.evaluate(()=>{window.daybook.assetUrl=id=>'daybook://asset/'+id;});
    const doc=p.locator(`[data-document="${id}"]`),toggle=p.locator(`[data-action=organize-toggle][data-doc="${id}"]`),empty=p.locator(`[data-action=organize-toggle][data-doc="${intent}"]`);
    const record=async()=> (await p.evaluate(day=>window.daybook.day(day),day)).diary;
    assert(await empty.isDisabled());assert.equal(await p.locator(`[data-document="${intent}"] [contenteditable]`).count(),1);
    assert.equal(await doc.locator('.block-controls').count(),0);
    const before=(await record()).revision.id;await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    assert.equal(await doc.locator('.block-controls').count(),3);assert(await doc.locator('[data-action=block-up]').first().isDisabled());
    await toggle.click();assert.equal((await record()).revision.id,before,'Mode toggles must not create content revisions');await toggle.click();
    await doc.locator('[data-action=block-up][data-id=photo]').click();
    await p.locator('[data-page=history]').click();let saved=(await record()).revision;
    assert.deepEqual(saved.payload.blocks.map(b=>b.id),['first','photo','check']);assert.equal(saved.payload.blocks[1].caption,'保留图片说明');assert.equal(saved.payload.blocks[2].checked,true);
    await p.locator('[data-page=today]').click();await p.waitForSelector(`[data-document="${id}"]`);assert.equal(await doc.locator('.block-controls').count(),0);
    await toggle.click();await doc.locator('[data-action=block-remove][data-id=first]').click();
    await p.locator('[data-page=history]').click();saved=(await record()).revision;assert.deepEqual(saved.payload.blocks.map(b=>b.id),['photo','check']);
    const versions=await p.evaluate(id=>window.daybook.versions(id),id);assert(versions.some(r=>r.id===original.id||r.id===original.revision?.id));
    const initial=(await record()).firstEditedAt;
    await p.locator('[data-page=today]').click();await p.waitForSelector(`[data-document="${id}"]`);await toggle.click();
    if(mobile){await p.evaluate(()=>window.dispatchEvent(new Event('riye-back')));}else await p.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-pressed'),'false');await toggle.click();
    if(mobile)for(const width of [320,393]){await p.setViewportSize({width,height:950});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const heights=await doc.locator('.block-controls button').evaluateAll(buttons=>buttons.map(b=>b.getBoundingClientRect().height));assert(heights.every(h=>h>=44));}
    await p.screenshot({path:path.join(project,mobile?'.qa-organize-mobile.png':'.qa-organize-desktop.png'),fullPage:true});
    await doc.locator('[data-action=block-remove][data-id=photo]').click();await doc.locator('[data-action=block-remove][data-id=check]').click();
    assert(await toggle.isDisabled());assert.equal(await doc.locator('.block-controls').count(),0);assert.equal(await doc.locator('[contenteditable]').count(),1);
    await p.locator('[data-page=history]').click();assert.equal((await record()).firstEditedAt,initial,'Organizing must preserve first-edit time');
    // Restoring an older revision remains available after paragraph deletion.
    await p.evaluate(async({id,day})=>{const old=(await window.daybook.versions(id)).find(r=>r.payload?.blocks?.some(b=>b.id==='first'));const current=(await window.daybook.day(day)).diary;await window.daybook.save({entityId:id,parents:current.heads.map(r=>r.id),payload:old.payload});},{id,day});
    await p.locator('[data-page=today]').click();await p.waitForSelector(`[data-document="${id}"] [data-block=first]`);assert.equal(await doc.locator('.block-controls').count(),0);
    await toggle.click();await p.locator('[data-action=day-prev]').click();await p.locator('[data-action=day-next]').click();await p.waitForSelector(`[data-document="${id}"]`);assert.equal(await toggle.getAttribute('aria-pressed'),'false');assert.deepEqual(errors,[]);
    console.log('PASS: '+(mobile?'mobile':'desktop')+' organizer ordering, deletion, history restore, empty legacy records, first-edit preservation, navigation and exit behavior.');
  }finally{if(app)await app.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{await check(false);await check(true);})().catch(e=>{console.error(e);process.exitCode=1;});
