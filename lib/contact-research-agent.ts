import Anthropic from "@anthropic-ai/sdk";
import dns from "dns";
import { promisify } from "util";

const resolveMx = promisify(dns.resolveMx);

// ============================================================================
// TYPES
// ============================================================================

export interface DiscoveredContact {
  name: string;
  email: string;
  phone: string | null;
  role: string;
  confidence: "high" | "medium" | "low";
  source: string;
  verified: boolean;
}

export interface ResearchResult {
  contacts: DiscoveredContact[];
  summary: string;
  stages: {
    pagesVisited: string[];
    contactsFound: number;
    emailsVerified: number;
    phonesFound: number;
  };
  durationMs: number;
}

export interface ContactResearchParams {
  companyName: string;
  companyResearch: string;
  companyDomain?: string;
}

// ============================================================================
// WEB BROWSING UTILITIES
// ============================================================================

/**
 * Fetch a webpage and extract readable text content
 */
async function fetchWebpage(url: string): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    // Ensure URL has protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, content: "", error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    // Extract text content and important elements
    const content = extractTextFromHtml(html);

    // Limit content size to avoid token limits
    const truncated = content.length > 15000
      ? content.substring(0, 15000) + "\n...[truncated]"
      : content;

    return { success: true, content: truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, content: "", error: message };
  }
}

/**
 * Extract readable text from HTML, preserving structure
 */
function extractTextFromHtml(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Extract links (important for finding team/contact pages)
  const links: string[] = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const linkText = match[2].trim();
    if (linkText && href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      links.push(`[${linkText}](${href})`);
    }
  }

  // Extract emails directly from HTML
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = html.match(emailRegex) || [];

  // Extract phone numbers
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  const phones = html.match(phoneRegex) || [];

  // Convert HTML to text
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");

  // Clean up whitespace
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\n\s+/g, "\n");
  text = text.trim();

  // Compile the result
  let result = "=== PAGE CONTENT ===\n" + text;

  if (emails.length > 0) {
    result += "\n\n=== EMAILS FOUND ===\n" + Array.from(new Set(emails)).join("\n");
  }

  if (phones.length > 0) {
    result += "\n\n=== PHONE NUMBERS FOUND ===\n" + Array.from(new Set(phones)).join("\n");
  }

  if (links.length > 0) {
    // Filter to relevant links
    const relevantLinks = links.filter(link => {
      const lower = link.toLowerCase();
      return lower.includes("team") || lower.includes("about") ||
             lower.includes("contact") || lower.includes("leadership") ||
             lower.includes("staff") || lower.includes("people") ||
             lower.includes("management") || lower.includes("executive") ||
             lower.includes("who we are") || lower.includes("our team");
    });

    if (relevantLinks.length > 0) {
      result += "\n\n=== RELEVANT LINKS ===\n" + relevantLinks.slice(0, 20).join("\n");
    }
  }

  return result;
}

/**
 * Extract domain from URL or email
 */
function extractDomainFromText(text: string): string | null {
  // Try to find domain from URLs
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi;
  const urlMatches = Array.from(text.matchAll(urlRegex));

  // Try to find domain from email addresses
  const emailRegex = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  const emailMatches = Array.from(text.matchAll(emailRegex));

  const domains = new Set<string>();

  // Common domains to filter out
  const commonDomains = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
    "icloud.com", "mail.com", "protonmail.com", "linkedin.com", "twitter.com",
    "facebook.com", "github.com", "google.com", "microsoft.com", "apple.com",
    "wikipedia.org", "medium.com", "youtube.com", "instagram.com"
  ];

  for (const match of urlMatches) {
    const domain = match[1].toLowerCase();
    if (!commonDomains.includes(domain)) {
      domains.add(domain);
    }
  }

  for (const match of emailMatches) {
    const domain = match[1].toLowerCase();
    if (!commonDomains.includes(domain)) {
      domains.add(domain);
    }
  }

  return domains.size > 0 ? Array.from(domains)[0] : null;
}

// ============================================================================
// DNS VERIFICATION
// ============================================================================

const mxCache = new Map<string, boolean>();

async function verifyEmailDomain(email: string): Promise<boolean> {
  const domain = email.split("@")[1];
  if (!domain) return false;

  if (mxCache.has(domain)) {
    return mxCache.get(domain)!;
  }

  try {
    const records = await resolveMx(domain);
    const hasValidMx = records && records.length > 0;
    mxCache.set(domain, hasValidMx);
    return hasValidMx;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

// ============================================================================
// AGENTIC RESEARCH SYSTEM
// ============================================================================

/**
 * Define the tools available to the agent
 */
const agentTools: Anthropic.Tool[] = [
  {
    name: "browse_webpage",
    description: `Fetch and read the content of a webpage. Returns the text content, any email addresses found, phone numbers found, and relevant links (team, about, contact pages).

Use this to:
1. Browse the company homepage to find team/contact page links
2. Browse team/about/contact pages to find actual contact information
3. Browse individual staff profile pages if available

The tool will extract emails and phone numbers automatically from the page.`,
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch (e.g., 'https://example.com/team' or 'example.com/about')"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "submit_contacts",
    description: `Submit the discovered contacts. Call this when you have found contacts with REAL email addresses (not generated patterns).

IMPORTANT:
- Only submit contacts where you found an ACTUAL email on the website
- Include phone numbers if found
- Do NOT make up or guess emails - only use emails you actually found on the pages you browsed`,
    input_schema: {
      type: "object" as const,
      properties: {
        contacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Full name of the person"
              },
              email: {
                type: "string",
                description: "Email address found on the website (must be real, not generated)"
              },
              phone: {
                type: ["string", "null"],
                description: "Phone number if found, null otherwise"
              },
              role: {
                type: "string",
                description: "Job title or role"
              },
              source_url: {
                type: "string",
                description: "The URL where this contact info was found"
              }
            },
            required: ["name", "email", "role", "source_url"]
          }
        }
      },
      required: ["contacts"]
    }
  }
];

/**
 * Execute a tool call from the agent
 */
async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  pagesVisited: string[]
): Promise<string> {
  if (toolName === "browse_webpage") {
    const url = toolInput.url as string;
    pagesVisited.push(url);

    console.log(`Agent browsing: ${url}`);
    const result = await fetchWebpage(url);

    if (result.success) {
      return result.content;
    } else {
      return `Error fetching page: ${result.error}`;
    }
  }

  if (toolName === "submit_contacts") {
    // This is handled in the main loop
    return "Contacts submitted successfully.";
  }

  return "Unknown tool";
}

/**
 * Run the agentic research loop
 */
export async function researchContacts(
  params: ContactResearchParams
): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;

  const pagesVisited: string[] = [];
  let finalContacts: DiscoveredContact[] = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      contacts: [],
      summary: "No API key configured",
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  const anthropic = new Anthropic({ apiKey });

  // Extract domain from research document
  const domain = params.companyDomain || extractDomainFromText(companyResearch);

  // Build the initial prompt for the agent
  const systemPrompt = `You are a contact research agent. Your job is to find REAL contact information (emails, phone numbers) for key people at a company by browsing their website.

CRITICAL RULES:
1. You must find ACTUAL emails on the website - NEVER make up or guess email patterns
2. Start by browsing the company homepage to find links to team/about/contact pages
3. Browse those pages to find contact information
4. Look for leadership, executives, key staff members
5. Extract real emails and phone numbers that are displayed on the pages
6. You have a maximum of 6 page visits - be strategic
7. When you've found contacts with real emails, use submit_contacts to finish

WHAT TO LOOK FOR:
- Team pages, About Us pages, Contact pages, Leadership pages
- Staff directories, Executive bios
- Email addresses displayed on the page (the tool will highlight these)
- Phone numbers displayed on the page

WHAT NOT TO DO:
- Don't guess email patterns like first.last@domain.com
- Don't make up contact information
- Don't spend all visits on irrelevant pages`;

  const userPrompt = `Research contacts for: ${companyName}

Company Website Domain: ${domain || "Unknown - try to find it"}

Research Document (may contain useful context):
---
${companyResearch.substring(0, 3000)}
---

Start by browsing the company website${domain ? ` at ${domain}` : ""}. Find team/about/contact pages and extract REAL email addresses and phone numbers for key contacts.

Remember: Only submit contacts with REAL emails you found on their website. Do not generate email patterns.`;

  // Initialize conversation
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt }
  ];

  // Agentic loop - max 8 iterations
  const maxIterations = 8;
  let iteration = 0;
  let shouldContinue = true;

  while (shouldContinue && iteration < maxIterations) {
    iteration++;
    console.log(`Agent iteration ${iteration}...`);

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: systemPrompt,
        tools: agentTools,
        messages
      });

      // Check for tool use
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        // No tool use - agent is done or stuck
        console.log("Agent finished without tool use");
        shouldContinue = false;
        break;
      }

      // Process tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        if (toolUse.name === "submit_contacts") {
          // Agent is submitting contacts - we're done
          const input = toolUse.input as { contacts: Array<{
            name: string;
            email: string;
            phone?: string | null;
            role: string;
            source_url: string;
          }> };

          // Verify emails and build final contacts
          for (const contact of input.contacts || []) {
            const verified = await verifyEmailDomain(contact.email);
            finalContacts.push({
              name: contact.name,
              email: contact.email,
              phone: contact.phone || null,
              role: contact.role,
              confidence: verified ? "high" : "medium",
              source: contact.source_url,
              verified
            });
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Contacts submitted successfully."
          });

          shouldContinue = false;
        } else {
          // Execute other tools
          const result = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
            pagesVisited
          );

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result
          });
        }
      }

      // Add assistant message and tool results to conversation
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      // Check if we hit stop reason
      if (response.stop_reason === "end_turn" && toolUseBlocks.length === 0) {
        shouldContinue = false;
      }

    } catch (error) {
      console.error("Agent error:", error);
      shouldContinue = false;
    }

    // Check timeout (40 seconds max)
    if (Date.now() - startTime > 40000) {
      console.log("Agent timeout reached");
      shouldContinue = false;
    }
  }

  // Build result
  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s). `;
  summary += `${emailsVerified} email(s) verified. `;
  if (phonesFound > 0) {
    summary += `${phonesFound} phone number(s) found.`;
  }

  return {
    contacts: finalContacts.slice(0, 10),
    summary,
    stages: {
      pagesVisited,
      contactsFound: finalContacts.length,
      emailsVerified,
      phonesFound
    },
    durationMs
  };
}
