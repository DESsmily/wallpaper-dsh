# dsh-wallpaper

给 dsh（DeepSeek Harness）Web 界面加一个 **主题管理** 设置页：换壁纸，并让界面半透明地浮在壁纸之上。

支持四种壁纸来源、静态图与视频、以及不透明度 / 模糊 / 压暗 / 铺满方式四项外观微调。

## 功能

**设置 → 主题管理** 里有三块：

### 壁纸来源

| 来源 | 说明 |
| --- | --- |
| 关闭 | 恢复 dsh 原生外观 |
| 本地文件夹 | 扫该目录及**一级子目录**下的图片/视频 |
| Wallpaper Engine | 指到 Steam 根目录即可，自动定位工坊内容 |
| 单个文件 | 一个图片或视频的绝对路径 |
| 图片链接 | 远端 `http(s)` 链接，浏览器直连 |

Wallpaper Engine 那项，填 `D:\Software\Steam`、`...\steamapps\workshop\content`、
`...\content\431960` 或某个具体壁纸项目目录都能自动定位，不用精确到 `431960`。

工坊里的 **视频** 类型壁纸直接用原视频循环播放；**场景 / 网页 / 应用** 类型浏览器放不了
（`.pkg` 场景包、`.html` 网页场景），所以取该项目的预览图当静态壁纸。列表里有角标区分。

### 壁纸选择

网格展示扫到的壁纸，点一下即应用。缩略图懒加载，一次扫到几百张也不会卡。

### 外观

- **界面不透明** — 越低壁纸越明显；100% 时界面完全遮住壁纸
- **壁纸模糊** — 0–40px，柔化背景突出前景文字
- **压暗强度** — 提高前景文字在亮壁纸上的可读性
- **铺满方式** — 铺满裁剪 / 完整显示 / 拉伸填满

## 安装

**从源码本地安装（跨盘符）** —— Windows 上 pnpm 会把 `link:D:/...` 的盘符路径当成
相对路径拼到 profile 目录下，链接会指到不存在的位置。绕开它的办法是先在 profile 里
建一个同盘符的 junction：

```sh
PROFILE="$DSH_HOME/profiles/web"        # 未设置 DSH_HOME 时用 ~/.dsh
mkdir -p "$PROFILE/local-plugins"
cmd //c "mklink /J \"$PROFILE\\local-plugins\\dsh-wallpaper\" D:\\DownLoads\\wallpaper-dsh"

dsh plugin --profile web add "dsh-wallpaper@link:./local-plugins/dsh-wallpaper"
```

`dsh plugin add` 会自动把包加进 `package.json` 的 `dsh.profile.bundles`（因为本包声明了
`dsh.bundle`）。如果没加，手工补一条：

```json
{ "dsh": { "profile": { "bundles": ["…", "dsh-wallpaper"] } } }
```

**从 npm 安装**：暂未发布

重启 dsh 后，设置弹框左侧会多出「主题管理」。启动日志有
`[dsh-wallpaper] 主题管理已挂载` 即为加载成功。

## 配置存放

`$DSH_HOME/dsh-wallpaper-theme.json`（`DSH_HOME` 未设置时用 `~/.dsh`）。

选中的壁纸记录也在里面，所以重启后壁纸仍在。手改坏了不会导致启动失败 —— 脏字段一律回退默认值。

## 实现说明

插件是**双半**结构，与 dsh-hud 同形态：

| 文件 | 运行环境 | 职责 |
| --- | --- | --- |
| `lib/index.js` | Node（host） | HTTP 路由、配置持久化、媒体转发 |
| `lib/scan.js` | Node | 四种来源的扫描与归一 |
| `lib/client.js` | 浏览器 | 设置页 UI、壁纸层与半透明样式 |

`lib/client.js` 是**手写的 lazy-CJS bundle**，没有构建步骤 —— 官方要求的形态就是
`window.__ModuleLoader__.load({ id, factory })`，所以直接手写、不引入打包器。

host 半**不 import 任何 `@deepseek-ai/*`**，只用 node 内置模块。插件的 peer 依赖在
profile 的 `node_modules` 下不一定可解析，只依赖内置模块可以确保任何部署下都能加载。

### 壁纸是怎么画上去的

dsh 的背景画在 `body{background:var(--dsw-alias-bg-base)}` 上，而 `html` 是透明的。所以：

1. **静态图** 放 `<html>` 的 `background-image`，压暗用一层 `linear-gradient` 叠在图片之上（不插 DOM、不玩 z-index）。
2. **视频** 放一个 `<div id="dsh-wallpaper-layer">`，**挂在 `<html>` 下**、`z-index:-1`。挂 `<body>` 下会被 body 自己的背景整个遮住。
3. 把 `body` 上的背景类 token 覆写成半透明，界面就透出底下的壁纸。

覆写用的是 `--dsw-alias-bg-base`、`-layer-1/2/3`、`-overlay` 和 `--dsw-specific-sidebar-fill`
（侧栏单独用后者，不覆写它侧栏会整块不透明）。规则写在 `html.dsh-wallpaper-on body` 上而不是
`html` 上 —— 这套 token 由主题声明在 `body`，写在 `html` 上继承不过去。

暗色模式的开关是 `body[data-ds-dark-theme]` 属性（不是 `html` 上的 class），所以暗色覆写挂在属性选择器上。

### 安全

`/media` 是唯一能读到磁盘任意文件的面，做了两道闸：

- 扩展名必须在受支持列表内
- `realpath` 归一后必须落在**当前生效来源**的根目录内（`/a/bc` 不会匹配 `/a/b`）

写接口另有同源校验（`Origin.host === Host`），防止浏览器里第三方页面跨站改写壁纸根目录后借 `/media` 读本机文件。

浏览器**拿不到磁盘绝对路径** —— 服务端只下发拼好的 `/media?path=...` URL。

## 开发

```sh
npm test               # 三个套件依次跑
```

| 脚本 | 覆盖 |
| --- | --- |
| `test-scan.mjs` | 四种来源的扫描产物形状、路径白名单判定 |
| `test-host.mjs` | 路由全链路（含越权读、跨站写、Range、脏参数清洗） |
| `test-client.mjs` | bundle 格式、插槽注册、组件各分支渲染、壁纸层 DOM 副作用 |

三个脚本零依赖，只用 node 内置模块。`test-host.mjs` 用临时 `DSH_HOME`，不会碰真实配置。
默认读本机 `D:\Software\Steam` 下的 Wallpaper Engine 库，换机器用 `DSH_WP_TEST_LIB` 覆盖：

```sh
DSH_WP_TEST_LIB="E:\\Steam" npm test
```

这几个套件不是装饰 —— 它们抓到过扫描层漏掉视频项目、同源校验误拦局域网访问、
以及壁纸图层挂错父节点（挂到 `<body>` 下会被 body 背景遮住）等问题。

## 许可

MIT
