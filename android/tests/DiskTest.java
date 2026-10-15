import dev.riye.app.Disk;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
public class DiskTest{
 private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  File root=Files.createTempDirectory("riye-java-test-").toFile();Disk d=new Disk(root);
  d.operation(new JSONObject().put("op","mkdir").put("path","/data/revisions"));d.operation(new JSONObject().put("op","mkdir").put("path","/data/assets"));
  boolean blocked=false;try{d.resolve("/data/../../outside");}catch(Exception e){blocked=true;}check(blocked,"paths must stay private");
  byte[] photo=java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwYQAAAAASUVORK5CYII=");JSONObject a=d.addImage(new ByteArrayInputStream(photo));String id=UUID.randomUUID().toString(),actor=UUID.randomUUID().toString();
  JSONObject revision=new JSONObject().put("schema",1).put("id",id).put("entityId","note:2026-10-14:diary").put("deviceId",actor).put("parents",new JSONArray()).put("timestamp","2026-10-14T08:00:00.000Z").put("effectiveDate","2026-10-14").put("deleted",false).put("payload",new JSONObject().put("blocks",new JSONArray().put(new JSONObject().put("id",UUID.randomUUID().toString()).put("kind","text").put("text","来自手机的日记")).put(new JSONObject().put("id",UUID.randomUUID().toString()).put("kind","image").put("assetId",a.getString("assetId")).put("caption","原图"))));
  Disk.atomic(d.resolve("/data/revisions/"+id+".json"),revision.toString().getBytes(StandardCharsets.UTF_8));
  JSONObject snap=new JSONObject().put("manifest",new JSONObject().put("format","riye-backup").put("schema",1).put("datasetId",JSONObject.NULL)).put("revisionIds",new JSONArray().put(id)).put("assetIds",new JSONArray().put(a.getString("assetId")));
  File zip=new File(args.length>0?args[0]:new File(root,"fixture.zip").getPath());d.backup(zip,snap);JSONArray names=d.openZip(zip,false);check(names.length()==3,"backup contains manifest, record and original photo");
  Object encoded=d.operation(new JSONObject().put("op","zip-read").put("name","assets/"+a.getString("assetId")+".bin"));check(Arrays.equals(photo,Base64.getDecoder().decode((String)encoded)),"original bytes preserved");d.closeZip();
  Disk reopened=new Disk(root);String record=(String)reopened.operation(new JSONObject().put("op","read").put("path","/data/revisions/"+id+".json"));check(new String(Base64.getDecoder().decode(record),StandardCharsets.UTF_8).contains("来自手机的日记"),"restart preserves data");
  if(args.length>1){Disk other=new Disk(Files.createTempDirectory("riye-desktop-backup-read-").toFile());JSONArray entries=other.openZip(new File(args[1]),false);boolean sawImage=false,sawRecord=false;for(int i=0;i<entries.length();i++){String name=entries.getString(i);String bytes=(String)other.operation(new JSONObject().put("op","zip-read").put("name",name));byte[] data=Base64.getDecoder().decode(bytes);if(name.startsWith("assets/")){check(Arrays.equals(data,photo),"desktop original photo preserved");sawImage=true;}if(name.startsWith("revisions/")){check(new String(data,StandardCharsets.UTF_8).contains("电脑导出的日记"),"desktop text readable");sawRecord=true;}}check(sawImage&&sawRecord,"desktop backup has both text and image");other.closeZip();}
  System.out.println("PASS: Android private file adapter, path isolation, original photos, restart and streaming ZIP backup.");
 }
}
