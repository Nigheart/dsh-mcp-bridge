# dsh-mcp-bridge

把一个正在运行的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）实例通过
[MCP](https://modelcontextprotocol.io) 暴露出来，让外部 agent——Codex，或任何 MCP 客户端——直接驱动
该实例自己的会话。

对调用方来说，一个 DSH 会话就像一个子代理：它有自己的上下文、在指定工作区里干活、最后返回一个结果。
这个桥接还允许调用方**代替人回答 DSH agent 提出的问题**，因此被委派的任务不会因为找不到人而卡死。

## 为什么需要它

用另一个 agent 通过 Web GUI 去操作 DSH，每一步都要付出一次截图或 DOM 往返。这个桥接把这些换成一个小而
结构化的 API：一次工具调用进，一个结果出。

## 架构

```
MCP 客户端（stdio）
 └── bin/dsh-mcp.mjs          MCP server；轮询桥接，并把提问扣下来交给调用方
      └── HTTP 127.0.0.1:<port>/dsh-bridge
           └── lib/index.js    跑在 DSH 进程内的 host Cordis 插件
                └── ctx.sessionController → DSH agent
```

分成两半，而且这个分法是有原因的：

- **`lib/index.js`** 是 DSH host 插件，与 Web GUI 同进程，因此能读写该实例已有的会话。它注册一条 HTTP
  路由，并负责所有与 DSH 的交互。
- **`bin/dsh-mcp.mjs`** 是独立的 MCP server，对你的 agent 讲 stdio、对插件讲 HTTP。它之所以存在，是因为
  DSH 进程自己占用了 stdout，插件无法直接提供 stdio 服务。

等待与轮询都发生在 MCP server 内部，那里不产生任何模型开销；你的模型只花一次工具调用，然后拿到完成的
结果。

## 环境要求

- 带 Web profile 的 DSH（`dsh web` 或桌面端）。
- 与 DSH 同一台机器上的 Node.js 18 或更高版本。
- 能启动 stdio server 的 MCP 客户端。

## 安装插件

在正在运行的那个 profile 下使用 DSH CLI：

```bash
dsh plugin --profile web add dsh-mcp-bridge
```

然后重启 DSH。启动日志里应出现：

```
[dsh-mcp-bridge] mounted /dsh-bridge (tokenRequired=false)
```

也可以单独验证：

```bash
curl -s http://127.0.0.1:3080/dsh-bridge/ping
# {"ok":true,"data":{"bridge":"dsh-mcp-bridge","version":"0.3.0","tokenRequired":false}}
```

如果你的实例监听的不是 3080，请把这里和下面的 `DSH_BRIDGE_URL` 一起改成实际端口。

### 手动安装

若想自己接线，把包加进 profile 的 `package.json` 并列入 bundle：

```json
{
  "dependencies": { "dsh-mcp-bridge": "^0.3.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mcp-bridge"] } }
}
```

包自带 `cordis.patch.yml`，只插入一行 loader 配置。那一行声明了 `inject: [webServer, sessionController]`，
**不要删掉它**。没有 `inject` 时，插件可能在那些服务存在之前就被激活，于是找不到可绑定的对象，最终一条
路由都不会挂上。

## 配置 MCP 客户端

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.dsh]
command = "node"
args = ["/absolute/path/to/dsh-mcp-bridge/bin/dsh-mcp.mjs"]
startup_timeout_sec = 60

# 仅在 DSH 不在默认端口、或设置了 token 时需要
[mcp_servers.dsh.env]
DSH_BRIDGE_URL = "http://127.0.0.1:8080/dsh-bridge"
```

server 会在 MCP 握手时（`initialize.instructions`）下发自己的用法说明，客户端无需额外提示词就能知道
工作流程。

环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DSH_BRIDGE_URL` | `http://127.0.0.1:3080/dsh-bridge` | 插件监听的地址。 |
| `DSH_BRIDGE_TOKEN` | *未设置* | 作为 `x-dsh-bridge-token` 发送，需与插件侧一致。 |
| `DSH_BRIDGE_TIMEOUT_MS` | `600000` | 单次委派轮次的默认等待上限。 |
| `DSH_BRIDGE_POLL_MS` | `2000` | 进度轮询间隔。 |

## 工具

| 工具 | 用途 |
|---|---|
| `dsh_list_sessions` | 列出该实例的会话，可按工作区过滤。 |
| `dsh_delegate` | 在工作区新建会话、或按 `sessionId` 继续一个会话，发送指令并等待该轮结束。 |
| `dsh_answer` | 回答 DSH agent 提出的问题，让它继续。 |
| `dsh_poll` | 读取会话状态与最新输出；用于等待返回 `waiting` 或 `timeout` 之后。 |

### 委派任务

```
dsh_delegate({ workspace: "/home/me/project", instruction: "给 parser.js 补上缺失的测试" })
```

省略 `sessionId` 会新建一个 DSH agent；把返回值里的 `sessionId` 传回来，就是继续**同一个** agent，它还记
得之前做过的事。`status` 告诉你发生了什么：

| `status` | 含义 |
|---|---|
| `completed` | 该轮结束，`output` 是 agent 的最终答复。 |
| `waiting` | agent 提出了问题，接管机制把它扣下来交给你。 |
| `timeout` | 仍在运行；用同一个 `baselineSeq` 再调 `dsh_poll`。 |

### 回答问题

被委派的会话默认处于 **takeover** 状态：当 DSH agent 调用它的提问工具时，这次调用会被挂起并交给调用方，
而不是丢给 GUI。此时 `dsh_delegate` 会立刻带着问题返回，而不是干等：

```json
{
  "status": "waiting",
  "waiting": {
    "kind": "user-question",
    "toolName": "ask_user_question",
    "intercepted": true,
    "detail": [{ "id": "choice", "question": "用哪个数据库？", "options": ["sqlite", "postgres"] }]
  }
}
```

用 `detail` 里的 id 回答：

```
dsh_answer({ sessionId, answers: [{ id: "choice", selected: ["sqlite"] }] })
```

若约三分钟内无人回答，问题会回落到 DSH GUI，因此无人值守的委派不会永久挂住。给 `dsh_delegate` 传
`takeover: false` 则从一开始就把问题留给 GUI。

## 安全

这个桥接是一个控制面：能访问它的人，就能向该 DSH 实例的任意会话发送指令、读取其全部历史。

- 它**只服务回环调用方**，其余一律返回 `403`。这一点很重要，因为随附的 Web profile 绑定的是 `0.0.0.0`。
- 两端都设置 `DSH_BRIDGE_TOKEN` 可以额外要求 `x-dsh-bridge-token` 头。
- 该路由直接注册在 DSH 的 HTTP 服务器上，**不受** `/api` 的信任主机栅栏保护；上面的检查是唯一的关口。

## 已知限制

- MCP server 与 DSH 必须在同一台机器上，因为桥接只服务回环。
- 单次委派轮次受 `DSH_BRIDGE_TIMEOUT_MS` 限制，且不流式返回中间输出。
- `cancel` 只停止当前活动轮次，DSH 里已排队的消息仍会继续执行。
- 插件通过 `sessionController.page` 读取会话尾部，因此超大会话只报告近期历史。

## 开发

开发这个插件不必反复重启 DSH：先把它作为动态 Cordis 插件加载，对着真实服务验证行为，再固化成 bundle
包安装。但最后**一定要真重启一次**——动态插件总是在它依赖的服务就绪之后才被激活，因此它无法暴露启动
顺序类的缺陷（例如缺少 `inject`）。

## 许可证

MIT
