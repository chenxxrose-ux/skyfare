# 航跡 Skyfare

即時機票比價網頁：選航線、日期、人數和艙等，查 Google 航班的即時票價；可以追蹤某一班航班或整條航線的最低價，降價時用 Telegram 通知。網頁放在 GitHub Pages，任何人打開網址就能用。

```
docs/index.html           網頁（GitHub Pages）
worker/src/index.js       後端（Cloudflare Workers，免費方案即可）
worker/wrangler.toml      後端設定
.github/workflows/        推送到 GitHub 後自動部署後端
```

## 運作方式

```
瀏覽器 ──► GitHub Pages（網頁）
   │
   └──► Cloudflare Worker ──► SerpApi（Google 航班即時票價）
              │  └─ KV：存追蹤清單和價格紀錄
              └─ 每 6 小時自動查價 ──► Telegram 降價通知
```

API 金鑰只放在 Worker 裡，不會出現在公開網頁上。同樣的搜尋 20 分鐘內會共用結果，節省查詢次數。

## 設定步驟（約 15 分鐘）

### 1. 申請三個免費帳號

| 服務 | 要拿到的東西 |
|---|---|
| [SerpApi](https://serpapi.com) | Dashboard 裡的 **API Key** |
| [Cloudflare](https://dash.cloudflare.com) | **Account ID**（Workers 頁面右側）和一組 **API Token**（My Profile → API Tokens → 用「Edit Cloudflare Workers」範本建立） |
| Telegram | 跟 [@BotFather](https://t.me/BotFather) 傳 `/newbot` 建立機器人，拿到 **Bot Token** 和機器人帳號 |

### 2. 建立 KV 儲存空間

Cloudflare 後台 → Storage & Databases → **KV** → Create，名稱打 `skyfare`，把產生的 ID 貼到 `worker/wrangler.toml` 的 `id = "..."`。

同一個檔案裡也改好：
- `TELEGRAM_BOT`：機器人帳號（不含 @）
- `SITE_URL`：你的 GitHub Pages 網址，例如 `https://你的帳號.github.io/skyfare`

### 3. 把金鑰放進 GitHub Secrets

repo → Settings → Secrets and variables → Actions → New repository secret，新增：

| 名稱 | 內容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `SERPAPI_KEY` | SerpApi API Key |
| `TELEGRAM_TOKEN` | Telegram Bot Token |
| `TELEGRAM_SECRET` | 自己隨便打一串英數字（20 字以上），用來驗證 Telegram 的請求 |

推送到 `main` 後，Actions 會自動部署後端。成功後在 Actions 紀錄裡會看到 Worker 網址，長得像 `https://skyfare-api.你的帳號.workers.dev`。

### 4. 讓網頁接上後端

打開 `docs/index.html`，把最上面的設定改成你的 Worker 網址：

```js
const API_BASE = "https://skyfare-api.你的帳號.workers.dev";
```

沒填的話網頁會用示範資料，方便先看樣子。

### 5. 開啟 GitHub Pages

repo → Settings → Pages → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾選 `/docs`，存檔。一兩分鐘後網址就會生效。

### 6. 連接 Telegram 機器人

在瀏覽器打開下面這個網址一次（把三個地方換成你的值）：

```
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=<Worker網址>/telegram&secret_token=<TELEGRAM_SECRET>
```

看到 `"ok":true` 就完成了。之後在網頁追蹤航班，按「用 Telegram 接收降價通知」，在 Telegram 按「開始」即可。

## 查詢次數

SerpApi 免費方案每月有搜尋次數上限，以下都會用掉次數：
- 網頁上每次搜尋（同樣條件 20 分鐘內不重複計算）
- 每筆追蹤每 6 小時自動查一次，也就是每筆每天 4 次

分享給很多人用時，可以：
- 把 `wrangler.toml` 的排程改成 `"0 0,12 * * *"`（每天 2 次）
- 調低 `MAX_WATCHES`（同時追蹤的上限）
- 升級 SerpApi 付費方案

次數用完時，網頁會顯示「這個月的免費查詢次數用完了」。

## 常見問題

**價格是即時的嗎？** 搜尋時是當下向 Google 航班查詢，最多快取 20 分鐘。實際訂票價格以航空公司或訂票網站為準。

**來回票怎麼算？** 顯示的是來回總價（所有乘客合計），列表中的航班是去程；回程在 Google 航班訂票時選擇。

**別人可以刪掉我的追蹤嗎？** 不行。只有建立追蹤的那個瀏覽器有刪除權限；分享連結給朋友，對方只能看價格走勢。
