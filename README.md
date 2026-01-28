# PodRSS_API

English | [中文](README.zh-CN.md)

A podcast RSS parsing service that provides channel overview and episode list APIs, with a simple web test page.

## API

- `GET /api/podcast?url=<rss_url>`
  - Parse podcast channel metadata
  - Cache for 5 hours (no cache if empty), `refresh=1` to bypass cache
  - Note: caching relies on `Cache-Control` headers and depends on your deployment cache layer
- Response fields: `podcast` (`name`, `author`, `rss`, `image`, `website`, `description`)
- Example:
  ```json
  {
    "podcast": {
      "name": "Sample Podcast",
      "author": "Podcast Author",
      "rss": "https://example.com/feed.xml",
      "image": "https://example.com/cover.jpg",
      "website": "https://example.com",
      "description": "<p>Channel description...</p>"
    }
  }
  ```
- `GET /api/podcast/episodes?url=<rss_url>&cursor=0&limit=10`
  - Return channel info with cursor-based episode list
  - Cache for 36 hours (no cache if empty page)
  - Optional: `refresh=1` to bypass cache
- Response fields: `podcast`, `pagination` (`cursor`, `limit`, `nextCursor`, `hasMore`), `episodes` (`title`, `author`, `publishedAt`, `duration`, `audio`, `image`, `description`, `intro`, `url`, `link`)
- Example:
  ```json
  {
    "podcast": {
      "name": "Sample Podcast",
      "author": "Podcast Author",
      "rss": "https://example.com/feed.xml",
      "image": "https://example.com/cover.jpg",
      "website": "https://example.com",
      "description": "<p>Channel description...</p>"
    },
    "pagination": {
      "cursor": 0,
      "limit": 10,
      "nextCursor": 10,
      "hasMore": true
    },
    "episodes": [
      {
        "title": "Episode 1",
        "author": "Host",
        "publishedAt": 1736856000000,
        "duration": "01:02:03",
        "audio": "https://cdn.example.com/audio.mp3",
        "image": "https://example.com/episode.jpg",
        "description": "<p>Full show notes</p>",
        "intro": "Plain text summary",
        "url": "https://example.com/episode",
        "link": "https://example.com/episode"
      }
    ]
  }
  ```

## Standard Deployment

1. Install dependencies
   ```bash
   npm install
   ```
2. Configure environment variables (required)
   - Copy `.env.example` to `.env` and fill it in
   ```bash
   cp .env.example .env
   ```
3. Start the service
   ```bash
   npm start
   ```

Access:
- Home: `http://localhost:3000/`
- Test page: `http://localhost:3000/test.html`

## Deploy with Docker

1. Pull image (recommended)
   ```bash
   docker pull jaksay/podcast-rss-api:latest
   ```
2. Run container
   ```bash
   docker run -d -p 3000:3000 -e API_KEY=your_key --name podrss-api jaksay/podcast-rss-api:latest
   ```
3. Or build locally
   ```bash
   docker build -t podrss-api .
   ```
   ```bash
   docker run -d -p 3000:3000 -e API_KEY=your_key --name podrss-api-local podrss-api
   ```
4. Access:
   - `http://localhost:3000/`
   - `http://localhost:3000/test.html`

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Jaksay/Podcast-RSS-API&env=API_KEY)

1. Create a new project on Vercel and import the repository.
2. Set environment variables:
   - `API_KEY`: API auth key (required)
   - `PORT`: optional (Vercel assigns one automatically)
3. After deployment, access:
   - `/` home
   - `/test.html` test page
   - `/api/podcast` API

## Authentication

All `/api` requests must include one of the following:
- Header: `X-API-Key: <your_key>`
- Query: `?api_key=<your_key>`

If `API_KEY` is not configured, the API returns 500 with a configuration error.
