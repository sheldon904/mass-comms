# Database Schema

The application uses SQLite via Prisma ORM. The database file is stored at `prisma/dev.db`.

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────┐
│                       Company                            │
├─────────────────────────────────────────────────────────┤
│ id        String    @id @default(cuid())                │
│ name      String                                         │
│ filename  String                                         │
│ research  String                                         │
│ summary   String?                                        │
│ createdAt DateTime  @default(now())                     │
│ updatedAt DateTime  @updatedAt                          │
└─────────────────────────────────────────────────────────┘
          │
          │ 1:N
          ▼
┌─────────────────────────────────────────────────────────┐
│                       Contact                            │
├─────────────────────────────────────────────────────────┤
│ id        String    @id @default(cuid())                │
│ name      String                                         │
│ email     String                                         │
│ role      String?                                        │
│ companyId String    (FK → Company.id)                   │
└─────────────────────────────────────────────────────────┘
          │
          │ 1:N
          ▼
┌─────────────────────────────────────────────────────────┐
│                        Email                             │
├─────────────────────────────────────────────────────────┤
│ id        String    @id @default(cuid())                │
│ subject   String                                         │
│ body      String                                         │
│ status    String    @default("draft")                   │
│ purpose   String?                                        │
│ companyId String    (FK → Company.id)                   │
│ contactId String    (FK → Contact.id)                   │
│ sentAt    DateTime?                                      │
│ resendId  String?                                        │
│ createdAt DateTime  @default(now())                     │
│ updatedAt DateTime  @updatedAt                          │
└─────────────────────────────────────────────────────────┘
```

## Models

### Company

Stores uploaded research documents and company metadata.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | String | PK, cuid | Unique identifier |
| name | String | Required | Company name (from filename or frontmatter) |
| filename | String | Required | Original .md filename |
| research | String | Required | Full markdown content |
| summary | String | Optional | AI-extracted summary (not currently used) |
| createdAt | DateTime | Default: now() | Record creation timestamp |
| updatedAt | DateTime | Auto-updated | Last modification timestamp |

**Relations:**
- `contacts`: One-to-many with Contact
- `emails`: One-to-many with Email

---

### Contact

Stores contact information for outreach targets.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | String | PK, cuid | Unique identifier |
| name | String | Required | Contact's full name |
| email | String | Required | Email address |
| role | String | Optional | Job title (CEO, CTO, etc.) |
| companyId | String | FK, Required | Parent company reference |

**Relations:**
- `company`: Many-to-one with Company (cascade delete)
- `emails`: One-to-many with Email

---

### Email

Stores drafted and sent emails.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | String | PK, cuid | Unique identifier |
| subject | String | Required | Email subject line |
| body | String | Required | Email body (plain text) |
| status | String | Default: "draft" | Workflow status |
| purpose | String | Optional | User-specified intent |
| companyId | String | FK, Required | Target company reference |
| contactId | String | FK, Required | Target contact reference |
| sentAt | DateTime | Optional | When email was sent |
| resendId | String | Optional | Resend API message ID |
| createdAt | DateTime | Default: now() | Record creation timestamp |
| updatedAt | DateTime | Auto-updated | Last modification timestamp |

**Status Values:**
- `draft` - Generated but not reviewed
- `approved` - Approved and ready to send
- `sent` - Successfully delivered
- `failed` - Send attempt failed

**Relations:**
- `company`: Many-to-one with Company (cascade delete)
- `contact`: Many-to-one with Contact (cascade delete)

---

## Prisma Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Company {
  id        String    @id @default(cuid())
  name      String
  filename  String
  research  String
  summary   String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  contacts  Contact[]
  emails    Email[]
}

model Contact {
  id        String   @id @default(cuid())
  name      String
  email     String
  role      String?
  companyId String
  company   Company  @relation(fields: [companyId], references: [id], onDelete: Cascade)
  emails    Email[]
}

model Email {
  id        String    @id @default(cuid())
  subject   String
  body      String
  status    String    @default("draft")
  purpose   String?
  companyId String
  company   Company   @relation(fields: [companyId], references: [id], onDelete: Cascade)
  contactId String
  contact   Contact   @relation(fields: [contactId], references: [id], onDelete: Cascade)
  sentAt    DateTime?
  resendId  String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

---

## Common Queries

### Get all companies with contact counts

```typescript
const companies = await prisma.company.findMany({
  include: {
    _count: {
      select: { contacts: true },
    },
  },
  orderBy: { createdAt: "desc" },
});
```

### Get company with contacts and emails

```typescript
const company = await prisma.company.findUnique({
  where: { id: companyId },
  include: {
    contacts: {
      orderBy: { name: "asc" },
    },
    emails: {
      select: { status: true },
    },
  },
});
```

### Get emails grouped by status

```typescript
const emailStats = await prisma.email.groupBy({
  by: ["status"],
  _count: true,
});
```

### Get all draft emails with relations

```typescript
const emails = await prisma.email.findMany({
  where: { status: "draft" },
  include: {
    contact: {
      select: { name: true, email: true, role: true },
    },
    company: {
      select: { name: true },
    },
  },
  orderBy: { createdAt: "desc" },
});
```

---

## Migrations

### Create a new migration

```bash
npx prisma migrate dev --name description_of_changes
```

### Apply migrations in production

```bash
npx prisma migrate deploy
```

### Reset database (development only)

```bash
npx prisma migrate reset
```

### View database with Prisma Studio

```bash
npx prisma studio
```

---

## Cascade Delete Behavior

- Deleting a **Company** deletes all its Contacts and Emails
- Deleting a **Contact** deletes all Emails to that contact
- This is configured via `onDelete: Cascade` in the schema

---

## SQLite Considerations

1. **File-based**: Database is a single file (`prisma/dev.db`)
2. **No concurrent writes**: SQLite locks the file during writes
3. **Limited types**: No native JSON, UUID, or array types
4. **Portability**: Easy to back up (just copy the file)

For production with higher concurrency needs, consider migrating to PostgreSQL.
