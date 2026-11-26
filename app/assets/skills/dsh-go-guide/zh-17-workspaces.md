# 工作区

工作区是主机上的目录，对话在这些目录里读写文件。本机主机的工作区在这台手机上，远程主机的工作区在对方电脑上。

<!-- nav: catalogAllFeatures,catalogWorkspaces -->
`全部功能 › 工作区`

[打开](dshgo://open/workspaces)

列表把置顶的工作区排在前面，然后是分组，最后是其余工作区；每一项带目录和对话数量。

## 管理

点一项打开面板：

- **重命名工作区**：改显示名称，不动目录。
- 置顶，或取消置顶。
- 分组：把工作区放进一个组。
- 在这里新建对话：新对话直接使用这个目录。
- **移除工作区**：只从列表里去掉，文件夹和对话都会保留。

点**添加工作区**选择主机上的目录；添加后 App 会把它设为当前工作区。

## iOS 本机的 App 容器文件

iOS 本机引擎提供对话工具 `mcp__host_files__operate`，用于查看、读写、复制、移动和删除本 App 数据容器里的文件；手机操控尚未准备好时，这个工具仍可用。先让它列出 `roots`，再操作以下路径：

- `app:/`：本 App 的数据容器，包含 `Documents`、`Library` 和 `tmp`。`app:/Library` 是本 App 容器内的目录，不是 iOS 系统的 `/Library`。容器 UUID 自动获取，路径中无需手填 UUID。
- `workspace:/`：当前对话的工作区根；对话未指定目录时使用宿主默认工作区。它是路径别名，访问权限仍由当前对话的权限设置决定。

工具的 `operation` 支持 `roots`、`list`、`stat`、`read`、`write`、`mkdir`、`copy`、`move`、`remove`。单路径操作使用 `path`，复制和移动使用 `source`、`destination`；覆盖和递归操作默认关闭，需明确指定。读取结果中的文件内容为 base64。

安装并启用可选 Linux 后，也可以在其 shell 中使用 `hostfs`：

```sh
hostfs roots
hostfs cp app:/Library/Exports/report.pdf workspace:/report.pdf
```

这个例子把 App 容器中已有的 PDF 复制到工作区；文件需实际存在。`hostfs` 支持 `roots/ls/stat/read/write/mkdir/cp/mv/rm`，通过宿主服务访问文件，并非把整个 App 容器挂进 Linux。`cp/mv -f` 明确允许覆盖，`mkdir -p` 创建父目录，`rm -r` 递归删除；`read` 的 JSON 结果携带 base64 内容。

只读权限 `read-only` 允许读取容器；工作区可写权限 `workspace-write` 允许写当前获准的工作区，包括从 App 其他位置复制进来。写入工作区外、移走或删除 App 其他目录的文件需要 `danger-full-access`。对话工具会通过引擎申请扩权审批；Linux 中遇到权限不足时，应为对应 bash 调用申请扩权后再执行。`linux_root_write` 只控制 Linux 系统盘写入，不会授予宿主文件权限。批准只表示允许尝试该操作，不表示文件存在、已经成功，也不开放其他 App 或系统目录。

失败时查看实际错误：`HOSTFS_INVALID_REQUEST` 为参数错误，`HOSTFS_PATH_DENIED` 为路径超出允许的根或不符合路径规则，`HOSTFS_POLICY_DENIED` 为当前权限不足，`HOSTFS_ROOT_BUSY` 保护 App 容器根目录本身；`ENOENT` 表示文件不存在，`EEXIST` 表示目标已存在。先按错误修正路径、参数或权限，再确认实际结果。

App 容器也包含引擎、配置、对话和 Linux 数据。运行中覆盖、移动或删除这些目录可能损坏数据、使引擎退出或导致下次启动失败；根目录保护不覆盖所有子目录。容器以外的文件继续使用系统文件选择器导入或导出。上述宿主文件工具与 `hostfs` 尚待 iPhone 真机验证。

## 注意

- 目录由主机提供：远程主机上不存在的目录选不到。
- 工作区属于各自的主机；切换主机后看到的是那台主机的工作区。
