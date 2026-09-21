# vendor/

このダッシュボードは「ビルド不要・HTML/CSS/JS単体」という方針のため、外部ライブラリは
npm等でインストールせず、必要なファイルをこのフォルダに直接同梱しています。

## qrcode.js

- 由来：[kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
- 取得元：`https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js`（バージョン1.4.4）
- ライセンス：MIT License（Copyright (c) 2009 Kazuhiko Arase）
- 用途：設定パネルの「他の端末への引き継ぎ」機能で、登録チャンネル等をQRコードとして
  表示するために使用。外部CDNへのランタイム依存を避けるため、ファイルをそのまま
  同梱している（改変はしていない）。
- 使い方（`app.js`から）：
  ```js
  const qr = qrcode(0, "M"); // 0 = バージョン自動判定, 'M' = 誤り訂正レベル
  qr.addData(jsonString);
  qr.make();
  container.innerHTML = qr.createSvgTag(4, 8); // セルサイズ4px, 余白8px
  ```
- 更新する場合は、上記取得元から最新版を同じファイル名で取得し直してください
  （このプロジェクトではビルドプロセスを持たないため、ファイルをそのまま置き換えるだけです）。

## fonts/Poppins-ExtraBold.woff2

- 由来：[Google Fonts - Poppins](https://fonts.google.com/specimen/Poppins)
- 取得元：`https://fonts.googleapis.com/css2?family=Poppins:wght@800` が指す
  `https://fonts.gstatic.com/...woff2`（ウェイト800・latin subsetのみ）。
- ライセンス：SIL Open Font License, Version 1.1。
- 用途：ヘッダーのロゴ「UnDop」の見出しフォント（本文の日本語部分は従来どおり
  システムフォントのまま）。Google Fonts CDNへのランタイム依存を避けるため、
  qrcode.jsと同じ方針でファイルをそのまま同梱している（latin以外の文字は
  ロゴで使わないため、他のsubset・他のウェイトは同梱していない）。
- 使い方（`style.css`から）：`@font-face`で読み込み、`.app-header h1`にのみ適用。
- 更新・別ウェイト追加が必要な場合は、上記取得元のCSSから該当woff2のURLを
  確認して取得し直してください。

