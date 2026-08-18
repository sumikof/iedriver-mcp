# ie-mode-mcp

Microsoft Edge の **IE モード** で動作するレガシー Web アプリケーションを、AI エージェントから
MCP 経由で操作するための MCP Server。

汎用 Selenium MCP Server ではなく、Edge IE Mode 専用の軽量 MCP Server である。

```
AI Agent ──(MCP / stdio)──> ie-mode-mcp ──> BrowserManager ──> selenium-webdriver
                                                                     │
                                                          IEDriverServer.exe
                                                                     │
                                                     Microsoft Edge (IE Mode)
                                                                     │
                                                       Legacy Web Application
```

## 特徴

- Node.js 22 / TypeScript / selenium-webdriver のみで構成 (HTTP Server・DB・DI・Logging Framework なし)
- MCP Transport は **stdio のみ**
- ブラウザセッションは **1 つのみ**、WebDriver 操作は **完全逐次実行** (Promise Chain)
- WebDriver の低レベル API (`findElement` / `executeScript` など) は Tool として公開しない
- HTML 全文は返さず、`inspect_page` が LLM 向けに要約した画面情報を返す
- 承認フローなし。Tool を呼び出した時点で操作を実行する

## 必要な環境

- Windows 11 (ログイン済みインタラクティブセッション)
- Node.js 22
- Microsoft Edge (IE モードが利用可能なこと)
- IEDriverServer.exe

Windows Service (Session 0) 上でのブラウザ動作は想定しない。IEDriver は GUI / ウィンドウフォーカス /
ネイティブイベントの影響を受けるため、専用の Windows VM または専用セッションでの利用を推奨する。

## セットアップ

```
npm install
npm run build
node dist/index.js
```

## 設定 (環境変数のみ)

| 環境変数 | 説明 | 既定値 |
| --- | --- | --- |
| `IE_MCP_EDGE_PATH` | msedge.exe のパス | 未指定 (IEDriver の既定動作) |
| `IE_MCP_DRIVER_PATH` | IEDriverServer.exe のパス | 未指定 (PATH から探索) |
| `IE_MCP_ALLOWED_ORIGINS` | `navigate` を許可する Origin のカンマ区切り。`*` で無制限 | `*` |
| `IE_MCP_TIMEOUT_MS` | 既定のタイムアウト (ms) | `10000` |

例:

```
IE_MCP_EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
IE_MCP_DRIVER_PATH=C:\tools\IEDriverServer.exe
IE_MCP_ALLOWED_ORIGINS=http://legacy01.local,http://legacy02.local
IE_MCP_TIMEOUT_MS=10000
```

## AI Agent 側の MCP 設定例

```json
{
  "mcpServers": {
    "ie-mode": {
      "command": "node",
      "args": ["C:\\ie-mode-mcp\\dist\\index.js"],
      "env": {
        "IE_MCP_EDGE_PATH": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "IE_MCP_DRIVER_PATH": "C:\\tools\\IEDriverServer.exe",
        "IE_MCP_ALLOWED_ORIGINS": "http://legacy01.local"
      }
    }
  }
}
```

## MCP Tool (10 個)

| Tool | 入力 | 概要 |
| --- | --- | --- |
| `browser_start` | なし | Edge IE Mode を起動する。起動済みなら既存セッションを返す |
| `browser_close` | なし | ブラウザを終了する。何度呼んでもエラーにならない |
| `navigate` | `url` | URL Allowlist を確認してから遷移する |
| `inspect_page` | `frame?` | URL / title / 画面テキスト / 操作可能要素を返す (HTML 全文は返さない) |
| `click` | `selector`, `frame?` | 表示・有効を待ってからクリックする (自動 Retry なし) |
| `type` | `selector`, `frame?`, `text`, `clear?` | input / textarea へ入力する |
| `select` | `selector`, `frame?`, `by`, `value` | `<select>` の option を text / value / index で選択する |
| `wait_for` | `type`, `selector?`, `frame?`, `text?`, `timeoutMs?` | present / visible / enabled / text / url / title を待機する |
| `switch_window` | `target:"newest"` または `index` | popup / 別 Window へ切り替える |
| `screenshot` | なし | 現在の画面を PNG (MCP image content) で返す |

### Selector

```json
{ "by": "id | name | css | xpath | linkText", "value": "searchButton" }
```

### Target (iframe は 1 階層に対応)

```json
{
  "frame": { "by": "name", "value": "mainFrame" },
  "selector": { "by": "id", "value": "searchButton" }
}
```

`inspect_page` は要素一覧に `iframe` を含める。frame 内を見たい場合は
`inspect_page` に `frame` を渡す。

### inspect_page の返却例

```json
{
  "url": "http://legacy01.local/customer",
  "title": "顧客検索",
  "text": "顧客検索 顧客名 支店 検索",
  "elements": [
    { "tag": "input", "id": "customerName", "name": "customerName", "type": "text" },
    { "tag": "select", "id": "branch", "name": "branch", "text": "東京支店", "optionCount": 12 },
    { "tag": "button", "id": "searchButton", "text": "検索" }
  ],
  "truncated": false
}
```

## Agent の基本ループ

```
browser_start → navigate → inspect_page → click / type / select → wait_for → inspect_page
```

## エラー

エラーは Selenium の Stack Trace ではなく、次のコードで返す。

```
BROWSER_NOT_STARTED / ELEMENT_NOT_FOUND / TIMEOUT / WINDOW_NOT_FOUND /
NAVIGATION_FAILED / DRIVER_LOST / URL_NOT_ALLOWED / INVALID_ARGUMENT / INTERNAL_ERROR
```

```json
{
  "error": "ELEMENT_NOT_FOUND",
  "message": "Element was not found: id=searchButton",
  "selector": { "by": "id", "value": "searchButton" }
}
```

IEDriver / Edge が異常終了した場合は `DRIVER_LOST` を返し、内部の driver は破棄される。
自動復旧・自動再実行は行わない (二重登録などの副作用を防ぐため)。Agent は `browser_start`
を再実行して復旧する。

## ログ

stdout は MCP Protocol が使用するため、ログはすべて **stderr** へ JSON 1 行で出力する。
入力文字列・Cookie・HTML 全文は記録しない (`type` は文字数のみ記録)。

```json
{"level":"info","tool":"type","selector":{"by":"id","value":"password"},"textLength":16,"durationMs":128}
```

## ディレクトリ構成

```
src/
├─ index.ts      MCP Server のエントリーポイント (stdio)
├─ config.ts     環境変数と stderr ログ
├─ tools.ts      MCP Tool の Schema と Handler
├─ browser.ts    BrowserManager (Selenium / IEDriver 操作の集約)
├─ selectors.ts  Selector → Selenium の By 変換
└─ errors.ts     Selenium Error → MCP Error Code 変換
```

## 初期実装で対応しないもの

複数ブラウザセッション / 複数ユーザー / HTTP Transport / REST API / DB / セッション永続化 /
自動ブラウザ復旧 / 複雑な Retry Policy / WebDriver Grid / 汎用 Selenium API /
`executeScript` Tool / Element Cache / Metrics / 承認フロー / 認証・認可
