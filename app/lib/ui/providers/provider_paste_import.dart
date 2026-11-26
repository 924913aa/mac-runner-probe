// 「粘贴导入」: 从一段随手复制的文本里认出 Base URL、API Key 和模型名。
//
// 认得出的三种写法:
//   一行        https://egg.krphp.com/ zs-8cgsczjfqdy0-... 可用：gpt-6.2-sol
//   多行        地址一行、Key 一行、「可用：」后面跟模型
//   字段：值    Base URL：… / API Key：… / 模型：…
//
// 认不出来的字段返回 null / 空，由表单提示手动填写；这里不做任何网络请求。

class ProviderPasteImport {
  const ProviderPasteImport({this.baseUrl, this.apiKey, this.models = const []});

  /// 已去掉行尾标点、保留原样的 http(s) 地址（交给 normalizeBaseUrl 归一化）。
  final String? baseUrl;

  final String? apiKey;

  /// 模型 id，已去重；不含 URL 与 Key。
  final List<String> models;

  bool get isEmpty => baseUrl == null && apiKey == null && models.isEmpty;
}

final _urlPattern = RegExp(r'https?://[^\s<>"“”‘’（）()【】\[\]，,；;、|]+', caseSensitive: false);

/// 带明显前缀的 Key（sk-、zs-、gsk-…）；前缀后面允许 - 和 _。
final _prefixedKeyPattern = RegExp(
  r'(?:sk|zs|pk|ak|rk|hk|gsk|xai|api|key|token|or)[-_][A-Za-z0-9_\-]{10,}',
  caseSensitive: false,
);

/// 无前缀的长 token：够长、不含 . / : 之类地址特征，才当 Key。
final _bareKeyPattern = RegExp(r'[A-Za-z0-9_\-]{24,}');

/// 「字段：值」的左侧。冒号可以是 : ： 或 =
final _pairPattern = RegExp(r'^([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 _./·-]{0,20})\s*[:：=]\s*(.*)$');

const _urlWords = ['url', 'address', 'endpoint', 'base', '地址', '接口', '域名', '链接'];
const _keyWords = ['key', 'token', 'secret', '密钥', '令牌', '密匙', '认证'];
const _modelWords = ['model', 'models', '模型', '可用'];

ProviderPasteImport parseProviderPaste(String raw) {
  final text = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (text.trim().isEmpty) return const ProviderPasteImport();

  String? url;
  String? key;
  final models = <String>[];

  // 1. 「字段：值」优先，它能区分同一行里的几个 token。
  for (final line in text.split('\n')) {
    final match = _pairPattern.firstMatch(line.trim());
    if (match == null) continue;
    final label = match.group(1)!.toLowerCase();
    final value = match.group(2)!.trim();
    if (value.isEmpty) continue;
    // https://… 自己也会被 "https:" 拆成一对，这里跳过。
    if (value.startsWith('//')) continue;
    if (_isUrlLabel(label)) {
      url ??= _firstUrl(value);
    } else if (_isKeyLabel(label)) {
      key ??= _firstKey(value, allowBare: true);
    } else if (_isModelLabel(label)) {
      models.addAll(_splitModels(value));
    }
  }

  // 2. 没有字段标签时: 第一个 http(s) 链接、第一个像 Key 的 token。
  url ??= _firstUrl(text);
  key ??= _firstKey(text.replaceAll(_urlPattern, ' '), allowBare: true);

  // 3. 模型: 「可用/模型」那段已经被第 1 步吃掉了；没有就取余下像模型 id 的 token。
  if (models.isEmpty) models.addAll(_looseModels(text, url: url, key: key));

  final seen = <String>{};
  final cleaned = <String>[];
  for (final model in models) {
    final id = _cleanModel(model);
    if (id.isEmpty || id == key || id == url) continue;
    if (!RegExp(r'[A-Za-z0-9]').hasMatch(id)) continue; // 纯中文标签不算模型
    if (seen.add(id.toLowerCase())) cleaned.add(id);
  }

  return ProviderPasteImport(baseUrl: url, apiKey: key, models: cleaned);
}

bool _isUrlLabel(String label) =>
    _urlWords.any(label.contains) && !_isKeyLabel(label) && !_isModelLabel(label);

bool _isKeyLabel(String label) => _keyWords.any(label.contains);

bool _isModelLabel(String label) => _modelWords.any(label.contains);

/// 返回 (label 结束的位置, 值的开始位置)，只认第一个冒号。
(int, int)? _indexOfLabelColon(String line) {
  for (var i = 0; i < line.length; i++) {
    final char = line[i];
    if (char == ':' || char == '：' || char == '=') return (i, i + 1);
  }
  return null;
}

String? _firstUrl(String text) {
  final match = _urlPattern.firstMatch(text);
  if (match == null) return null;
  final url = _trimUrl(match.group(0)!);
  return url.isEmpty ? null : url;
}

String _trimUrl(String url) {
  var result = url.trim();
  const trailing = '。，,.;；:：!！?？、|)）]】}》>”"\'';
  while (result.isNotEmpty && trailing.contains(result[result.length - 1])) {
    result = result.substring(0, result.length - 1);
  }
  return result;
}

String? _firstKey(String text, {required bool allowBare}) {
  final prefixed = _prefixedKeyPattern.firstMatch(text);
  if (prefixed != null) return prefixed.group(0);
  if (!allowBare) return null;
  for (final match in _bareKeyPattern.allMatches(text)) {
    final token = match.group(0)!;
    // 地址、模型名里也可能有长 token；带 . 或 / 的都不算。
    if (token.contains('.') || token.contains('/')) continue;
    return token;
  }
  return null;
}

List<String> _splitModels(String value) {
  return value
      .split(RegExp(r'[、,，;；/|\n\t|]'))
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .toList();
}

/// 没有任何标签时: 去掉 URL 和 Key，剩下的像模型 id 的 token。
List<String> _looseModels(String text, {String? url, String? key}) {
  var rest = text;
  if (url != null) rest = rest.replaceAll(url, ' ');
  if (key != null) rest = rest.replaceAll(key, ' ');
  rest = rest.replaceAll(_urlPattern, ' ');
  final result = <String>[];
  for (final chunk in rest.split(RegExp(r'[\s、,，;；|]+'))) {
    var token = _cleanModel(chunk);
    // 「可用：gpt-6.2-sol」这种贴在一起的，去掉前面的标签。
    final cut = _indexOfLabelColon(token);
    if (cut != null) token = _cleanModel(token.substring(cut.$2));
    if (token.isEmpty) continue;
    if (!RegExp(r'[A-Za-z0-9]').hasMatch(token)) continue; // 纯中文标签
    if (!RegExp(r'[-_.:/]|\d').hasMatch(token)) continue; // gpt、sol 这种没特征的不猜
    result.add(token);
  }
  return result;
}

String _cleanModel(String raw) {
  var token = raw.trim();
  const trailing = '。，,;；:：|、)）]】》”"\'';
  while (token.isNotEmpty && trailing.contains(token[token.length - 1])) {
    token = token.substring(0, token.length - 1).trim();
  }
  const leading = '（(【[「“‘"\'';
  while (token.isNotEmpty && leading.contains(token[0])) {
    token = token.substring(1).trim();
  }
  return token;
}
