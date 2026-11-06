const http=require('node:http');
async function server(){
 const files=new Map(),dirs=new Set(['/']),control={deleteFail:false,partialEvent:false},requests=[];
 const esc=s=>s.replaceAll('&','&amp;');
 const srv=http.createServer(async(req,res)=>{const p=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path:p});
  if(req.method==='PROPFIND'){
   if(!dirs.has(p)){res.writeHead(404);res.end();return;}
   const response=(name,bytes,dir=false)=>`<d:response><d:href>${esc(name)}</d:href><d:propstat><d:prop><d:resourcetype>${dir?'<d:collection/>':''}</d:resourcetype>${dir?'':`<d:getcontentlength>${bytes}</d:getcontentlength>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
   let xml='<d:multistatus xmlns:d="DAV:">'+response(p,0,true);if(req.headers.depth!=='0'){
    for(const [name,body]of files)if(name.startsWith(p)&&!name.slice(p.length).includes('/'))xml+=response(name,body.length);
    for(const dir of dirs)if(dir!==p&&dir.startsWith(p)&&!dir.slice(p.length).replace(/\/$/,'').includes('/'))xml+=response(dir,0,true);
   }res.writeHead(207);res.end(xml+'</d:multistatus>');return;
  }
  if(req.method==='MKCOL'){const exists=dirs.has(p);dirs.add(p);res.writeHead(exists?405:201);res.end();return;}
  if(req.method==='GET'){if(!files.has(p)){res.writeHead(404);res.end();return;}res.end(files.get(p));return;}
  if(req.method==='PUT'){if(files.has(p)&&req.headers['if-none-match']==='*'){res.writeHead(412);res.end();return;}const chunks=[];for await(const b of req)chunks.push(b);let data=Buffer.concat(chunks);if(control.partialEvent&&p.includes('/retentions/')){control.partialEvent=false;files.set(p,data.subarray(0,8));res.writeHead(503);res.end();return;}files.set(p,data);if(control.afterPut)await control.afterPut(p);res.writeHead(201);res.end();return;}
  if(req.method==='DELETE'){if(control.deleteFail){control.deleteFail=false;res.writeHead(503);res.end();return;}files.delete(p);res.writeHead(204);res.end();return;}
  res.writeHead(405);res.end();
 });await new Promise(r=>srv.listen(0,'127.0.0.1',r));return{files,dirs,control,requests,config:{primary:'http://127.0.0.1:'+srv.address().port,directory:'/riye',username:'u',password:'p',auto:false},close:()=>new Promise(r=>srv.close(r))};
}
module.exports={server};
