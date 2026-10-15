'use strict';
const zlib=require('node:zlib');
const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
function crc32(buf){let c=0xffffffff;for(const b of buf)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function makeZip(entries){
  if(entries.length>65535||entries.reduce((n,entry)=>n+Buffer.byteLength(entry[1]),0)>1024*1024*1024)throw Error('备份超过当前版本支持的 1 GB 总容量');
  const parts=[],central=[];let offset=0;
  for(const [name,data] of entries){
    const bytes=Buffer.from(data),filename=Buffer.from(name,'utf8'),packed=zlib.deflateRawSync(bytes,{level:5}),crc=crc32(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(0x21,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(offset,42);
    parts.push(local,filename,packed);central.push(c,filename);offset+=local.length+filename.length+packed.length;
  }
  if(entries.length>65535||offset>0xffffffff)throw Error('备份超出当前 ZIP 格式容量');
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,cd,end]);
}
function readZip(buf){
  let end=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('不是有效的 ZIP 备份');
  const count=buf.readUInt16LE(end+10),start=buf.readUInt32LE(end+16),size=buf.readUInt32LE(end+12);
  if(start+size>end||buf.readUInt16LE(end+4)||buf.readUInt16LE(end+6))throw Error('不支持此备份格式');
  let pos=start,total=0;const entries=new Map();
  for(let i=0;i<count;i++){
    if(pos+46>end||buf.readUInt32LE(pos)!==0x02014b50)throw Error('备份目录损坏');
    const flags=buf.readUInt16LE(pos+8),method=buf.readUInt16LE(pos+10),crc=buf.readUInt32LE(pos+16),packed=buf.readUInt32LE(pos+20),length=buf.readUInt32LE(pos+24),nl=buf.readUInt16LE(pos+28),xl=buf.readUInt16LE(pos+30),cl=buf.readUInt16LE(pos+32),local=buf.readUInt32LE(pos+42);
    if(flags&1||![0,8].includes(method)||length>128*1024*1024||(total+=length)>1024*1024*1024)throw Error('备份过大或格式不支持');
    const name=buf.subarray(pos+46,pos+46+nl).toString('utf8');
    if(!name||name.includes('..')||name.startsWith('/')||name.includes('\\')||entries.has(name))throw Error('备份路径不正确');
    if(local+30>start||buf.readUInt32LE(local)!==0x04034b50)throw Error('备份内容损坏');
    const localNl=buf.readUInt16LE(local+26),localXl=buf.readUInt16LE(local+28),from=local+30+localNl+localXl;
    if(from+packed>start||buf.subarray(local+30,local+30+localNl).toString('utf8')!==name)throw Error('备份内容损坏');
    let data;try{const raw=buf.subarray(from,from+packed);data=method===0?Buffer.from(raw):zlib.inflateRawSync(raw,{maxOutputLength:length+1});}catch{throw Error('备份解压失败');}
    if(data.length!==length||crc32(data)!==crc)throw Error('备份校验失败');
    entries.set(name,data);pos+=46+nl+xl+cl;
  }
  if(pos!==start+size)throw Error('备份目录损坏');return entries;
}
module.exports={makeZip,readZip};
