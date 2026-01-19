import Anthropic from "@anthropic-ai/sdk";

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }
  return new Anthropic({ apiKey });
}

interface DraftEmailParams {
  companyName: string;
  companyResearch: string;
  contactName: string;
  contactRole: string | null;
  contactEmail: string;
  purpose: string;
}

interface DraftedEmail {
  subject: string;
  body: string;
}

export async function draftEmail(params: DraftEmailParams): Promise<DraftedEmail> {
  const { companyName, companyResearch, contactName, contactRole, purpose } = params;

  const systemPrompt = `You are an expert at writing personalized, professional outreach emails.
Your emails are:
- Concise (2-3 short paragraphs max)
- Professional but warm
- Highly personalized based on company research
- Clear about the purpose/ask
- Free of fluff or generic filler

You write in plain text format (no HTML, no markdown formatting).
Always address the recipient by their first name.
Never use placeholder text like [Company Name] - use the actual information provided.`;

  const userPrompt = `Write a personalized email to ${contactName}${contactRole ? ` (${contactRole})` : ""} at ${companyName}.

COMPANY RESEARCH:
${companyResearch}

PURPOSE OF EMAIL:
${purpose}

Generate a subject line and email body. Format your response as:
SUBJECT: [subject line here]
BODY:
[email body here]`;

  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
    system: systemPrompt,
  });

  // Validate response has content
  if (!response.content || response.content.length === 0) {
    throw new Error("Empty response from Claude");
  }

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  const text = content.text;

  if (!text || text.trim().length === 0) {
    throw new Error("Empty text response from Claude");
  }
  const subjectMatch = text.match(/SUBJECT:\s*(.+?)(?:\n|$)/);
  const bodyMatch = text.match(/BODY:\s*([\s\S]+)$/);

  if (!subjectMatch || !bodyMatch) {
    throw new Error("Could not parse email from Claude response");
  }

  return {
    subject: subjectMatch[1].trim(),
    body: bodyMatch[1].trim(),
  };
}
