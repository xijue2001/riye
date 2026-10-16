# 第三方组件

Windows 使用 Electron 44.7.2；其完整许可证和 Chromium notices 随运行时保留。

移动界面的运行依赖包括 @noble/hashes、buffer、path-browserify、fflate、base64-js、ieee754。具体版本由 mobile/package-lock.json 固定；完整许可证文本保留在 mobile/THIRD_PARTY_LICENSES.txt，并随 APK 包内资源提供。

安卓网络依赖 okhttp-jvm 5.5.0、okio-jvm 3.18.1、kotlin-stdlib 2.1.21、annotations 13.0，由 Apache License 2.0 授权；完整许可证文本与来源同样收录在 mobile/THIRD_PARTY_LICENSES.txt，随 APK 包内资源提供。依赖的来源为 Maven Central，构建时核对下载校验和。OkHttp 的 public suffix 数据遵循 Mozilla Public License 2.0，完整授权文本随 APK 包内资源提供。

esbuild 仅用于编译；Android SDK 与 JDK 只用于构建，不打包其工具二进制。

Windows 打包使用 resedit 3.1.0 与 pe-library 2.0.1（MIT）替换 EXE 图标和产品版本资源；它们仅用于构建，锁定版本见根目录 `package-lock.json`，不随应用运行时分发。
