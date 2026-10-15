function () {
  if (window.__QXZR_BOOKMARK__) return;
  window.__QXZR_BOOKMARK__ = true;

  /* round engine */
  const TAG = "QX_CANDLE_ROUND";
  const STORE_KEY = "qxCandleRoundUi";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  /* ===================================================================
     à¦…à¦‚à¦¶ à§§ â€” à¦¡à§‡à¦Ÿà¦¾ à¦Ÿà§à¦°à§à¦¯à¦¾à¦•à¦¿à¦‚ + à¦¨à¦•à¦² (fake) candle à¦•à¦¨à§à¦Ÿà§à¦°à§‹à¦²à¦¾à¦° + WS à¦¹à§à¦•
     =================================================================== */

  const state = {
    asset: null,
    assetSource: null,
    period: 60,
    periodSource: null,
    serverOffset: 0,
    lastTick: null,
    candle: null,
    history: [],
    ticks: 0,
    events: {},
    sockets: [],
  };
  let lastDataAt = 0;

  // --- à¦¨à¦•à¦² candle controller ---
  const fake = {
    active: false,
    target: null,
    seconds: 5,
    startPrice: null,
    startAt: 0,
    holdOffset: null,
  };

  const startFake = (target, seconds) => {
    fake.active = true;
    fake.target = Number(target);
    fake.seconds = Math.max(0.2, Number(seconds) || 5);
    fake.startPrice = state.lastTick ? state.lastTick.price : null;
    fake.startAt = Date.now() / 1000;
    fake.holdOffset = null;
  };
  const stopFake = () => {
    fake.active = false;
    fake.startPrice = null;
    fake.holdOffset = null;
  };

  const fakePrice = (realPrice) => {
    if (!fake.active || !isFinite(fake.target)) return realPrice;
    if (fake.startPrice == null) {
      fake.startPrice = realPrice;
      fake.startAt = Date.now() / 1000;
    }
    const dur = Math.max(0.2, fake.seconds);
    const elapsed = Date.now() / 1000 - fake.startAt;
    if (elapsed < dur) {
      const p = elapsed / dur; // linear interpolation
      return fake.startPrice + (fake.target - fake.startPrice) * p;
    }
    if (fake.holdOffset == null) fake.holdOffset = fake.target - realPrice;
    return realPrice + fake.holdOffset;
  };

  const fakeifyTicks = (rows) => {
    let changed = false;
    for (const row of rows) {
      if (
        Array.isArray(row) &&
        typeof row[0] === "string" &&
        typeof row[1] === "number" &&
        typeof row[2] === "number" &&
        (!state.asset || row[0] === state.asset)
      ) {
        row[2] = fakePrice(row[2]);
        changed = true;
      }
    }
    return changed;
  };

  const fakeifyPayload = (arr) => {
    if (Array.isArray(arr) && arr[0] === "quotes/stream" && Array.isArray(arr[1])) {
      return fakeifyTicks(arr[1]);
    }
    if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) {
      return fakeifyTicks(arr);
    }
    return false;
  };

  const rewriteText = (text) => {
    const idx = text.indexOf("[");
    if (idx < 0) return null;
    const prefix = text.slice(0, idx);
    let arr;
    try {
      arr = JSON.parse(text.slice(idx));
    } catch (_) {
      return null;
    }
    return fakeifyPayload(arr) ? prefix + JSON.stringify(arr) : null;
  };

  const rewriteBinary = (bytes) => {
    const off = bytes.length && bytes[0] < 10 ? 1 : 0;
    let text;
    try {
      text = decoder.decode(bytes.subarray(off));
    } catch (_) {
      return null;
    }
    const idx = text.indexOf("[");
    if (idx < 0) return null;
    const jsonPrefix = text.slice(0, idx);
    let arr;
    try {
      arr = JSON.parse(text.slice(idx));
    } catch (_) {
      return null;
    }
    if (!fakeifyPayload(arr)) return null;
    const body = encoder.encode(jsonPrefix + JSON.stringify(arr));
    const out = new Uint8Array(off + body.length);
    if (off) out[0] = bytes[0];
    out.set(body, off);
    return out;
  };

  // --- à¦¡à§‡à¦Ÿà¦¾ à¦Ÿà§à¦°à§à¦¯à¦¾à¦•à¦¿à¦‚ (à¦¶à§à¦§à§ à¦ªà¦¡à¦¼à¦¾) ---
  const countEvent = (name) => {
    state.events[name] = (state.events[name] || 0) + 1;
  };

  const setAsset = (asset, source) => {
    if (!asset || typeof asset !== "string") return;
    if (state.asset !== asset) {
      state.asset = asset;
      state.candle = null;
      state.history = [];
    }
    state.assetSource = source;
  };

  const setPeriod = (period, source) => {
    const p = Number(period);
    if (!p || p < 1 || p > 86400) return;
    if (state.periodSource === "user" && source !== "user") return;
    if (state.period !== p) {
      state.period = p;
      state.candle = null;
      state.history = [];
    }
    state.periodSource = source;
  };

  const onTick = (asset, time, price) => {
    if (typeof asset !== "string" || !isFinite(time) || !isFinite(price)) return;
    if (!state.asset) setAsset(asset, "first-tick");
    if (asset !== state.asset) return;

    state.ticks++;
    state.serverOffset = time - Date.now() / 1000;
    state.lastTick = { time, price };
    lastDataAt = Date.now();

    const start = Math.floor(time / state.period) * state.period;
    const c = state.candle;
    if (!c || c.start !== start) {
      if (c && start > c.start) {
        state.history.push({ start: c.start, open: c.open, close: c.close, high: c.high, low: c.low });
        if (state.history.length > 50) state.history.shift();
      }
      state.candle = { start, open: price, high: price, low: price, close: price, fromHistory: false };
    } else {
      c.close = price;
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
    }
  };

  const onHistory = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.asset && !state.asset) setAsset(obj.asset, "history");
    if (obj.asset && obj.asset !== state.asset) return;
    if (obj.period) {
      setPeriod(obj.period, "history");
      if (Number(obj.period) !== state.period) return;
    }
    const candles = Array.isArray(obj.candles) ? obj.candles : null;
    if (!candles || !candles.length) return;

    const parsed = candles
      .filter((k) => Array.isArray(k) && k.length >= 5)
      .map((k) => ({ start: Number(k[0]), open: Number(k[1]), close: Number(k[2]), high: Number(k[3]), low: Number(k[4]) }))
      .filter((k) => isFinite(k.start) && isFinite(k.open))
      .sort((a, b) => a.start - b.start);
    if (!parsed.length) return;

    const last = parsed[parsed.length - 1];
    const nowServer = Date.now() / 1000 + state.serverOffset;
    const currentStart = Math.floor(nowServer / state.period) * state.period;

    const closed = parsed.filter((k) => k.start < currentStart);
    state.history = closed.slice(-50);
    if (last.start === currentStart) {
      state.candle = { ...last, fromHistory: true };
    }
    lastDataAt = Date.now();
  };

  const handlePayload = (data) => {
    if (Array.isArray(data)) {
      let handled = false;
      for (const row of data) {
        if (Array.isArray(row) && row.length >= 3 && typeof row[0] === "string" && typeof row[1] === "number" && typeof row[2] === "number") {
          onTick(row[0], row[1], row[2]);
          handled = true;
        }
      }
      if (handled) countEvent("quotes/stream");
      return;
    }
    if (data && typeof data === "object") {
      if (Array.isArray(data.candles)) {
        countEvent("history(candles)");
        onHistory(data);
      }
    }
  };
  
