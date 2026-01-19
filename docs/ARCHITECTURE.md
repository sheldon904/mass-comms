# Architecture Overview

## System Design

The Mass Communications System follows a standard Next.js 14 App Router architecture with server components, API routes, and client-side interactivity where needed.

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Dashboard  │  │  Companies  │  │   Emails    │         │
│  │   (SSR)     │  │   (SSR)     │  │   (SSR)     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│         │                │                │                 │
│         └────────────────┼────────────────┘                 │
│                          │                                  │
│              ┌───────────▼───────────┐                      │
│              │   Client Components   │                      │
│              │  (FileUpload, Forms)  │                      │
│              └───────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      API Routes                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ /upload  │  │/contacts │  │  /draft  │  │  /send   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │   Prisma   │  │   Claude   │  │   Resend   │
    │  (SQLite)  │  │    API     │  │    API     │
    └────────────┘  └────────────┘  └────────────┘
```

## Directory Structure

```
mass_comms/
├── app/                    # Next.js App Router
│   ├── layout.tsx          # Root layout with navigation
│   ├── page.tsx            # Dashboard (server component)
│   ├── globals.css         # Global styles + Tailwind
│   ├── companies/          # Company management
│   │   ├── page.tsx        # List view + upload
│   │   └── [id]/           # Dynamic routes
│   │       ├── page.tsx    # Detail view
│   │       └── draft/      # Email drafting
│   ├── emails/             # Email queue
│   │   └── page.tsx        # Review/approval
│   └── api/                # API routes
│       ├── upload/         # File upload handler
│       ├── companies/      # Company CRUD
│       ├── contacts/       # Contact CRUD
│       ├── draft/          # AI email generation
│       ├── emails/         # Email management
│       └── send/           # Resend integration
├── components/             # React components
│   ├── ui/                 # Base UI components
│   └── *.tsx               # Feature components
├── lib/                    # Utility modules
│   ├── db.ts               # Prisma client singleton
│   ├── utils.ts            # Helper functions
│   ├── resend.ts           # Resend client
│   ├── agent.ts            # Claude integration
│   └── parse-research.ts   # Markdown parser
└── prisma/                 # Database
    ├── schema.prisma       # Data models
    └── migrations/         # Migration history
```

## Data Flow

### 1. Company Upload Flow

```
User drops .md file
        │
        ▼
┌───────────────┐
│ FileUpload    │ (client component)
│ Component     │
└───────┬───────┘
        │ FormData POST
        ▼
┌───────────────┐
│ /api/upload   │ (API route)
│               │
│ 1. Parse MD   │
│ 2. Extract    │
│    metadata   │
│ 3. Save to DB │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│   Prisma      │
│   (SQLite)    │
└───────────────┘
```

### 2. Email Drafting Flow

```
User enters purpose
        │
        ▼
┌───────────────┐
│ DraftForm     │ (client component)
│               │
│ For each      │
│ contact...    │
└───────┬───────┘
        │ JSON POST
        ▼
┌───────────────┐
│ /api/draft    │ (API route)
│               │
│ 1. Fetch      │
│    company    │
│    research   │
│ 2. Call       │
│    Claude     │
│ 3. Save draft │
└───────┬───────┘
        │
        ├──────────────┐
        ▼              ▼
┌───────────────┐ ┌───────────────┐
│   Prisma      │ │   Claude API  │
│   (SQLite)    │ │               │
└───────────────┘ └───────────────┘
```

### 3. Email Sending Flow

```
User clicks Send
        │
        ▼
┌───────────────┐
│ EmailPreview  │ (client component)
│ or BulkActions│
└───────┬───────┘
        │ JSON POST
        ▼
┌───────────────┐
│ /api/send     │ (API route)
│               │
│ 1. Fetch      │
│    approved   │
│    emails     │
│ 2. Send via   │
│    Resend     │
│ 3. Update     │
│    status     │
└───────┬───────┘
        │
        ├──────────────┐
        ▼              ▼
┌───────────────┐ ┌───────────────┐
│   Prisma      │ │   Resend API  │
│   (SQLite)    │ │               │
└───────────────┘ └───────────────┘
```

## Component Architecture

### Server Components (Default)

Most pages are server components that fetch data directly:

```tsx
// app/companies/page.tsx
export default async function CompaniesPage() {
  const companies = await prisma.company.findMany({...});
  return <CompanyList companies={companies} />;
}
```

### Client Components

Interactive features use the `"use client"` directive:

```tsx
// components/file-upload.tsx
"use client";

export function FileUpload() {
  const [files, setFiles] = useState([]);
  // Drag-and-drop handling, fetch calls, etc.
}
```

### Composition Pattern

Server components render client components with server-fetched data:

```tsx
// Server component
export default async function CompanyDetailPage({ params }) {
  const company = await prisma.company.findUnique({...});
  return (
    <div>
      <h1>{company.name}</h1>
      {/* Client component receives server data */}
      <ContactForm companyId={company.id} contacts={company.contacts} />
    </div>
  );
}
```

## State Management

The app uses minimal client-side state:

1. **URL State**: Navigation handles most "global" state
2. **Component State**: React `useState` for form inputs, loading states
3. **Server State**: Data is fetched fresh via server components
4. **Refresh Pattern**: `router.refresh()` re-fetches server data after mutations

## Error Handling Strategy

1. **API Routes**: Return JSON errors with appropriate status codes
2. **Client Components**: Try/catch with user-friendly error messages
3. **Server Components**: Next.js error boundaries (error.tsx)

## Security Considerations

1. **API Keys**: Stored in environment variables, never exposed to client
2. **Input Validation**: Server-side validation on all API routes
3. **SQL Injection**: Prisma ORM handles parameterization
4. **XSS**: React's default escaping + careful use of dangerouslySetInnerHTML
