# 账号预计总费用告警探针

Node.js 18+，不依赖第三方 npm 包。

## 配置

复制 `.env.example` 为 `.env`，填写：

- `SUB2API_EMAIL`
- `SUB2API_PASSWORD`
- `WECOM_WEBHOOK_URL`

密码和企业微信 Webhook 只保存在本地 `.env`，不要提交到 Git。

## 运行

```powershell
node src/index.js --test
node src/index.js --once
```

`--test` 只检查本地配置，不访问远程接口。`--once` 执行一次完整巡检。

## 告警规则

- 所有可监控账号的“预计总费用”之和低于 `ESTIMATED_COST_THRESHOLD`。
- `OPENAI_GROUP_NAME` 分组下账号的“预计总费用”之和低于同一阈值。
- 单个账号 `5h` 或 `7d` 窗口剩余比例低于 `QUOTA_REMAIN_PERCENT`。
- 缺少 `5h` 窗口时，不发送 `5h` 告警。
- 相同告警在 `ALERT_COOLDOWN_MINUTES` 内只发送一次。

预计总费用与管理台一致：优先使用接口直接返回的预计总费用字段；否则在 7 日窗口的 `utilization` 和 `window_stats.cost` 都是大于 0 的有限数字时，按 `cost * 100 / utilization` 估算。不会用预付余额、钱包余额或配额余额替代。成功拿到用量但无法估算时按 0 计入。

用量查询也与管理台一致：Anthropic OAuth / Setup Token 使用 `source=passive`，其余会展示用量的账号走主动查询，并优先使用批量接口。管理台不查询用量的账号不参与合计，也不会让巡检失败。用量获取失败则中止本次巡检。

`OPENAI_GROUP_NAME` 必须与账号 `groups[].name` 的管理台显示一致。

## 测试

```powershell
node --test
```
