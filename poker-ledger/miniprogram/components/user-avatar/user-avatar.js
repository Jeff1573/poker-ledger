const log = require("../../utils/log");
const CONST = require("../../utils/const");

/**
 * 用户头像组件。
 *
 * 设计目标：
 * 1) 图片加载失败（后端不可达、域名未配置、http 明文被拦截、微信 CDN 头像过期）时，
 *    不再显示系统破图，而是降级为「昵称首字 + 稳定配色」的文字头像；
 * 2) src 为空时同样走文字头像，避免大量无头像用户出现一排破图；
 * 3) 失败时先自动重试一次（带时间戳破缓存），覆盖弱网/首帧竞态导致的偶发失败；
 * 4) 最终失败时打一条结构化日志，便于定位到底是哪张图、哪个地址加载不出来。
 */

// 文字头像配色池：与全局绿/米色主题协调，保证白字对比度足够。
const PALETTE = [
  { bg: "#2E8B73", fg: "#F8F3E7" },
  { bg: "#3F7FA8", fg: "#F2F7FA" },
  { bg: "#A9762F", fg: "#FBF4E6" },
  { bg: "#8C5A9E", fg: "#F8F1FB" },
  { bg: "#B4553F", fg: "#FCF1ED" },
  { bg: "#4E7B57", fg: "#F1F7F1" },
  { bg: "#5B6472", fg: "#F4F6F8" }
];

// 失败后重试的等待时间，避免和首屏其它请求抢带宽。
const RETRY_DELAY_MS = 600;

// 内联头像缓存：同一个头像 URL 在多处渲染（成员列表、交易流水、弹层）只请求一次。
// key = 原始绝对 URL，value = data URL
const inlineCache = new Map();
const INLINE_CACHE_MAX = 80;

/**
 * 判断某个头像地址是否需要走「base64 内联」。
 *
 * 背景：真机的 <image> 不能加载 http 明文图片，而本地后端只有 http。
 * 此时改用 wx.request 取回图片内容再以 data URL 渲染。
 * 生产环境 API_BASE_URL 是 https，不走这条分支。
 *
 * 注意：chooseAvatar 返回的本地临时路径也可能是 http://tmp/xxx，
 * 因此必须用 API_BASE_URL 前缀匹配，不能只看协议头。
 *
 * @param {string} src
 * @returns {boolean}
 */
function needInline(src) {
  const base = String(CONST.API_BASE_URL || "").replace(/\/$/, "");
  const raw = String(src || "");
  if (!raw || !base) return false;
  if (base.indexOf("http://") !== 0) return false;
  return raw.indexOf(`${base}/`) === 0;
}

/**
 * 把绝对地址还原成后端相对路径（/uploads/avatars/xxx.jpg）。
 *
 * @param {string} src
 * @returns {string}
 */
function toRelativePath(src) {
  const base = String(CONST.API_BASE_URL || "").replace(/\/$/, "");
  const raw = String(src || "");
  if (!base || raw.indexOf(`${base}/`) !== 0) return "";
  return raw.slice(base.length);
}

/**
 * 写入内联缓存，超出上限时淘汰最早的一条。
 *
 * @param {string} key
 * @param {string} value
 */
function putInlineCache(key, value) {
  if (inlineCache.size >= INLINE_CACHE_MAX) {
    const oldest = inlineCache.keys().next();
    if (!oldest.done) inlineCache.delete(oldest.value);
  }
  inlineCache.set(key, value);
}

/**
 * 由昵称稳定地推导一个配色下标，保证同一个人每次渲染颜色一致。
 *
 * @param {string} name
 * @returns {{bg:string, fg:string}}
 */
function pickPalette(name) {
  const s = String(name || "");
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) % 100000;
  }
  return PALETTE[hash % PALETTE.length];
}

/**
 * 取昵称首个可见字符作为文字头像内容。
 *
 * @param {string} name
 * @returns {string}
 */
function pickInitial(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  // 用 Array.from 正确处理 emoji / 多字节字符，避免出现半个字符。
  const chars = Array.from(s);
  return chars[0] || "?";
}

/**
 * 给 URL 追加一次性的破缓存参数。
 *
 * @param {string} url
 * @returns {string}
 */
function withCacheBust(url) {
  const raw = String(url || "");
  if (!raw) return "";
  const sep = raw.indexOf("?") >= 0 ? "&" : "?";
  return `${raw}${sep}_r=${Date.now()}`;
}

Component({
  options: {
    // 允许页面全局样式（.avatar 等）作用到组件根节点，方便沿用原有布局
    addGlobalClass: true
  },

  properties: {
    // 头像图片地址（已补全为绝对 URL）
    src: {
      type: String,
      value: "",
      observer: "handleSrcChange"
    },
    // 昵称，用于文字头像与首字提取
    name: {
      type: String,
      value: "",
      observer: "handleNameChange"
    },
    // 直径（rpx）
    size: {
      type: Number,
      value: 96
    },
    // 是否描边
    bordered: {
      type: Boolean,
      value: false
    },
    // 圆角（rpx），默认圆形
    radius: {
      type: Number,
      value: 0
    }
  },

  data: {
    // 实际用于 <image src> 的地址（重试时会带上破缓存参数）
    displaySrc: "",
    failed: false,
    retried: false,
    initial: "?",
    fallbackBg: PALETTE[0].bg,
    fallbackFg: PALETTE[0].fg,
    fontSize: 40,
    cornerRadius: 48
  },

  lifetimes: {
    attached() {
      this._detached = false;
      this.refreshDerived();
      this.applySrc(this.data.src);
    },

    detached() {
      this._detached = true;
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
    }
  },

  methods: {
    /**
     * 根据 src 决定直接渲染还是先转成 data URL。
     *
     * @param {string} src
     */
    applySrc(src) {
      const raw = String(src || "");
      this._currentSrc = raw;

      if (!raw) {
        this.setData({ displaySrc: "", failed: false, retried: false });
        return;
      }

      if (!needInline(raw)) {
        this.setData({ displaySrc: raw, failed: false, retried: false });
        return;
      }

      const cached = inlineCache.get(raw);
      if (cached) {
        this.setData({ displaySrc: cached, failed: false, retried: false });
        return;
      }

      // 先占位为空，等 data URL 回来再渲染，避免先发一次注定失败的 http 图片请求
      this.setData({ displaySrc: "", failed: false, retried: false });
      this.loadInline(raw);
    },

    /**
     * 通过后端把头像转成 base64 再渲染（真机不支持 http 明文图片）。
     *
     * @param {string} src
     */
    loadInline(src) {
      const relativePath = toRelativePath(src);
      if (!relativePath) return;

      const base = String(CONST.API_BASE_URL || "").replace(/\/$/, "");
      const url = `${base}/api/avatars/inline?src=${encodeURIComponent(relativePath)}`;

      wx.request({
        url,
        method: "GET",
        success: (res) => {
          if (this._detached || this._currentSrc !== src) return;
          const body = res && res.data;
          const dataUrl = body && body.ok ? String(body.dataUrl || "") : "";
          if (!dataUrl) {
            log.warn("avatar.inline.fail", "头像内联失败，回退直连加载", {
              src,
              statusCode: Number((res && res.statusCode) || 0),
              code: String((body && body.code) || "")
            });
            // 回退直连：能显示就显示，不能显示会走 handleError 的降级流程
            this.setData({ displaySrc: src });
            return;
          }
          putInlineCache(src, dataUrl);
          this.setData({ displaySrc: dataUrl });
        },
        fail: (err) => {
          if (this._detached || this._currentSrc !== src) return;
          log.warn("avatar.inline.error", "头像内联请求异常，回退直连加载", {
            src,
            errMsg: String((err && err.errMsg) || "")
          });
          this.setData({ displaySrc: src });
        }
      });
    },

    refreshDerived() {
      const size = Number(this.data.size) || 96;
      const radius = Number(this.data.radius) > 0 ? Number(this.data.radius) : Math.round(size / 2);
      const palette = pickPalette(this.data.name);
      this.setData({
        initial: pickInitial(this.data.name),
        fallbackBg: palette.bg,
        fallbackFg: palette.fg,
        fontSize: Math.max(20, Math.round(size * 0.42)),
        cornerRadius: radius
      });
    },

    handleNameChange() {
      this.refreshDerived();
    },

    /**
     * src 变化时重置失败/重试状态，避免换头像后仍然显示旧的首字占位。
     */
    handleSrcChange() {
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
      }
      this.refreshDerived();
      this.applySrc(this.data.src);
    },

    handleLoad() {
      if (this.data.failed) this.setData({ failed: false });
    },

    /**
     * 首次失败：换一个破缓存地址重试一次。
     * 第二次仍失败：降级为文字头像，并记录可排查的日志。
     */
    handleError(e) {
      const errMsg = String((e && e.detail && e.detail.errMsg) || "");
      const src = String(this.data.src || "");
      const current = String(this.data.displaySrc || "");
      // data URL 不会因为网络失败，重试没有意义，直接降级
      const canRetry = !this.data.retried && !!current && current.indexOf("data:") !== 0;

      if (canRetry) {
        const retrySrc = withCacheBust(current);
        log.warn("avatar.load.retry", "头像加载失败，带破缓存参数重试一次", { src, errMsg });
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this.setData({ displaySrc: retrySrc, retried: true });
        }, RETRY_DELAY_MS);
        return;
      }

      log.warn("avatar.load.fail", "头像图片加载失败，已降级为文字头像", { src, errMsg });
      this.setData({ failed: true });
      this.triggerEvent("error", { src, errMsg });
    }
  }
});
