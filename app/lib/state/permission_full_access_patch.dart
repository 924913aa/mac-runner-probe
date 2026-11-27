// 纯文本逻辑：把 profile 的 `permission` 行固定成完全访问默认。
// 不依赖 Flutter，可以 `dart run` 直接跑样例。

/// 目标预设名。DSH 内置的 danger-full-access = sandbox danger-full-access + approval never。
const fullAccessPreset = 'danger-full-access';

final _permissionRow = RegExp(r'^- id:\s*permission\s*$');
final _anyRow = RegExp(r'^- ');
final _defaultPreset = RegExp(r'^(\s*)defaultPreset:\s*(.*)$');
final _configLine = RegExp(r'^(\s*)config:\s*$');

/// [patch] with `permission.defaultPreset` set to [fullAccessPreset], or null
/// when it already is (so callers can stay idempotent and skip a restart).
String? withFullAccessDefault(String patch) {
  final source = patch.replaceAll('\r\n', '\n');
  final lines = source.split('\n');

  // 找顶层 `- id: permission`（设置表单写出来的形态），避开 `- insert:` 里的同名行。
  final start = lines.indexWhere(_permissionRow.hasMatch);
  if (start < 0) {
    final tail = source.endsWith('\n') || source.isEmpty ? '' : '\n';
    return '$source$tail'
        '- id: permission\n'
        '  config:\n'
        '    defaultPreset: $fullAccessPreset\n';
  }

  var end = lines.length;
  for (var i = start + 1; i < lines.length; i += 1) {
    if (_anyRow.hasMatch(lines[i])) {
      end = i;
      break;
    }
  }

  for (var i = start + 1; i < end; i += 1) {
    final match = _defaultPreset.firstMatch(lines[i]);
    if (match == null) continue;
    final current = (match[2] ?? '').trim().replaceAll(RegExp(r'''^["']|["']$'''), '');
    if (current == fullAccessPreset) return null;
    lines[i] = '${match[1]}defaultPreset: $fullAccessPreset';
    return lines.join('\n');
  }

  // 行在但没有 defaultPreset：插到 config 下面；连 config 都没有就整体补一块。
  for (var i = start + 1; i < end; i += 1) {
    final match = _configLine.firstMatch(lines[i]);
    if (match == null) continue;
    lines.insert(i + 1, '${match[1]}  defaultPreset: $fullAccessPreset');
    return lines.join('\n');
  }
  lines.insertAll(start + 1, ['  config:', '    defaultPreset: $fullAccessPreset']);
  return lines.join('\n');
}
