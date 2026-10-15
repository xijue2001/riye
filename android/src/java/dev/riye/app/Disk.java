package dev.riye.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.util.*;
import java.util.zip.*;

/** Private-file adapter. Record semantics stay in the shared, tested JS core. */
public final class Disk {
    public final File root;
    private ZipFile currentZip;
    private File zipSource;
    private boolean removeZipSource;
    private static final long BACKUP_LIMIT=1024L*1024*1024;
    private static final String UUID="[a-f0-9-]{36}",HASH="[a-f0-9]{64}";
    public Disk(File root)throws Exception{this.root=root.getCanonicalFile();if(!root.mkdirs()&&!root.isDirectory())throw new IOException("无法创建本地数据目录");}
    public File resolve(String virtual)throws Exception{
        if(virtual==null||(!virtual.equals("/data")&&!virtual.startsWith("/data/")))throw new IOException("本地路径不正确");
        File file=new File(root,virtual.length()>6?virtual.substring(6):"").getCanonicalFile();
        if(!file.equals(root)&&!file.getPath().startsWith(root.getPath()+File.separator))throw new IOException("本地路径不正确");return file;
    }
    private static byte[] read(InputStream stream,long limit)throws Exception{
        ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[65536];int n;long total=0;
        while((n=stream.read(buf))!=-1){total+=n;if(total>limit)throw new IOException("文件超过允许大小");out.write(buf,0,n);}return out.toByteArray();
    }
    public static byte[] bytes(File file,long limit)throws Exception{try(InputStream in=new FileInputStream(file)){return read(in,limit);}}
    public static String hash(byte[] bytes)throws Exception{byte[] sum=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder s=new StringBuilder();for(byte b:sum)s.append(String.format(Locale.ROOT,"%02x",b&255));return s.toString();}
    public static String mime(byte[] b)throws Exception{
        if(b.length>=8&&Arrays.equals(Arrays.copyOf(b,8),new byte[]{(byte)137,80,78,71,13,10,26,10}))return "image/png";
        if(b.length>=3&&(b[0]&255)==255&&(b[1]&255)==216&&(b[2]&255)==255)return "image/jpeg";
        if(b.length>=6&&new String(b,0,6,StandardCharsets.US_ASCII).matches("GIF8[79]a"))return "image/gif";
        if(b.length>=12&&new String(b,0,4,StandardCharsets.US_ASCII).equals("RIFF")&&new String(b,8,4,StandardCharsets.US_ASCII).equals("WEBP"))return "image/webp";
        if(b.length>=2&&b[0]=='B'&&b[1]=='M')return "image/bmp";
        throw new IOException("请使用 JPEG、PNG、WebP、GIF 或 BMP 图片");
    }
    public static void atomic(File file,byte[] bytes)throws Exception{
        File parent=file.getParentFile();if(!parent.mkdirs()&&!parent.isDirectory())throw new IOException("无法创建本地目录");
        File temp=new File(parent,file.getName()+"."+java.util.UUID.randomUUID()+".tmp");
        try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.flush();out.getFD().sync();}move(temp,file);}finally{temp.delete();}
    }
    private static void move(File from,File to)throws Exception{
        try{Files.move(from.toPath(),to.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
        catch(AtomicMoveNotSupportedException e){Files.move(from.toPath(),to.toPath(),StandardCopyOption.REPLACE_EXISTING);}
    }
    public synchronized JSONObject addImage(InputStream in)throws Exception{
        byte[] data=read(in,50L*1024*1024);String type=mime(data),id=hash(data);File file=resolve("/data/assets/"+id+".bin");if(!file.exists())atomic(file,data);
        return new JSONObject().put("assetId",id).put("mime",type).put("size",data.length);
    }
    public synchronized Object operation(JSONObject q)throws Exception{
        String op=q.getString("op");File f=q.has("path")?resolve(q.getString("path")):null;
        switch(op){
            case "mkdir": if(!f.mkdirs()&&!f.isDirectory())throw new IOException("无法创建本地目录");return true;
            case "exists": return f.exists();
            case "list": {String[] names=f.list();if(names==null)throw new IOException("无法读取本地目录");Arrays.sort(names);return new JSONArray(Arrays.asList(names));}
            case "read": return Base64.getEncoder().encodeToString(bytes(f,128L*1024*1024));
            case "create": if(!f.getParentFile().mkdirs()&&!f.getParentFile().isDirectory())throw new IOException("无法创建本地目录");if(!f.createNewFile()&&q.optBoolean("exclusive"))throw new IOException("文件已经存在");return true;
            case "write": {byte[] data=Base64.getDecoder().decode(q.getString("bytes"));if(data.length>128L*1024*1024)throw new IOException("文件过大");try(FileOutputStream out=new FileOutputStream(f)){out.write(data);out.flush();out.getFD().sync();}return true;}
            case "rename": move(resolve(q.getString("from")),resolve(q.getString("to")));return true;
            case "remove": if(f.exists()&&!f.delete())throw new IOException("无法移除本地文件");return true;
            case "backup": backup(f,q);return true;
            case "auto-backup": {JSONArray ids=q.getJSONArray("revisionIds");if(ids.length()==0)return true;File file=resolve("/data/backups/daily-"+LocalDate.now()+".zip");if(!file.exists())backup(file,q);pruneDaily();return true;}
            case "list-backups": return listBackups();
            case "zip-read": return Base64.getEncoder().encodeToString(zipEntry(q.getString("name")));
            case "zip-close": closeZip();return true;
            default: throw new IOException("不支持的本地操作");
        }
    }
    private void pruneDaily()throws Exception{
        File folder=resolve("/data/backups");File[] files=folder.listFiles((dir,name)->name.matches("daily-\\d{4}-\\d{2}-\\d{2}\\.zip"));if(files==null)return;
        Arrays.sort(files,Comparator.comparing(File::getName).reversed());for(int i=7;i<files.length;i++)files[i].delete();
    }
    public synchronized JSONArray listBackups()throws Exception{
        File folder=resolve("/data/backups");File[] files=folder.listFiles((dir,name)->name.matches("(daily-\\d{4}-\\d{2}-\\d{2}|before-restore-\\d+)\\.zip"));
        JSONArray result=new JSONArray();if(files==null)return result;Arrays.sort(files,Comparator.comparingLong(File::lastModified).reversed());
        for(File f:files)result.put(new JSONObject().put("name",f.getName()).put("size",f.length()).put("modified",f.lastModified()));return result;
    }
    public synchronized File namedBackup(String name)throws Exception{
        if(!name.matches("(daily-\\d{4}-\\d{2}-\\d{2}|before-restore-\\d+)\\.zip"))throw new IOException("备份名称不正确");File f=resolve("/data/backups/"+name);if(!f.isFile())throw new IOException("备份已经不存在");return f;
    }
    public synchronized void backup(File file,JSONObject snapshot)throws Exception{
        JSONArray ids=snapshot.getJSONArray("revisionIds"),assets=snapshot.getJSONArray("assetIds");List<File> records=new ArrayList<>(),images=new ArrayList<>();long total=0;
        if(ids.length()+assets.length()>65534)throw new IOException("备份文件数量超过当前格式容量");
        for(int i=0;i<ids.length();i++){
            String id=ids.getString(i);if(!id.matches(UUID))throw new IOException("记录编号不正确");File r=resolve("/data/revisions/"+id+".json");records.add(r);total+=r.length();
            JSONObject content=new JSONObject(new String(bytes(r,4L*1024*1024),StandardCharsets.UTF_8));JSONObject p=content.optJSONObject("payload");JSONArray blocks=p==null?null:p.optJSONArray("blocks");
            if(blocks!=null)for(int j=0;j<blocks.length();j++){JSONObject b=blocks.getJSONObject(j);if("image".equals(b.optString("kind"))){String hash=b.getString("assetId");if(!hash.matches(HASH)||!resolve("/data/assets/"+hash+".bin").isFile())throw new IOException("还有图片尚未下载，请先同步");}}
        }
        for(int i=0;i<assets.length();i++){String id=assets.getString(i);if(!id.matches(HASH))throw new IOException("图片编号不正确");File a=resolve("/data/assets/"+id+".bin");images.add(a);total+=a.length();}
        if(total>BACKUP_LIMIT)throw new IOException("备份超过当前版本支持的 1 GB 总容量");
        if(!file.getParentFile().mkdirs()&&!file.getParentFile().isDirectory())throw new IOException("无法创建备份目录");File tmp=new File(file.getParentFile(),file.getName()+"."+java.util.UUID.randomUUID()+".tmp");
        try{
            try(FileOutputStream raw=new FileOutputStream(tmp);ZipOutputStream out=new ZipOutputStream(new BufferedOutputStream(raw))){
                out.setLevel(5);out.putNextEntry(new ZipEntry("manifest.json"));out.write(snapshot.getJSONObject("manifest").toString().getBytes(StandardCharsets.UTF_8));out.closeEntry();
                byte[] buf=new byte[65536];for(File r:records)entry(out,"revisions/"+r.getName(),r,buf);for(File a:images)entry(out,"assets/"+a.getName(),a,buf);
            }move(tmp,file);
        }finally{tmp.delete();}
    }
    private static void entry(ZipOutputStream out,String name,File file,byte[] buffer)throws Exception{
        out.putNextEntry(new ZipEntry(name));try(InputStream in=new FileInputStream(file)){int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);}out.closeEntry();
    }
    public synchronized JSONArray openZip(File file,boolean temporary)throws Exception{
        closeZip();ZipFile candidate=new ZipFile(file);Set<String> unique=new HashSet<>();JSONArray names=new JSONArray();long total=0;
        try{
            Enumeration<? extends ZipEntry> entries=candidate.entries();while(entries.hasMoreElements()){
                ZipEntry e=entries.nextElement();if(e.isDirectory())continue;String name=e.getName();
                if(!name.equals("manifest.json")&&!name.matches("revisions/"+UUID+"\\.json")&&!name.matches("assets/"+HASH+"\\.bin"))throw new IOException("备份包含不支持的路径");
                if(!unique.add(name)||e.getSize()<0||e.getSize()>128L*1024*1024||(total+=e.getSize())>BACKUP_LIMIT)throw new IOException("备份过大或目录损坏");names.put(name);
            }
            if(!unique.contains("manifest.json"))throw new IOException("缺少日页备份说明");currentZip=candidate;zipSource=file;removeZipSource=temporary;return names;
        }catch(Exception e){candidate.close();throw e;}
    }
    private synchronized byte[] zipEntry(String name)throws Exception{
        if(currentZip==null)throw new IOException("备份尚未打开");ZipEntry e=currentZip.getEntry(name);if(e==null)throw new IOException("备份缺少文件");
        byte[] data;try(InputStream in=currentZip.getInputStream(e)){data=read(in,Math.min(e.getSize()+1,128L*1024*1024));}
        CRC32 crc=new CRC32();crc.update(data);if(data.length!=e.getSize()||crc.getValue()!=e.getCrc())throw new IOException("备份校验失败");return data;
    }
    public synchronized void closeZip()throws Exception{if(currentZip!=null){currentZip.close();currentZip=null;if(removeZipSource&&zipSource!=null)zipSource.delete();zipSource=null;}}
}
