# Moon Cookie Storage

跨浏览器（Chrome / Edge / Firefox）Manifest V3 扩展。

## 开发

```bash
npm run build          # 构建全部到 dist/{chrome,edge,firefox}
npm run build:firefox  # 单独构建
npm test              # 协议、加密和授权流程测试（Node.js 22+）
npm run package       # 打包 dist/packages/*.zip，manifest 在压缩包根目录
```

推送 `vMAJOR.MINOR.PATCH` tag 且与 `package.json`、`src/manifest.json` 版本一致时，Release Action 会测试、打包并上传三个浏览器 zip。也可在 Actions 页手动运行，只产出 artifact。

本地调试直接加载构建目录，不必解压 zip：
- Chrome：`chrome://extensions` → 开发者模式 → 加载 `dist/chrome`
- Edge：`edge://extensions` → 开发者模式 → 加载 `dist/edge`
- Firefox：`about:debugging#/runtime/this-firefox` → 临时载入 `dist/firefox/manifest.json`

## 安装

不发布到应用商店。用户不能双击 zip 安装，先解压，并确认目录根部有 `manifest.json`。

Chrome、Edge：

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开「开发者模式」。这个开关必须保持打开，关掉后扩展会被禁用。
3. 选择「加载已解压的扩展程序」，选中解压后的 chrome 或 edge 目录。

没有自动更新。换版本后在同一页面重新加载。

Firefox 正式版不能永久安装未签名扩展。`about:debugging` 的临时载入会在重启后消失。要给普通用户长期使用，需先做 AMO 未上架签名（不出现在商店），再安装签过名的 xpi。Firefox Developer Edition 或 Nightly 可在 `about:config` 把 `xpinstall.signatures.required` 设为 `false`，然后安装未签名包。

## 结构

- `src/manifest.json`：公共 manifest（Chrome/Edge 使用 service worker）
- `scripts/build.mjs`：按浏览器生成差异（Firefox 使用 `background.scripts` 并添加 gecko id）
- `src/browser.js`：统一 `browser` / `chrome` API 入口
- `src/bridge.js`：自动发现 9528 页面，桥接网页与扩展
- `src/wait.*`：授权确认及 2 秒检查调度
- `src/protocol.js`：参数约束、AES 加密及 GET 回调格式
- 远程管理接入协议：[docs/protocol.md](docs/protocol.md)
