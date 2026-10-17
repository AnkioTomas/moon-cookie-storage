# Moon Cookie Storage

跨浏览器（Chrome / Edge / Firefox）Manifest V3 扩展。

## 开发

```bash
npm run build          # 构建全部到 dist/{chrome,edge,firefox}
npm run build:firefox  # 单独构建
```

加载方式：
- Chrome：`chrome://extensions` → 开发者模式 → 加载 `dist/chrome`
- Edge：`edge://extensions` → 开发者模式 → 加载 `dist/edge`
- Firefox：`about:debugging#/runtime/this-firefox` → 临时载入 `dist/firefox/manifest.json`

## 结构

- `src/manifest.json`：公共 manifest（Chrome/Edge 使用 service worker）
- `scripts/build.mjs`：按浏览器生成差异（Firefox 使用 `background.scripts` 并添加 gecko id）
- `src/browser.js`：统一 `browser` / `chrome` API 入口
