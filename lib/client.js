/**
 * dsh-wallpaper — 主题管理插件（client 半）。
 *
 * 两件事：
 *   1. 往设置弹框注册一个 `settings.section` 页面「主题管理」（来源选择 / 目录配置 /
 *      壁纸网格 / 外观微调）
 *   2. 把选中的壁纸画到整个页面最底层，并把界面调成半透明
 *
 * 本文件是**手写的** lazy-CJS bundle（与 dsh-hud 的发布形态一致），没有构建步骤：
 * 官方要求的形态就是 `window.__ModuleLoader__.load({ id, factory })`，factory 内
 * 只允许 `require('react')` 这类冻结模块表里的请求。因此这里不写 JSX，统一用
 * `h = react.createElement`。
 *
 * 服务端（lib/index.js）不下发磁盘路径，只下发拼好的 URL，所以这里拿到的
 * `thumbUrl`/`mediaUrl` 可以直接塞进 <img>/<video>。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wallpaper',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    /** 依赖：插槽服务（设置页面注册面）。 */
    var inject = ["slots"];

    var API = "/api/dsh-wallpaper";
    var STYLE_ID = "dsh-wallpaper-style";
    var LAYER_ID = "dsh-wallpaper-layer";
    var ROOT_CLASS = "dsh-wallpaper-on";

    // ─────────────────────────────────────────────────────────────
    // 共享状态：设置页与壁纸层读同一份快照，写入后统一重绘
    // ─────────────────────────────────────────────────────────────
    var snapshot = {
      loaded: false,
      config: null,
      current: null,
      items: [],
      error: "",
      banner: "",
      busy: false,
    };
    var listeners = new Set();
    function getSnapshot() { return snapshot; }
    function subscribe(listener) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
    function emit(patch) {
      snapshot = Object.assign({}, snapshot, patch);
      for (var listener of Array.from(listeners)) listener();
    }

    /** 统一的接口调用；非 2xx 或 ok!==true 一律抛出带服务端文案的错误。 */
    async function api(path, body) {
      var init = body === undefined
        ? { cache: "no-store" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          };
      var res = await fetch(API + path, init);
      var data = null;
      try { data = await res.json(); } catch (error) { /* 非 JSON 响应 */ }
      if (!res.ok || data === null || data.ok !== true) {
        var reason = data && data.error ? data.error : "HTTP " + res.status;
        throw new Error(reason);
      }
      return data;
    }

    /** 把服务端返回的完整状态铺进快照（所有写接口都会回一份最新状态）。 */
    function adopt(data) {
      emit({
        loaded: true,
        config: data.config,
        current: data.current === undefined ? null : data.current,
        items: Array.isArray(data.items) ? data.items : [],
        error: data.error || "",
        busy: false,
      });
    }

    async function loadState() {
      try {
        adopt(await api("/state"));
      } catch (error) {
        emit({ loaded: true, error: message(error), busy: false });
      }
    }

    async function saveConfig(patch, bannerText) {
      emit({ busy: true, banner: "" });
      try {
        adopt(await api("/config", patch));
        if (bannerText) emit({ banner: bannerText });
      } catch (error) {
        emit({ busy: false, banner: "保存失败：" + message(error) });
      }
    }

    async function selectItem(id) {
      emit({ busy: true, banner: "" });
      try {
        adopt(await api("/select", { id: id }));
        emit({ banner: "已应用壁纸" });
      } catch (error) {
        emit({ busy: false, banner: "应用失败：" + message(error) });
      }
    }

    async function clearCurrent() {
      emit({ busy: true, banner: "" });
      try {
        adopt(await api("/clear", {}));
        emit({ banner: "已关闭壁纸" });
      } catch (error) {
        emit({ busy: false, banner: "关闭失败：" + message(error) });
      }
    }

    function message(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ─────────────────────────────────────────────────────────────
    // 壁纸层：把当前壁纸画到页面最底层，并启用半透明界面
    //
    // dsh 的背景画在 `body{background:var(--dsw-alias-bg-base,#fff)}` 上，所以：
    //   ① 壁纸放到 <html> 的固定背景 —— body 有自己的不透明背景，壁纸必须在它**下面**
    //   ② 把 body 的背景类 token 覆写成半透明 —— 界面随之透出底下的壁纸
    //   ③ 压暗用多层背景（渐变叠在图片之上）实现，不插 DOM、不玩 z-index
    //
    // 暗色模式的开关是 `body[data-ds-dark-theme]` 属性（官方主题用
    // `document.body.toggleAttribute('data-ds-dark-theme', dark)` 写的），
    // 不是 html 上的 class，所以暗色覆写挂在 body 的属性选择器上。
    //
    // 用到的 token 与色值取自官方主题（dsh-client-ui-theme）：
    //   亮色 bg-base/layer-1..3 = #fff，overlay = #e9ecf2
    //   暗色 bg-base #151517、layer-1 #232324、layer-2 #2c2c2e、layer-3 #353638、overlay #61666b
    // ─────────────────────────────────────────────────────────────
    var ALPHA = "var(--dsh-wp-alpha,0.78)";
    var STYLE = [
      // ① 壁纸铺满视口；渐变层压在图片之上做压暗（dim=0 时渐变全透明）
      "html." + ROOT_CLASS + "{",
      "  background-image:linear-gradient(rgba(0,0,0,var(--dsh-wp-dim,0)),rgba(0,0,0,var(--dsh-wp-dim,0))),var(--dsh-wp-image);",
      "  background-size:cover,var(--dsh-wp-fit,cover);",
      "  background-position:center center,center center;",
      "  background-repeat:no-repeat,no-repeat;",
      "  background-attachment:fixed,fixed;",
      "}",
      // 视频壁纸层：挂在 <html> 下、z-index:-1 —— 这样它画在 body 的背景**之下**，
      // 半透明的界面才能盖在它上面。挂在 body 下会被 body 的背景完全遮住。
      "html." + ROOT_CLASS + " #" + LAYER_ID + "{",
      "  position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:#000;",
      "}",
      "html." + ROOT_CLASS + " #" + LAYER_ID + " video{",
      "  display:block;width:100%;height:100%;object-fit:var(--dsh-wp-fit,cover);",
      "  filter:blur(var(--dsh-wp-blur,0px)) brightness(calc(1 - var(--dsh-wp-dim,0)));",
      "}",
      // ② 界面半透明：覆写 body 上的背景类 token（!important 压过主题自身声明）。
      //    必须写在 `html.<class> body` 上而不是 `html.<class>` 上：这套 token 由主题
      //    声明在 body 上（`body{…}` / `body[data-ds-dark-theme]{…}`），html 上的声明
      //    继承不过去。选择器权重 (0,2,2) / (0,3,2) 也压过官方主题的 (0,0,1) / (0,1,1)。
      //    另外官方主题的 presenter 会把 token 覆写**内联写在 body 上**，
      //    这里靠 !important 压过内联声明（内联不带 !important 时stylesheet 的 !important 胜出）。
      //
      //    覆盖面：bg-base 管 frame 与对话区；layer-1/2/3 管设置弹框、菜单、卡片；
      //    overlay 管遮罩层；specific-sidebar-fill 是侧栏单独用的一个 token，不覆写它
      //    侧栏会整块不透明地压在壁纸上。
      "html." + ROOT_CLASS + " body{",
      "  --dsw-alias-bg-base:rgba(255,255,255," + ALPHA + ") !important;",
      "  --dsw-alias-bg-layer-1:rgba(255,255,255," + ALPHA + ") !important;",
      "  --dsw-alias-bg-layer-2:rgba(255,255,255," + ALPHA + ") !important;",
      "  --dsw-alias-bg-layer-3:rgba(255,255,255," + ALPHA + ") !important;",
      "  --dsw-alias-bg-overlay:rgba(233,236,242," + ALPHA + ") !important;",
      "  --dsw-specific-sidebar-fill:rgba(246,247,250," + ALPHA + ") !important;",
      "}",
      "html." + ROOT_CLASS + " body[data-ds-dark-theme]{",
      "  --dsw-alias-bg-base:rgba(21,21,23," + ALPHA + ") !important;",
      "  --dsw-alias-bg-layer-1:rgba(35,35,36," + ALPHA + ") !important;",
      "  --dsw-alias-bg-layer-2:rgba(44,44,46," + ALPHA + ") !important;",
      "  --dsw-alias-bg-layer-3:rgba(53,54,56," + ALPHA + ") !important;",
      "  --dsw-alias-bg-overlay:rgba(97,102,107," + ALPHA + ") !important;",
      "  --dsw-specific-sidebar-fill:rgba(27,27,28," + ALPHA + ") !important;",
      "}",
      // ── 设置页样式（与官方 token 对齐，不造新视觉语言）──
      ".dsh-wp-root{display:flex;flex-direction:column;gap:16px;padding:2px 0 24px;font-size:13px;color:var(--dsw-alias-label-primary,#111);}",
      ".dsh-wp-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.1));border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;}",
      ".dsh-wp-title{font-size:13px;font-weight:600;margin:0;}",
      ".dsh-wp-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);line-height:1.5;margin:0;}",
      ".dsh-wp-seg{display:flex;flex-wrap:wrap;gap:6px;}",
      ".dsh-wp-seg>button{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.12));background:transparent;color:inherit;border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;}",
      ".dsh-wp-seg>button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));}",
      ".dsh-wp-seg>button.is-on{background:var(--dsw-alias-state-business-tertiary,rgba(0,110,255,0.12));border-color:var(--dsw-alias-state-business-primary,#006eff);color:var(--dsw-alias-state-business-primary,#006eff);font-weight:600;}",
      ".dsh-wp-row{display:flex;gap:8px;align-items:center;}",
      ".dsh-wp-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.12));background:var(--dsw-alias-bg-base,transparent);color:inherit;border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;}",
      ".dsh-wp-btn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.12));background:transparent;color:inherit;border-radius:7px;padding:6px 13px;font-size:12px;cursor:pointer;white-space:nowrap;}",
      ".dsh-wp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.05));}",
      ".dsh-wp-btn.is-primary{background:var(--dsw-alias-state-business-primary,#006eff);border-color:transparent;color:#fff;font-weight:600;}",
      ".dsh-wp-btn:disabled{opacity:0.5;cursor:default;}",
      ".dsh-wp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;max-height:340px;overflow-y:auto;padding:2px;}",
      ".dsh-wp-tile{position:relative;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.1));border-radius:9px;overflow:hidden;cursor:pointer;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,0.03));padding:0;text-align:left;color:inherit;font:inherit;}",
      ".dsh-wp-tile:hover{border-color:var(--dsw-alias-state-business-primary,#006eff);}",
      ".dsh-wp-tile.is-on{border-color:var(--dsw-alias-state-business-primary,#006eff);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#006eff);}",
      ".dsh-wp-thumb{display:block;width:100%;height:74px;object-fit:cover;background:rgba(0,0,0,0.08);}",
      ".dsh-wp-tile-name{display:block;padding:5px 7px;font-size:11px;line-height:1.35;height:2.7em;overflow:hidden;word-break:break-all;}",
      ".dsh-wp-badge{position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.62);color:#fff;border-radius:5px;font-size:10px;padding:1px 5px;}",
      ".dsh-wp-check{position:absolute;top:4px;left:4px;background:var(--dsw-alias-state-business-primary,#006eff);color:#fff;border-radius:50%;width:17px;height:17px;font-size:11px;line-height:17px;text-align:center;}",
      ".dsh-wp-slider{display:flex;align-items:center;gap:9px;}",
      ".dsh-wp-slider>span{width:62px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary,#555);}",
      ".dsh-wp-slider>input{flex:1;}",
      ".dsh-wp-slider>em{width:38px;flex:none;font-style:normal;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);text-align:right;}",
      ".dsh-wp-note{font-size:12px;line-height:1.5;}",
      ".dsh-wp-note.is-ok{color:var(--dsw-alias-state-success-primary,#1a9e4b);}",
      ".dsh-wp-note.is-err{color:var(--dsw-alias-state-error-primary,#d93025);}",
    ].join("\n");

    function injectStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = STYLE;
      document.head.appendChild(tag);
    }

    /**
     * 应用当前壁纸到页面。
     *
     * 纯 DOM 副作用，幂等：每次状态变化整份重算，不依赖上一次的结果。
     * 关闭壁纸时必须把 class / 变量 / 视频层全部撤干净，否则界面会留在半透明状态。
     */
    function applyWallpaper(config, current) {
      var root = document.documentElement;
      var layer = document.getElementById(LAYER_ID);

      if (current === null || current === undefined) {
        root.classList.remove(ROOT_CLASS);
        root.style.removeProperty("--dsh-wp-image");
        if (layer !== null) layer.remove();
        return;
      }

      root.style.setProperty("--dsh-wp-alpha", String(config.opacity));
      root.style.setProperty("--dsh-wp-dim", String(config.dim));
      root.style.setProperty("--dsh-wp-blur", config.blur + "px");
      root.style.setProperty("--dsh-wp-fit", config.fit);
      root.classList.add(ROOT_CLASS);

      if (current.kind === "video") {
        // 视频壁纸走真实 <video> 元素（CSS 背景图放不了视频）。
        // 必须挂在 <html> 下而不是 body 下：图层要靠 z-index:-1 待在 body 背景之下，
        // 挂 body 下会被 body 自己的背景整个遮住。
        root.style.removeProperty("--dsh-wp-image");
        if (layer === null) {
          layer = document.createElement("div");
          layer.id = LAYER_ID;
          root.appendChild(layer);
        }
        // 只换源不重建元素，避免每次重绘都重新加载视频
        if (layer.dataset.src !== current.mediaUrl) {
          layer.dataset.src = current.mediaUrl;
          layer.textContent = "";
          var video = document.createElement("video");
          video.src = current.mediaUrl;
          video.autoplay = true;
          video.loop = true;
          video.muted = true;
          video.playsInline = true;
          layer.appendChild(video);
          var played = video.play();
          if (played && typeof played.catch === "function") played.catch(function () { /* 自动播放被拦时保留首帧 */ });
        }
      } else {
        if (layer !== null) layer.remove();
        // CSS 背景图必须带 url() 且引号转义，否则含特殊字符的 URL 会破坏规则
        root.style.setProperty("--dsh-wp-image", 'url("' + String(current.mediaUrl).replace(/"/g, '\\"') + '")');
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 设置页 UI
    // ─────────────────────────────────────────────────────────────

    /** 来源选项：与 host 侧 MODES 一一对应。 */
    var MODES = [
      { id: "off", label: "关闭" },
      { id: "folder", label: "本地文件夹" },
      { id: "wallpaper-engine", label: "Wallpaper Engine" },
      { id: "file", label: "单个文件" },
      { id: "url", label: "图片链接" },
    ];

    var FITS = [
      { id: "cover", label: "铺满裁剪" },
      { id: "contain", label: "完整显示" },
      { id: "fill", label: "拉伸填满" },
    ];

    /** 输入框型配置：目录 / 文件 / 链接三种模式共用一套"草稿 + 保存"逻辑。 */
    function FieldRow(props) {
      var draft = react.useState(props.value);
      var value = draft[0];
      var setValue = draft[1];
      // 外部值变化（切换来源、重新扫描）时同步草稿，否则输入框会停在旧值
      var seen = react.useRef(props.value);
      if (seen.current !== props.value) {
        seen.current = props.value;
        if (value !== props.value) setValue(props.value);
      }
      var save = function () {
        if (value.trim() === props.value) return;
        props.onSave(value.trim());
      };
      return h("div", { className: "dsh-wp-row" },
        h("input", {
          className: "dsh-wp-input",
          type: "text",
          value: value,
          placeholder: props.placeholder,
          spellCheck: false,
          disabled: props.busy,
          onChange: function (e) { setValue(e.target.value); },
          onKeyDown: function (e) { if (e.key === "Enter") save(); },
        }),
        h("button", {
          className: "dsh-wp-btn is-primary",
          type: "button",
          disabled: props.busy || value.trim() === props.value,
          onClick: save,
        }, "保存")
      );
    }

    /** 带数值回显的滑杆；拖动时只改本地状态，松手才提交，避免每帧打一次接口。 */
    function Slider(props) {
      var draft = react.useState(props.value);
      var value = draft[0];
      var setValue = draft[1];
      var seen = react.useRef(props.value);
      if (seen.current !== props.value) {
        seen.current = props.value;
        if (value !== props.value) setValue(props.value);
      }
      var commit = function () {
        if (value !== props.value) props.onCommit(value);
      };
      return h("div", { className: "dsh-wp-slider" },
        h("span", null, props.label),
        h("input", {
          type: "range",
          min: props.min,
          max: props.max,
          step: props.step,
          value: value,
          disabled: props.busy,
          onChange: function (e) { setValue(Number(e.target.value)); },
          onPointerUp: commit,
          onKeyUp: commit,
          onBlur: commit,
        }),
        h("em", null, props.display === undefined ? String(value) : props.display(value))
      );
    }

    /** 壁纸网格；缩略图 lazy 加载，避免一次拉几十张预览图拖慢设置页。 */
    function Grid(props) {
      if (props.items.length === 0) {
        return h("p", { className: "dsh-wp-hint" },
          props.config.mode === "off"
            ? "选择一种来源后这里会列出可用的壁纸。"
            : "没有扫到壁纸。请检查路径是否正确，或换一个来源。"
        );
      }
      return h("div", { className: "dsh-wp-grid" },
        props.items.map(function (item) {
          var on = props.current !== null && props.current !== undefined && props.current.id === item.id;
          return h("button", {
            key: item.id,
            type: "button",
            className: "dsh-wp-tile" + (on ? " is-on" : ""),
            title: item.title,
            disabled: props.busy,
            onClick: function () { props.onPick(item.id); },
          },
            h("img", { className: "dsh-wp-thumb", src: item.thumbUrl, alt: "", loading: "lazy", decoding: "async" }),
            item.badge ? h("span", { className: "dsh-wp-badge" }, item.badge) : null,
            on ? h("span", { className: "dsh-wp-check" }, "✓") : null,
            h("span", { className: "dsh-wp-tile-name" }, item.title)
          );
        })
      );
    }

    /** 设置页主体。 */
    function ThemeSection() {
      var snap = react.useSyncExternalStore(subscribe, getSnapshot);
      react.useEffect(function () { loadState(); }, []);

      if (!snap.loaded) {
        return h("div", { className: "dsh-wp-root" }, h("p", { className: "dsh-wp-hint" }, "正在读取壁纸配置…"));
      }
      if (snap.config === null) {
        return h("div", { className: "dsh-wp-root" },
          h("p", { className: "dsh-wp-note is-err" }, "无法连接壁纸服务：" + snap.error)
        );
      }

      var config = snap.config;
      var current = snap.current;
      var busy = snap.busy;

      return h("div", { className: "dsh-wp-root" },

        // ── 来源 ──
        h("section", { className: "dsh-wp-card" },
          h("h3", { className: "dsh-wp-title" }, "壁纸来源"),
          h("div", { className: "dsh-wp-seg" }, MODES.map(function (mode) {
            return h("button", {
              key: mode.id,
              type: "button",
              className: config.mode === mode.id ? "is-on" : "",
              disabled: busy,
              onClick: function () { if (config.mode !== mode.id) saveConfig({ mode: mode.id }); },
            }, mode.label);
          })),

          config.mode === "folder"
            ? h(react.Fragment, null,
                h(FieldRow, {
                  value: config.root,
                  placeholder: "本地图片/视频文件夹的绝对路径，例如 D:\\Pictures\\wallpapers",
                  busy: busy,
                  onSave: function (v) { saveConfig({ root: v, mode: "folder" }); },
                }),
                h("p", { className: "dsh-wp-hint" }, "扫描该文件夹及其一级子目录下的 jpg/png/webp/gif 与 mp4/webm。")
              )
            : null,

          config.mode === "wallpaper-engine"
            ? h(react.Fragment, null,
                h(FieldRow, {
                  value: config.root,
                  placeholder: "Wallpaper Engine 根目录，例如 D:\\Software\\Steam",
                  busy: busy,
                  onSave: function (v) { saveConfig({ root: v, mode: "wallpaper-engine" }); },
                }),
                h("p", { className: "dsh-wp-hint" },
                  "填 Steam 根目录、steamapps/workshop/content 或 431960 目录都可以，会自动定位。",
                  "视频类壁纸直接用原视频循环播放；场景/网页类壁纸浏览器放不了，取项目的预览图。"
                )
              )
            : null,

          config.mode === "file"
            ? h(FieldRow, {
                value: config.file,
                placeholder: "单个图片或视频的绝对路径，例如 D:\\Pictures\\a.jpg",
                busy: busy,
                onSave: function (v) { saveConfig({ file: v, mode: "file" }); },
              })
            : null,

          config.mode === "url"
            ? h(FieldRow, {
                value: config.url,
                placeholder: "https://example.com/wallpaper.jpg",
                busy: busy,
                onSave: function (v) { saveConfig({ url: v, mode: "url" }); },
              })
            : null,

          snap.error ? h("p", { className: "dsh-wp-note is-err" }, snap.error) : null,
          snap.banner ? h("p", { className: "dsh-wp-note is-ok" }, snap.banner) : null
        ),

        // ── 壁纸库 ──
        config.mode === "off"
          ? null
          : h("section", { className: "dsh-wp-card" },
              h("h3", { className: "dsh-wp-title" }, "选择壁纸（" + snap.items.length + "）"),
              config.mode === "folder" || config.mode === "wallpaper-engine"
                ? h("div", { className: "dsh-wp-row" },
                    h("button", {
                      className: "dsh-wp-btn",
                      type: "button",
                      disabled: busy,
                      onClick: function () { saveConfig({ mode: config.mode, root: config.root }, "已重新扫描"); },
                    }, "重新扫描")
                  )
                : null,
              h(Grid, {
                items: snap.items,
                current: current,
                busy: busy,
                config: config,
                onPick: selectItem,
              })
            ),

        // ── 外观 ──
        h("section", { className: "dsh-wp-card" },
          h("h3", { className: "dsh-wp-title" }, "外观"),
          h(Slider, {
            label: "界面不透明",
            value: config.opacity, min: 0, max: 1, step: 0.01, busy: busy,
            display: function (v) { return Math.round(v * 100) + "%"; },
            onCommit: function (v) { saveConfig({ opacity: v }); },
          }),
          h(Slider, {
            label: "壁纸模糊",
            value: config.blur, min: 0, max: 40, step: 1, busy: busy,
            display: function (v) { return v + "px"; },
            onCommit: function (v) { saveConfig({ blur: v }); },
          }),
          h(Slider, {
            label: "压暗强度",
            value: config.dim, min: 0, max: 1, step: 0.01, busy: busy,
            display: function (v) { return Math.round(v * 100) + "%"; },
            onCommit: function (v) { saveConfig({ dim: v }); },
          }),
          h("div", { className: "dsh-wp-seg" }, FITS.map(function (fit) {
            return h("button", {
              key: fit.id,
              type: "button",
              className: config.fit === fit.id ? "is-on" : "",
              disabled: busy,
              onClick: function () { if (config.fit !== fit.id) saveConfig({ fit: fit.id }); },
            }, fit.label);
          })),
          h("p", { className: "dsh-wp-hint" },
            "「界面不透明」越低，壁纸越明显；调到 100% 等于只看壁纸不透明度、界面完全遮住它。"
          ),
          h("div", { className: "dsh-wp-row" },
            h("button", {
              className: "dsh-wp-btn",
              type: "button",
              disabled: busy || current === null,
              onClick: clearCurrent,
            }, "移除当前壁纸")
          )
        )
      );
    }

    // ─────────────────────────────────────────────────────────────
    // cordis 接线
    // ─────────────────────────────────────────────────────────────
    function apply(ctx) {
      injectStyle();
      var slots = ctx.get("slots");
      if (slots === undefined) return;

      // 壁纸层跟随全局状态：首次拉取后建一次，之后每次变更重算
      var lastKey = "";
      var unsubscribe = subscribe(function () {
        var snap = snapshot;
        // 只在"影响画面的字段"变化时碰 DOM，否则拖滑杆会连带重设背景图
        var key = JSON.stringify([
          snap.current === null ? null : snap.current.id,
          snap.current === null ? null : snap.current.mediaUrl,
          snap.config === null ? null : [snap.config.opacity, snap.config.blur, snap.config.dim, snap.config.fit],
        ]);
        if (key === lastKey) return;
        lastKey = key;
        if (snap.config !== null) applyWallpaper(snap.config, snap.current);
      });
      ctx.effect(function () { return unsubscribe; }, "dsh-wallpaper: layer subscription");
      loadState();

      // 设置弹框「主题管理」页面
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "dsh-wallpaper", order: 20, label: "主题管理" },
          function () { return h(ThemeSection); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = "dsh-wallpaper";
    return module.exports;
  }
});
