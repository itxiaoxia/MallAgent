# MallAgent

MallAgent 是一个 Windows 优先的本地桌面 Agent：Tauri 负责窗口和生命周期，Python 3.11 + FastAPI 负责本地 API，LangChain 负责 Agent 编排，模型连接采用 OpenAI 兼容协议。

## 功能

- 配置 OpenAI 兼容的 Base URL、模型、API Key、temperature 和 max tokens。
- 自定义默认提示词；只要填写，每次 `/api/chat` 请求都会作为 Agent 的系统提示词发送。
- 配置并测试 MCP 服务，支持 stdio 和 Streamable HTTP 两种传输方式。
- Tauri 启动时自动拉起本地 Python 后端，退出时回收子进程；主程序为窗口化启动。
- 配置保存在当前用户目录，API 返回配置时不会回传完整 API Key。

## 环境准备

需要 Python 3.11、Node.js、Rust MSVC 工具链和 WebView2。Windows PowerShell 下执行：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
npm.cmd install
```

如果本机没有 Python 3.11，先安装 Python 3.11 后再执行上面的命令。当前开发环境已经准备好 Python 3.11 虚拟环境。

## 开发启动

```powershell
npm.cmd run tauri:dev
```

这会打开 MallAgent 桌面窗口，并在后台启动本地 Agent 服务。只调试前端时可以使用 `npm.cmd run dev`。

## 打包

```powershell
npm.cmd run tauri:build
```

打包流程会先用 PyInstaller 生成 `src-tauri/resources/mallagent-backend.exe`，再构建 Vite 前端和 Tauri 安装包。后端子进程由 Tauri 以隐藏控制台方式启动。

## 配置说明

默认配置使用 `https://api.openai.com/v1` 和 `gpt-4o-mini`。在“连接与设置”中填写模型信息后保存即可。自定义兼容服务只需修改 Base URL、模型和 API Key。

MCP stdio 服务需要填写命令、参数以及可选的 JSON 环境变量；HTTP 服务需要填写 Streamable HTTP URL 以及可选的 JSON 请求头。启用后可先点击“测试连接”检查工具发现结果。

配置默认由 `platformdirs` 放在当前用户配置目录，也可以通过 `MALLAGENT_CONFIG_PATH` 指定 JSON 文件路径。当前 API Key 为本地 JSON 配置中的明文值，应用不会将其返回到前端或写入日志；使用共享 Windows 账户时应保护该配置文件。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
npm.cmd test
npm.cmd run build
cargo test --manifest-path src-tauri\Cargo.toml
cargo fmt --manifest-path src-tauri\Cargo.toml -- --check
```

后端也可以单独启动进行 API 检查：

```powershell
Push-Location backend
..\.venv\Scripts\python.exe -m mallagent --host 127.0.0.1 --port 45831
Pop-Location
```
