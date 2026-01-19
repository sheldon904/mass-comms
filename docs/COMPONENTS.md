# Components Reference

## UI Components

Base UI components located in `components/ui/`. These are styled following shadcn/ui patterns.

### Button

A versatile button component with multiple variants and sizes.

**Location:** `components/ui/button.tsx`

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | `"default"` \| `"destructive"` \| `"outline"` \| `"secondary"` \| `"ghost"` \| `"link"` | `"default"` | Visual style |
| size | `"default"` \| `"sm"` \| `"lg"` \| `"icon"` | `"default"` | Button size |
| asChild | boolean | false | Render as child element (for Links) |

**Usage:**

```tsx
import { Button } from "@/components/ui/button";
import Link from "next/link";

// Basic button
<Button>Click me</Button>

// Variants
<Button variant="destructive">Delete</Button>
<Button variant="outline">Cancel</Button>
<Button variant="ghost">Menu</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="icon"><Icon /></Button>

// As Link
<Button asChild>
  <Link href="/page">Go to Page</Link>
</Button>
```

---

### Input

Text input field with consistent styling.

**Location:** `components/ui/input.tsx`

**Usage:**

```tsx
import { Input } from "@/components/ui/input";

<Input
  type="email"
  placeholder="Enter email"
  value={value}
  onChange={(e) => setValue(e.target.value)}
/>
```

---

### Textarea

Multi-line text input.

**Location:** `components/ui/textarea.tsx`

**Usage:**

```tsx
import { Textarea } from "@/components/ui/textarea";

<Textarea
  placeholder="Enter description..."
  rows={6}
  value={value}
  onChange={(e) => setValue(e.target.value)}
/>
```

---

### Card

Container component for grouped content.

**Location:** `components/ui/card.tsx`

**Components:**
- `Card` - Outer container
- `CardHeader` - Header section
- `CardTitle` - Title text
- `CardDescription` - Subtitle/description
- `CardContent` - Main content area
- `CardFooter` - Footer section

**Usage:**

```tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

<Card>
  <CardHeader>
    <CardTitle>Card Title</CardTitle>
    <CardDescription>Card description text</CardDescription>
  </CardHeader>
  <CardContent>
    <p>Card content goes here</p>
  </CardContent>
</Card>
```

---

### Badge

Small status indicator or label.

**Location:** `components/ui/badge.tsx`

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | `"default"` \| `"secondary"` \| `"destructive"` \| `"outline"` \| `"success"` \| `"warning"` | `"default"` | Visual style |

**Usage:**

```tsx
import { Badge } from "@/components/ui/badge";

<Badge>Default</Badge>
<Badge variant="success">Sent</Badge>
<Badge variant="warning">Draft</Badge>
<Badge variant="destructive">Failed</Badge>
```

---

### Label

Form field label.

**Location:** `components/ui/label.tsx`

**Usage:**

```tsx
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

<div>
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" />
</div>
```

---

### Tabs

Tabbed interface for organizing content.

**Location:** `components/ui/tabs.tsx`

**Components:**
- `Tabs` - Container with state management
- `TabsList` - Tab button container
- `TabsTrigger` - Individual tab button
- `TabsContent` - Content panel for each tab

**Usage:**

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

<Tabs defaultValue="tab1">
  <TabsList>
    <TabsTrigger value="tab1">Tab 1</TabsTrigger>
    <TabsTrigger value="tab2">Tab 2</TabsTrigger>
  </TabsList>
  <TabsContent value="tab1">
    Content for tab 1
  </TabsContent>
  <TabsContent value="tab2">
    Content for tab 2
  </TabsContent>
</Tabs>
```

---

## Feature Components

### FileUpload

Drag-and-drop file uploader for markdown research files.

**Location:** `components/file-upload.tsx`

**Features:**
- Drag-and-drop zone
- Click to browse
- Multiple file support
- Upload progress tracking
- Success/error status per file

**Usage:**

```tsx
import { FileUpload } from "@/components/file-upload";

// No props needed - handles everything internally
<FileUpload />
```

**Behavior:**
1. Filters for `.md` files only
2. Reads file content client-side
3. POSTs to `/api/upload` for each file
4. Displays upload status
5. Calls `router.refresh()` on completion

---

### CompanyCard

Displays company summary in a clickable card format.

**Location:** `components/company-card.tsx`

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| id | string | Company ID (for link) |
| name | string | Company name |
| contactCount | number | Number of contacts |
| emailCounts | object | Count of emails by status |

**Usage:**

```tsx
import { CompanyCard } from "@/components/company-card";

<CompanyCard
  id="clx123"
  name="Acme Corp"
  contactCount={3}
  emailCounts={{ draft: 2, approved: 1, sent: 0 }}
/>
```

---

### ContactForm

CRUD interface for managing contacts within a company.

**Location:** `components/contact-form.tsx`

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| companyId | string | Parent company ID |
| contacts | Contact[] | Initial contact list |

**Features:**
- Add new contacts with name, email, role
- Inline editing of existing contacts
- Delete with confirmation
- Optimistic UI updates

**Usage:**

```tsx
import { ContactForm } from "@/components/contact-form";

<ContactForm
  companyId="clx123"
  contacts={[
    { id: "c1", name: "Jane", email: "jane@co.com", role: "CEO" }
  ]}
/>
```

---

### DraftForm

Form for specifying email campaign purpose and generating drafts.

**Location:** `components/draft-form.tsx`

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| companyId | string | Target company ID |
| companyName | string | Company name (for display) |
| contacts | Contact[] | Contacts to draft emails for |

**Features:**
- Large textarea for purpose/intent
- Shows list of contacts that will receive emails
- Progress indicator during generation
- Redirects to email queue on completion

**Usage:**

```tsx
import { DraftForm } from "@/components/draft-form";

<DraftForm
  companyId="clx123"
  companyName="Acme Corp"
  contacts={contacts}
/>
```

---

### EmailPreview

Expandable card for reviewing and managing individual emails.

**Location:** `components/email-preview.tsx`

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| email | Email | Email with contact and company relations |

**Features:**
- Expandable to show full body
- Inline editing of subject and body
- Approve/Reject buttons for drafts
- Send button for approved emails
- Status badge display

**Actions by Status:**
- `draft`: Edit, Approve, Reject
- `approved`: Send Now
- `sent`: View only (dimmed)

**Usage:**

```tsx
import { EmailPreview } from "@/components/email-preview";

<EmailPreview email={{
  id: "e1",
  subject: "Hello",
  body: "Email content...",
  status: "draft",
  purpose: "Introduction",
  contact: { name: "Jane", email: "jane@co.com", role: "CEO" },
  company: { name: "Acme Corp" }
}} />
```

---

### BulkActions

Action bar for bulk operations on email lists.

**Location:** `components/bulk-actions.tsx`

**Props:**

| Prop | Type | Description |
|------|------|-------------|
| emails | Email[] | List of emails to act on |
| action | `"approve"` \| `"send"` | Which action to display |

**Features:**
- Shows count of emails
- Single button for bulk action
- Confirmation dialog
- Loading state during operation

**Usage:**

```tsx
import { BulkActions } from "@/components/bulk-actions";

// For draft emails
<BulkActions emails={drafts} action="approve" />

// For approved emails
<BulkActions emails={approved} action="send" />
```

---

## Utility Function

### cn()

Combines class names with Tailwind merge support.

**Location:** `lib/utils.ts`

**Usage:**

```tsx
import { cn } from "@/lib/utils";

// Merge classes with conditional logic
<div className={cn(
  "base-class",
  isActive && "active-class",
  variant === "primary" && "primary-styles"
)} />
```
