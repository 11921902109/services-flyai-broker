# FlyAI broker

Travelworld 的服务端 FlyAI 代理。它只通过官方 `@fly-ai/flyai-cli@1.0.16` 访问飞猪服务，不在浏览器或 Sites Worker 中暴露 FlyAI 密钥。

## 运行

需要 Node.js 18 或更高版本。

```bash
npm install
npm start
```

部署平台必须配置：

- `FLYAI_API_KEY`：FlyAI 服务端密钥。仅传给官方 CLI 子进程。
- `BROKER_SHARED_TOKEN`：至少 24 个字符的随机共享令牌，由 Travelworld 服务端使用。

可选：

- `PORT`：默认 `8788`。
- `HOST`：默认 `0.0.0.0`。
- `MAX_CONCURRENT_SEARCHES`：默认 `4`，范围 `1-16`。

生产环境应由容器或平台网关终止 HTTPS，并把两个密钥保存在平台的 Secret Manager 中。不要把 broker URL 当作公开的浏览器 API，也不要将共享令牌放到前端代码。

## HTTP 接口

### 健康检查

`GET /health`

### 搜索

`POST /v1/search`

请求头：

```text
Authorization: Bearer <BROKER_SHARED_TOKEN>
Content-Type: application/json
```

酒店查询：

```json
{
  "action": "hotel",
  "params": {
    "destName": "Singapore",
    "keyWords": "Village Hotel Bugis",
    "checkInDate": "2026-10-20",
    "checkOutDate": "2026-10-22"
  }
}
```

酒店可选字段为 `poiName`、`hotelTypes`、`sort`、`hotelStars`、`hotelBedTypes` 和 `maxPrice`。入住与退房日期必须成对提供。

景点查询：

```json
{
  "action": "poi",
  "params": {
    "cityName": "Singapore",
    "keyword": "Gardens by the Bay"
  }
}
```

景点可选字段为 `poiLevel` 和官方 CLI 支持的 `category`。

关键词查询：

```json
{
  "action": "keyword",
  "params": {
    "query": "新加坡滨海湾花园门票"
  }
}
```

成功响应保留官方 CLI 的结果结构：

```json
{
  "ok": true,
  "action": "hotel",
  "result": {
    "data": {}
  }
}
```

错误响应不包含上游密钥、命令行或原始 stderr：

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_PARAMS",
    "message": "params.destName must be a string."
  }
}
```

## 安全边界

- 仅开放 `hotel`、`poi` 和 `keyword` 三个 action。
- 拒绝未声明字段，对长度、枚举、日期和数值范围做严格校验。
- 官方 CLI 使用参数数组启动，`shell: false`，不接受自定义命令。
- 单次请求超时 30 秒，请求体上限 32 KiB，标准输出上限 2 MiB。
- 不开启 CLI debug，不记录请求体或密钥，不向调用方返回原始 stderr。
- 飞猪结果可能没有价格；上层应保留原有 Google Maps 行程，将价格作为非阻断的增强信息。
