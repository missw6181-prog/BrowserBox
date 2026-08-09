# BrowserBox

Windows 本地浏览器环境管理工具（V1）。

## 技术栈

- Electron + Vue 3 + TypeScript + Vite
- Element Plus
- proxy-chain（本地代理桥，解决 Chrome SOCKS5 认证限制）
- Chrome for Testing（官方测试版 Chrome）

## 开发

```bash
cd BrowserBox
npm install
npm run dev
```

## 使用流程

1. 首次启动选择数据目录（如 `D:\BrowserBox`）
2. 「浏览器管理」下载 Chrome for Testing
3. 「代理管理」添加 / 导入代理并测试
4. 「环境管理」创建环境并绑定代理，点击启动

Chrome 始终连接 `127.0.0.1:<动态端口>`，由 proxy-chain 转发到上游 HTTP/SOCKS（含账号密码）。
