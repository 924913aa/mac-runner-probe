# Workspaces

A workspace is a folder on the host. Conversations read and write files in it. On the on-device engine the folder is on this phone; on a remote host it is on that computer or server.

<!-- nav: catalogAllFeatures,catalogWorkspaces -->
`All features › Workspaces`

[Open](dshgo://open/workspaces)

The list puts pinned workspaces first, then groups, then the rest. Each row shows its folder and how many conversations it holds.

## Managing

Tap a row to open its sheet:

- **Rename workspace**: change the display name; the folder stays where it is.
- Pin the workspace, or remove the pin.
- Assign it to a group.
- Start a new conversation there, so the chat uses that folder.
- **Remove workspace**: only removes it from the list; the folder and its conversations stay.

Tap **Add workspace** to pick a folder on the host. The app then makes it the current workspace.

## App container files on the iOS on-device engine

The iOS on-device engine provides `mcp__host_files__operate` in conversations to inspect, read, write, copy, move, and remove files in this app's data container. This tool remains available when phone control has not been prepared. Ask it to list `roots` first, then use these paths:

- `app:/`: this app's data container, including `Documents`, `Library`, and `tmp`. `app:/Library` is inside this app's container, not the iOS system `/Library`. The host obtains the container UUID automatically; you do not need to enter it.
- `workspace:/`: the current conversation's workspace root, with the host's default workspace used when the conversation specifies no directory. It is a path alias; the current conversation's permissions still determine access.

The tool's `operation` supports `roots`, `list`, `stat`, `read`, `write`, `mkdir`, `copy`, `move`, and `remove`. Use `path` for single-path operations and `source`/`destination` for copying or moving. Overwriting and recursive operations default to off and must be requested explicitly. File contents in read results are base64.

After installing and enabling optional Linux, its shell can also use `hostfs`:

```sh
hostfs roots
hostfs cp app:/Library/Exports/report.pdf workspace:/report.pdf
```

This example copies an existing PDF from the app container into the workspace; the source file must exist. `hostfs` supports `roots/ls/stat/read/write/mkdir/cp/mv/rm`. It accesses files through the host service rather than mounting the entire app container in Linux. Use `cp/mv -f` to allow overwriting, `mkdir -p` to create parent folders, and `rm -r` for recursive removal. The JSON result of `read` carries base64 content.

Read-only access (`read-only`) allows reading the container. Workspace-write access (`workspace-write`) allows writing the currently approved workspace, including copying files into it from other app folders. Writing outside that workspace, moving files out of other app folders, or deleting them requires `danger-full-access`. The conversation tool requests escalation through the engine's approval flow. When a Linux command lacks permission, request escalation for the corresponding bash call before running it again. `linux_root_write` only controls writes to the Linux system disk; it does not grant host-file access. Approval permits an attempt; it does not mean a file exists, an operation succeeded, or other apps and system folders are accessible.

Check the actual error on failure: `HOSTFS_INVALID_REQUEST` means invalid arguments, `HOSTFS_PATH_DENIED` means a path is outside the allowed roots or violates path rules, `HOSTFS_POLICY_DENIED` means insufficient current permissions, and `HOSTFS_ROOT_BUSY` protects the app container root itself. `ENOENT` means a file does not exist, and `EEXIST` means the destination already exists. Correct the path, arguments, or permissions indicated by the error, then check the actual result.

The app container also holds engine files, configuration, conversations, and Linux data. Overwriting, moving, or deleting these folders while the engine runs can corrupt data, stop the engine, or break its next startup. Root-directory protection does not protect every subfolder. Continue using the system file picker to import or export files outside the container. These host-file tools and `hostfs` still need validation on a physical iPhone.

## Notes

- Folders come from the host: a folder that doesn't exist there can't be picked.
- Workspaces belong to their host; after switching hosts you see that host's workspaces.
