/**
 * YTM Playlist Mixer (GAS Web App)
 * - Mix 2 playlists A/B by ratio with startWith
 * - Priority head + every N NORMAL => enqueue FULL priority list, spread over next turns
 * - Picker API for UI (title + thumbnail)
 * - Cloud sync:
 *    - Settings (form + priority selections) via UserProperties
 *    - Playlist picker cache (items list) via UserProperties (cross-device)
 *
 * Cache optimization:
 *    - GAS CacheService (6h): videoIds from playlist A/B to avoid repeated YouTube API calls
 *    - LocalStorage (browser): picker items (title + thumbnail) for fast UI load
 *    - UserProperties (cloud): picker items sync across devices
 *    - Priority: GAS Cache > YouTube API
 *
 * Requirement: Enable Advanced Google Service: YouTube Data API
 */

const SETTINGS_KEY_ = "YTM_MIXER_SETTINGS_V1";
const PLAYLIST_CACHE_PREFIX_ = "YTM_MIXER_PL_CACHE_V1:";
const INSERT_DELAY_MS_ = 100;   // pause between playlist item insertions to avoid rate limiting
const RETRY_DELAY_MS_ = 1500;   // wait before retrying a failed insertion

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("YTM Playlist Mixer");
}

/** ---------- Cloud settings (multi-device) ---------- */

function saveUserSettings(payload) {
  const props = PropertiesService.getUserProperties();
  props.setProperty(SETTINGS_KEY_, JSON.stringify(payload || {}));
  return { ok: true, savedAt: new Date().toISOString() };
}

function loadUserSettings() {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(SETTINGS_KEY_);
  if (!raw) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: "Dữ liệu lưu bị lỗi JSON." };
  }
}

/**
 * Khôi phục danh sách ưu tiên A đã lưu (kể cả khi playlist A đã xoá).
 * Trả về videoId + title/thumb nếu còn trong cloud cache.
 */
function recoverPriorityAFromStorage() {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(SETTINGS_KEY_);
  if (!raw) {
    return { ok: false, error: "Không tìm thấy cấu hình đã lưu trong UserProperties." };
  }

  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "Cấu hình đã lưu bị lỗi JSON." };
  }

  const priorityAIds = Array.isArray(settings.priorityAIds)
    ? uniquePreserveOrder_(settings.priorityAIds.map(v => String(v || "").trim()).filter(Boolean))
    : [];

  const playlistAInput = String(settings.playlistA || "").trim();
  let playlistAKey = "";
  try { playlistAKey = playlistAInput ? normalizePlaylistId_(playlistAInput) : ""; } catch (e) {}

  const metaIndex = buildVideoMetaIndexFromCloudCache_(playlistAKey);
  const items = priorityAIds.map((videoId, idx) => {
    const meta = metaIndex[videoId] || {};
    return {
      order: idx + 1,
      videoId,
      title: meta.title || "",
      thumb: meta.thumb || "",
    };
  });

  return {
    ok: true,
    playlistAInput,
    playlistAKey,
    savedAt: settings.savedAt || "",
    count: items.length,
    items,
    note: "Nếu title trống thì chỉ còn videoId (cache tiêu đề không còn).",
  };
}

/**
 * Xuất nhanh danh sách ưu tiên A ra text để copy/paste.
 */
function recoverPriorityAAsText() {
  const res = recoverPriorityAFromStorage();
  if (!res.ok) return res;

  const lines = res.items.map(it => {
    const title = it.title ? ` - ${it.title}` : "";
    return `${it.videoId}${title}`;
  });

  return {
    ok: true,
    count: res.count,
    text: lines.join("\n"),
    items: res.items,
  };
}

/**
 * Chạy hàm này trong Apps Script để in danh sách ưu tiên A ra Logs.
 */
function logRecoveredPriorityA() {
  const res = recoverPriorityAAsText();
  if (!res.ok) {
    Logger.log("recoverPriorityAAsText error: %s", res.error || "unknown");
    return res;
  }
  Logger.log("Recovered Priority A count: %s", res.count);
  Logger.log("%s", res.text || "");
  return res;
}

/**
 * Debug tổng hợp: in cấu hình đã lưu + danh sách Priority A ra Logs.
 */
function debugDumpSavedStateAndPriorityA() {
  const settingsRes = loadUserSettings();
  Logger.log("loadUserSettings.ok = %s", settingsRes && settingsRes.ok);
  if (!settingsRes || !settingsRes.ok) {
    Logger.log("loadUserSettings.error = %s", settingsRes && settingsRes.error ? settingsRes.error : "unknown");
  } else if (!settingsRes.data) {
    Logger.log("Không có dữ liệu settings trong UserProperties.");
  } else {
    const s = settingsRes.data;
    Logger.log("savedAt = %s", s.savedAt || "");
    Logger.log("playlistA = %s", s.playlistA || "");
    Logger.log("priorityAIds.count = %s", Array.isArray(s.priorityAIds) ? s.priorityAIds.length : 0);
  }

  const recoverRes = recoverPriorityAAsText();
  Logger.log("recoverPriorityAAsText.ok = %s", recoverRes && recoverRes.ok);
  if (!recoverRes || !recoverRes.ok) {
    Logger.log("recoverPriorityAAsText.error = %s", recoverRes && recoverRes.error ? recoverRes.error : "unknown");
  } else {
    Logger.log("Recovered Priority A count: %s", recoverRes.count || 0);
    Logger.log("%s", recoverRes.text || "");
  }

  return { settingsRes, recoverRes };
}

/**
 * Fallback: nếu priorityAIds rỗng thì lấy toàn bộ item còn trong cloud cache của playlistA.
 */
function recoverPlaylistAItemsFromCacheFallback() {
  const settingsRes = loadUserSettings();
  if (!settingsRes || !settingsRes.ok || !settingsRes.data) {
    return { ok: false, error: "Không có settings để xác định playlistA." };
  }

  const playlistAInput = String(settingsRes.data.playlistA || "").trim();
  if (!playlistAInput) {
    return { ok: false, error: "settings không có playlistA." };
  }

  let playlistAKey = "";
  try {
    playlistAKey = normalizePlaylistId_(playlistAInput);
  } catch (e) {
    return { ok: false, error: "Không parse được playlistA từ settings." };
  }

  const key = PLAYLIST_CACHE_PREFIX_ + playlistAKey;
  const raw = PropertiesService.getUserProperties().getProperty(key);
  if (!raw) {
    return { ok: false, error: `Không còn cloud cache cho key: ${key}` };
  }

  try {
    const obj = JSON.parse(raw);
    const items = Array.isArray(obj.items) ? obj.items : [];
    const normalized = items
      .map((it, i) => ({
        order: i + 1,
        videoId: String((it && it.videoId) || "").trim(),
        title: String((it && it.title) || ""),
        thumb: String((it && it.thumb) || ""),
      }))
      .filter(it => !!it.videoId);

    return {
      ok: true,
      playlistAInput,
      playlistAKey,
      cacheFetchedAt: obj.fetchedAt || "",
      count: normalized.length,
      items: normalized,
      note: "Đây là toàn bộ item cache của playlistA, không phải riêng danh sách priority đã chọn.",
    };
  } catch (e) {
    return { ok: false, error: "Cloud cache bị lỗi JSON." };
  }
}

function logRecoverPlaylistAItemsFromCacheFallback() {
  const res = recoverPlaylistAItemsFromCacheFallback();
  Logger.log("recoverPlaylistAItemsFromCacheFallback.ok = %s", res && res.ok);
  if (!res || !res.ok) {
    Logger.log("recoverPlaylistAItemsFromCacheFallback.error = %s", res && res.error ? res.error : "unknown");
    return res;
  }

  Logger.log("playlistAKey = %s", res.playlistAKey || "");
  Logger.log("cacheFetchedAt = %s", res.cacheFetchedAt || "");
  Logger.log("cached items count = %s", res.count || 0);
  const text = (res.items || []).map(it => `${it.videoId}${it.title ? ` - ${it.title}` : ""}`).join("\n");
  Logger.log("%s", text);
  return res;
}

function buildVideoMetaIndexFromCloudCache_(playlistAKey) {
  const props = PropertiesService.getUserProperties();
  const all = props.getProperties() || {};

  const keys = Object.keys(all).filter(k => k.indexOf(PLAYLIST_CACHE_PREFIX_) === 0);
  const preferredKey = playlistAKey ? (PLAYLIST_CACHE_PREFIX_ + playlistAKey) : "";

  const orderedKeys = [];
  if (preferredKey && all[preferredKey]) orderedKeys.push(preferredKey);
  for (const k of keys) {
    if (k !== preferredKey) orderedKeys.push(k);
  }

  const index = {};
  for (const k of orderedKeys) {
    try {
      const obj = JSON.parse(all[k] || "{}");
      const arr = Array.isArray(obj.items) ? obj.items : [];
      for (const it of arr) {
        const videoId = String((it && it.videoId) || "").trim();
        if (!videoId || index[videoId]) continue;
        index[videoId] = {
          title: String((it && it.title) || ""),
          thumb: String((it && it.thumb) || ""),
        };
      }
    } catch (e) {
      // skip broken cache entry
    }
  }
  return index;
}

/** ---------- Cloud playlist picker cache (cross-device) ---------- */
// payload: { playlistKey: string, fetchedAt: string, items: [{videoId,title,thumb}] }
function savePlaylistCache(payload) {
  if (!payload || !payload.playlistKey) throw new Error("Thiếu playlistKey.");
  const key = PLAYLIST_CACHE_PREFIX_ + String(payload.playlistKey);
  const props = PropertiesService.getUserProperties();
  props.setProperty(key, JSON.stringify({
    playlistKey: String(payload.playlistKey),
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    items: Array.isArray(payload.items) ? payload.items : [],
  }));
  return { ok: true };
}

// params: { playlist: <link or id> }
function loadPlaylistCache(params) {
  if (!params || !params.playlist) throw new Error("Thiếu playlist.");
  const playlistKey = normalizePlaylistId_(params.playlist);
  const key = PLAYLIST_CACHE_PREFIX_ + playlistKey;
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(key);
  if (!raw) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: "Cache playlist bị lỗi JSON." };
  }
}

// params: { playlist: <link or id> }
function clearPlaylistCache(params) {
  if (!params || !params.playlist) throw new Error("Thiếu playlist.");
  const playlistKey = normalizePlaylistId_(params.playlist);
  const key = PLAYLIST_CACHE_PREFIX_ + playlistKey;
  PropertiesService.getUserProperties().deleteProperty(key);
  return { ok: true };
}

/**
 * For UI picker: returns playlist items with title + thumbnail + videoId
 */
function getPlaylistItemsForPicker(params) {
  if (!params) throw new Error("Thiếu params.");
  const playlistId = normalizePlaylistId_(params.playlist);
  const maxItems = clampInt_(params.maxItems, 1, 500);

  const items = [];
  let pageToken;

  try {
    do {
      const resp = YouTube.PlaylistItems.list("snippet,contentDetails", {
        playlistId,
        maxResults: 50,
        pageToken,
      });

      for (const it of (resp.items || [])) {
        const videoId = it.contentDetails && it.contentDetails.videoId;
        const sn = it.snippet || {};
        const title = sn.title || "";
        const thumbs = sn.thumbnails || {};
        const thumb =
          (thumbs.medium && thumbs.medium.url) ||
          (thumbs.default && thumbs.default.url) ||
          (thumbs.high && thumbs.high.url) ||
          "";

        if (!videoId) continue;
        if (title === "Private video" || title === "Deleted video") continue;

        items.push({ videoId, title, thumb });
        if (items.length >= maxItems) break;
      }

      pageToken = (resp.nextPageToken && items.length < maxItems) ? resp.nextPageToken : null;
    } while (pageToken);
  } catch (e) {
    throw new Error(formatPlaylistApiError_(e, playlistId));
  }

  return { playlistId, items };
}

function createMixedPlaylist(params) {
  if (!params) {
    throw new Error("Thiếu params. Hãy chạy qua Web App (mở URL triển khai), không chạy hàm này trong editor.");
  }

  const aId = normalizePlaylistId_(params.playlistA);
  const bId = normalizePlaylistId_(params.playlistB);

  const total = clampInt_(params.totalItems, 1, 500);
  const ratioA = clampInt_(params.ratioA, 0, 50);
  const ratioB = clampInt_(params.ratioB, 0, 50);
  if (ratioA === 0 && ratioB === 0) throw new Error("Tỷ lệ không hợp lệ (cả A và B đều = 0).");

  const start = (params.startWith === "B") ? "B" : "A";
  const pickModeA = (params.pickModeA === "ORDER") ? "ORDER" : "SHUFFLE";
  const pickModeB = (params.pickModeB === "ORDER") ? "ORDER" : "SHUFFLE";
  const privacy = ["PRIVATE", "UNLISTED", "PUBLIC"].includes(params.privacy) ? params.privacy : "PRIVATE";

  // treat only true/"true" as true
  const allowDuplicates = (params.allowDuplicates === true || params.allowDuplicates === "true");

  // Priority config
  const priorityEveryA = clampInt_(params.priorityEveryA, 0, 9999);
  const priorityEveryB = clampInt_(params.priorityEveryB, 0, 9999);

  const priorityHeadA = clampIntAllowMinusOne_(params.priorityHeadA, -1, 9999);
  const priorityHeadB = clampIntAllowMinusOne_(params.priorityHeadB, -1, 9999);

  let priorityA = normalizePriorityInput_(params.priorityA);
  let priorityB = normalizePriorityInput_(params.priorityB);

  const ts = formatNow_();
  const baseTitle = (params.title && String(params.title).trim()) ? String(params.title).trim() : "YTM Mix";
  const title = `${baseTitle} - ${ts}`;

  const aAll = getPlaylistVideoIds_(aId);
  const bAll = getPlaylistVideoIds_(bId);
  if (!aAll.length) throw new Error("Playlist A không có bài nào (hoặc không đọc được).");
  if (!bAll.length) throw new Error("Playlist B không có bài nào (hoặc không đọc được).");

  const aSet = new Set(aAll);
  const bSet = new Set(bAll);
  priorityA = priorityA.filter(v => aSet.has(v));
  priorityB = priorityB.filter(v => bSet.has(v));

  let aNormal = aAll.filter(v => !priorityA.includes(v));
  let bNormal = bAll.filter(v => !priorityB.includes(v));

  if (pickModeA === "SHUFFLE") {
    aNormal = shuffle_([...aNormal]);
    priorityA = shuffle_([...priorityA]);
  }
  if (pickModeB === "SHUFFLE") {
    bNormal = shuffle_([...bNormal]);
    priorityB = shuffle_([...priorityB]);
  }

  const aPicker = makePicker_(aNormal, priorityA, {
    allowDuplicates,
    reshuffleOnRepeat: pickModeA === "SHUFFLE",
    priorityEvery: priorityEveryA,
    priorityHead: priorityHeadA,
  });

  const bPicker = makePicker_(bNormal, priorityB, {
    allowDuplicates,
    reshuffleOnRepeat: pickModeB === "SHUFFLE",
    priorityEvery: priorityEveryB,
    priorityHead: priorityHeadB,
  });

  const mixResult = buildMixUsingPickers_(aPicker, bPicker, total, ratioA, ratioB, start);
  const mixed = mixResult.videoIds;

  const description =
    `Auto-mixed ${ts}\n` +
    `A=${aId}\nB=${bId}\n` +
    `ratio=${ratioA}:${ratioB}, start=${start}, total=${total}\n` +
    `pickA=${pickModeA}, pickB=${pickModeB}\n` +
    `priorityA(count=${priorityA.length}, head=${priorityHeadA}, every=${priorityEveryA})\n` +
    `priorityB(count=${priorityB.length}, head=${priorityHeadB}, every=${priorityEveryB})\n` +
    `repeatIfShort=true, allowDuplicates=${allowDuplicates}\n` +
    `stats: countA=${mixResult.countA}, countB=${mixResult.countB}\n`;

  const newPlaylistId = createPlaylist_(title, description, privacy);

  let addedCount = 0, failedCount = 0;
  const failedErrors = [];
  for (const videoId of mixed) {
    try {
      addVideoToPlaylist_(newPlaylistId, videoId);
      addedCount++;
    } catch (e) {
      // Retry once after a short delay (handles transient API errors / rate limits)
      try {
        Utilities.sleep(RETRY_DELAY_MS_);
        addVideoToPlaylist_(newPlaylistId, videoId);
        addedCount++;
      } catch (e2) {
        failedCount++;
        failedErrors.push({ videoId, error: e2.message || String(e2) });
      }
    }
    Utilities.sleep(INSERT_DELAY_MS_); // small pause between insertions to avoid rate limiting
  }

  return {
    playlistId: newPlaylistId,
    url: `https://www.youtube.com/playlist?list=${newPlaylistId}`,
    count: addedCount,
    title,
    createdAt: ts,
    priorityASelected: priorityA.length,
    priorityBSelected: priorityB.length,
    countA: mixResult.countA,
    countB: mixResult.countB,
    failedCount,
    failedErrors,
    allowDuplicates,
  };
}

/** ---------- Mix builder ---------- */

// Returns { videoIds, countA, countB } — counts are based on which picker was used,
// not on set membership, so overlap videos are counted correctly.
function buildMixUsingPickers_(aPicker, bPicker, total, ratioA, ratioB, startWith) {
  const videoIds = [];
  let turn = startWith;
  let countA = 0, countB = 0;

  while (videoIds.length < total) {
    if (turn === "A") {
      if (ratioA === 0) { turn = "B"; continue; }
      for (let k = 0; k < ratioA && videoIds.length < total; k++) {
        videoIds.push(aPicker.next());
        countA++;
      }
      turn = "B";
    } else {
      if (ratioB === 0) { turn = "A"; continue; }
      for (let k = 0; k < ratioB && videoIds.length < total; k++) {
        videoIds.push(bPicker.next());
        countB++;
      }
      turn = "A";
    }
  }
  return { videoIds, countA, countB };
}

/** ---------- Picker (option 2 spread full priority list) ---------- */

function makePicker_(normalList, priorityList, opts) {
  const allowDuplicates = !!opts.allowDuplicates;
  const reshuffleOnRepeat = !!opts.reshuffleOnRepeat;
  const priorityEvery = clampInt_(opts.priorityEvery, 0, 9999);
  const priorityHead = clampIntAllowMinusOne_(opts.priorityHead, -1, 9999);

  const state = {
    normal: normalList || [],
    priority: priorityList || [],
    iNormal: 0,
    iPriority: 0,

    headRemaining: 0,

    // Count NORMAL picks since last trigger
    normalSinceTrigger: 0,

    // pending priority picks, one per next() call
    pendingPriority: 0,

    seen: allowDuplicates ? null : new Set(),
  };

  if (state.priority.length > 0) {
    if (priorityHead === -1) state.headRemaining = state.priority.length;
    else state.headRemaining = Math.min(priorityHead, state.priority.length);
  }

  function nextFrom_(arrName) {
    const arr = state[arrName];
    if (!arr.length) return null;

    const idxKey = (arrName === "normal") ? "iNormal" : "iPriority";

    if (state[idxKey] >= arr.length) {
      if (reshuffleOnRepeat && arr.length > 1) shuffle_(arr);
      state[idxKey] = 0;
    }

    if (state.seen) {
      let tries = 0;
      while (tries < arr.length && state.seen.has(arr[state[idxKey]])) {
        state[idxKey]++;
        if (state[idxKey] >= arr.length) {
          if (reshuffleOnRepeat && arr.length > 1) shuffle_(arr);
          state[idxKey] = 0;
        }
        tries++;
      }
    }

    const vid = arr[state[idxKey]];
    state[idxKey]++;

    if (state.seen) state.seen.add(vid);
    return vid;
  }

  function enqueueFullPriorityCycle_() {
    if (!state.priority.length) return;
    state.pendingPriority += state.priority.length;
  }

  return {
    next: function () {
      // head
      if (state.headRemaining > 0 && state.priority.length > 0) {
        const v = nextFrom_("priority");
        if (v) {
          state.headRemaining--;
          return v;
        }
      }

      // spread queued priority
      if (state.pendingPriority > 0 && state.priority.length > 0) {
        const v = nextFrom_("priority");
        if (v) {
          state.pendingPriority--;
          return v;
        }
        state.pendingPriority = Math.max(0, state.pendingPriority - 1);
      }

      // normal
      const n = nextFrom_("normal");
      if (n) {
        state.normalSinceTrigger++;

        if (priorityEvery > 0 && state.priority.length > 0 && state.normalSinceTrigger >= priorityEvery) {
          enqueueFullPriorityCycle_();
          state.normalSinceTrigger = 0;
        }
        return n;
      }

      // fallback priority
      const p = nextFrom_("priority");
      if (p) return p;

      throw new Error("Playlist nguồn không có bài hợp lệ để lấy.");
    }
  };
}

/** ---------- Priority normalization ---------- */

function normalizePriorityInput_(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    const out = input
      .map(v => String(v || "").trim())
      .filter(Boolean)
      .map(v => extractVideoId_(v) || v);
    return uniquePreserveOrder_(out);
  }
  return parseVideoIdsFromMultiline_(String(input));
}

function uniquePreserveOrder_(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function parseVideoIdsFromMultiline_(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  for (const line of lines) {
    const vid = extractVideoId_(line);
    if (vid) out.push(vid);
  }
  return uniquePreserveOrder_(out);
}

function extractVideoId_(s) {
  const str = String(s || "").trim();
  if (!str) return "";

  let m = str.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  if (m) return m[1];

  m = str.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (m) return m[1];

  if (/^[a-zA-Z0-9_-]{6,}$/.test(str)) return str;
  return "";
}

/** ---------- YouTube API ---------- */

function getPlaylistVideoIds_(playlistId) {
  // ✅ Step 1: Check GAS CacheService (6 hours)
  const cacheKey = "PLAYLIST_VIDEOS:" + playlistId;
  const cached = CacheService.getUserCache().get(cacheKey);
  
  if (cached) {
    Logger.log(`✅ Cache hit for ${playlistId} (${cached.length} videos)`);
    return JSON.parse(cached);
  }
  
  // Step 2: Cache miss => load from YouTube API
  Logger.log(`📥 Loading from YouTube API: ${playlistId}`);
  const out = [];
  let pageToken;
  try {
    do {
      const resp = YouTube.PlaylistItems.list("contentDetails", {
        playlistId,
        maxResults: 50,
        pageToken,
      });
      const items = resp.items || [];
      for (const it of items) {
        const vid = it.contentDetails && it.contentDetails.videoId;
        if (vid) out.push(vid);
      }
      pageToken = resp.nextPageToken;
    } while (pageToken);
  } catch (e) {
    throw new Error(formatPlaylistApiError_(e, playlistId));
  }
  
  // ✅ Step 3: Save to cache for 6 hours (21600 seconds)
  CacheService.getUserCache().put(cacheKey, JSON.stringify(out), 21600);
  Logger.log(`💾 Cached ${out.length} videos for 6 hours`);
  
  return out;
}

function createPlaylist_(title, description, privacyStatus) {
  const resp = YouTube.Playlists.insert(
    { snippet: { title, description }, status: { privacyStatus } },
    "snippet,status"
  );
  return resp.id;
}

function addVideoToPlaylist_(playlistId, videoId) {
  YouTube.PlaylistItems.insert(
    { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
    "snippet"
  );
}

/** ---------- Helpers ---------- */

function normalizePlaylistId_(input) {
  const s = sanitizeText_(input);
  if (!s) throw new Error("Bạn chưa nhập playlist.");

  const candidates = [s, safeDecodeURIComponent_(s)];
  for (const c of candidates) {
    const byList = extractListParam_(c);
    if (byList) return byList;

    const byBrowse = extractBrowsePlaylistId_(c);
    if (byBrowse) return byBrowse;

    const byDirect = normalizeDirectPlaylistId_(c);
    if (byDirect) return byDirect;
  }

  throw new Error("Không đọc được playlistId. Hãy dán link có ?list= hoặc dán playlistId.");
}

function sanitizeText_(input) {
  return String(input || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^<|>$/g, "");
}

function safeDecodeURIComponent_(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function extractListParam_(s) {
  const m = String(s || "").match(/[?&]list=([a-zA-Z0-9_-]+)/i);
  return m ? m[1] : "";
}

function extractBrowsePlaylistId_(s) {
  const m = String(s || "").match(/\/browse\/([a-zA-Z0-9_-]+)/i);
  if (!m) return "";
  return normalizeDirectPlaylistId_(m[1]);
}

function normalizeDirectPlaylistId_(s) {
  const id = String(s || "").trim();
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) return "";
  if (id.startsWith("VL") && /^[a-zA-Z0-9_-]{10,}$/.test(id.slice(2))) return id.slice(2);
  return id;
}

function formatPlaylistApiError_(error, playlistId) {
  const msg = (error && error.message) ? String(error.message) : String(error || "Lỗi không xác định.");
  if (/playlistId.*cannot be found/i.test(msg) || /playlistNotFound|notFound/i.test(msg)) {
    const authHint = getAuthorizedChannelHint_();
    return (
      `Không tìm thấy playlist: ${playlistId}. ` +
      `Nguyên nhân thường gặp: (1) playlist là Private và tài khoản đang chạy Web App không phải chủ playlist, ` +
      `(2) bạn đang dán playlist kiểu Mix/Radio tự động của YouTube Music (API không đọc được), ` +
      `(3) playlist đã xoá hoặc đổi quyền truy cập. ` +
      `Hãy thử đặt playlist nguồn thành Unlisted/Public để kiểm tra nhanh. ${authHint}`
    );
  }
  return `Lỗi đọc playlist ${playlistId}: ${msg}`;
}

function getAuthorizedChannelHint_() {
  try {
    const me = YouTube.Channels.list("snippet", { mine: true, maxResults: 1 });
    const ch = me && me.items && me.items[0];
    const title = ch && ch.snippet && ch.snippet.title;
    const id = ch && ch.id;
    if (title || id) {
      return `Tài khoản API hiện tại: ${title || "(không có tên kênh)"}${id ? ` (${id})` : ""}.`;
    }
  } catch (e) {}
  return "Không xác định được kênh YouTube đang dùng để gọi API.";
}

/**
 * Debug nhanh quyền truy cập playlist.
 * params: { playlist: <link hoặc id> }
 */
function debugPlaylistAccess(params) {
  if (!params || !params.playlist) throw new Error("Thiếu playlist.");
  const playlistId = normalizePlaylistId_(params.playlist);

  const result = {
    playlistId,
    channelHint: getAuthorizedChannelHint_(),
    playlistReadable: false,
    itemsReadable: false,
    itemCountSample: 0,
    title: "",
    privacyStatus: "",
    rawError: "",
  };

  try {
    const p = YouTube.Playlists.list("snippet,status,contentDetails", { id: playlistId, maxResults: 1 });
    const pl = p && p.items && p.items[0];
    if (pl) {
      result.playlistReadable = true;
      result.title = (pl.snippet && pl.snippet.title) || "";
      result.privacyStatus = (pl.status && pl.status.privacyStatus) || "";
    }
  } catch (e) {
    result.rawError = e && e.message ? String(e.message) : String(e);
  }

  try {
    const it = YouTube.PlaylistItems.list("contentDetails", { playlistId, maxResults: 5 });
    result.itemsReadable = true;
    result.itemCountSample = (it && it.items && it.items.length) ? it.items.length : 0;
  } catch (e) {
    result.rawError = result.rawError || (e && e.message ? String(e.message) : String(e));
  }

  return result;
}

function shuffle_(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clampInt_(v, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampIntAllowMinusOne_(v, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return min;
  if (n === -1) return -1;
  return Math.max(min, Math.min(max, n));
}

function formatNow_() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function countABStats_(mixed, aSet, bSet) {
  let countA = 0, countB = 0, unknown = 0;
  for (const vid of mixed) {
    if (aSet.has(vid)) countA++;
    else if (bSet.has(vid)) countB++;
    else unknown++;
  }
  return { countA, countB, unknown };
}