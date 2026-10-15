const esbuild=require('esbuild'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'android/build/assets');fs.mkdirSync(out,{recursive:true});
esbuild.build({entryPoints:[path.join(__dirname,'platform.js')],bundle:true,platform:'browser',format:'iife',target:'chrome110',minify:true,inject:[path.join(__dirname,'globals.js')],alias:{'node:fs':path.join(__dirname,'shims/fs.js'),'node:path':'path-browserify','node:crypto':path.join(__dirname,'shims/crypto.js'),'node:zlib':path.join(__dirname,'shims/zlib.js')},nodePaths:[path.join(__dirname,'node_modules')],outfile:path.join(out,'bridge.js')}).then(()=>{
 fs.copyFileSync(path.join(__dirname,'THIRD_PARTY_LICENSES.txt'),path.join(out,'third-party.txt'));
 fs.copyFileSync(path.join(root,'LICENSE'),path.join(out,'riye-license.txt'));
 for(const file of ['app.js','style.css','icon.svg'])fs.copyFileSync(path.join(root,'renderer',file),path.join(out,file));
 let html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8');html=html.replace('<script src="app.js">','<script src="bridge.js"></script><script src="app.js">');fs.writeFileSync(path.join(out,'index.html'),html);console.log('Android assets bundled');
}).catch(e=>{console.error(e);process.exitCode=1;});
