'use strict';
// Resource-only branding of the checked official Electron executable.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {NtExecutable,NtExecutableResource,Data,Resource}=require('resedit');
const root=path.resolve(__dirname,'..');
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node scripts/windows-icon.cjs input.exe output.exe');
const original=NtExecutable.from(fs.readFileSync(input),{ignoreCert:true});
const resource=NtExecutableResource.from(original);
const icon=Data.IconFile.from(fs.readFileSync(path.join(root,'desktop/icon.ico')));
const icons=icon.icons.map(item=>item.data);
const groups=Resource.IconGroupEntry.fromEntries(resource.entries);
for(const group of groups.length?groups:[{id:1,lang:1033}])Resource.IconGroupEntry.replaceIconsForResource(resource.entries,group.id,group.lang,icons);
const version=require('../package.json').version.split('.').map(Number);
for(const info of Resource.VersionInfo.fromEntries(resource.entries)){
 info.setFileVersion(...version,0,1033);
 info.setProductVersion(...version,0,1033);
 info.setStringValues({lang:1033,codepage:1200},{FileDescription:'日页',ProductName:'日页',InternalName:'Riye',OriginalFilename:'Riye.exe'});
 info.outputToResourceEntries(resource.entries);
}
const originalCode=original.getAllSections().filter(s=>s.info.name!=='.rsrc').map(s=>({name:s.info.name,data:s.data?Buffer.from(new Uint8Array(s.data)):null}));
resource.outputResource(original);
const bytes=Buffer.from(original.generate());
const verified=NtExecutable.from(bytes),verifiedResource=NtExecutableResource.from(verified);
for(const section of originalCode){const actual=verified.getAllSections().find(s=>s.info.name===section.name);assert(actual,'Missing executable section '+section.name);assert.deepEqual(actual.data?Buffer.from(actual.data):null,section.data,'Executable code changed: '+section.name);}
const iconBytes=item=>Buffer.from(item.isRaw()?item.bin:item.generate());
for(const group of Resource.IconGroupEntry.fromEntries(verifiedResource.entries)){
 const actual=group.getIconItemsFromEntries(verifiedResource.entries);
 assert.equal(actual.length,icons.length);
 for(let i=0;i<icons.length;i++)assert.deepEqual(iconBytes(actual[i]),iconBytes(icons[i]),'Embedded icon differs');
}
fs.writeFileSync(output,bytes);
console.log('Verified Riye executable icons; every non-resource section is unchanged.');
