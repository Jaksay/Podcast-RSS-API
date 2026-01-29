# PodRSS_API

[![Docker 镜像](https://img.shields.io/docker/v/jaksay/podcast-rss-api?sort=semver)](https://hub.docker.com/r/jaksay/podcast-rss-api)

[English](README.md) | 中文

一个播客 RSS 解析服务，提供频道概览与分集列表接口，并内置简单的网页测试工具。

## 接口

- `GET /api/podcast?url=<rss_url>`
  - 解析频道基础信息
  - 缓存 48 小时（无数据不缓存），`refresh=1` 跳过缓存
  - 说明：缓存通过 `Cache-Control` 响应头实现，是否生效取决于部署环境是否有缓存层
- 返回字段：`podcast`（`name`、`author`、`rss`、`image`、`website`、`description_html`、`description_text`）
- 示例响应：
  ```json
  {
    "podcast": {
      "name": "示例播客",
      "author": "播客作者",
      "rss": "https://example.com/feed.xml",
      "image": "https://example.com/cover.jpg",
      "website": "https://example.com",
      "description_html": "<p>频道简介...</p>",
      "description_text": "频道简介..."
    }
  }
  ```
- `GET /api/podcast/episodes?url=<rss_url>&cursor=0&limit=10`
  - 返回频道信息与游标分页分集列表
  - 缓存 36 小时（当前页无数据不缓存）
  - 可选参数：`refresh=1` 强制刷新
- 返回字段：`podcast`、`pagination`（`cursor`、`limit`、`nextCursor`、`hasMore`）、`episodes`（`id`、`title`、`author`、`publishedAt`、`duration`、`audio`、`image`、`description_html`、`description_text`、`url`、`link`、`guid`）
- 示例响应：
  ```json
  {
    "podcast": {
      "name": "示例播客",
      "author": "播客作者",
      "rss": "https://example.com/feed.xml",
      "image": "https://example.com/cover.jpg",
      "website": "https://example.com",
      "description_html": "<p>频道简介...</p>",
      "description_text": "频道简介..."
    },
    "pagination": {
      "cursor": 0,
      "limit": 10,
      "nextCursor": 10,
      "hasMore": true
    },
    "episodes": [
      {
        "id": "episode_hash",
        "title": "第 1 集",
        "author": "主持人",
        "publishedAt": 1736856000000,
        "duration": "01:02:03",
        "audio": "https://cdn.example.com/audio.mp3",
        "image": "https://example.com/episode.jpg",
        "description_html": "<p>完整 show notes</p>",
        "description_text": "纯文本简介",
        "url": "https://example.com/episode",
        "link": "https://example.com/episode",
        "guid": "episode_guid"
      }
    ]
  }
  ```

## 常规部署

1. 安装依赖
   ```bash
   npm install
   ```
2. 配置环境变量（必填）
   - 复制 `.env.example` 为 `.env` 并填写
   ```bash
   cp .env.example .env
   ```
3. 启动服务
   ```bash
   npm start
   ```

访问：
- 首页说明与入口：`http://localhost:3000/`
- 测试工具：`http://localhost:3000/test.html`

## 使用 Docker 部署

1. 拉取镜像（推荐）
   ```bash
   docker pull jaksay/podcast-rss-api:latest
   ```
2. 运行容器
   ```bash
   docker run -d -p 3000:3000 -e API_KEY=你的密钥 --name podrss-api jaksay/podcast-rss-api:latest
   ```
3. 或本地构建
   ```bash
   docker build -t podrss-api .
   ```
   ```bash
   docker run -d -p 3000:3000 -e API_KEY=你的密钥 --name podrss-api-local podrss-api
   ```
4. 访问：
   - 首页说明与入口：`http://localhost:3000/`
   - 测试工具：`http://localhost:3000/test.html`

## 部署到 Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Jaksay/Podcast-RSS-API&env=API_KEY)

1. 在 Vercel 新建项目并导入仓库。
2. 设置环境变量：
   - `API_KEY`：接口鉴权密钥（必填）
   - `PORT`：可不设置（Vercel 会自动分配）
3. 部署完成后，按同样路径访问：
   - `/` 首页
   - `/test.html` 测试工具
   - `/api/podcast` 接口

## 鉴权

所有 `/api` 请求必须携带（以下二选一）：
- Header：`X-API-Key: <你的密钥>`
- Query：`?api_key=<你的密钥>`

若未配置 `API_KEY`，接口会返回 500 并提示配置。
