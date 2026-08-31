# Roamie Backend

Node.js/TypeScript backend for Roamie.

## Prerequisites

- Node.js 18+ (recommended Node 20+)
- npm
- A PostgreSQL database

## 1) Install dependencies

```bash
npm install
```

## 2) Configure environment

Create a `.env` file in `backend/` with the following keys:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME

LINQ_API_TOKEN=your_linq_token
LINQ_API_BASE_URL=https://your-linq-base-url
LINQ_FROM_PHONE=+1XXXXXXXXXX
LINQ_WEBHOOK_SECRET=optional_webhook_secret

OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
OPENAI_VISION_MODEL=gpt-4o-mini
OPENAI_TRANSCRIPTION_MODEL=whisper-1

RECEIPT_PARSE_ENABLED=true
VOICE_PARSE_ENABLED=true

TRUST_PROXY=true
WEBHOOK_RATE_LIMIT_PER_MINUTE=300
LINQ_MIN_MS_BETWEEN_SENDS=550
BUDGET_WARNING_PERCENT=80
```

Notes:
- `DATABASE_URL`, `LINQ_API_TOKEN`, `LINQ_API_BASE_URL`, `LINQ_FROM_PHONE`, and `OPENAI_API_KEY` are required.
- `LINQ_WEBHOOK_SECRET` and `ADMIN_DEBUG_TOKEN` are optional.

## 3) Generate Prisma client

```bash
npm run prisma:generate
```

## 4) Run database migrations

```bash
npm run prisma:migrate
```

## 5) Start in development mode

```bash
npm run dev
```

Expected log:

`Roamie is listening on port 3000`

## Production run

Build:

```bash
npm run build
```

Start:

```bash
npm run start
```

## Useful commands

- Run tests: `npm test`
- Watch tests: `npm run test:watch`
- Open Prisma Studio: `npm run prisma:studio`
