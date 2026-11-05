# 决策记录: dsh 可执行文件只有一个来源

Status: implemented

## 问题

插件解析 `dsh` 可执行文件时，在 `PASEO_DSH_EXECUTABLE` 和插件设置页之后，还读 Paseo 配置的 `agents.providers.dsh-pi.command`。这一档来自 `dsh` 还存在包装层的时期：Windows 上直接 spawn `dsh`（`.cmd`）会失败，用户必须把 `cmd.exe /d /c dsh.cmd` 手写进 Paseo 配置。`server/dsh-spawn.ts` 出现后，包装解析（`.cmd`/`.ps1`、npm 布局、桌面安装）由插件自己完成，那一行配置变成多余。

两个来源争同一个值带来的是不可解释性：设置页改了不生效时，无法从任何界面判断最终生效值来自哪里，用户只能怀疑「插件配置没用」。

## 决定

可执行文件只来自两处，顺序固定：

1. `PASEO_DSH_EXECUTABLE` 环境变量
2. 插件设置页的 `dsh executable`

两者都没有时，插件解析 `dsh`（`spawnDsh` 负责包装、npm 布局与桌面安装）。Paseo 的 provider 配置只提供 `enabled` 与 Daemon 环境；插件不再读其中的 `command`。`resolveDshLaunch` 去掉 `launch` 参数，`status()` 探针、目录缓存键与子代理设置键都只随这两档变化，诊断信息改为指向设置页。

## 考虑过的其他做法

- **保留 Paseo 配置为第三档**：放弃。两个来源争同一个值，设置页改了不生效时无法自解释。
- **去掉插件设置，只认 Paseo 配置**：放弃。配置只能手改 JSON，设置页本来就是唯一入口。
- **只在解析失败时回退到 Paseo 配置**：放弃。回退路径不可观测，等于把同一问题藏起来。

## 后果

- 只在 Paseo 配置里写 `command` 的用户会失效，必须改用设置页或环境变量；诊断信息已经指向设置页。
- 需要包装脚本的场景改用 `PASEO_DSH_EXECUTABLE` 或设置页写入该包装路径，插件照常把它当可执行文件调用。
- `server/dsh-config.ts`、`server/provider.ts`、`server/bridge-client.ts`、`server/subagent-settings.ts` 的调用点收窄；`dsh-config`、`dsh-spawn`、`provider`、`subagent-settings` 四个测试文件的期望值改为两档。

## 怎么验证的

删除本机 `~/.paseo/config.json` 中 `agents.providers.dsh-pi.command`，reload 后 `provider models dsh-pi` 仍返回 20 行、`provider ls` 仍为 `available`，说明插件能自行解析。`pnpm test` 中 `dsh-config`、`dsh-spawn`、`provider`、`subagent-settings` 四套通过。