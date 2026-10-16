package dev.riye.app;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.*;
import android.security.keystore.*;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.webkit.*;
import android.widget.FrameLayout;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.*;

public final class MainActivity extends Activity {
    private static final String ORIGIN="https://appassets.androidplatform.net",PAGE=ORIGIN+"/assets/index.html",KEY_ALIAS="riye-webdav-password-v1";
    private WebView web;private Disk disk;private volatile boolean trusted=true;
    private final ExecutorService worker=Executors.newCachedThreadPool();
    private final ConcurrentMap<String,Call> calls=new ConcurrentHashMap<>();
    private final OkHttpClient http=new OkHttpClient.Builder().connectTimeout(10,TimeUnit.SECONDS).readTimeout(20,TimeUnit.SECONDS).writeTimeout(20,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
    private String pickerId,exportId,restoreId;private JSONObject pickerContext,exportSnapshot;
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        try{disk=new Disk(new File(getFilesDir(),"data-v1"));}catch(Exception e){new AlertDialog.Builder(this).setMessage("本地数据暂时无法打开："+e.getMessage()).setPositiveButton("关闭",(d,w)->finish()).show();return;}
        FrameLayout root=new FrameLayout(this);root.setBackgroundColor(Color.rgb(240,243,235));web=new WebView(this);web.setBackgroundColor(Color.rgb(245,246,242));root.addView(web,new FrameLayout.LayoutParams(-1,-1));setContentView(root);
        if(Build.VERSION.SDK_INT>=30){
            getWindow().setDecorFitsSystemWindows(false);root.post(()->{WindowInsetsController controller=getWindow().getInsetsController();if(controller!=null)controller.setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);});
            root.setOnApplyWindowInsetsListener((v,insets)->{Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()),ime=insets.getInsets(WindowInsets.Type.ime());v.setPadding(bars.left,bars.top,bars.right,Math.max(bars.bottom,ime.bottom));boolean keyboard=insets.isVisible(WindowInsets.Type.ime());js("if(window.__riyeKeyboard)window.__riyeKeyboard("+keyboard+")");return WindowInsets.CONSUMED;});
        }else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setSupportMultipleWindows(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setMediaPlaybackRequiresUserGesture(true);s.setTextZoom(100);
        web.addJavascriptInterface(new NativeBridge(),"RiyeNative");
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return true;}
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){trusted=PAGE.equals(url);}
            @Override public void onPageFinished(WebView view,String url){if(PAGE.equals(url))js("if(window.__riyeRecoverMedia)window.__riyeRecoverMedia()");}
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest req){
                try{
                    Uri u=req.getUrl();if(!"https".equals(u.getScheme())||!"appassets.androidplatform.net".equals(u.getHost()))return denied();
                    String p=u.getPath();
                    if(p.startsWith("/data-assets/")){String id=p.substring(13);if(!id.matches("[a-f0-9]{64}"))return denied();File image=disk.resolve("/data/assets/"+id+".bin");byte[] first=new byte[16];int n;try(InputStream in=new FileInputStream(image)){n=in.read(first);}String mime=Disk.mime(Arrays.copyOf(first,Math.max(0,n)));return new WebResourceResponse(mime,null,200,"OK",Collections.singletonMap("Cache-Control","private, max-age=86400"),new FileInputStream(image));}
                    if(!p.startsWith("/assets/"))return denied();String name=p.substring(8);if(!Arrays.asList("index.html","app.js","bridge.js","style.css","icon.png").contains(name))return denied();
                    String mime=name.endsWith(".html")?"text/html":name.endsWith(".css")?"text/css":name.endsWith(".png")?"image/png":"text/javascript";
                    return new WebResourceResponse(mime,name.endsWith(".png")?null:"UTF-8",getAssets().open(name));
                }catch(Exception e){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
            }
        });
        web.setWebChromeClient(new WebChromeClient(){@Override public void onPermissionRequest(PermissionRequest request){request.deny();}});
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,()->back());
        web.loadUrl(PAGE);
    }
    private static WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
    private void js(String script){runOnUiThread(()->{if(web!=null&&!isFinishing())web.evaluateJavascript(script,null);});}
    private void back(){if(Build.VERSION.SDK_INT>=30&&web.getRootWindowInsets()!=null&&web.getRootWindowInsets().isVisible(WindowInsets.Type.ime())){((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(web.getWindowToken(),0);return;}js("if(window.__riyeBack)window.__riyeBack()");}
    @Override public void onBackPressed(){back();}
    @Override public void onPause(){if(web!=null)js("if(window.__riyePause)window.__riyePause()");super.onPause();}
    @Override public void onDestroy(){for(Call c:calls.values())c.cancel();worker.shutdownNow();if(web!=null){web.removeJavascriptInterface("RiyeNative");web.destroy();web=null;}try{if(disk!=null)disk.closeZip();}catch(Exception ignored){}super.onDestroy();}
    private void reply(String id,Object value,Exception error){
        try{JSONObject r=new JSONObject().put("id",id).put("ok",error==null);if(error==null)r.put("value",value==null?JSONObject.NULL:value);else r.put("error",error.getMessage()==null?"操作未完成":error.getMessage());js("window.__riyeReply("+r.toString()+")");}catch(Exception ignored){}
    }
    public final class NativeBridge {
        @JavascriptInterface public String fs(String json){try{if(!trusted)throw new IOException("页面来源不正确");Object value=disk.operation(new JSONObject(json));return new JSONObject().put("ok",true).put("value",value==null?JSONObject.NULL:value).toString();}catch(Exception e){return "{\"ok\":false,\"error\":"+JSONObject.quote(e.getMessage()==null?"本地保存未完成":e.getMessage())+"}";}}
        @JavascriptInterface public void cancel(String id){Call call=calls.get(id);if(call!=null)call.cancel();}
        @JavascriptInterface public void request(String json){
            try{if(!trusted)throw new IOException("页面来源不正确");JSONObject q=new JSONObject(json);String id=q.getString("id"),op=q.getString("op");JSONObject args=q.optJSONObject("args");if(args==null)args=new JSONObject();JSONObject a=args;
                if(Arrays.asList("pick-images","export-backup","open-restore","finish").contains(op)){runOnUiThread(()->{try{uiRequest(id,op,a);}catch(Exception e){reply(id,null,e);}});return;}
                worker.execute(()->{try{Object value;
                    switch(op){
                        case "http":value=httpRequest(id,a);break;
                        case "load-config":value=loadConfig();break;
                        case "save-config":saveConfig(a);value=true;break;
                        case "pending-media":{String saved=getSharedPreferences("pending-media",0).getString("result","");value=saved.isEmpty()?JSONObject.NULL:new JSONObject(saved);break;}
                        case "ack-media":{SharedPreferences p=getSharedPreferences("pending-media",0);String saved=p.getString("result","");if(!saved.isEmpty()&&new JSONObject(saved).optString("token").equals(a.optString("token")))p.edit().clear().commit();value=true;break;}
                        case "storage-info":{File[] r=new File(disk.root,"revisions").listFiles(),p=new File(disk.root,"assets").listFiles();long total=folderSize(disk.root);value="本地保存 "+(r==null?0:r.length)+" 个版本、"+(p==null?0:p.length)+" 张图片，共 "+String.format(Locale.CHINA,"%.1f",total/1048576.0)+" MB";break;}
                        default:throw new IOException("不支持的手机操作");
                    }reply(id,value,null);
                }catch(Exception e){reply(id,null,e);}});
            }catch(Exception ignored){}
        }
    }
    private JSONObject httpRequest(String id,JSONObject a)throws Exception{
        String url=a.getString("url"),method=a.optString("method","GET");if(!url.matches("https?://.*"))throw new IOException("服务地址不正确");
        JSONObject headers=a.optJSONObject("headers");Request.Builder b=new Request.Builder().url(url);if(headers!=null)for(Iterator<String> it=headers.keys();it.hasNext();){String key=it.next();b.header(key,headers.getString(key));}
        RequestBody body=null;if(a.has("body")&&!a.isNull("body"))body=RequestBody.create(Base64.getDecoder().decode(a.getString("body")),MediaType.parse(headers==null?"application/octet-stream":headers.optString("Content-Type","application/octet-stream")));
        Call call=http.newCall(b.method(method,body).build());calls.put(id,call);
        try(Response response=call.execute()){
            ByteArrayOutputStream out=new ByteArrayOutputStream();if(response.body()!=null)try(InputStream in=response.body().byteStream()){byte[] buf=new byte[65536];long total=0;int n;while((n=in.read(buf))!=-1){if((total+=n)>128L*1024*1024)throw new IOException("远程文件过大");out.write(buf,0,n);}}
            JSONObject h=new JSONObject();for(String name:response.headers().names())h.put(name,response.header(name));return new JSONObject().put("status",response.code()).put("headers",h).put("body",Base64.getEncoder().encodeToString(out.toByteArray()));
        }finally{calls.remove(id);}
    }
    private void uiRequest(String id,String op,JSONObject args)throws Exception{
        if(op.equals("finish")){reply(id,true,null);finish();return;}
        if(op.equals("pick-images")){
            if(pickerId!=null)throw new IOException("图片选择器已经打开");pickerId=id;pickerContext=args;
            getSharedPreferences("pending-media",0).edit().putString("request",id).putString("context",args.toString()).commit();
            Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);startActivityForResult(intent,10);return;
        }
        if(op.equals("export-backup")){
            if(exportId!=null)throw new IOException("导出正在进行");exportId=id;exportSnapshot=args;
            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/zip").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,"日页备份-"+java.time.LocalDate.now()+".zip");startActivityForResult(intent,11);return;
        }
        if(op.equals("open-restore")){
            if(restoreId!=null)throw new IOException("恢复正在进行");restoreId=id;
            if(args.has("name")&&!args.isNull("name")){File f=disk.namedBackup(args.getString("name"));confirmRestore(id,f,false);}
            else{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/zip","application/octet-stream","application/x-zip-compressed"});startActivityForResult(intent,12);}
        }
    }
    @Override protected void onActivityResult(int code,int result,Intent intent){super.onActivityResult(code,result,intent);
        if(code==10){String id=pickerId;pickerId=null;JSONObject context=pickerContext;pickerContext=null;
            SharedPreferences prefs=getSharedPreferences("pending-media",0);if(id==null)id=prefs.getString("request","");if(context==null)try{context=new JSONObject(prefs.getString("context","{}"));}catch(Exception ignored){context=new JSONObject();}
            final String request=id;final JSONObject target=context;
            if(result!=RESULT_OK||intent==null){prefs.edit().clear().commit();reply(request,new JSONObject(),null);return;}
            List<Uri> uris=new ArrayList<>();if(intent.getClipData()!=null)for(int i=0;i<intent.getClipData().getItemCount();i++)uris.add(intent.getClipData().getItemAt(i).getUri());else if(intent.getData()!=null)uris.add(intent.getData());
            worker.execute(()->{try{JSONArray images=new JSONArray();for(Uri uri:uris)try(InputStream in=getContentResolver().openInputStream(uri)){if(in==null)throw new IOException("无法读取这张图片");images.put(disk.addImage(in));}
                JSONObject r=new JSONObject().put("token",UUID.randomUUID().toString()).put("entityId",target.optString("entityId")).put("images",images);prefs.edit().putString("result",r.toString()).commit();reply(request,r,null);js("if(window.__riyeRecoverMedia)window.__riyeRecoverMedia()");
            }catch(Exception e){reply(request,null,e);}});
        }
        if(code==11){final String id=exportId;final JSONObject snap=exportSnapshot;exportId=null;exportSnapshot=null;if(id==null)return;if(result!=RESULT_OK||intent==null||intent.getData()==null){reply(id,null,null);return;}final Uri uri=intent.getData();
            worker.execute(()->{File tmp=new File(getCacheDir(),"export-"+UUID.randomUUID()+".zip");try{disk.backup(tmp,snap);try(InputStream in=new FileInputStream(tmp);OutputStream out=getContentResolver().openOutputStream(uri)){if(out==null)throw new IOException("无法写入选择的位置");copy(in,out,1024L*1024*1024);}reply(id,"saved",null);}catch(Exception e){reply(id,null,e);}finally{tmp.delete();}});
        }
        if(code==12){final String id=restoreId;if(id==null)return;if(result!=RESULT_OK||intent==null||intent.getData()==null){restoreId=null;reply(id,null,null);return;}final Uri uri=intent.getData();
            worker.execute(()->{File tmp=new File(getCacheDir(),"restore-"+UUID.randomUUID()+".zip");try{try(InputStream in=getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(tmp)){if(in==null)throw new IOException("无法读取备份");copy(in,out,1024L*1024*1024);}runOnUiThread(()->confirmRestore(id,tmp,true));}catch(Exception e){restoreId=null;tmp.delete();reply(id,null,e);}});
        }
    }
    private void confirmRestore(String id,File file,boolean temp){
        new AlertDialog.Builder(this).setTitle("恢复这份备份？").setMessage("当前数据会先另存备份。备份中的记录恢复为当前内容，备份中没有的记录继续保留。").setNegativeButton("取消",(d,w)->{restoreId=null;if(temp)file.delete();reply(id,null,null);}).setPositiveButton("恢复",(d,w)->worker.execute(()->{try{JSONArray names=disk.openZip(file,temp);reply(id,new JSONObject().put("names",names),null);}catch(Exception e){reply(id,null,e);}finally{restoreId=null;}})).setOnCancelListener(d->{restoreId=null;if(temp)file.delete();reply(id,null,null);}).show();
    }
    private static void copy(InputStream in,OutputStream out,long limit)throws Exception{byte[] buffer=new byte[65536];long n=0;int count;while((count=in.read(buffer))!=-1){if((n+=count)>limit)throw new IOException("文件超过当前版本容量");out.write(buffer,0,count);}out.flush();}
    private static long folderSize(File file){if(file.isFile())return file.length();long total=0;File[] children=file.listFiles();if(children!=null)for(File child:children)total+=folderSize(child);return total;}
    private SecretKey secretKey()throws Exception{KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(store.containsAlias(KEY_ALIAS))return(SecretKey)store.getKey(KEY_ALIAS,null);KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());return gen.generateKey();}
    private String encrypt(String text)throws Exception{Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,secretKey());return Base64.getEncoder().encodeToString(c.getIV())+":"+Base64.getEncoder().encodeToString(c.doFinal(text.getBytes(StandardCharsets.UTF_8)));}
    private String decrypt(String text)throws Exception{String[] parts=text.split(":",2);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,secretKey(),new GCMParameterSpec(128,Base64.getDecoder().decode(parts[0])));return new String(c.doFinal(Base64.getDecoder().decode(parts[1])),StandardCharsets.UTF_8);}
    private JSONObject loadConfig()throws Exception{
        String saved=getSharedPreferences("connection",0).getString("config","");JSONObject c=saved.isEmpty()?new JSONObject().put("primary","http://100.98.167.16:6086").put("secondary","http://10.255.0.11:6086").put("directory","/sata2-2/riye").put("username","user"):new JSONObject(saved);
        String encrypted=c.optString("passwordEncrypted","");c.remove("passwordEncrypted");c.put("password",encrypted.isEmpty()?"":decrypt(encrypted));c.put("auto",false);return c;
    }
    private void saveConfig(JSONObject raw)throws Exception{JSONObject c=new JSONObject(raw.toString());String pass=c.optString("password","");c.remove("password");if(!pass.isEmpty())c.put("passwordEncrypted",encrypt(pass));if(!getSharedPreferences("connection",0).edit().putString("config",c.toString()).commit())throw new IOException("连接设置未能保存");}
}
