# BrowserBox（浏览器多开工具）

Windows 本地浏览器环境管理工具：多开隔离 Profile、绑定代理、管理 Chrome for Testing / 本机 Chrome。

## 技术栈

- Electron + Vue 3 + TypeScript + Vite + Element Plus
- proxy-chain（本地代理桥，解决 Chrome SOCKS5 / 代理认证限制）
- koffi（Win32：进程与窗口，避免常驻 PowerShell）

## 文档

完整功能回顾与后续规划（环境墙、批量自动化、指纹分档等）：

- **[docs/说明与规划.md](./docs/说明与规划.md)**

## 开发与打包

```bash
cd BrowserBox
npm.cmd install
npm.cmd run dev
npm.cmd run pack:win
```

安装包输出：`dist/浏览器多开工具-1.0.0-Setup.exe`  
（当前**不**内置 Chrome for Testing，需在「浏览器管理」下载或使用本机 Chrome。）

## 快速使用

1. 安装并启动（单实例：再次双击会唤起已有窗口）
2. 「浏览器管理」下载 CfT 或设本机 Chrome 为默认
3. 「代理管理」添加 / 导入代理并测试
4. 「设置」可选指纹信息（简单伪装 / 深度伪装 / 关闭）与地区语言同步
5. 「环境管理」创建环境（可开关随机浏览器指纹、可指定浏览器语言）、绑定代理、启动；可用批量启停与定位；行内「指纹」查看使用状态与伪装档案

Chrome 始终连接 `127.0.0.1:<动态端口>`，由 proxy-chain 转发到上游 HTTP/SOCKS（含账号密码）。
指纹为轻量伪装（非定制内核）：默认简单伪装更稳妥；深度伪装走常驻 CDP。语言/时区可按代理国家同步，也可按环境单独指定语言。
