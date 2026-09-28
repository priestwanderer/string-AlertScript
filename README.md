# 账号预计总费用告警探针

Node.js 18+，不依赖第三方 npm 包。

## 配置

复制 `.env.example` 为 `.env`，填写：

- `WECOM_WEBHOOK_URL`
- `SUB2API_SERVERS`，以及每台服务器的地址、账号和密码

密码和企业微信 Webhook 只保存在本地 `.env`，不要提交到 Git。

可以同时监控多台服务器。`SUB2API_SERVERS` 用英文逗号分隔服务器标识，例如 `main,backup`。每台服务器使用自己的 `SUB2API_SERVER_<标识大写>_BASE_URL`、`EMAIL`、`PASSWORD` 和可选的 `NAME`。告警文本会带上对应服务器名称，同一条告警在不同服务器上分别计算静默时间。

只监控一台时可以不填 `SUB2API_SERVERS`，改填 `SUB2API_BASE_URL`、`SUB2API_EMAIL`、`SUB2API_PASSWORD`。地址没有代码内置默认值，必须写在 `.env` 中。

某台服务器巡检失败时，其他服务器仍会继续检查。失败原因会作为该服务器的一条告警。单次巡检因此以非 0 状态退出；定时巡检记录失败后继续下一轮。

## 运行

```powershell
node src/index.js --test
node src/index.js --once
npm run hourly
```

`--test` 只检查本地配置，不访问远程接口。`--once` 和 `npm start` 执行一次完整巡检。`npm run hourly` 会先立即检查一次，然后按 `CHECK_INTERVAL_MINUTES` 重复检查，默认 60 分钟。没有新的异常时不发送企业微信消息；定时进程遇到单次失败会保留下来，等下一轮继续检查。

## 告警规则

- 所有可监控账号的“预计总费用”之和低于 `ESTIMATED_COST_THRESHOLD`。
- `platform` 为 OpenAI 的账号“预计总费用”之和低于同一阈值。按平台统计，不区分具体分组。
- 单个账号 `5h` 或 `7d` 窗口剩余比例低于 `QUOTA_REMAIN_PERCENT`。
- 缺少 `5h` 窗口时，不发送 `5h` 告警。
- 相同告警在 `ALERT_COOLDOWN_MINUTES` 内只发送一次。

预计总费用与管理台一致：优先使用接口直接返回的预计总费用字段；否则在 7 日窗口的 `utilization` 和 `window_stats.cost` 都是大于 0 的有限数字时，按 `cost * 100 / utilization` 估算。不会用预付余额、钱包余额或配额余额替代。成功拿到用量但无法估算时按 0 计入。

用量查询也与管理台一致：Anthropic OAuth / Setup Token 使用 `source=passive`，其余会展示用量的账号走主动查询，并优先使用批量接口。管理台不查询用量的账号不参与合计，也不会让巡检失败。某台服务器的用量获取失败时，不使用残缺数据计算该服务器的费用，并单独报告这台服务器巡检失败。

## 测试

```powershell
node --test
```
