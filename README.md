# ie-mode-mcp

Microsoft Edge の **IE モード** で動作するレガシー Web アプリケーションを、AI エージェントから
MCP (Model Context Protocol) 経由で操作するための MCP Server。

```
AI Agent ──(MCP / stdio)──> ie-mode-mcp ──> BrowserManager ──> selenium-webdriver
                                                                     │
                                                          IEDriverServer.exe
                                                                     │
                                                     Microsoft Edge (IE Mode)
                                                                     │
                                                       Legacy Web Application
```

- Node.js 22 / TypeScript / selenium-webdriver のみで構成（HTTP Server・DB・DI・Logging Framework なし）
- MCP Transport は **stdio のみ**
- ブラウザセッションは **1 つのみ**、WebDriver 操作は **完全逐次実行**
- HTML 全文は返さず、`inspect_page` が LLM 向けに要約した画面情報を返す
- 承認フローなし。Tool を呼び出した時点で操作を実行する

---

## 目次

1. [クイックスタート](#1-クイックスタート)
2. [前提条件](#2-前提条件)
3. [Windows 側の事前設定](#3-windows-側の事前設定)
4. [インストールとビルド](#4-インストールとビルド)
5. [環境変数](#5-環境変数)
6. [起動方法](#6-起動方法)
7. [AI Agent への登録](#7-ai-agent-への登録)
8. [Tool リファレンス](#8-tool-リファレンス)
9. [利用例](#9-利用例)
10. [エラーと対処](#10-エラーと対処)
11. [ログ](#11-ログ)
12. [トラブルシューティング](#12-トラブルシューティング)
13. [開発](#13-開発)
14. [制限事項](#14-制限事項)

---

## 1. クイックスタート

Windows 上で以下を実行する。

```powershell
git clone https://github.com/sumikof/iedriver-mcp.git
cd iedriver-mcp
npm install
npm run build

# IEDriverServer.exe のパスと、遷移を許可する Origin を指定して起動
$env:IE_MCP_DRIVER_PATH = "C:\tools\IEDriverServer.exe"
$env:IE_MCP_ALLOWED_ORIGINS = "http://legacy01.local"
node dist/index.js
```

`{"level":"info","event":"started","transport":"stdio"}` が stderr に出力されれば起動成功。
通常は手動で起動せず、[AI Agent 側の MCP 設定](#7-ai-agent-への登録)から自動起動させる。

---

## 2. 前提条件

| 項目 | 内容 |
| --- | --- |
| OS | Windows 11 / Windows 10（**ログイン済みのインタラクティブセッション**） |
| Node.js | 22 以上 |
| ブラウザ | Microsoft Edge（IE モードが利用可能なこと） |
| Driver | IEDriverServer.exe（Selenium 4.x 系。**32bit 版を推奨**） |

- IEDriverServer.exe は [Selenium のダウンロードページ](https://www.selenium.dev/downloads/)から取得し、
  任意のフォルダ（例: `C:\tools\`）に配置する。
  64bit 版には既知の制約があるため、Selenium 公式は 32bit 版の利用を推奨している。
- IEDriver は GUI・ウィンドウフォーカス・ネイティブイベントの影響を受けるため、
  **専用の Windows VM または専用の Windows セッション**での利用を推奨する。
- Windows Service（Session 0）上でブラウザを動作させる構成は想定していない。
- MCP Server と IEDriver / Edge は同一 Windows 環境で動作させる。

---

## 3. Windows 側の事前設定

IEDriver は環境設定の影響を強く受ける。**先に手動で設定を済ませてから** MCP Server を起動する。

### 3.1 Edge の IE モードを利用可能にする

対象サイトが IE モードで開けることを、先に Edge の手動操作で確認しておく。IE モードは以下の
いずれかのポリシーで有効化する（`Software\Policies\Microsoft\Edge` 配下）。

| ポリシー（表示名） | レジストリ値名 |
| --- | --- |
| Configure Internet Explorer integration | `InternetExplorerIntegrationLevel` |
| Configure the Enterprise Mode Site List | `InternetExplorerIntegrationSiteList` |
| Send all intranet sites to Internet Explorer | （Edge 77 以降のグループポリシーで設定） |

具体的な構成は組織のポリシーに依存するため、詳細は
[Microsoft の IE モードのドキュメント](https://learn.microsoft.com/ja-jp/deployedge/edge-ie-mode)
と自組織の管理者に確認すること。Windows / Edge は最新の更新を適用しておく。

### 3.2 IEDriver の要求する設定

| 項目 | 必要な状態 | 本 Server での扱い |
| --- | --- | --- |
| ブラウザのズーム | 100% | `ignoreZoomSetting(true)` を設定済みのため必須ではないが、100% を推奨 |
| 保護モード（Protected Mode） | すべてのゾーンで同じ設定 | 未統一の場合は起動時に例外となる。Internet オプション → セキュリティ で統一する |
| IEDriverServer の bit 数 | 32bit 推奨 | — |

保護モードの設定が統一されていないと `browser_start` が失敗する。IEDriver の
`introduceFlakinessByIgnoringProtectedModeSettings` は動作が不安定になるため使用していない。

---

## 4. インストールとビルド

```powershell
npm install     # 依存パッケージの取得
npm run build   # TypeScript を dist/ へビルド
```

生成物は `dist/index.js`。ビルド後は `npm start`（= `node dist/index.js`）でも起動できる。

---

## 5. 環境変数

設定ファイル（YAML / JSON）は使用せず、環境変数のみで設定する。

| 環境変数 | 説明 | 既定値 |
| --- | --- | --- |
| `IE_MCP_EDGE_PATH` | msedge.exe のパス | 未指定（IEDriver が自動検出） |
| `IE_MCP_DRIVER_PATH` | IEDriverServer.exe のパス | 未指定（`PATH` から探索） |
| `IE_MCP_ALLOWED_ORIGINS` | `navigate` を許可する Origin のカンマ区切り。`*` で無制限 | `*` |
| `IE_MCP_TIMEOUT_MS` | 要素検索・待機の既定タイムアウト（ms） | `10000` |

```
IE_MCP_EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
IE_MCP_DRIVER_PATH=C:\tools\IEDriverServer.exe
IE_MCP_ALLOWED_ORIGINS=http://legacy01.local,http://legacy02.local
IE_MCP_TIMEOUT_MS=10000
```

- IE Driver 4.5.0 以降は IE 非搭載環境（Windows 11 の既定）で Edge を自動検出するため、
  `IE_MCP_EDGE_PATH` は通常不要。自動検出に失敗する場合のみ明示指定する。
- 運用の再現性を優先する場合は `IE_MCP_DRIVER_PATH` を明示指定することを推奨する。
- `IE_MCP_ALLOWED_ORIGINS` は誤操作防止用の簡易的な制限であり、Origin（scheme + host + port）
  の完全一致で判定する。パス単位の制限は行わない。

---

## 6. 起動方法

### 手動起動（動作確認用）

PowerShell:

```powershell
$env:IE_MCP_DRIVER_PATH = "C:\tools\IEDriverServer.exe"
$env:IE_MCP_ALLOWED_ORIGINS = "http://legacy01.local"
node dist/index.js
```

コマンドプロンプト:

```bat
set IE_MCP_DRIVER_PATH=C:\tools\IEDriverServer.exe
set IE_MCP_ALLOWED_ORIGINS=http://legacy01.local
node dist\index.js
```

stdio でクライアントからの接続を待ち受ける。標準入出力が MCP のプロトコルに使用されるため、
**この状態でキーボード入力しても応答はない**（正常）。ログはすべて stderr に出力される。
終了は `Ctrl+C`（ブラウザも自動的に閉じる）。

> **注意**: MCP Server の起動だけではブラウザは起動しない。ブラウザは Agent が `browser_start`
> を呼び出した時点で起動する。

### 通常運用

AI Agent（MCP クライアント）が本 Server を子プロセスとして起動する。手動起動は不要。
次章の設定を行う。

---

## 7. AI Agent への登録

MCP クライアントの設定ファイルに以下を追加する。

```json
{
  "mcpServers": {
    "ie-mode": {
      "command": "node",
      "args": ["C:\\ie-mode-mcp\\dist\\index.js"],
      "env": {
        "IE_MCP_DRIVER_PATH": "C:\\tools\\IEDriverServer.exe",
        "IE_MCP_EDGE_PATH": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "IE_MCP_ALLOWED_ORIGINS": "http://legacy01.local,http://legacy02.local",
        "IE_MCP_TIMEOUT_MS": "10000"
      }
    }
  }
}
```

- パスは JSON 内でバックスラッシュをエスケープする（`C:\\...`）。
- `args` にはビルド後の `dist/index.js` の**絶対パス**を指定する。
- Claude Code の場合は `claude mcp add` でも登録できる。

```powershell
claude mcp add ie-mode --env IE_MCP_DRIVER_PATH=C:\tools\IEDriverServer.exe --env IE_MCP_ALLOWED_ORIGINS=http://legacy01.local -- node C:\ie-mode-mcp\dist\index.js
```

登録後、クライアント側で `browser_start` を含む 10 個の Tool が見えていれば接続成功。

---

## 8. Tool リファレンス

公開する Tool は 10 個。WebDriver の低レベル API（`findElement` / `executeScript` など）は公開しない。

| Tool | 入力 | 概要 |
| --- | --- | --- |
| `browser_start` | なし | Edge IE Mode を起動する。起動済みなら既存セッションを再利用する |
| `browser_close` | なし | ブラウザを終了する。何度呼んでもエラーにならない |
| `navigate` | `url` | URL Allowlist を確認してから遷移する |
| `inspect_page` | `frame?` | URL / title / 画面テキスト / 操作可能要素を返す |
| `click` | `selector`, `frame?` | 表示・有効を待ってからクリックする |
| `type` | `selector`, `frame?`, `text`, `clear?` | input / textarea へ入力する |
| `select` | `selector`, `frame?`, `by`, `value` | `<select>` の option を選択する |
| `wait_for` | `type`, `selector?`, `frame?`, `text?`, `timeoutMs?` | 条件が満たされるまで待機する |
| `switch_window` | `target:"newest"` / `index`, `timeoutMs?` | popup・別 Window へ切り替える |
| `screenshot` | なし | 現在の画面を PNG（MCP image content）で返す |

### 共通: Selector

```json
{ "by": "id | name | css | xpath | linkText", "value": "searchButton" }
```

レガシー Web アプリでは `name` と `xpath` の使用頻度が高いため対応している。

### 共通: frame（iframe は 1 階層）

すべての要素操作 Tool は任意の `frame` を受け取る。指定すると `defaultContent` に戻してから
frame に切り替え、その中で要素を検索する。

```json
{
  "frame": { "by": "name", "value": "mainFrame" },
  "selector": { "by": "id", "value": "searchButton" }
}
```

### `browser_start`

```json
{}
```

```json
{ "status": "ready", "reused": false }
```

`reused: true` は既存セッションをそのまま使ったことを示す。既存セッションが死んでいる場合は
自動的に起動し直す。

### `navigate`

```json
{ "url": "http://legacy01.local/customer" }
```

```json
{ "url": "http://legacy01.local/customer", "title": "顧客検索" }
```

### `inspect_page`

Agent が画面を理解するための主要 Tool。HTML 全文は返さず、URL / title / 表示テキスト /
操作可能要素（`a` `button` `input` `textarea` `select` `iframe`）のみを返す。
非表示の要素と `type="hidden"` の input は除外される。

```json
{ "frame": { "by": "name", "value": "mainFrame" } }
```

```json
{
  "url": "http://legacy01.local/customer",
  "title": "顧客検索",
  "text": "顧客検索 顧客名 支店 検索",
  "elements": [
    { "tag": "input", "id": "customerName", "name": "customerName", "type": "text" },
    { "tag": "select", "id": "branch", "name": "branch", "text": "東京支店", "optionCount": 12 },
    { "tag": "button", "id": "searchButton", "text": "検索" },
    { "tag": "iframe", "name": "mainFrame" }
  ],
  "truncated": false
}
```

- `truncated: true` は要素が上限（300 件）で打ち切られたことを示す。
- 要素一覧に `iframe` が含まれる場合、その中身を見るには `frame` を指定して再度呼び出す。

### `click`

```json
{ "selector": { "by": "id", "value": "searchButton" } }
```

```json
{ "url": "http://legacy01.local/customer", "title": "顧客検索" }
```

表示・有効になるまで待ってからクリックする。**click は自動 Retry しない**（登録・更新・送信が
既に成功している状態での再クリックによる二重処理を防ぐため）。

### `type`

```json
{
  "selector": { "by": "id", "value": "customerName" },
  "text": "山田太郎",
  "clear": true
}
```

`clear`（既定 `true`）が `true` なら `clear()` 後に入力、`false` なら追記する。

### `select`

```json
{
  "selector": { "by": "id", "value": "branch" },
  "by": "text",
  "value": "東京支店"
}
```

```json
{ "text": "東京支店", "value": "13", "index": 2 }
```

`by` は `text` / `value` / `index`（`index` は 0 始まり）。

### `wait_for`

固定 sleep を使わず、明示的に待機する。

```json
{
  "type": "visible",
  "selector": { "by": "id", "value": "resultTable" },
  "timeoutMs": 10000
}
```

| `type` | 必要な入力 | 条件 |
| --- | --- | --- |
| `present` | `selector` | 要素が DOM に存在する |
| `visible` | `selector` | 要素が表示されている |
| `enabled` | `selector` | 要素が表示され、かつ操作可能 |
| `text` | `selector`, `text` | 要素のテキストが `text` を含む |
| `url` | `text` | 現在の URL が `text` を含む |
| `title` | `text` | title が `text` を含む |

`timeoutMs` 省略時は `IE_MCP_TIMEOUT_MS` を使用する。

### `switch_window`

```json
{ "target": "newest" }
```

```json
{ "index": 1 }
```

```json
{ "url": "http://legacy01.local/detail", "title": "顧客詳細", "index": 1, "windowCount": 2 }
```

`newest` は新しい Window Handle が現れるまで短時間ポーリングする。検出できなかった場合は
現存する最後の Window に切り替える。

### `screenshot`

```json
{}
```

PNG 画像（MCP の image content）を返す。DOM だけでは判断できないレイアウト・エラー画面の確認に使う。

---

## 9. 利用例

### 基本ループ

```
browser_start → navigate → inspect_page → click / type / select → wait_for → inspect_page
```

`inspect_page` で画面を把握 → 操作 → `wait_for` で結果を待つ → 再度 `inspect_page`、を繰り返す。

### 例: 顧客「山田太郎」を検索して詳細画面を開く

| # | Tool | 引数 |
| --- | --- | --- |
| 1 | `browser_start` | `{}` |
| 2 | `navigate` | `{ "url": "http://legacy01.local/customer" }` |
| 3 | `inspect_page` | `{}` |
| 4 | `type` | `{ "selector": { "by": "id", "value": "customerName" }, "text": "山田太郎" }` |
| 5 | `select` | `{ "selector": { "by": "id", "value": "branch" }, "by": "text", "value": "東京支店" }` |
| 6 | `click` | `{ "selector": { "by": "id", "value": "searchButton" } }` |
| 7 | `wait_for` | `{ "type": "visible", "selector": { "by": "id", "value": "resultTable" } }` |
| 8 | `inspect_page` | `{}` |
| 9 | `click` | `{ "selector": { "by": "linkText", "value": "山田太郎" } }` |
| 10 | `wait_for` | `{ "type": "title", "text": "顧客詳細" }` |
| 11 | `inspect_page` | `{}` |

### 例: iframe 内を操作する

```json
{"tool": "inspect_page", "args": {}}
{"tool": "inspect_page", "args": { "frame": { "by": "name", "value": "mainFrame" } }}
{"tool": "click", "args": {
  "frame": { "by": "name", "value": "mainFrame" },
  "selector": { "by": "id", "value": "searchButton" }
}}
```

frame の指定は操作ごとに毎回渡す（内部で毎回 `defaultContent` に戻してから切り替えるため、
状態は持ち越されない）。

### 例: popup を操作して元の Window に戻る

```json
{"tool": "click",         "args": { "selector": { "by": "id", "value": "openPopup" } }}
{"tool": "switch_window", "args": { "target": "newest" }}
{"tool": "inspect_page",  "args": {}}
{"tool": "switch_window", "args": { "index": 0 }}
```

---

## 10. エラーと対処

エラーは Selenium の Stack Trace ではなく、次のコードで返る（`isError: true`）。

```json
{
  "error": "ELEMENT_NOT_FOUND",
  "message": "Element was not found: id=searchButton",
  "selector": { "by": "id", "value": "searchButton" }
}
```

| エラーコード | 意味 | 対処 |
| --- | --- | --- |
| `BROWSER_NOT_STARTED` | ブラウザ未起動 | `browser_start` を呼ぶ |
| `ELEMENT_NOT_FOUND` | 要素・frame が見つからない | `inspect_page` で実際の要素を確認し、Selector を見直す |
| `TIMEOUT` | `wait_for` の条件が満たされなかった | 条件・`timeoutMs` を見直す。画面が想定と異なる可能性 |
| `WINDOW_NOT_FOUND` | 指定 Window が存在しない | `switch_window` の `index` を見直す |
| `NAVIGATION_FAILED` | 遷移に失敗 | URL・ネットワーク・認証を確認 |
| `DRIVER_LOST` | IEDriver / Edge が異常終了 | `browser_start` で再起動する（下記参照） |
| `URL_NOT_ALLOWED` | Allowlist 外の Origin | `IE_MCP_ALLOWED_ORIGINS` を見直す |
| `INVALID_ARGUMENT` | 引数不正 | Tool の入力仕様を確認 |
| `INTERNAL_ERROR` | その他（起動失敗を含む） | `message` と stderr のログを確認 |

### `DRIVER_LOST` からの復旧

ブラウザまたは Driver が落ちた場合、内部の WebDriver は破棄され、以後の操作は
`BROWSER_NOT_STARTED` になる。**自動復旧・直前操作の自動再実行は行わない**（二重登録などの
副作用を防ぐため）。Agent 側で `browser_start` を呼び直し、画面の状態を `inspect_page` で
確認してから操作を再開する。直前の操作が既に成立している可能性があるため、登録・更新系の
操作をそのまま再実行してはならない。

---

## 11. ログ

stdout は MCP のプロトコルが使用するため、ログはすべて **stderr** に JSON 1 行で出力する。

```json
{"level":"info","event":"started","transport":"stdio"}
{"level":"info","tool":"navigate","url":"http://legacy01.local/customer","durationMs":842}
{"level":"info","tool":"type","selector":{"by":"id","value":"password"},"textLength":16,"durationMs":128}
{"level":"error","tool":"click","selector":{"by":"id","value":"x"},"error":"ELEMENT_NOT_FOUND","message":"Element was not found: id=x","durationMs":5012}
```

入力文字列そのもの・Cookie・認証情報・HTML 全文は記録しない（`type` は文字数のみ）。
ファイルに残す場合は stderr をリダイレクトする。

```powershell
node dist/index.js 2>> C:\logs\ie-mode-mcp.log
```

---

## 12. トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| `browser_start` が `INTERNAL_ERROR` になる | `IE_MCP_DRIVER_PATH` が正しいか。IEDriverServer.exe を単体で起動できるか |
| 保護モード関連の例外が出る | Internet オプション → セキュリティ で全ゾーンの保護モード設定を統一する |
| ズーム関連の例外が出る | Edge / IE のズームを 100% に戻す |
| Edge は起動するが IE モードにならない | IE モードのポリシー（サイトリスト等）を確認する。手動で IE モード表示できるか先に確認 |
| 操作が固まる・要素をクリックできない | ウィンドウが最小化・非アクティブになっていないか。リモートデスクトップ切断中は不安定になる |
| `inspect_page` の要素が空 | frame 内の画面ではないか（`frame` を指定して再取得）。`screenshot` で実画面を確認 |
| Agent 側に Tool が見えない | `dist/index.js` を絶対パスで指定しているか。`npm run build` 済みか |
| 標準出力に何も出ない | 正常。ログは stderr に出力される |

`screenshot` は原因調査に有効。DOM 情報だけでは判断できない状態（モーダル、認証ダイアログ、
レンダリング崩れ）を確認できる。

---

## 13. 開発

```
src/
├─ index.ts      MCP Server のエントリーポイント（stdio）
├─ config.ts     環境変数と stderr ログ
├─ tools.ts      MCP Tool の Schema と Handler
├─ browser.ts    BrowserManager（Selenium / IEDriver 操作の集約）
├─ selectors.ts  Selector → Selenium の By 変換
└─ errors.ts     Selenium Error → MCP Error Code 変換
```

```powershell
npm run build   # tsc でビルド
npm start       # node dist/index.js
```

- MCP Tool は Selenium を直接触らず、必ず `BrowserManager` を経由する。
- すべての WebDriver 操作は Promise Chain で逐次化されており、Tool が並列に呼ばれても
  IEDriver へは 1 件ずつしか送られない。
- 副作用のない操作（要素検索・Window Handle 検出）のみ Retry する。`click` や送信は Retry しない。

---

## 14. 制限事項

初期実装では以下に対応しない。

複数ブラウザセッション / 複数ユーザー / HTTP Transport / REST API / DB / セッション永続化 /
自動ブラウザ復旧 / 複雑な Retry Policy / WebDriver Grid / 汎用 Selenium API /
`executeScript` Tool / 多段 iframe（1 階層のみ）/ Element Cache / Metrics / 承認フロー / 認証・認可
