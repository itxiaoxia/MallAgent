# MallAgent

MallAgent 是一个基于 Tauri、React/Vite 和 Python/FastAPI 的本地桌面 Agent。

## 安装依赖

请先准备 Node.js、Rust 和 Python 3.11，然后在项目根目录执行：

```bash
npm install
```

## 开发运行

```bash
npm run tauri:dev
```

## 打包

macOS：

```bash
sh scripts/build.sh
```

产物：`release/macos/MallAgent.app`

Windows：

```bat
scripts\build.bat
```

产物：`release/windows/MallAgent.exe`
