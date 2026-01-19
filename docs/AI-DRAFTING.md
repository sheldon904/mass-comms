# AI Email Drafting

The system uses Claude (Anthropic's AI) to generate personalized outreach emails based on company research and user-specified intent.

## How It Works

```
┌──────────────────┐
│  User specifies  │
│  email purpose   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  For each        │
│  contact...      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│  Build prompt    │────▶│  Company research │
│  with context    │     │  Contact info     │
│                  │     │  User's purpose   │
└────────┬─────────┘     └──────────────────┘
         │
         ▼
┌──────────────────┐
│  Claude API      │
│  generates email │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Parse response  │
│  Extract subject │
│  and body        │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Save as draft   │
│  in database     │
└──────────────────┘
```

## Agent Configuration

**Location:** `lib/agent.ts`

### System Prompt

The Claude agent is configured with the following system prompt:

```
You are an expert at writing personalized, professional outreach emails.
Your emails are:
- Concise (2-3 short paragraphs max)
- Professional but warm
- Highly personalized based on company research
- Clear about the purpose/ask
- Free of fluff or generic filler

You write in plain text format (no HTML, no markdown formatting).
Always address the recipient by their first name.
Never use placeholder text like [Company Name] - use the actual information provided.
```

### User Prompt Template

Each email generation request includes:

```
Write a personalized email to {contact_name} ({role}) at {company_name}.

COMPANY RESEARCH:
{full_research_document}

PURPOSE OF EMAIL:
{user_specified_purpose}

Generate a subject line and email body. Format your response as:
SUBJECT: [subject line here]
BODY:
[email body here]
```

## API Parameters

| Parameter | Value |
|-----------|-------|
| Model | `claude-sonnet-4-20250514` |
| Max Tokens | 1024 |
| Temperature | Default (1.0) |

## Response Parsing

The agent expects a structured response:

```
SUBJECT: Partnership Opportunity with Acme Corp
BODY:
Hi Jane,

I noticed Acme Corp recently launched your new AI product line...

[rest of email]

Best regards,
[Sender]
```

The parser extracts:
- **Subject**: Text after "SUBJECT:" until newline
- **Body**: Everything after "BODY:" to end of response

## Customization

### Changing the Model

Edit `lib/agent.ts`:

```typescript
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514", // Change this
  // ...
});
```

Available models:
- `claude-sonnet-4-20250514` - Fast, cost-effective (recommended)
- `claude-opus-4-20250514` - Most capable
- `claude-3-haiku-20240307` - Fastest, cheapest

### Adjusting Output Style

Modify the system prompt in `lib/agent.ts`:

```typescript
const systemPrompt = `You are an expert at writing personalized, professional outreach emails.
// Add or modify guidelines here
`;
```

Common adjustments:
- Email length (currently 2-3 paragraphs)
- Tone (professional, casual, formal)
- Structure requirements
- Call-to-action style

### Adding More Context

Expand the user prompt to include:

```typescript
const userPrompt = `Write a personalized email to ${contactName}...

COMPANY RESEARCH:
${companyResearch}

SENDER INFORMATION:
Company: ${senderCompany}
Role: ${senderRole}
Value Proposition: ${valueProp}

PURPOSE OF EMAIL:
${purpose}
`;
```

## Best Practices for Purpose/Intent

The quality of generated emails depends heavily on the purpose description.

### Good Examples

```
Introduce our AI consulting services and propose a 30-minute discovery call
to discuss how we helped similar SaaS companies reduce churn by 15%.
```

```
Follow up on our conversation at TechCrunch Disrupt about their
upcoming Series B round and explore potential investment partnership.
```

```
Congratulate them on their recent product launch and propose a
guest post exchange for our respective engineering blogs.
```

### Poor Examples

```
Reach out to them
```

```
Sell our product
```

```
Say hello
```

### Tips for Better Results

1. **Be specific about the ask** - What do you want them to do?
2. **Mention relevant context** - Shared connections, recent news, etc.
3. **Include your value prop** - Why should they care?
4. **Specify the tone** - If you want something specific

## Error Handling

### Common Issues

| Error | Cause | Solution |
|-------|-------|----------|
| "Could not parse email" | Claude didn't follow format | Retry or adjust prompt |
| "Unexpected response type" | API returned non-text | Check API status |
| Rate limit errors | Too many requests | Implement backoff |

### Retry Logic

The current implementation doesn't include automatic retries. For production, consider:

```typescript
async function draftEmailWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await draftEmail(params);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

## Cost Considerations

| Model | Input Cost | Output Cost |
|-------|------------|-------------|
| Sonnet | $3/M tokens | $15/M tokens |
| Opus | $15/M tokens | $75/M tokens |
| Haiku | $0.25/M tokens | $1.25/M tokens |

**Typical email generation:**
- Input: ~1,000-3,000 tokens (research + prompt)
- Output: ~200-400 tokens (email)
- Cost per email: ~$0.01-0.05 with Sonnet

## Testing Without API Calls

For development/testing, you can mock the agent:

```typescript
// lib/agent.ts
export async function draftEmail(params: DraftEmailParams): Promise<DraftedEmail> {
  if (process.env.MOCK_AI === "true") {
    return {
      subject: `[TEST] Email to ${params.contactName}`,
      body: `Hi ${params.contactName.split(" ")[0]},\n\nThis is a test email.\n\nBest,\nTest`,
    };
  }

  // Real implementation...
}
```
