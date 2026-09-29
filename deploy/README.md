# 监控面板域名入口

## 已部署结构

`alertboard.string.ink:443` 由宿主机 Nginx 处理，反向代理到 `https://127.0.0.1:18443`，再通过现有监控网关进入面板。

- 站点配置：`/etc/nginx/sites-available/alertboard.string.ink.conf`。
- 启用链接：`/etc/nginx/sites-enabled/zz-alertboard.string.ink.conf`。保留既有默认站点顺序。
- 源站证书：`/etc/nginx/ssl/alertboard.string.ink/origin.crt`。
- 源站私钥：`/etc/nginx/ssl/alertboard.string.ink/origin.key`，`root:root`、`0600`，父目录 `0700`。
- 该证书仅覆盖 `alertboard.string.ink`，不是泛域名证书；有效期至 2041-09-25 UTC。
- 原监控网关、账密认证及 `18443` 入口不变。宿主机代理验证本机网关的自签名证书；更换网关证书后也要验证并重载宿主机 Nginx。
- 不修改 `testai.string.ink` 和 `jp.string.ink` 的配置。

证书和私钥不放入仓库。`install-alertboard-domain.sh` 是当前服务器的首次安装脚本，接受服务器上的 PEM 文件和站点配置文件路径；若目标已存在则拒绝覆盖。源站核验通过不等于 Cloudflare 公网链路已通过。

## Cloudflare 配置与状态

2026-09-29 部署后，源站 HTTPS 验证成功，公网 HTTPS 请求返回重定向到自身的 `308`。这与 HTTP 回源冲突相符；未登录 Cloudflare 控制台确认具体规则，不能断言一定是全局 Flexible 模式。

2026-09-29 用户完成该子域名的 Cloudflare 配置规则后，公网复测通过，HTTPS 循环跳转已消失。截图确认规则匹配 `alertboard.string.ink` 且处于活动状态；截图未展示具体 SSL 模式值。

部署所用的配置步骤如下，仅匹配此子域名，避免改动整个 `string.ink`：

1. 在 Cloudflare 选择 `string.ink`，进入「规则」→「概述」→「创建规则」→「配置规则」。
2. 条件：主机名等于 `alertboard.string.ink`，或表达式 `(http.host eq "alertboard.string.ink")`。
3. 设置 `SSL` 为 `Strict`（对应 `Full (strict)`，即「完全（严格）」），然后部署。
4. 保持该 DNS 记录的代理开启。若已有匹配该域名的 SSL 配置规则或回源端口覆盖，先检查冲突，确保 HTTPS 回源到 `443`。

不要为绕过回源问题而删除登录认证、关闭证书验证或允许明文传输面板账号密码。

官方说明：
- https://developers.cloudflare.com/rules/configuration-rules/create-dashboard/
- https://developers.cloudflare.com/rules/configuration-rules/settings/
- https://developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/

## 核验结果与完成标准

部署当次已验证：Nginx 语法通过；源站证书链、域名及私钥配对通过；源站 `/healthz` 返回 `200` / `ok`；未登录访问首页、脚本、样式和接口返回 `401`；后端对应资源返回 `200`；两个既有站点返回 `200` 且配置校验和不变。

2026-09-29 Cloudflare 设置完成后的公网复测结果：

- HTTPS 首页返回 `401`，包含 `WWW-Authenticate: Basic realm="String Operations"`，现有登录保护正常。
- HTTPS `/healthz` 返回 `200`，响应正文为 `ok`。
- 未登录访问 `/vendor/vue.global.prod.js`、`/monitor-view.js`、`/monitor.css`、`/api/schedule` 均返回 `401`，没有因新增入口而绕过认证。
- HTTP 首页返回 `308`，跟随跳转后仅经过一次重定向即到达 HTTPS 登录保护页（`401`），未再出现循环。
- HTTPS 请求未关闭客户端证书验证；公网响应包含 Cloudflare 服务头。
- 尚未使用用户真实账密完成浏览器登录，因此上述结果不等于已验证登录后的完整交互。

后续可使用以下命令复查：

```sh
curl --max-time 20 -I https://alertboard.string.ink/
curl --max-time 20 https://alertboard.string.ink/healthz
```

预期：首页 `401` 且带有 `WWW-Authenticate: Basic realm="String Operations"`；健康检查返回 `ok`，不应返回 HTML 或 `308`。再由用户使用原有账密验证页面、JS/CSS 和接口。不能把只检查后端资源视为已完成真实用户登录测试。
