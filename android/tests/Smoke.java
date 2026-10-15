package dev.riye.qa;
import android.app.*;
import android.os.*;
import android.content.*;
import android.webkit.*;
import org.json.*;
import java.lang.reflect.*;
import java.util.concurrent.*;
public class Smoke extends Instrumentation {
 private CountDownLatch done=new CountDownLatch(1);private String result;
 public class Reporter { @JavascriptInterface public void report(String value){result=value;done.countDown();} }
 @Override public void onCreate(Bundle args){super.onCreate(args);start();}
 @Override public void onStart(){
  Bundle status=new Bundle();
  try{
   Activity activity=startActivitySync(new Intent().setClassName("dev.riye.app","dev.riye.app.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
   Field field=activity.getClass().getDeclaredField("web");field.setAccessible(true);WebView web=(WebView)field.get(activity);
   String script="(async()=>{while(!window.daybook)await new Promise(r=>setTimeout(r,100));await window.daybook.init();"+
    "const id='note:2026-10-14:diary';const old=await window.daybook.day('2026-10-14');const image=await window.daybook.addImage(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwYQAAAAASUVORK5CYII='),c=>c.charCodeAt(0)));"+
    "await window.daybook.save({entityId:id,parents:old.diary.heads.map(r=>r.id),payload:{blocks:[{id:crypto.randomUUID(),kind:'text',text:'Native Android smoke test'},{id:crypto.randomUUID(),kind:'image',assetId:image.assetId,caption:'Original native photo'}]}});"+
    "await window.daybook.saveConfig({primary:'http://10.0.2.2:8765',secondary:'',directory:'/native-smoke',username:'user',password:'pass',auto:false});"+
    "const c=await window.daybook.init();if(!c.config.hasPassword)throw Error('Native keystore password missing');"+
    "const t=await window.daybook.testConnection({primary:'http://10.0.2.2:8765',secondary:'',directory:'/native-smoke',username:'user',password:'',auto:false});await window.daybook.sync();"+
    "const d=await window.daybook.day('2026-10-14');if(d.diary.revision.payload.blocks[0].text!=='Native Android smoke test')throw Error('Native save missing');"+
    "window.__riyePause();window.__riyeBack=()=>{};window.dispatchEvent(new Event('riye-reload'));return {ok:true,test:t,photo:image.assetId,status:(await window.daybook.init()).status};})().then(r=>SmokeResult.report(JSON.stringify(r))).catch(e=>SmokeResult.report(JSON.stringify({ok:false,error:e.message,stack:e.stack})))";
   runOnMainSync(()->{web.addJavascriptInterface(new Reporter(),"SmokeResult");web.evaluateJavascript(script,null);});
   if(!done.await(180,TimeUnit.SECONDS))throw new Exception("Android WebView did not finish smoke test");
   JSONObject parsed=new JSONObject(result);status.putString("result",result);finish(parsed.optBoolean("ok")?Activity.RESULT_OK:Activity.RESULT_CANCELED,status);
  }catch(Exception e){status.putString("error",e.toString());finish(Activity.RESULT_CANCELED,status);}
 }
}
