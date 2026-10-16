# 日页构建与验证

## Windows

保留 Electron 44.7.2 官方 x64 运行时。执行：

```sh
npm ci
python3 scripts/get-runtime.py .runtime win32
python3 scripts/package.py
```

Windows 运行包使用官方 ZIP。`Riye.exe` 只替换图标和产品版本资源；构建时重新读取 PE 资源验证图标，并逐节校验所有非资源区段字节。其余运行时文件流式复制并复核尺寸与 CRC。程序 EXE 的校验值与原 Electron EXE 不同，不沿用原文件的数字签名。应用数据位于用户数据目录，与解压的软件目录分开。

图标资源位于 `renderer/icon.png`、`desktop/icon.ico` 和 `android/src/res/drawable-nodpi/`。Android 使用独立前景层及背景色提供自适应图标，主体保留在安全区内，支持圆形及圆角方形桌面遮罩。

## Android

需要 Node.js、npm、Python 3 和 JDK 17（包含 javac 编译模块、keytool）。首次执行：

```sh
cd mobile
npm ci
cd ..
python3 android/tools/bootstrap.py
python3 android/build.py
```

`bootstrap.py` 通过 Google 官方仓库元数据下载 Android API 36、Build Tools 36.0.0、Platform Tools，并核对校验和；JVM 依赖从 Maven Central 获取并校验。Java 源码、资源和 manifest 位于 `android/src/`；移动适配器位于 `mobile/`；数据模型和 WebDAV 协议复用 `core/`。

安卓本地文件保存在应用私有 `files/data-v1`；WebView 只加载包内资源。网络请求使用原生 OkHttp，密码使用 AndroidKeyStore AES-GCM。本地数据与 Windows 的记录/原图格式一致。

本仓库已对应现有应用，构建前必须恢复此前保留的 `android/.private/` 安装更新签名。没有签名时构建会停止；只有从未安装过的全新项目首次生成签名才使用 `python3 android/build.py --new-signing-key`。**为同一已安装应用发布更新，必须恢复此前保留的签名和密码，不要另生成一个新签名。** 签名不在源码包里，另存于“日页-Android更新签名备份.zip”；恢复该包内文件到 `android/.private/` 后构建。禁止提交或公开该目录。

输出：`dist/Riye-Android-v0.1.3.apk`。安装包面向 Android 8.0 及以上，target API 36，无本机 CPU 库，适用于 Redmi 的 ARM64 设备。只申请 INTERNET 权限；图片和备份使用系统文档选择器。

## 自动验证

```sh
npm test
PLAYWRIGHT_MODULE=<playwright路径> node tests/ui.cjs
PLAYWRIGHT_MODULE=<playwright路径> node tests/conflict-ui.cjs
PLAYWRIGHT_MODULE=<playwright路径> node tests/mobile-ui.cjs
```

UI 检查需要 `.runtime/linux/electron`，可通过 `scripts/get-runtime.py` 获取，启动使用无界面模式。移动 UI 检查使用 Electron 内的原生接口替身，验证共享移动 bundle，不替代真实安卓运行测试。

安卓文件适配器的 JVM 检查：

```sh
java --module jdk.compiler/com.sun.tools.javac.Main -classpath android/.tools/json-test.jar -d android/build/qa-disk android/src/java/dev/riye/app/Disk.java android/tests/DiskTest.java
java -classpath android/build/qa-disk:android/.tools/json-test.jar DiskTest android/build/java-backup-fixture.zip
```

可选的真实 Android 16 模拟器检查：

```sh
python3 android/tools/emulator_setup.py
python3 android/tools/native_qa.py
```

本次开发环境未完成模拟器启动，不能把下列可选测试视为已通过。具备硬件虚拟化的开发主机可重新运行。

模拟器检查把正式 APK 与独立测试 APK 装入临时模拟设备。它测试 WebView、原生文件、KeyStore 和 OkHttp/WebDAV。测试桥只在独立测试 APK 的运行期间添加，正式 APK 不包含测试入口。

只更新源码包：

```sh
python3 scripts/package.py --source-only
```

## 发布限制

暂无应用自动更新或 Android 后台同步；手机手动前台同步。每张照片上限 50 MB，完整备份总量上限 1 GB。当前全量记录和图片保存在各端；超大长期数据集的分页与历史清理未实现。
