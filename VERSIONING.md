# 版本管理

开源仓库：[xijue2001/riye](https://github.com/xijue2001/riye)。main保存经过检查的当前源码；新功能在feature分支修改，通过测试后合并。安装包放在GitHub Releases，不提交到源码历史。

## 已交付的两个历史版本

- windows-v0.1.0：从已交付Windows运行包恢复的应用源码，Windows原包的校验和另行记录。
- android-v0.1.0：Android试用版与共享同步改进的完整源码，已交付APK的校验和另行记录。

两端当时都叫0.1.0，但源码完成时间不同，因此各自保留标签，不能拿后期源码冒充早期Windows包的来源。历史标签不重写，安装包不替换同名文件；有修复就发新版本。

## 后续统一升版

从0.1.1起统一升版。下次修复使用0.1.2，下面以0.1.1为示例。根package.json是主版本，Android的versionCode每次递增，mobile元数据与锁文件一起更新：

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

## GitHub上传与发布记录 — 2026-10-15

- 完整源码与版本管理配置已上传main；保留Windows源码、Android源码、构建与版本管理改进的独立提交。
- windows-v0.1.0指向7529641ed3f9ffc13912e83dac4a42060a9a5710；android-v0.1.0指向ba0ba44bca07b149cba4e7cd12ddc3e6136278c8。
- 两个Release已发布，均附原安装包、说明和校验文件；Android保持pre-release，未宣称完成Redmi实机测试。
- 远端自动测试通过：17项核心测试、版本检查、移动适配器构建、Python语法检查。
- GitHub返回的安装包大小与SHA-256均与releases/manifest.json记录一致；签名私钥、密码和个人日记数据未提交。

首次Android发布的浏览器页面发生网关错误，因此保留一次性工作流publish-android-0.1.0.yml作为审计记录。它只允许在本仓库main上发布编号413339108的既有草稿，发布前核对目标提交和三个附件的大小、状态与SHA-256；不新建Release、不上传或替换附件，重复运行仅核对已发布结果。使用本次任务的临时GITHUB_TOKEN，不保存个人令牌或安卓签名。后续版本仍按上面的升版、测试、构建和发布流程进行。
