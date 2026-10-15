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

  const parseSocketIoText = (text) => {
    const m = /^\d+(?:-)?(?:\/[^,]*,)?(\d*)(\[.*)$/s.exec(text);
    if (!m) return null;
    try {
      const arr = JSON.parse(m[2]);
      if (Array.isArray(arr) && typeof arr[0] === "string") return { event: arr[0], data: arr[1] };
    } catch (_) {}
    return null;
  };

  const handleIncomingText = (text) => {
    if (text.length > 2 && (text[0] === "[" || text[0] === "{")) {
      try {
        handlePayload(JSON.parse(text));
      } catch (_) {}
      return;
    }
    const msg = parseSocketIoText(text);
    if (!msg) return;
    countEvent(msg.event);
    const d = msg.data;
    if (d && d._placeholder) return;
    if (msg.event === "quotes/stream") handlePayload(d);
    else if (/history/i.test(msg.event) || (d && Array.isArray(d.candles))) onHistory(d);
    else if (msg.event === "instruments/update" && d && d.asset) {
      setAsset(d.asset, "server");
      if (d.period) setPeriod(d.period, "server");
    }
  };

  const handleIncomingBinary = (buf) => {
    let bytes = new Uint8Array(buf);
    if (bytes.length && bytes[0] < 10) bytes = bytes.subarray(1);
    const text = decoder.decode(bytes);
    try {
      handlePayload(JSON.parse(text));
    } catch (_) {
      handleIncomingText(text);
    }
  };

  const handleOutgoing = (data) => {
    if (typeof data !== "string") return;
    const msg = parseSocketIoText(data);
    if (!msg) return;
    const d = msg.data;
    countEvent("â†’ " + msg.event);
    switch (msg.event) {
      case "instruments/update":
      case "chart_notification/get":
      case "history/load/line":
      case "instruments/follow":
        if (d && typeof d === "object") {
          if (d.asset) setAsset(d.asset, "client:" + msg.event);
          if (d.period) setPeriod(d.period, "client:" + msg.event);
        }
        break;
      case "depth/follow":
        if (typeof d === "string") setAsset(d, "client:depth/follow");
        break;
    }
  };

  const trackState = (raw) => {
    try {
      if (typeof raw === "string") handleIncomingText(raw);
      else if (raw instanceof ArrayBuffer) handleIncomingBinary(raw);
      else if (raw instanceof Blob) raw.arrayBuffer().then(handleIncomingBinary).catch(() => {});
    } catch (_) {}
  };

  /* --- à¦¹à§à¦•: à¦šà¦¾à¦²à§ à¦¥à¦¾à¦•à¦¾ socket-à¦“ à¦§à¦°à¦¤à§‡ MessageEvent.data + send à¦ªà§à¦¯à¦¾à¦š à¦•à¦°à¦¿ --- */
  const PROC = Symbol("qxProcessed");
  const FAKED = Symbol("qxFaked");
  const nativeDataDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
  const nativeGetData = nativeDataDesc.get;

  Object.defineProperty(MessageEvent.prototype, "data", {
    configurable: true,
    enumerable: nativeDataDesc.enumerable,
    get() {
      const raw = nativeGetData.call(this);
      // à¦¶à§à¦§à§ WebSocket à¦¥à§‡à¦•à§‡ à¦†à¦¸à¦¾ message à¦§à¦°à¦¿ (postMessage/worker à¦¬à¦¾à¦¦)
      const tgt = this.currentTarget || this.target;
      if (!(tgt instanceof WebSocket)) return raw;

      // state à¦Ÿà§à¦°à§à¦¯à¦¾à¦•à¦¿à¦‚ â€” à¦ªà§à¦°à¦¤à¦¿ event-à¦ à¦à¦•à¦¬à¦¾à¦°
      if (!this[PROC]) {
        this[PROC] = true;
        try {
          if (typeof raw === "string") state.sockets.indexOf(tgt.url) < 0 && noteSocket(tgt.url);
          else noteSocket(tgt.url);
        } catch (_) {}
        trackState(raw);
      }

      if (!fake.active) return raw;
      if (this[FAKED] !== undefined) return this[FAKED];

      let out = raw;
      try {
        if (typeof raw === "string") {
          const n = rewriteText(raw);
          if (n != null) out = n;
        } else if (raw instanceof ArrayBuffer) {
          const n = rewriteBinary(new Uint8Array(raw));
          if (n) out = n.buffer;
        }
        // Blob à¦¸à¦¿à¦™à§à¦•à§à¦°à§‹à¦¨à¦¾à¦¸à§‡ rewrite à¦•à¦°à¦¾ à¦¯à¦¾à¦¯à¦¼ à¦¨à¦¾ â€” à¦¤à¦–à¦¨ à¦†à¦¸à¦²à¦Ÿà¦¾à¦‡ à¦¯à¦¾à¦¯à¦¼à¥¤
      } catch (_) {}
      this[FAKED] = out;
      return out;
    },
  });

  const noteSocket = (url) => {
    try {
      const u = String(url).split("?")[0];
      if (state.sockets.indexOf(u) < 0) {
        state.sockets.push(u);
        if (state.sockets.length > 5) state.sockets.shift();
      }
    } catch (_) {}
  };

  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      handleOutgoing(data);
    } catch (_) {}
    return nativeSend.apply(this, arguments);
  };

  // à¦­à¦¬à¦¿à¦·à§à¦¯à¦¤à§‡ à¦–à§‹à¦²à¦¾ à¦¨à¦¤à§à¦¨ socket-à¦“ à¦¯à§‡à¦¨ à¦¤à¦¾à¦²à¦¿à¦•à¦¾à¦¯à¦¼ à¦†à¦¸à§‡
  const NativeWS = window.WebSocket;
  const HookedWS = new Proxy(NativeWS, {
    construct(target, args) {
      const ws = new target(...args);
      try {
        noteSocket(args[0]);
      } catch (_) {}
      return ws;
    },
  });
  window.WebSocket = HookedWS;

  var script = document.currentScript;
  if (!script) {
    var nodes = document.querySelectorAll("script[src*='qx.js']");
    script = nodes[nodes.length - 1];
  }
  var ORIGIN = location.origin;
  try {
    ORIGIN = new URL(script.src).origin;
  } catch (e) {}

  var APP = "QUOTEX ZR";
  var UI_ROUND_KEY = "qxzr_round_ui";
  var uiRound = { fakeTarget: "", fakeSeconds: 5 };
  var fakeRunning = false;
  
