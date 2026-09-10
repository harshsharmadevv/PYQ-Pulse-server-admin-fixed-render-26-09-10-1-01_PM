# PYQ Pulse — Admin API

The admin API is backed directly by Supabase. This server contains only admin authentication and admin endpoints; public/mobile APIs are not included.

## Authentication

Every `/api/admin/*` endpoint requires:

```http
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
```

The token user email must be present in the backend `.env`:

```env
ADMIN_EMAILS=admin@example.com
```

`SUPABASE_SERVICE_ROLE_KEY` stays server-side only.

## Recommended data-entry order

1. Create **Exam**
2. Create **Subject** under that exam
3. Create **Taxonomy nodes** (chapter/topic) under the subject/exam
4. Create **Questions** and link `examId`, `subjectId`, `topicId`
5. Create a **Set**
6. Add questions to the set with positions, or replace the complete set ordering
7. Set `isPublished: true` only when the set is ready for the app

The backend automatically recalculates:
- `exams.total_sets`
- `exams.total_questions_available`
- `exams.free_sets`
- `subjects.question_count`
- `sets.total_questions`

So these counters should not be manually maintained from the admin panel.

## Main endpoints

### Dashboard
- `GET /api/admin/dashboard`
- `GET /api/admin/health`

### Exams
- `GET /api/admin/exams`
- `POST /api/admin/exams`
- `PATCH /api/admin/exams/:id`
- `DELETE /api/admin/exams/:id`

Create example:

```json
{
  "id": "jee-main",
  "name": "JEE Main",
  "code": "JEE",
  "shortName": "JEE",
  "description": "Engineering entrance practice",
  "isActive": true,
  "isFeatured": true,
  "displayOrder": 1
}
```

### Subjects
- `GET /api/admin/subjects?examId=jee-main`
- `POST /api/admin/subjects`
- `PATCH /api/admin/subjects/:id`
- `DELETE /api/admin/subjects/:id`

Create example:

```json
{
  "id": "jee-main-physics",
  "name": "Physics",
  "examId": "jee-main",
  "nodeType": "SUBJECT",
  "slug": "physics",
  "displayOrder": 1
}
```

### Taxonomy
- `GET /api/admin/taxonomy`
- `GET /api/admin/taxonomy/:id`
- `POST /api/admin/taxonomy`
- `PATCH /api/admin/taxonomy/:id`
- `DELETE /api/admin/taxonomy/:id`

Create topic example:

```json
{
  "id": "jee-main-physics-kinematics",
  "parentId": null,
  "subjectId": "jee-main-physics",
  "examId": "jee-main",
  "name": "Kinematics",
  "nodeType": "TOPIC",
  "slug": "kinematics",
  "displayOrder": 1
}
```

### Questions
- `GET /api/admin/questions`
- `GET /api/admin/questions/:id`
- `POST /api/admin/questions`
- `POST /api/admin/questions/bulk`
- `PATCH /api/admin/questions/:id`
- `DELETE /api/admin/questions/:id`

Create example:

```json
{
  "questionId": "JEE-MAIN-2025-PHY-0001",
  "stem": "What is the SI unit of force?",
  "questionType": "MCQ",
  "difficulty": 1,
  "sourceYear": 2025,
  "examName": "JEE Main",
  "examId": "jee-main",
  "subjectId": "jee-main-physics",
  "topicId": "jee-main-physics-kinematics",
  "options": {
    "A": "Joule",
    "B": "Newton",
    "C": "Watt",
    "D": "Pascal"
  },
  "correctOption": "B",
  "explanation": "The SI unit of force is Newton.",
  "hasImage": false
}
```

For MCQ questions, `correctOption` and non-empty `options` are required.

Bulk questions:

```json
{
  "questions": [
    {
      "questionId": "JEE-MAIN-2025-PHY-0001",
      "stem": "What is the SI unit of force?",
      "questionType": "MCQ",
      "options": {
        "A": "Joule",
        "B": "Newton",
        "C": "Watt",
        "D": "Pascal"
      },
      "correctOption": "B",
      "examId": "jee-main",
      "subjectId": "jee-main-physics"
    }
  ]
}
```

Maximum bulk size: 500 questions.

### Sets
- `GET /api/admin/sets`
- `GET /api/admin/sets/:id`
- `POST /api/admin/sets`
- `PATCH /api/admin/sets/:id`
- `DELETE /api/admin/sets/:id`

Create example:

```json
{
  "id": "jee-main-2025-physics-set-1",
  "name": "JEE Main Physics 2025 — Set 1",
  "examId": "jee-main",
  "examName": "JEE Main",
  "subjectId": "jee-main-physics",
  "setType": "PYQ",
  "year": 2025,
  "isFree": true,
  "isPublished": false,
  "accessStatus": "free"
}
```

A set can also be created with:

```json
{
  "...": "...",
  "questionIds": [
    "QUESTION_UUID_1",
    "QUESTION_UUID_2"
  ]
}
```

### Set ↔ Questions
- `GET /api/admin/sets/:setId/questions`
- `POST /api/admin/sets/:setId/questions`
- `POST /api/admin/sets/:setId/questions/bulk`
- `PUT /api/admin/sets/:setId/questions`
- `DELETE /api/admin/sets/:setId/questions/:questionId`

For complete replacement/reordering, `PUT` is the safest option:

```json
{
  "questionIds": [
    "QUESTION_UUID_1",
    "QUESTION_UUID_2",
    "QUESTION_UUID_3"
  ]
}
```

Positions are generated as `1, 2, 3...`.

### App config
- `GET /api/admin/app-config`
- `PUT /api/admin/app-config/:key`
- `DELETE /api/admin/app-config/:key`

Example:

```json
{
  "value": {
    "market_enabled": true,
    "mock_enabled": true,
    "review_enabled": true,
    "maintenance_mode": false
  }
}
```

### Banners
- `GET /api/admin/banners`
- `POST /api/admin/banners`
- `PATCH /api/admin/banners/:id`
- `DELETE /api/admin/banners/:id`

### Subscription plans
- `GET /api/admin/subscription-plans`
- `POST /api/admin/subscription-plans`
- `PATCH /api/admin/subscription-plans/:id`
- `DELETE /api/admin/subscription-plans/:id`

### Market products
- `GET /api/admin/market-products`
- `POST /api/admin/market-products`
- `PATCH /api/admin/market-products/:id`
- `DELETE /api/admin/market-products/:id`

### Mode rules
- `GET /api/admin/mode-rules`
- `POST /api/admin/mode-rules`
- `PATCH /api/admin/mode-rules/:id`
- `DELETE /api/admin/mode-rules/:id`

### Orders (read-only)
- `GET /api/admin/orders`
- `GET /api/admin/orders/:id`

Orders are read from `public.order_intents`. No order mutation endpoint is exposed because the supplied schema does not define an admin order-management workflow.

### Users (read-only admin view)
- `GET /api/admin/users`
- `GET /api/admin/users/:id`

## Public fetch endpoints that consume admin data

After admin data is saved, the existing public APIs read the same Supabase tables:

- `GET /api/app-config`
- `GET /api/banners`
- `GET /api/exams`
- `GET /api/sets`
- `GET /api/market-products`
- `GET /api/subscription-plans`
- `GET /api/taxonomy/subjects`
- `GET /api/taxonomy/tree`
- `GET /api/subjects/shortcuts`
- `GET /api/subjects/taxonomy`
- `GET /api/mode-rules/resolve?mode=practice`
- `POST /api/practice-builder/metadata`

Published/active flags still control public visibility:
- exam → `isActive`
- banner → `isActive`
- set → `isPublished`
- product → `isActive`
- subscription plan → `isActive`

## Important

The server accepts camelCase fields and also accepts the corresponding snake_case names on admin writes. Admin responses are normalized to camelCase, matching the public API contract.

The `.env` file is intentionally not included in the repaired distribution. Keep your existing `.env` beside `server.js`, or copy `.env.example` to `.env` and fill in your Supabase values.
