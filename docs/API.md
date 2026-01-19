# API Reference

All API routes are located under `/app/api/` and follow Next.js 14 Route Handler conventions.

## Base URL

```
http://localhost:3000/api
```

---

## Upload

### POST /api/upload

Upload a markdown research file to create or update a company.

**Request**

```
Content-Type: multipart/form-data
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| filename | string | Yes | Original filename (e.g., `acme-corp.md`) |
| content | string | Yes | Full markdown content of the file |

**Response**

```json
{
  "company": {
    "id": "clx1234567890",
    "name": "Acme Corp",
    "filename": "acme-corp.md",
    "research": "# Acme Corp\n\nResearch content...",
    "summary": null,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  },
  "created": true
}
```

If a company with the same filename exists, it will be updated:

```json
{
  "company": { ... },
  "updated": true
}
```

**Errors**

| Status | Description |
|--------|-------------|
| 400 | Missing filename or content |
| 500 | Database error |

---

## Contacts

### POST /api/contacts

Create a new contact for a company.

**Request**

```json
{
  "name": "Jane Doe",
  "email": "jane@acme.com",
  "role": "CEO",
  "companyId": "clx1234567890"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Contact's full name |
| email | string | Yes | Contact's email address |
| role | string | No | Job title or role |
| companyId | string | Yes | Parent company ID |

**Response**

```json
{
  "contact": {
    "id": "clx0987654321",
    "name": "Jane Doe",
    "email": "jane@acme.com",
    "role": "CEO",
    "companyId": "clx1234567890"
  }
}
```

**Errors**

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 500 | Database error |

---

### GET /api/contacts

List all contacts, optionally filtered by company.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| companyId | string | No | Filter by company ID |

**Response**

```json
{
  "contacts": [
    {
      "id": "clx0987654321",
      "name": "Jane Doe",
      "email": "jane@acme.com",
      "role": "CEO",
      "companyId": "clx1234567890"
    }
  ]
}
```

---

### PUT /api/contacts/[id]

Update an existing contact.

**Request**

```json
{
  "name": "Jane Smith",
  "email": "jane.smith@acme.com",
  "role": "CTO"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Contact's full name |
| email | string | Yes | Contact's email address |
| role | string | No | Job title or role |

**Response**

```json
{
  "contact": {
    "id": "clx0987654321",
    "name": "Jane Smith",
    "email": "jane.smith@acme.com",
    "role": "CTO",
    "companyId": "clx1234567890"
  }
}
```

---

### DELETE /api/contacts/[id]

Delete a contact.

**Response**

```json
{
  "success": true
}
```

---

## Draft

### POST /api/draft

Generate a personalized email draft using Claude AI.

**Request**

```json
{
  "companyId": "clx1234567890",
  "contactId": "clx0987654321",
  "purpose": "Introduce our consulting services and schedule a discovery call"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| companyId | string | Yes | Target company ID |
| contactId | string | Yes | Target contact ID |
| purpose | string | Yes | Intent/goal of the email |

**Response**

```json
{
  "email": {
    "id": "clx5555555555",
    "subject": "Partnership Opportunity for Acme Corp",
    "body": "Hi Jane,\n\nI noticed Acme Corp recently...",
    "status": "draft",
    "purpose": "Introduce our consulting services...",
    "companyId": "clx1234567890",
    "contactId": "clx0987654321",
    "sentAt": null,
    "resendId": null,
    "createdAt": "2024-01-15T11:00:00.000Z",
    "updatedAt": "2024-01-15T11:00:00.000Z"
  }
}
```

**Errors**

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 404 | Company or contact not found |
| 500 | Claude API error or database error |

---

## Emails

### PUT /api/emails/[id]

Update an email (edit content or change status).

**Request**

```json
{
  "subject": "Updated Subject Line",
  "body": "Updated email body...",
  "status": "approved"
}
```

All fields are optional. Only provided fields will be updated.

| Field | Type | Description |
|-------|------|-------------|
| subject | string | Email subject line |
| body | string | Email body content |
| status | string | One of: `draft`, `approved`, `sent`, `failed` |

**Response**

```json
{
  "email": {
    "id": "clx5555555555",
    "subject": "Updated Subject Line",
    "body": "Updated email body...",
    "status": "approved",
    ...
  }
}
```

---

### DELETE /api/emails/[id]

Delete an email draft.

**Response**

```json
{
  "success": true
}
```

---

## Send

### POST /api/send

Send one or more approved emails via Resend.

**Request**

```json
{
  "emailIds": ["clx5555555555", "clx6666666666"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| emailIds | string[] | Yes | Array of email IDs to send |

**Response**

```json
{
  "results": [
    {
      "id": "clx5555555555",
      "success": true,
      "resendId": "abc123"
    },
    {
      "id": "clx6666666666",
      "success": false,
      "error": "Invalid recipient email"
    }
  ],
  "summary": {
    "total": 2,
    "sent": 1,
    "failed": 1
  }
}
```

**Errors**

| Status | Description |
|--------|-------------|
| 400 | No email IDs provided or no approved emails found |
| 500 | RESEND_FROM_EMAIL not configured or API error |

---

## Error Response Format

All error responses follow this format:

```json
{
  "error": "Human-readable error message"
}
```

---

## Authentication

Currently, the API has no authentication. For production use, consider adding:

1. **API Key Authentication** for programmatic access
2. **Session-based Auth** for the web interface
3. **Rate Limiting** to prevent abuse

---

## Rate Limits

**Resend API Limits:**
- Free tier: 100 emails/day, 1 email/second
- Pro tier: Higher limits based on plan

The `/api/send` endpoint processes emails sequentially to respect rate limits. For high-volume sending, implement a queue system.
