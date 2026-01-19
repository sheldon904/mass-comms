# Mass Communications System

AI-powered mass email outreach system built with Next.js 14, Claude API, and Resend.

## Features

- **Company Research Upload**: Upload markdown files containing company research
- **Contact Management**: Add and manage contacts for each company
- **AI Email Drafting**: Claude generates personalized emails based on company research and your specified purpose
- **Review Workflow**: Review, edit, approve, or reject draft emails
- **Bulk Send**: Send approved emails via Resend

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Database**: SQLite via Prisma
- **Email**: Resend
- **AI**: Claude API (Anthropic)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
```bash
cp .env.local.example .env.local
# Edit .env.local with your API keys
```

Required environment variables:
- `DATABASE_URL` - SQLite database path (default: `file:./dev.db`)
- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `RESEND_API_KEY` - Your Resend API key
- `RESEND_FROM_EMAIL` - Verified sender email (e.g., `you@yourdomain.com`)

3. Initialize the database:
```bash
npx prisma migrate dev
```

4. Start the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000)

## Usage

### 1. Upload Company Research

Navigate to **Companies** and upload `.md` files containing research about target companies. The filename or frontmatter will be used as the company name.

Example research file format:
```markdown
---
company: Acme Corp
---

# Acme Corp Research

## Overview
Acme Corp is a leading provider of...

## Recent News
- Launched new product X...
- Expanded to Europe...

## Key People
- Jane Doe, CEO
- John Smith, CTO
```

### 2. Add Contacts

Click on a company to view its details, then add contacts (name, email, role).

### 3. Draft Emails

Click "Draft Emails" and describe your outreach purpose. Claude will generate personalized emails for each contact based on the company research.

Example purposes:
- "Introduce our AI consulting services and schedule a discovery call"
- "Follow up on our meeting at the conference last week"
- "Propose a partnership opportunity around their new product launch"

### 4. Review & Approve

Navigate to **Emails** to review drafts. You can:
- Edit subject and body
- Approve individual emails
- Bulk approve all drafts
- Reject/delete emails

### 5. Send

Approved emails can be sent individually or in bulk. Emails are delivered via Resend and marked as "sent" with a tracking ID.

## Development

```bash
# Run development server
npm run dev

# Build for production
npm run build

# Run production server
npm start

# Run Prisma Studio (database viewer)
npx prisma studio
```

## Notes

- **Resend Domain**: Verify a domain in Resend before sending production emails
- **Rate Limits**: Resend has rate limits; for large volumes, implement queuing
- **Security**: Never commit `.env` files; API keys should stay private

---
*Last updated: January 2026*
