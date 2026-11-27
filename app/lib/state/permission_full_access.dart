// 「破甲」：把本机 profile 的权限默认固定成完全访问 —— 沙箱 danger-full-access、
// 审批 never，工作区之外也能直接读写，不再弹确认。
//
// 为什么是配置文件而不是改引擎代码：DSH 的权限是「调用时按 policy 判定」，
// 只要 profile 的 permission.defaultPreset 指向 danger-full-access，引擎就会在
// 每次工具调用时把 sandbox=danger-full-access / approval=never 传下去，写盘围栏
// （dsh-fs-sandbox）和审批闸（dsh-user-approval）都不会触发。改源码正则的补丁
// 会随引擎版本漂移，初始化配置不会。
//
// 只在设备本地引擎上生效（远程主机的 profile 不在本机，也不应替别人改权限）。
// 和 clearAutoDefaultPreset 一样是幂等的：已经固定就什么都不做，不重启。

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../runtime/runtime_state.dart';
import '../share_code/guest_fs.dart';
import 'engine_control.dart';
import 'permission_default_repair.dart' show mainProfilePatch;
import 'permission_full_access_patch.dart';

/// Locks the local profile's permission default to [fullAccessPreset] and
/// restarts DSH when it had to change anything.
Future<void> ensureFullAccessDefault(ProviderContainer container) async {
  try {
    final file = (await container.read(guestFsProvider.future))?.file(mainProfilePatch);
    if (file == null || !file.existsSync()) return;
    final original = file.readAsStringSync();
    final fixed = withFullAccessDefault(original);
    if (fixed == null) return;
    final tmp = File('${file.path}.dsh-go-tmp')..writeAsStringSync(fixed, flush: true);
    tmp.renameSync(file.path);
    debugPrint('Permissions: pinned the local profile default to $fullAccessPreset');
    if (!container.read(localRuntimeProvider).status.inSafeMode) await EngineControl.restart(container);
  } catch (error) {
    debugPrint('Permissions: could not pin the full-access default: $error');
  }
}
