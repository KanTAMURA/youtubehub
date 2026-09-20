// app.js
// YouTube Hub ダッシュボードの本体。
// 設定（APIキー・登録チャンネル・お気に入り動画）はすべて localStorage に保存する
// （このPCのこのブラウザだけに閉じた情報。サーバーには送らない）。
//
// APIユニットコストの目安（2026年時点の一般的な値。将来変わる可能性あり）:
//   - channels.list / playlistItems.list / videos.list : 1ユニット/回
//   無料枠は1日10,000ユニット。
//   （検索バー機能は削除済み。search.list（100ユニット/回）は現在使用していない）

const STORAGE_KEY = "yth_state_v1";

// チャンネルごとの「表示件数」「直近n日以内」設定のデフォルト値・上限。
// playlistItems.listは1回1ユニットでmaxResults=50まで取得できるため、
// フィルタ後に上限まで取れるよう常に50件取得してからチャンネルごとの
// 表示件数・日数でクライアント側で絞り込む。
const DEFAULT_CHANNEL_VIDEO_COUNT = 6;
const MAX_CHANNEL_VIDEO_COUNT = 50;
const PLAYLIST_FETCH_SIZE = 50;

// 「登録チャンネルの新着」で、1チャンネルにつき1行に並べる動画カードの最大枚数。
// これを超える本数を表示するチャンネルは、このチャンネル自身のブロック内で
// 次の行へ折り返す（#channels-containerの横並び・折り返しはCSS側のflex-wrapで行う）。
const MAX_CHANNEL_CARDS_PER_ROW = 4;

// ---------- 視聴済み動画の記録 ----------
// 設定（APIキー・チャンネル等）とは別のlocalStorageキーに分離して保存する。
// 保存するのは動画ID＋視聴日時のみ（タイトル・サムネイルは保存しない）ため、
// 視聴数が増えてもデータ量は小さく抑えられる。
// { [videoId]: watchedAtのISO文字列 } という形のオブジェクトとして保持する。
const WATCHED_STORAGE_KEY = "yth_watched_v1";
const WATCHED_RETENTION_DAYS = 28; // 4週間より前の履歴は起動時に自動削除
const DEFAULT_WATCH_COMPLETE_PERCENT = 90; // 再生時間の何%見たら「視聴済み」とみなすか（設定タブで変更可能）

const DEFAULT_STATE = {
  apiKey: "",
  newsCount: 3,
  watchCompletePercent: DEFAULT_WATCH_COMPLETE_PERCENT,
  showVideoStats: true, // 動画の再生時間・再生数バッジを表示するか（オフならvideos.listを呼ばない）
  channels: [], // { id, title, uploadsPlaylistId, isNews, showInFeed, videoCount, daysLimit }
  favorites: [], // { videoId, title, thumbnail, channelTitle }
  quota: { date: "", units: 0 },
  onboardingDismissed: false // 初回チュートリアルを一度でも閉じた（スキップ／完了／✕）かどうか
};

let state = loadState();
let watchedMap = loadWatchedMap();
let ytPlayer = null;
let ytApiReady = false;
let currentPlayingVideoId = null;
let watchProgressTimer = null;
let showWatchedVideos = false; // 「視聴済みの動画も表示」チェックボックスの状態（保存はしない）
let isFetchingNews = false; // 今日のニュース取得中フラグ（更新ボタン連打・多重呼び出し防止）
const embeddableCache = new Map(); // videoId -> boolean（同一セッション内のキャッシュ）
const channelVideosCache = new Map(); // channelId -> 取得済みの動画リスト（同一セッション内のキャッシュ。APIの再呼び出しを避けるため）

// ---------- state 永続化 ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const merged = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(raw) };
    // 旧バージョン（週単位の weeksLimit）からの移行：weeksLimit → daysLimit（×7日）に変換して削除。
    merged.channels = (merged.channels || []).map((ch) => {
      if (!Object.prototype.hasOwnProperty.call(ch, "weeksLimit")) return ch;
      const { weeksLimit, ...rest } = ch;
      if (rest.daysLimit === undefined && weeksLimit !== null && weeksLimit !== undefined) {
        rest.daysLimit = weeksLimit * 7;
      }
      return rest;
    });
    return merged;
  } catch (e) {
    console.warn("state読み込み失敗。初期状態を使用します。", e);
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("state保存に失敗しました", e);
  }
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- 視聴済み状態の永続化 ----------

function loadWatchedMap() {
  try {
    const raw = localStorage.getItem(WATCHED_STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return pruneWatchedMap(map);
  } catch (e) {
    console.warn("視聴履歴の読み込みに失敗しました。初期化します。", e);
    return {};
  }
}

// WATCHED_RETENTION_DAYS（4週間）より前の記録を削除する。
// 削除が発生した場合はその場でlocalStorageにも反映する。
function pruneWatchedMap(map) {
  const cutoff = Date.now() - WATCHED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pruned = {};
  let changed = false;
  for (const [videoId, watchedAt] of Object.entries(map)) {
    const t = new Date(watchedAt).getTime();
    if (!Number.isNaN(t) && t >= cutoff) {
      pruned[videoId] = watchedAt;
    } else {
      changed = true;
    }
  }
  if (changed) {
    try {
      localStorage.setItem(WATCHED_STORAGE_KEY, JSON.stringify(pruned));
    } catch (e) {
      console.warn("視聴履歴の保存に失敗しました", e);
    }
  }
  return pruned;
}

function saveWatchedMap() {
  try {
    localStorage.setItem(WATCHED_STORAGE_KEY, JSON.stringify(watchedMap));
  } catch (e) {
    console.warn("視聴履歴の保存に失敗しました", e);
  }
}

function isWatched(videoId) {
  return Object.prototype.hasOwnProperty.call(watchedMap, videoId);
}

function markWatched(videoId) {
  if (isWatched(videoId)) return;
  watchedMap[videoId] = new Date().toISOString();
  saveWatchedMap();
}

function unmarkWatched(videoId) {
  if (!isWatched(videoId)) return;
  delete watchedMap[videoId];
  saveWatchedMap();
}

// ---------- クォータ概算トラッキング ----------

function trackQuota(units) {
  if (state.quota.date !== todayStr()) {
    state.quota = { date: todayStr(), units: 0 };
  }
  state.quota.units += units;
  saveState();
  renderQuotaBadge();
}

function renderQuotaBadge() {
  if (state.quota.date !== todayStr()) {
    document.getElementById("quota-badge").textContent = "API使用量（概算）: 0 / 10,000 ユニット（本日）";
    return;
  }
  const el = document.getElementById("quota-badge");
  el.textContent = `API使用量（概算）: ${state.quota.units.toLocaleString()} / 10,000 ユニット（本日・概算値）`;
  el.style.color = state.quota.units > 8000 ? "#ff6b6b" : "";
}

// ---------- YouTube Data API 呼び出し ----------

const API_BASE = "https://www.googleapis.com/youtube/v3";

async function apiGet(path, params, costUnits) {
  if (!state.apiKey) {
    throw new Error("APIキーが未設定です。設定パネルで入力してください。");
  }
  const url = new URL(`${API_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("key", state.apiKey);

  const res = await fetch(url.toString());
  trackQuota(costUnits);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || res.statusText;
    throw new Error(`YouTube API エラー: ${msg}`);
  }
  return res.json();
}

// チャンネル解決（URL / @ハンドル / チャンネルID のいずれにも対応）
function parseChannelInput(raw) {
  const input = raw.trim();
  const channelIdMatch = input.match(/\/channel\/(UC[\w-]{20,})/);
  if (channelIdMatch) return { mode: "id", value: channelIdMatch[1] };

  const handleMatch = input.match(/\/@([\w.-]+)/);
  if (handleMatch) return { mode: "handle", value: `@${handleMatch[1]}` };

  if (/^UC[\w-]{20,}$/.test(input)) return { mode: "id", value: input };
  if (input.startsWith("@")) return { mode: "handle", value: input };

  // それ以外はハンドルとして試す（@を補って再試行）
  return { mode: "handle", value: `@${input.replace(/^@/, "")}` };
}

async function resolveChannel(raw) {
  const { mode, value } = parseChannelInput(raw);
  const params = { part: "snippet,contentDetails" };
  if (mode === "id") params.id = value;
  else params.forHandle = value;

  const data = await apiGet("channels", params, 1);
  const item = data.items && data.items[0];
  if (!item) {
    throw new Error(
      "チャンネルが見つかりませんでした。チャンネルURL（/channel/UC... または /@ハンドル）を貼り付けるか、チャンネルIDを直接入力してください。"
    );
  }
  return {
    id: item.id,
    title: item.snippet.title,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    thumbnail:
      ((item.snippet.thumbnails && (item.snippet.thumbnails.default || item.snippet.thumbnails.medium)) || {})
        .url || ""
  };
}

// ---------- チャンネル登録欄の入力自動判定・チャンネル名検索（search.list） ----------
// URL（/channel/UC.../@ハンドル形式）・@ハンドル・チャンネルID(UC...)は「直接追加」（1ユニット）、
// それ以外の文字列は「チャンネル名」とみなして検索（search.list、100ユニット）に振り分ける。
function detectChannelInputMode(raw) {
  const v = (raw || "").trim();
  if (!v) return "idle";
  if (/\/channel\/(UC[\w-]{20,})/.test(v)) return "id";
  if (/\/@[\w.-]+/.test(v)) return "id";
  if (/^UC[\w-]{20,}$/.test(v)) return "id";
  if (v.startsWith("@")) return "id";
  return "search";
}

function formatSubscriberCount(n) {
  if (n == null) return "登録者数非公開";
  if (n < 1000) return `登録者 ${n}人`;
  if (n < 10000) return `登録者 ${trimTrailingZero(n / 1000)}千人`;
  return `登録者 ${trimTrailingZero(n / 10000)}万人`;
}

// チャンネル名での検索。search.list（100ユニット）を1回、続けてchannels.list（1ユニット）を
// 1回呼び、検索結果（最大5件）にチャンネルアイコン・登録者数を付与して返す。
// ボタンを明示的に押したときだけ呼ばれる想定（キー入力のたびには呼ばない）。
async function searchChannels(query) {
  const searchData = await apiGet(
    "search",
    { part: "snippet", type: "channel", maxResults: 5, q: query },
    100
  );
  const ids = (searchData.items || [])
    .map((it) => it.id && it.id.channelId)
    .filter(Boolean);
  if (!ids.length) return [];
  const detailData = await apiGet(
    "channels",
    { part: "snippet,statistics,contentDetails", id: ids.join(",") },
    1
  );
  const detailById = new Map((detailData.items || []).map((it) => [it.id, it]));
  return ids
    .map((id) => {
      const d = detailById.get(id);
      if (!d || !d.contentDetails || !d.contentDetails.relatedPlaylists) return null;
      const hidden = d.statistics && d.statistics.hiddenSubscriberCount;
      return {
        id,
        title: d.snippet.title,
        thumbnail:
          ((d.snippet.thumbnails && (d.snippet.thumbnails.default || d.snippet.thumbnails.medium)) || {}).url || "",
        subscriberCount: hidden ? null : Number((d.statistics && d.statistics.subscriberCount) || 0),
        uploadsPlaylistId: d.contentDetails.relatedPlaylists.uploads
      };
    })
    .filter(Boolean);
}

// 検索結果カード一式を描画する。「＋追加」を押すと、既存のチャンネル追加と同じ既定値
// （ニュース対象：オフ、登録チャンネル一覧に表示：オン、表示件数・直近日数：既定値）で登録する。
// buttonRegistry（channelId -> ボタン要素）に登録しておくことで、後からチャンネル一覧の
// 「削除」を押したときに、対応する「＋追加」ボタンを元の状態へ戻せるようにする。
// 検索結果カードの「アクション欄」（＋追加ボタン／表示件数・期間を選ぶバナー／登録済み表示の
// 3状態）を1枚のスロット要素の中で切り替えるコントローラー。
// 「＋追加」を押した直後はまだ登録せず、表示件数・直近日数を選んでから「登録する」で本登録する。
function createResultActionController(slotEl, r, onRegistered) {
  function renderIdle() {
    slotEl.classList.remove("expanded");
    slotEl.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "result-add-btn";
    btn.textContent = "＋ 追加";
    btn.addEventListener("click", renderForm);
    slotEl.appendChild(btn);
  }

  function renderRegistered() {
    slotEl.classList.remove("expanded");
    slotEl.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "result-add-btn added";
    btn.textContent = "登録済み";
    btn.disabled = true;
    slotEl.appendChild(btn);
  }

  function renderForm() {
    slotEl.classList.add("expanded");
    slotEl.innerHTML = `
      <div class="result-add-options">
        <label class="number-inline">表示件数
          <input type="number" class="result-count-input" min="1" max="${MAX_CHANNEL_VIDEO_COUNT}" value="${DEFAULT_CHANNEL_VIDEO_COUNT}" />
        </label>
        <label class="number-inline">直近
          <input type="number" class="result-days-input" min="0" placeholder="制限なし" /> 日以内
        </label>
        <span class="result-add-actions">
          <button type="button" class="result-confirm-btn">登録する</button>
          <button type="button" class="result-cancel-btn">キャンセル</button>
        </span>
      </div>
    `;
    const countInput = slotEl.querySelector(".result-count-input");
    const daysInput = slotEl.querySelector(".result-days-input");
    slotEl.querySelector(".result-cancel-btn").addEventListener("click", renderIdle);
    slotEl.querySelector(".result-confirm-btn").addEventListener("click", () => {
      if (state.channels.some((c) => c.id === r.id)) {
        renderRegistered();
        return;
      }
      const videoCount = Math.max(
        1,
        Math.min(MAX_CHANNEL_VIDEO_COUNT, Math.round(Number(countInput.value)) || DEFAULT_CHANNEL_VIDEO_COUNT)
      );
      const daysRaw = daysInput.value.trim();
      let daysLimit = daysRaw === "" ? null : Math.max(0, Math.round(Number(daysRaw)));
      if (daysLimit !== null && Number.isNaN(daysLimit)) daysLimit = null;
      state.channels.push({
        id: r.id,
        title: r.title,
        uploadsPlaylistId: r.uploadsPlaylistId,
        thumbnail: r.thumbnail || "",
        isNews: false,
        showInFeed: true,
        videoCount,
        daysLimit
      });
      saveState();
      renderRegistered();
      renderChannelManageList();
      refreshAll();
      if (onRegistered) onRegistered(r);
    });
  }

  if (state.channels.some((c) => c.id === r.id)) renderRegistered();
  else renderIdle();

  return { slotEl, reset: renderIdle };
}

function renderChannelSearchResults(container, buttonRegistry, results, onRegistered) {
  buttonRegistry.clear();
  container.innerHTML = "";
  if (!results.length) {
    container.innerHTML = `<p class="empty">チャンネルが見つかりませんでした。別のキーワードでお試しください。</p>`;
    return;
  }
  results.forEach((r) => {
    const card = document.createElement("div");
    card.className = "result-card";

    const avatar = document.createElement("div");
    avatar.className = "avatar-thumb";
    if (r.thumbnail) {
      const img = document.createElement("img");
      img.src = r.thumbnail;
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        avatar.textContent = (r.title[0] || "?").toUpperCase();
        avatar.classList.add("avatar-fallback");
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (r.title[0] || "?").toUpperCase();
      avatar.classList.add("avatar-fallback");
    }

    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.innerHTML = `
      <div class="result-title">${escapeHtml(r.title)}</div>
      <div class="result-subs">${escapeHtml(formatSubscriberCount(r.subscriberCount))}</div>
    `;

    const actionSlot = document.createElement("div");
    actionSlot.className = "result-action-slot";

    card.appendChild(avatar);
    card.appendChild(meta);
    card.appendChild(actionSlot);
    container.appendChild(card);

    const controller = createResultActionController(actionSlot, r, onRegistered);
    buttonRegistry.set(r.id, controller);
  });

  const note = document.createElement("p");
  note.className = "result-quota-note";
  note.textContent = `検索結果 ${results.length} 件（search.list + channels.listで約101ユニット消費しました）`;
  container.appendChild(note);
}

// チャンネル一覧で「削除」した際に、まだ画面に残っている検索結果のアクション欄が
// 「登録済み」のまま固まらないよう、該当カードを見つけて「＋追加」の状態に戻す。
// 設定パネル・初回チュートリアルの両方の検索結果欄を横断してチェックする。
const searchResultButtonRegistries = [];
function resetSearchResultButton(channelId) {
  searchResultButtonRegistries.forEach((registry) => {
    const entry = registry.get(channelId);
    if (entry && entry.slotEl && entry.slotEl.isConnected) {
      entry.reset();
    }
  });
}

// 入力欄の内容から判定したモードを、検出バッジ・案内文・送信ボタンのラベル・
// （オプションが渡された場合は）オプション欄の表示/非表示へ反映する。
function updateChannelDetectUI(raw, { hintEl, tagEl, textEl, submitBtn, optionsEl }) {
  const mode = detectChannelInputMode(raw);
  hintEl.classList.remove("mode-id", "mode-search");
  if (mode === "id") {
    hintEl.classList.add("mode-id");
    tagEl.textContent = "URL/ID";
    textEl.textContent = "URL・@ハンドル・チャンネルIDとして認識しました。そのまま追加します（1ユニット）。";
    if (submitBtn) submitBtn.textContent = "追加";
    if (optionsEl) optionsEl.hidden = false;
  } else if (mode === "search") {
    hintEl.classList.add("mode-search");
    tagEl.textContent = "検索";
    textEl.textContent = "チャンネル名として検索します（search.list・100ユニット）。";
    if (submitBtn) submitBtn.textContent = "🔍 検索";
    if (optionsEl) optionsEl.hidden = true;
  } else {
    tagEl.textContent = "待機中";
    textEl.textContent = "URL・@ハンドル・チャンネルID・チャンネル名、どれでも入力できます。";
    if (submitBtn) submitBtn.textContent = "追加";
    if (optionsEl) optionsEl.hidden = false;
  }
  return mode;
}

function parseVideoInput(raw) {
  const input = raw.trim();
  const m = input.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(input)) return input;
  throw new Error("動画のURLまたは動画ID（11文字）を入力してください。");
}

async function fetchVideoMeta(videoId) {
  const data = await apiGet("videos", { part: "snippet,status", id: videoId }, 1);
  const item = data.items && data.items[0];
  if (!item) throw new Error("動画が見つかりませんでした。");
  embeddableCache.set(videoId, item.status.embeddable !== false);
  return {
    videoId,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.medium?.url,
    channelTitle: item.snippet.channelTitle
  };
}

async function fetchPlaylistLatest(playlistId, maxResults = DEFAULT_CHANNEL_VIDEO_COUNT) {
  const data = await apiGet(
    "playlistItems",
    { part: "snippet,contentDetails", playlistId, maxResults },
    1
  );
  return (data.items || [])
    .filter((it) => it.contentDetails && it.contentDetails.videoId)
    .map((it) => ({
      videoId: it.contentDetails.videoId,
      title: it.snippet.title,
      thumbnail: it.snippet.thumbnails?.medium?.url,
      channelTitle: it.snippet.channelTitle,
      publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt
    }));
}

// daysLimitが未設定（null/0/未指定）なら無制限。指定があれば、
// 現在時刻からn日以内に公開された動画だけを残す。
function filterByDays(videos, daysLimit) {
  if (!daysLimit || daysLimit <= 0) return videos;
  const cutoff = Date.now() - daysLimit * 24 * 60 * 60 * 1000;
  return videos.filter((v) => v.publishedAt && new Date(v.publishedAt).getTime() >= cutoff);
}

// ---------- 動画の再生時間・再生数（設定でオン/オフ可能） ----------
// videos.list（part=contentDetails,statistics）は1回1ユニットで、動画IDを
// 最大50件までまとめて1回のリクエストに指定できる。表示対象の動画IDをできるだけ
// まとめて渡すことで、チャンネル数・ニュース対象チャンネル数が増えても
// 追加コストを最小限（呼び出し対象の総件数 ÷ 50 を切り上げた回数）に抑える。
const videoStatsCache = new Map(); // videoId -> { durationSeconds, viewCount }（セッション内キャッシュ）

function parseIsoDuration(iso) {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  return h * 3600 + min * 60 + s;
}

function formatDuration(seconds) {
  if (seconds == null) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function trimTrailingZero(n) {
  return n.toFixed(1).replace(/\.0$/, "");
}

// 再生数は概算表示でよいとのことなので、千・万単位に丸めて表示する（例: 3.2万回視聴）。
function formatViewCount(n) {
  if (n == null) return "";
  if (n < 1000) return `${n}回視聴`;
  if (n < 10000) return `${trimTrailingZero(n / 1000)}千回視聴`;
  return `${trimTrailingZero(n / 10000)}万回視聴`;
}

// 指定した動画IDの再生時間・再生数をまとめて取得する（50件ずつチャンク分割）。
// セッション内キャッシュがある動画は再取得しない。戻り値は videoId -> stats のMap。
async function fetchVideoStatsBatch(videoIds) {
  const uniqueIds = [...new Set(videoIds)].filter((id) => id && !videoStatsCache.has(id));
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const chunk = uniqueIds.slice(i, i + 50);
    try {
      const data = await apiGet("videos", { part: "contentDetails,statistics", id: chunk.join(",") }, 1);
      for (const item of data.items || []) {
        videoStatsCache.set(item.id, {
          durationSeconds: parseIsoDuration(item.contentDetails?.duration),
          viewCount: item.statistics?.viewCount != null ? Number(item.statistics.viewCount) : null
        });
      }
    } catch (err) {
      console.warn("動画の再生時間・再生数の取得に失敗しました:", err);
    }
  }
  const result = new Map();
  for (const id of videoIds) {
    if (videoStatsCache.has(id)) result.set(id, videoStatsCache.get(id));
  }
  return result;
}

// videosの配列に対し、取得済みの再生時間・再生数をまとめて付与する（該当なしは何もしない）。
async function attachVideoStats(videos) {
  if (!state.showVideoStats || !videos.length) return;
  const statsMap = await fetchVideoStatsBatch(videos.map((v) => v.videoId));
  for (const v of videos) {
    const stats = statsMap.get(v.videoId);
    if (stats) {
      v.durationSeconds = stats.durationSeconds;
      v.viewCount = stats.viewCount;
    }
  }
}

// ---------- 動画カード描画 ----------

// options.showWatchToggle: trueの場合、動画ごとに「視聴済みにする／未視聴に戻す」ボタンを表示する。
// options.onToggle: そのボタンを押した直後に呼ばれるコールバック（再描画用）。
function renderVideoCard(video, options = {}) {
  const card = document.createElement("div");
  card.className = "video-card";
  const watched = isWatched(video.videoId);
  if (watched) card.classList.add("is-watched");
  const showDuration = state.showVideoStats && video.durationSeconds != null;
  const showViews = state.showVideoStats && video.viewCount != null;
  card.innerHTML = `
    <div class="thumb-wrap">
      <img src="${video.thumbnail || ""}" alt="" loading="lazy" />
      ${watched ? `<span class="watched-badge">視聴済み</span>` : ""}
      ${showDuration ? `<span class="duration-badge">${formatDuration(video.durationSeconds)}</span>` : ""}
    </div>
    <div class="meta">
      <div class="title">${escapeHtml(video.title)}</div>
      <div class="channel">${escapeHtml(video.channelTitle || "")}</div>
      ${showViews ? `<div class="stats">${formatViewCount(video.viewCount)}</div>` : ""}
    </div>
  `;
  card.addEventListener("click", () => playVideo(video.videoId));

  if (options.showWatchToggle) {
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "watch-toggle-btn";
    toggleBtn.textContent = watched ? "未視聴に戻す" : "視聴済みにする";
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isWatched(video.videoId)) {
        unmarkWatched(video.videoId);
      } else {
        markWatched(video.videoId);
      }
      if (options.onToggle) options.onToggle();
    });
    card.querySelector(".meta").appendChild(toggleBtn);
  }

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderGrid(containerId, videos, emptyMessage, options = {}) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  if (!videos.length) {
    el.innerHTML = `<p class="empty">${emptyMessage}</p>`;
    return;
  }
  videos.forEach((v) => el.appendChild(renderVideoCard(v, options)));
}

// ---------- IFrame Player ----------

function ensureIframeApiLoaded() {
  if (window.YT && window.YT.Player) {
    ytApiReady = true;
    return;
  }
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
  };
}

function waitForYtApi() {
  return new Promise((resolve) => {
    if (ytApiReady) return resolve();
    const iv = setInterval(() => {
      if (ytApiReady) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
}

async function playVideo(videoId) {
  // 埋め込み可否の確認（キャッシュがあれば節約）
  if (!embeddableCache.has(videoId)) {
    try {
      await fetchVideoMeta(videoId);
    } catch (e) {
      console.warn(e);
    }
  }
  if (embeddableCache.get(videoId) === false) {
    alert("この動画は投稿者により埋め込み再生が許可されていません。通常のYouTubeで開きます。");
    window.open(`https://www.youtube.com/watch?v=${videoId}`, "_blank", "noopener");
    return;
  }

  document.getElementById("player-section").hidden = false;
  document.getElementById("player-section").scrollIntoView({ behavior: "smooth" });

  ensureIframeApiLoaded();
  await waitForYtApi();

  const playerVars = {
    rel: 0, // 関連動画は同一チャンネルのみに限定（YouTube仕様）
    modestbranding: 1,
    playsinline: 1,
    autoplay: 1,
    cc_load_policy: 0
  };

  currentPlayingVideoId = videoId;

  if (ytPlayer) {
    ytPlayer.loadVideoById(videoId);
  } else {
    ytPlayer = new YT.Player("player", {
      videoId,
      // widthとheightを明示的に指定しないとiframeがデフォルトの固定px値(640x390)で
      // 生成され、CSS側のwidth:100%指定への依存だけではブラウザによって反映が
      // 不安定になることがあるため、ここでも"100%"を明示してタブ幅に追従させる。
      width: "100%",
      height: "100%",
      playerVars,
      host: "https://www.youtube-nocookie.com",
      events: {
        onStateChange: handlePlayerStateChange
      }
    });
  }
}

// ---------- 視聴の自動検知 ----------
// ダッシュボード内のIFrameプレイヤーで再生した動画のみが対象（埋め込み不可で
// 通常のYouTubeが新しいタブで開かれた場合などは検知できないため、動画カードの
// 「視聴済みにする」ボタンで手動でも記録できるようにしている）。

function clearWatchProgressTimer() {
  if (watchProgressTimer) {
    clearInterval(watchProgressTimer);
    watchProgressTimer = null;
  }
}

function markWatchedAndRefresh(videoId) {
  if (isWatched(videoId)) return;
  markWatched(videoId);
  renderChannelsFeed(); // 視聴済みになった動画を「登録チャンネルの新着」から自動で非表示にする
}

function handlePlayerStateChange(event) {
  if (!window.YT) return;
  if (event.data === YT.PlayerState.ENDED) {
    clearWatchProgressTimer();
    if (currentPlayingVideoId) markWatchedAndRefresh(currentPlayingVideoId);
  } else if (event.data === YT.PlayerState.PLAYING) {
    clearWatchProgressTimer();
    // 最後まで見ずに閉じた場合にも対応できるよう、再生中は定期的に進捗を確認し、
    // WATCH_COMPLETE_RATIO（90%）を超えた時点で視聴済みとして記録する。
    watchProgressTimer = setInterval(() => {
      if (!ytPlayer || !currentPlayingVideoId) return;
      try {
        const duration = ytPlayer.getDuration();
        const current = ytPlayer.getCurrentTime();
        const ratio = (state.watchCompletePercent || DEFAULT_WATCH_COMPLETE_PERCENT) / 100;
        if (duration > 0 && current / duration >= ratio) {
          markWatchedAndRefresh(currentPlayingVideoId);
          clearWatchProgressTimer();
        }
      } catch (e) {
        // プレイヤーの状態取得に失敗した場合は無視して次回に回す
      }
    }, 5000);
  }
}

document.getElementById("player-close").addEventListener("click", () => {
  if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  clearWatchProgressTimer();
  currentPlayingVideoId = null;
  document.getElementById("player-section").hidden = true;
});

// ---------- 登録チャンネルの新着 ----------

// 各チャンネルのプレイリスト取得結果（最大50件）をセッション内でキャッシュし、
// 視聴済みトグルや「視聴済みも表示」チェックボックスの切り替えではAPIを呼び直さない。
async function getChannelVideos(ch) {
  if (channelVideosCache.has(ch.id)) return channelVideosCache.get(ch.id);
  const videos = await fetchPlaylistLatest(ch.uploadsPlaylistId, PLAYLIST_FETCH_SIZE);
  channelVideosCache.set(ch.id, videos);
  return videos;
}

async function renderChannelsFeed() {
  const container = document.getElementById("channels-container");
  const feedChannels = state.channels.filter((c) => c.showInFeed !== false);
  if (!feedChannels.length) {
    container.innerHTML = `<p class="empty">設定でチャンネルを登録してください（「登録チャンネル一覧に表示」がオフのチャンネルはここには表示されません）。</p>`;
    return;
  }
  if (!state.apiKey) {
    container.innerHTML = `<p class="empty">設定でAPIキーを入力してください。</p>`;
    return;
  }

  container.innerHTML = `<p class="empty">読み込み中...</p>`;

  // 「表示する動画があるチャンネルを上、ないチャンネルを下にまとめる」ためには、
  // 各チャンネルの表示対象動画が確定してから描画順を決める必要があるので、
  // 先に全チャンネル分を並行して取得し、そろった時点でまとめて描画する
  // （1件ずつ届いた順に追加すると、動画の有無が確定する前に並び順が決まってしまうため）。
  const results = await Promise.all(
    feedChannels.map(async (ch) => {
      try {
        const videos = await getChannelVideos(ch);
        const byDays = filterByDays(videos, ch.daysLimit);
        const visible = showWatchedVideos ? byDays : byDays.filter((v) => !isWatched(v.videoId));
        // 未視聴を上へ、視聴済みを下へ。それぞれのグループ内の順序（公開日等）は変えない
        // 安定ソートなので、視聴済みフラグだけを比較キーにすれば元の順序が保たれる。
        const ordered = [...visible].sort((a, b) => (isWatched(a.videoId) ? 1 : 0) - (isWatched(b.videoId) ? 1 : 0));
        const limited = ordered.slice(0, ch.videoCount || DEFAULT_CHANNEL_VIDEO_COUNT);
        const emptyMessage = ch.daysLimit
          ? `直近${ch.daysLimit}日以内の新着動画はありません。`
          : "新着動画がありません。";
        return { ch, limited, emptyMessage, error: null };
      } catch (err) {
        return { ch, limited: [], emptyMessage: null, error: err };
      }
    })
  );

  // 表示する動画が1件以上あるチャンネルを上、0件（エラーで取得できなかった場合も含む）の
  // チャンネルを下にまとめる。安定ソートなので、各グループ内では元の並び順
  // （設定パネルでの手動の並び順）を維持する。
  const ordered = [...results].sort((a, b) => (a.limited.length > 0 ? 0 : 1) - (b.limited.length > 0 ? 0 : 1));

  // 再生時間・再生数（設定でオンの場合のみ）：全チャンネル分の表示対象動画IDを
  // まとめて渡すことで、videos.listの呼び出し回数を最小限に抑える。
  await attachVideoStats(ordered.flatMap((r) => r.limited));

  container.innerHTML = "";
  for (const { ch, limited, emptyMessage, error } of ordered) {
    const block = document.createElement("div");
    block.className = "channel-block";
    block.innerHTML = `<h3>${escapeHtml(ch.title)}</h3><div class="grid" id="chgrid-${ch.id}"></div>`;
    container.appendChild(block);

    // このチャンネルのブロック幅を「動画本数に応じた自然な幅」にするため、
    // 1行あたりの枚数（最大MAX_CHANNEL_CARDS_PER_ROW枚）ぶんだけ固定幅の列を
    // インラインで指定する（.gridクラス既定のauto-fillを上書き）。これにより
    // 動画が少ないチャンネルは幅が狭く、多いチャンネルは最大幅×複数行になり、
    // #channels-container側のflex-wrapで横方向に詰めて並ぶ。
    const cardsPerRow = Math.max(1, Math.min(limited.length, MAX_CHANNEL_CARDS_PER_ROW));
    const chGridEl = document.getElementById(`chgrid-${ch.id}`);
    chGridEl.style.gridTemplateColumns = `repeat(${cardsPerRow}, 220px)`;

    if (error) {
      chGridEl.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    } else {
      renderGrid(`chgrid-${ch.id}`, limited, emptyMessage, {
        showWatchToggle: true,
        onToggle: renderChannelsFeed
      });
    }
  }
}

document.getElementById("show-watched-toggle").addEventListener("change", (e) => {
  showWatchedVideos = e.target.checked;
  renderChannelsFeed(); // キャッシュ済みのデータを使うのでAPIは呼ばれない
});

// ---------- 今日のニュース（リロードのたびに自動取得。手動更新ボタンでも再取得可） ----------
// playlistItems.listは1回1ユニットと軽量なため（channels.list/videos.listも同様）、
// 日次キャッシュはやめてリロード毎・手動更新ボタン押下ごとに取得し直す仕様にしている。
// ニュース対象チャンネル数が多いほど呼び出し回数は増えるが、それでもクォータへの
// 影響は小さい（検索バー機能は削除済みで、高コストなsearch.list(100ユニット/回)は未使用）。

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function renderDailyNews() {
  const grid = document.getElementById("news-grid");
  const newsChannels = state.channels.filter((c) => c.isNews);
  const refreshBtn = document.getElementById("news-refresh-btn");

  if (!state.apiKey || !newsChannels.length) {
    grid.innerHTML = `<p class="empty">設定でAPIキーとニュース対象チャンネル（チェックボックス）を登録してください。</p>`;
    return;
  }

  if (isFetchingNews) return; // 更新ボタン連打や複数箇所からの同時呼び出しを防ぐ
  isFetchingNews = true;
  if (refreshBtn) refreshBtn.disabled = true;
  grid.innerHTML = `<p class="empty">本日分のニュースを取得中...</p>`;
  try {
    const pooled = [];
    for (const ch of newsChannels) {
      const videos = await fetchPlaylistLatest(ch.uploadsPlaylistId, 5);
      pooled.push(...videos);
    }
    const picked = shuffle(pooled).slice(0, state.newsCount || 3);
    // 再生時間・再生数（設定でオンの場合のみ）：最終的に表示する件数分だけまとめて取得する。
    await attachVideoStats(picked);
    renderGrid("news-grid", picked, "本日分のニュースはありません。");
  } catch (err) {
    grid.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  } finally {
    isFetchingNews = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

document.getElementById("news-refresh-btn").addEventListener("click", () => {
  renderDailyNews();
});

// ---------- お気に入り動画 ----------

function renderFavoritesGrid() {
  renderGrid(
    "favorites-grid",
    state.favorites,
    "設定でお気に入り動画を登録してください。"
  );
}

// ---------- 設定パネル／チャンネル管理パネル（右からスライドする扉式） ----------
// スクロール位置に関係なく開けるよう、どちらもposition:fixedのドロワーとして実装している
// （パネル自体はDOMに常時存在し、CSSのtransformで画面外に出し入れする）。
// 登録チャンネルが増えると設定パネルが長大になるため、チャンネルの追加・一覧・並べ替えは
// 「チャンネル管理」として設定から分離し、ヘッダーの専用ボタンから開く別の扉にしている。

// 設定パネル・チャンネル管理パネル・初回チュートリアルのうち、いずれか1つでも開いていれば
// 背面スクロールを止める（複数の扉の開閉が絡んでも、状態を毎回まとめて判定するので崩れない）。
function updateBodyScrollLock() {
  const anyOpen = isSettingsOpen() || isChannelsOpen() || isOnboardingOpen();
  document.body.classList.toggle("settings-open", anyOpen);
}

function openSettings() {
  if (isChannelsOpen()) closeChannels();
  document.getElementById("settings-panel").classList.add("open");
  document.getElementById("settings-backdrop").hidden = false;
  updateBodyScrollLock();
}

function closeSettings() {
  document.getElementById("settings-panel").classList.remove("open");
  document.getElementById("settings-backdrop").hidden = true;
  updateBodyScrollLock();
}

function isSettingsOpen() {
  return document.getElementById("settings-panel").classList.contains("open");
}

document.getElementById("settings-toggle").addEventListener("click", () => {
  if (isSettingsOpen()) {
    closeSettings();
  } else {
    openSettings();
  }
});

document.getElementById("settings-close").addEventListener("click", closeSettings);
document.getElementById("settings-backdrop").addEventListener("click", closeSettings);

// チャンネル管理パネルを閉じたら、検索結果（チャンネル名検索でヒットした候補カード）を
// 破棄する。登録チャンネル数が増えても検索結果が残り続けて長大化することがないように、
// 開き直すたびに入力欄・検出バッジ・検索結果をまっさらな状態に戻す。
function clearChannelSearchState() {
  const resultsEl = document.getElementById("channel-search-results");
  if (resultsEl) resultsEl.innerHTML = "";
  channelAddButtonRegistry.clear();
  const input = document.getElementById("channel-add-input");
  if (input) input.value = "";
  updateChannelDetectUI("", channelAddUiRefs);
}

async function openChannels() {
  if (isSettingsOpen()) closeSettings();
  document.getElementById("channels-panel").classList.add("open");
  document.getElementById("channels-backdrop").hidden = false;
  updateBodyScrollLock();
  renderChannelManageList();
  // アイコン未取得のチャンネルがあれば、まとめて1回のAPI呼び出しで補完してから再描画する
  // （取得済みなら何もしない。開くたびに毎回APIを叩くわけではない）。
  const updated = await backfillChannelThumbnails();
  if (updated) renderChannelManageList();
}

function closeChannels() {
  document.getElementById("channels-panel").classList.remove("open");
  document.getElementById("channels-backdrop").hidden = true;
  updateBodyScrollLock();
  clearChannelSearchState();
}

function isChannelsOpen() {
  return document.getElementById("channels-panel").classList.contains("open");
}

document.getElementById("channels-toggle").addEventListener("click", () => {
  if (isChannelsOpen()) {
    closeChannels();
  } else {
    openChannels();
  }
});

document.getElementById("channels-close").addEventListener("click", closeChannels);
document.getElementById("channels-backdrop").addEventListener("click", closeChannels);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isOnboardingOpen()) {
    closeOnboarding();
  } else if (isChannelsOpen()) {
    closeChannels();
  } else if (isSettingsOpen()) {
    closeSettings();
  }
});

function renderSettingsForm() {
  document.getElementById("api-key-input").value = state.apiKey;
  document.getElementById("news-count-input").value = state.newsCount;
  document.getElementById("watch-ratio-input").value = state.watchCompletePercent ?? DEFAULT_WATCH_COMPLETE_PERCENT;
  document.getElementById("video-stats-toggle").checked = state.showVideoStats !== false;
  renderFavoriteManageList();
}

document.getElementById("api-key-input").addEventListener("change", (e) => {
  state.apiKey = e.target.value.trim();
  saveState();
  refreshAll();
});

// 一度閉じた初回チュートリアルを、設定パネルからいつでも見返せるようにするボタン。
// openOnboarding()は後方（初回オンボーディングのセクション）で定義しているが、
// 関数宣言は巻き上げられるため、記述順に関係なくここから呼び出せる。
document.getElementById("onboarding-reopen-btn").addEventListener("click", () => {
  closeSettings();
  openOnboarding();
});

document.getElementById("news-count-input").addEventListener("change", (e) => {
  state.newsCount = Math.max(1, Math.min(10, Number(e.target.value) || 3));
  saveState();
});

document.getElementById("watch-ratio-input").addEventListener("change", (e) => {
  const v = Math.max(1, Math.min(100, Math.round(Number(e.target.value)) || DEFAULT_WATCH_COMPLETE_PERCENT));
  state.watchCompletePercent = v;
  e.target.value = v;
  saveState();
});

document.getElementById("video-stats-toggle").addEventListener("change", (e) => {
  state.showVideoStats = e.target.checked;
  saveState();
  // オン/オフどちらの場合も表示を更新する（オンにした場合はここでvideos.listが呼ばれる）。
  refreshAll();
});

// 表示順（= state.channels の並び順）を入れ替える。
// idx±1が範囲外なら何もしない。
function moveChannel(idx, delta) {
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= state.channels.length) return;
  const arr = state.channels;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  saveState();
  renderChannelManageList();
  renderChannelsFeed();
}

// ドラッグ＆ドロップでの並べ替え：ハンドル（⠿）をドラッグして、
// ドロップ先の<li>の位置に挿入する。
function handleChannelDrop(fromIdx, toIdx) {
  if (Number.isNaN(fromIdx) || fromIdx === toIdx) return;
  const arr = state.channels;
  const [moved] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, moved);
  saveState();
  renderChannelManageList();
  renderChannelsFeed();
}

function renderChannelManageList() {
  const ul = document.getElementById("channel-list");
  ul.innerHTML = "";
  state.channels.forEach((ch, idx) => {
    const li = document.createElement("li");
    li.className = "channel-manage-item";
    const tags = [
      ch.isNews ? "ニュース対象" : null,
      ch.showInFeed === false ? "一覧非表示" : null
    ].filter(Boolean);

    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      li.classList.add("drag-over");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("drag-over");
      const fromIdx = Number(e.dataTransfer.getData("text/plain"));
      handleChannelDrop(fromIdx, idx);
    });

    const row = document.createElement("div");
    row.className = "channel-manage-row";

    const titleWrap = document.createElement("div");
    titleWrap.className = "channel-manage-title-wrap";
    const dragHandle = document.createElement("span");
    dragHandle.className = "drag-handle";
    dragHandle.textContent = "⠿";
    dragHandle.title = "ドラッグして並べ替え";
    dragHandle.draggable = true;
    dragHandle.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
      li.classList.add("dragging");
    });
    dragHandle.addEventListener("dragend", () => li.classList.remove("dragging"));

    // チャンネルアイコン（登録時に取得済み、または後述のbackfillChannelThumbnails()で
    // 取得したサムネイルを表示。取得できていない場合は頭文字のフォールバック表示にする）。
    const avatar = document.createElement("div");
    avatar.className = "avatar-thumb channel-avatar";
    if (ch.thumbnail) {
      const img = document.createElement("img");
      img.src = ch.thumbnail;
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        avatar.textContent = (ch.title[0] || "?").toUpperCase();
        avatar.classList.add("avatar-fallback");
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (ch.title[0] || "?").toUpperCase();
      avatar.classList.add("avatar-fallback");
    }

    const titleText = document.createElement("span");
    titleText.className = "channel-title-text";
    titleText.innerHTML = `${escapeHtml(ch.title)}${tags.length ? `（${tags.join("・")}）` : ""}`;
    titleWrap.appendChild(dragHandle);
    titleWrap.appendChild(avatar);
    titleWrap.appendChild(titleText);
    row.appendChild(titleWrap);

    // 表示件数・直近n日以内は、行を圧縮するためチャンネル名の隣にコンパクトに並べて表示する
    // （以前は行を分けて表示していた）。
    const inlineControls = document.createElement("div");
    inlineControls.className = "channel-manage-controls-inline";
    inlineControls.innerHTML = `
      <label class="number-inline compact" title="登録チャンネルの新着に並べる最大本数">件数
        <input type="number" class="ch-count-input" min="1" max="${MAX_CHANNEL_VIDEO_COUNT}"
          value="${ch.videoCount ?? DEFAULT_CHANNEL_VIDEO_COUNT}" />
      </label>
      <label class="number-inline compact" title="公開からn日を超えた動画を除外（空欄なら制限なし）">直近
        <input type="number" class="ch-days-input" min="0" placeholder="制限なし"
          value="${ch.daysLimit ?? ""}" />日
      </label>
    `;
    const countInput = inlineControls.querySelector(".ch-count-input");
    countInput.addEventListener("change", (e) => {
      const v = Math.max(1, Math.min(MAX_CHANNEL_VIDEO_COUNT, Math.round(Number(e.target.value)) || DEFAULT_CHANNEL_VIDEO_COUNT));
      ch.videoCount = v;
      e.target.value = v;
      saveState();
      renderChannelsFeed();
    });
    const daysInput = inlineControls.querySelector(".ch-days-input");
    daysInput.addEventListener("change", (e) => {
      const raw = e.target.value.trim();
      let v = raw === "" ? null : Math.max(0, Math.round(Number(raw)));
      if (v !== null && Number.isNaN(v)) v = null;
      ch.daysLimit = v;
      e.target.value = v ?? "";
      saveState();
      renderChannelsFeed();
    });
    row.appendChild(inlineControls);

    const actions = document.createElement("div");
    actions.className = "channel-manage-actions";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "move-btn";
    upBtn.textContent = "↑";
    upBtn.title = "表示順を上へ";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => moveChannel(idx, -1));

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "move-btn";
    downBtn.textContent = "↓";
    downBtn.title = "表示順を下へ";
    downBtn.disabled = idx === state.channels.length - 1;
    downBtn.addEventListener("click", () => moveChannel(idx, 1));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "delete-btn";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => {
      const removedId = ch.id;
      state.channels = state.channels.filter((c) => c.id !== ch.id);
      saveState();
      resetSearchResultButton(removedId);
      renderChannelManageList();
      refreshAll();
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);

    li.appendChild(row);
    ul.appendChild(li);
  });
}

// 登録チャンネルのアイコンを表示するための下準備。thumbnailをまだ持っていないチャンネル
// （このアイコン表示機能を実装する前から登録されていたチャンネルなど）だけをまとめて
// channels.listで取得する。IDをカンマ区切りで渡せば件数に関わらず1回の呼び出し＝1ユニット
// で済む（50件を超える場合のみ50件ごとに分割し、その場合も1チャンクにつき1ユニット）。
// 一度取得できたthumbnailはstateに保存されるため、この処理は基本的に初回のみ発生する。
async function backfillChannelThumbnails() {
  const missing = state.channels.filter((c) => !c.thumbnail);
  if (!missing.length || !state.apiKey) return false;
  let updated = false;
  try {
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const data = await apiGet("channels", { part: "snippet", id: chunk.map((c) => c.id).join(",") }, 1);
      const byId = new Map((data.items || []).map((it) => [it.id, it]));
      chunk.forEach((c) => {
        const item = byId.get(c.id);
        const url =
          item &&
          ((item.snippet.thumbnails && (item.snippet.thumbnails.default || item.snippet.thumbnails.medium)) || {})
            .url;
        if (url) {
          c.thumbnail = url;
          updated = true;
        }
      });
    }
    if (updated) saveState();
  } catch (err) {
    // アイコン取得に失敗しても一覧自体は表示できるよう、エラーは無視して
    // 頭文字のフォールバック表示に任せる。
  }
  return updated;
}

// 設定パネル「登録チャンネル」欄：入力欄1本化＋自動判定（B案）。
// URL・@ハンドル・チャンネルIDならそのまま直接追加、チャンネル名らしき文字列なら
// 「検索」ボタンとして振る舞い、search.listで検索して候補から選んで追加する。
const channelAddButtonRegistry = new Map();
searchResultButtonRegistries.push(channelAddButtonRegistry);

const channelAddUiRefs = {
  hintEl: document.getElementById("channel-detect-hint"),
  tagEl: document.getElementById("channel-detect-tag"),
  textEl: document.getElementById("channel-detect-text"),
  submitBtn: document.getElementById("channel-add-submit"),
  optionsEl: document.getElementById("channel-add-options")
};
document.getElementById("channel-add-input").addEventListener("input", (e) => {
  updateChannelDetectUI(e.target.value, channelAddUiRefs);
});
updateChannelDetectUI("", channelAddUiRefs);

document.getElementById("channel-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("channel-add-input");
  const raw = input.value.trim();
  if (!raw) return;
  const mode = detectChannelInputMode(raw);
  const resultsEl = document.getElementById("channel-search-results");

  if (mode === "search") {
    resultsEl.classList.add("loading");
    resultsEl.textContent = "検索中…";
    try {
      const results = await searchChannels(raw);
      resultsEl.classList.remove("loading");
      renderChannelSearchResults(resultsEl, channelAddButtonRegistry, results);
    } catch (err) {
      resultsEl.classList.remove("loading");
      resultsEl.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    }
    return;
  }

  const isNews = document.getElementById("channel-add-news").checked;
  const showInFeed = document.getElementById("channel-add-show-in-feed").checked;
  const countInput = document.getElementById("channel-add-count");
  const daysInput = document.getElementById("channel-add-days");
  const videoCount = Math.max(
    1,
    Math.min(MAX_CHANNEL_VIDEO_COUNT, Math.round(Number(countInput.value)) || DEFAULT_CHANNEL_VIDEO_COUNT)
  );
  const daysRaw = daysInput.value.trim();
  let daysLimit = daysRaw === "" ? null : Math.max(0, Math.round(Number(daysRaw)));
  if (daysLimit !== null && Number.isNaN(daysLimit)) daysLimit = null;
  try {
    const ch = await resolveChannel(raw);
    if (state.channels.some((c) => c.id === ch.id)) {
      alert("すでに登録済みのチャンネルです。");
      return;
    }
    state.channels.push({ ...ch, isNews, showInFeed, videoCount, daysLimit });
    saveState();
    input.value = "";
    document.getElementById("channel-add-news").checked = false;
    document.getElementById("channel-add-show-in-feed").checked = true;
    countInput.value = DEFAULT_CHANNEL_VIDEO_COUNT;
    daysInput.value = "";
    resultsEl.innerHTML = "";
    updateChannelDetectUI("", channelAddUiRefs);
    renderChannelManageList();
    refreshAll();
  } catch (err) {
    alert(err.message);
  }
});

function renderFavoriteManageList() {
  const ul = document.getElementById("favorite-manage-list");
  ul.innerHTML = "";
  state.favorites.forEach((v) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(v.title)}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "削除";
    btn.addEventListener("click", () => {
      state.favorites = state.favorites.filter((f) => f.videoId !== v.videoId);
      saveState();
      renderFavoriteManageList();
      renderFavoritesGrid();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

document.getElementById("favorite-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("favorite-add-input");
  const raw = input.value.trim();
  if (!raw) return;
  try {
    const videoId = parseVideoInput(raw);
    if (state.favorites.some((f) => f.videoId === videoId)) {
      alert("すでに登録済みの動画です。");
      return;
    }
    const meta = await fetchVideoMeta(videoId);
    state.favorites.push(meta);
    saveState();
    input.value = "";
    renderFavoriteManageList();
    renderFavoritesGrid();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 初回オンボーディング（チュートリアル） ----------
// APIキーが未設定 かつ まだこのガイドを閉じたことがない「初回アクセス」時にだけ、
// 「①APIキー取得 → ②貼り付け → ③チャンネル登録」の3ステップガイドを自動表示する。
// スキップ／はじめる／✕のいずれで閉じても state.onboardingDismissed を保存し、
// 以後は自動表示しない（設定パネルの「APIキー未設定なら自動的に開く」既存動作に代わって、
// 初回だけはこちらを優先する）。
// もう一度チュートリアルを見たい場合は、ブラウザの開発者ツールで
// localStorageの yth_state_v1 内の onboardingDismissed を false に書き換えるか、
// 設定をすべてクリアしてください（現時点では再表示ボタンは未実装）。

let onboardStep = 1;
const ONBOARD_STEP_TITLES = {
  1: "YouTube Hub へようこそ",
  2: "APIキーを貼り付けましょう",
  3: "チャンネルを登録しましょう"
};

function isOnboardingOpen() {
  return !document.getElementById("onboarding-panel").hidden;
}

function openOnboarding() {
  onboardStep = 1;
  document.getElementById("onboarding-backdrop").hidden = false;
  document.getElementById("onboarding-panel").hidden = false;
  updateBodyScrollLock(); // 背面スクロール停止は設定パネル・チャンネル管理パネルと同じ仕組みを流用
  renderOnboardingStep();
}

// dismiss=falseは将来的な「あとで見る」用の予備（現状は常にtrueで呼ぶ）。
function closeOnboarding({ dismiss = true } = {}) {
  document.getElementById("onboarding-backdrop").hidden = true;
  document.getElementById("onboarding-panel").hidden = true;
  updateBodyScrollLock();
  if (dismiss && !state.onboardingDismissed) {
    state.onboardingDismissed = true;
    saveState();
  }
}

function renderOnboardingStep() {
  for (let n = 1; n <= 3; n++) {
    document.getElementById(`onboard-step-${n}`).hidden = n !== onboardStep;
    const dot = document.getElementById(`onboard-dot-${n}`);
    dot.classList.toggle("active", n === onboardStep);
    dot.classList.toggle("done", n < onboardStep);
  }
  document.getElementById("onboard-step-title").textContent = ONBOARD_STEP_TITLES[onboardStep];
  document.getElementById("onboard-back").disabled = onboardStep === 1;
  document.getElementById("onboard-next").textContent = onboardStep === 3 ? "はじめる" : "次へ";
  if (onboardStep === 2) {
    document.getElementById("onboard-api-key-input").value = state.apiKey;
  }
}

document.getElementById("onboard-next").addEventListener("click", () => {
  // ステップ2→3に進むタイミングで、貼り付けられたAPIキーを本体の設定へ反映する
  // （空欄のまま進んだ場合は変更しない＝後で設定パネルから入力できる）。
  if (onboardStep === 2) {
    const key = document.getElementById("onboard-api-key-input").value.trim();
    if (key) {
      state.apiKey = key;
      saveState();
      document.getElementById("api-key-input").value = key; // 設定パネル側の表示も同期
    }
  }
  if (onboardStep < 3) {
    onboardStep++;
    renderOnboardingStep();
  } else {
    closeOnboarding();
    refreshAll();
  }
});

document.getElementById("onboard-back").addEventListener("click", () => {
  if (onboardStep > 1) {
    onboardStep--;
    renderOnboardingStep();
  }
});

document.getElementById("onboard-skip").addEventListener("click", () => {
  closeOnboarding();
  if (!state.apiKey) openSettings();
});

document.getElementById("onboard-close").addEventListener("click", () => {
  closeOnboarding();
  if (!state.apiKey) openSettings();
});

document.getElementById("onboarding-backdrop").addEventListener("click", () => {
  closeOnboarding();
  if (!state.apiKey) openSettings();
});

// ステップ3：チャンネル登録。設定パネルの「登録チャンネル」欄と同じ入力欄1本化＋自動判定
// （B案）を使う。ニュース対象・表示件数などのオプションはここでは表示せず、既定値のまま
// 登録する（細かい設定は後から設定パネルの「登録チャンネル」欄で変更できる）。
const onboardChannelButtonRegistry = new Map();
searchResultButtonRegistries.push(onboardChannelButtonRegistry);

const onboardChannelUiRefs = {
  hintEl: document.getElementById("onboard-channel-detect-hint"),
  tagEl: document.getElementById("onboard-channel-detect-tag"),
  textEl: document.getElementById("onboard-channel-detect-text"),
  submitBtn: document.getElementById("onboard-channel-submit")
};
document.getElementById("onboard-channel-input").addEventListener("input", (e) => {
  updateChannelDetectUI(e.target.value, onboardChannelUiRefs);
});
updateChannelDetectUI("", onboardChannelUiRefs);

document.getElementById("onboard-channel-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("onboard-channel-input");
  const status = document.getElementById("onboard-channel-status");
  const raw = input.value.trim();
  if (!raw) return;
  const mode = detectChannelInputMode(raw);
  const resultsEl = document.getElementById("onboard-channel-search-results");

  if (mode === "search") {
    status.textContent = "";
    resultsEl.classList.add("loading");
    resultsEl.textContent = "検索中…";
    try {
      const results = await searchChannels(raw);
      resultsEl.classList.remove("loading");
      renderChannelSearchResults(resultsEl, onboardChannelButtonRegistry, results, () => {
        status.textContent = "登録しました。続けて他のチャンネルも追加できます。";
      });
    } catch (err) {
      resultsEl.classList.remove("loading");
      resultsEl.innerHTML = "";
      status.textContent = err.message;
    }
    return;
  }

  status.textContent = "検索中…";
  try {
    const ch = await resolveChannel(raw);
    if (state.channels.some((c) => c.id === ch.id)) {
      status.textContent = `「${ch.title}」はすでに登録済みです。`;
      return;
    }
    state.channels.push({
      ...ch,
      isNews: false,
      showInFeed: true,
      videoCount: DEFAULT_CHANNEL_VIDEO_COUNT,
      daysLimit: null
    });
    saveState();
    input.value = "";
    status.textContent = `「${ch.title}」を登録しました。続けて他のチャンネルも追加できます。`;
    resultsEl.innerHTML = "";
    updateChannelDetectUI("", onboardChannelUiRefs);
    renderChannelManageList();
  } catch (err) {
    status.textContent = err.message;
  }
});

// ---------- 初期化 ----------

function refreshAll() {
  renderChannelsFeed();
  renderDailyNews();
  renderFavoritesGrid();
}

function init() {
  renderQuotaBadge();
  renderSettingsForm();
  renderChannelManageList();
  refreshAll();
  if (!state.apiKey && !state.onboardingDismissed) {
    openOnboarding();
  } else if (!state.apiKey) {
    openSettings();
  }
}

document.addEventListener("DOMContentLoaded", init);
