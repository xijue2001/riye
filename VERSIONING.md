# 版本管理

默认使用私人仓库 riye。main保存经过检查的当前源码；新功能在feature分支修改，通过测试后合并。安装包放在GitHub Releases，不提交到源码历史。

## 已交付的两个历史版本

- windows-v0.1.0：从已交付Windows运行包恢复的应用源码，Windows原包的校验和另行记录。
- android-v0.1.0：Android试用版与共享同步改进的完整源码，已交付APK的校验和另行记录。

两端当时都叫0.1.0，但源码完成时间不同，因此各自保留标签，不能拿后期源码冒充早期Windows包的来源。历史标签不重写，安装包不替换同名文件；有修复就发新版本。

## 后续统一升版

下一个版本从0.1.1开始。根package.json是主版本，Android的versionCode每次递增，mobile元数据与锁文件一起更新：

```sh
python3 scripts/versions.py bump 0.1.1
python3 scripts/versions.py check --tag v0.1.1
npm test
```

补丁号用于修复，次版本号用于兼容的新功能，主版本号用于不兼容改动。涉及记录与备份格式的变化须先设计迁移；不能只靠改版本号让旧数据失效。

更新CHANGELOG后提交。确认安装包完成相应平台验证后，创建注释标签，再发布Release：

```sh
git tag -a v0.1.1 -m '日页 0.1.1'
git push origin main
git push origin v0.1.1
```

自动CI负责核心测试、版本一致性、标签检查和移动适配器编译，不把这些结果当作Redmi实机安装或NAS实测。当前没有自动发布签名APK的工作流。

## 安装包与签名

Windows使用固定版本Electron，下载时核对官方SHA-256。安卓更新继续使用此前单独保留的安装签名：恢复到android/.private/后本地构建，禁止把密钥或密码提交到Git。仓库不会在无原签名时自动另建签名。

Release应附安装包、说明、SHA256SUMS和实际验证范围；未完成手机实测时标为pre-release。发布前核对根版本、Android versionName/versionCode和标签一致。保留最近一个可用版本；回滚代码通过新提交或新版本，避免删除历史。

## 已准备、尚待上传

本地已准备完整Git历史、两个标签和CI配置。需要创建或指定xijue2001账号下的私人日页仓库，再上传。仓库创建、远端标签、Releases与远端CI运行结果仍须以上传后的实际结果为准。
