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

interface KeyPerson {
  name: string;
  role: string;
}

interface ResearchPlan {
  keyPeople: KeyPerson[];
  companyDescription: string;
  suggestedPages: string[];
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// Vercel has 55s max - we use generous internal timeout
const INTERNAL_TIMEOUT_MS = 50000;

// Rate limit handling
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;

// ============================================================================
// DOMAIN EXTRACTION
// ============================================================================

function extractCompanyDomain(research: string, companyName: string): string | null {
  const cleanCompanyName = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(inc|llc|ltd|corp|company|co|group|holdings)$/i, "")
    .trim();

  const skipDomains = new Set([
    "prnewswire.com", "businesswire.com", "globenewswire.com", "prweb.com",
    "marketwatch.com", "reuters.com", "bloomberg.com", "wsj.com", "nytimes.com",
    "forbes.com", "fortune.com", "cnbc.com", "yahoo.com", "google.com",
    "linkedin.com", "twitter.com", "facebook.com", "instagram.com", "youtube.com",
    "wikipedia.org", "medium.com", "substack.com", "github.com",
    "gmail.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
    "sec.gov", "edgar.sec.gov", "crunchbase.com", "pitchbook.com",
    "bizjournals.com", "zoominfo.com", "apollo.io", "hunter.io",
  ]);

  const domainMatches: { domain: string; score: number }[] = [];

  // Pattern 1: Explicit website mentions
  const websitePatterns = [
    /(?:website|web site|homepage|visit us at|learn more at|visit)[:\s]+(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
    /(?:www\.)([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
  ];

  for (const pattern of websitePatterns) {
    let match;
    while ((match = pattern.exec(research)) !== null) {
      const domain = match[1].toLowerCase();
      if (!skipDomains.has(domain)) {
        const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
        domainMatches.push({ domain, score: containsCompanyName ? 100 : 50 });
      }
    }
  }

  // Pattern 2: Email domains
  const emailPattern = /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let emailMatch;
  while ((emailMatch = emailPattern.exec(research)) !== null) {
    const domain = emailMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({ domain, score: containsCompanyName ? 90 : 40 });
    }
  }

  // Pattern 3: URLs in text
  const urlPattern = /https?:\/\/(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(research)) !== null) {
    const domain = urlMatch[1].toLowerCase();
    if (!skipDomains.has(domain)) {
      const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
      domainMatches.push({ domain, score: containsCompanyName ? 80 : 30 });
    }
  }

  domainMatches.sort((a, b) => b.score - a.score);

  if (domainMatches.length > 0) {
    console.log(`Domain candidates: ${JSON.stringify(domainMatches.slice(0, 5))}`);
    return domainMatches[0].domain;
  }

  const simpleDomain = cleanCompanyName + ".com";
  console.log(`No domain found, trying fallback: ${simpleDomain}`);
  return simpleDomain;
}

// ============================================================================
// WEB BROWSING
// ============================================================================

async function fetchWebpage(url: string): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

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
    const content = extractTextFromHtml(html);
    const truncated = content.length > 15000
      ? content.substring(0, 15000) + "\n...[truncated]"
      : content;

    return { success: true, content: truncated };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, content: "", error: message };
  }
}

function extractTextFromHtml(html: string): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = html.match(emailRegex) || [];

  const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  const phones = html.match(phoneRegex) || [];

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

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\n\s+/g, "\n");
  text = text.trim();

  let result = "=== PAGE CONTENT ===\n" + text.substring(0, 10000);

  if (emails.length > 0) {
    result += "\n\n=== EMAILS FOUND ===\n" + Array.from(new Set(emails)).join("\n");
  }

  if (phones.length > 0) {
    result += "\n\n=== PHONES FOUND ===\n" + Array.from(new Set(phones)).join("\n");
  }

  const relevantLinks = links.filter(link => {
    const lower = link.toLowerCase();
    return lower.includes("team") || lower.includes("about") ||
           lower.includes("contact") || lower.includes("leadership") ||
           lower.includes("staff") || lower.includes("people") ||
           lower.includes("management") || lower.includes("executive") ||
           lower.includes("our-team") || lower.includes("who-we-are");
  });

  if (relevantLinks.length > 0) {
    result += "\n\n=== RELEVANT LINKS ===\n" + relevantLinks.slice(0, 10).join("\n");
  }

  return result;
}

// ============================================================================
// OSINT WEB SEARCH
// ============================================================================

async function webSearch(query: string): Promise<{ success: boolean; results: string; error?: string }> {
  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, results: "", error: `HTTP ${response.status}` };
    }

    const html = await response.text();

    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/\s+/g, " ").trim();

    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = text.match(emailRegex) || [];

    let result = text.length > 4000 ? text.substring(0, 4000) : text;

    if (emails.length > 0) {
      result += "\n\n=== EMAILS IN RESULTS ===\n" + Array.from(new Set(emails)).join("\n");
    }

    return { success: true, results: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, results: "", error: message };
  }
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
// RATE-LIMITED API CALL WITH RETRY
// ============================================================================

async function callAnthropicWithRetry(
  anthropic: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  startTime: number
): Promise<Anthropic.Message | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Check if we have time for a retry
    const elapsed = Date.now() - startTime;
    if (elapsed > INTERNAL_TIMEOUT_MS - 5000) {
      console.log("[API] Not enough time for retry");
      return null;
    }

    try {
      const response = await anthropic.messages.create(params);
      return response as Anthropic.Message;
    } catch (error) {
      const isRateLimit = error instanceof Error &&
        (error.message.includes("429") || error.message.includes("rate_limit"));

      if (isRateLimit && attempt < MAX_RETRIES - 1) {
        // Exponential backoff with jitter
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`[API] Rate limited, waiting ${Math.round(delay)}ms before retry ${attempt + 1}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      console.error(`[API] Error:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  return null;
}

// ============================================================================
// PHASE 1: EXTRACT KEY INFO FROM RESEARCH (Single API call)
// ============================================================================

async function extractKeyInfo(
  anthropic: Anthropic,
  companyName: string,
  companyResearch: string,
  startTime: number
): Promise<ResearchPlan | null> {
  console.log("[Phase 1] Extracting key info from research doc...");

  // Truncate research doc to prevent rate limit issues (max ~8000 chars)
  const truncatedResearch = companyResearch.length > 8000
    ? companyResearch.substring(0, 8000) + "\n...[truncated]"
    : companyResearch;

  const response = await callAnthropicWithRetry(anthropic, {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: "You extract key information from company research documents. Be concise. Return valid JSON only.",
    messages: [{
      role: "user",
      content: `Extract key people and info from this research about ${companyName}:

${truncatedResearch}

Return JSON:
{
  "keyPeople": [{"name": "Full Name", "role": "CEO/President/etc"}],
  "companyDescription": "One sentence description",
  "suggestedPages": ["about", "team", "contact"]
}

Rules:
- Only include REAL people with specific names (not generic titles)
- Maximum 6 key people (prioritize executives: CEO, President, Owner, Founder)
- Keep descriptions short
- Return ONLY valid JSON, no markdown`
    }]
  }, startTime);

  if (!response) {
    console.log("[Phase 1] Failed to get response");
    return null;
  }

  try {
    const textBlock = response.content.find(b => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    // Clean the response - remove markdown code blocks if present
    let jsonText = textBlock.text.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    }

    const plan = JSON.parse(jsonText) as ResearchPlan;
    console.log(`[Phase 1] Found ${plan.keyPeople.length} key people:`, plan.keyPeople.map(p => p.name));
    return plan;
  } catch (e) {
    console.error("[Phase 1] Failed to parse response:", e);
    return null;
  }
}

// ============================================================================
// PHASE 2: AGENTIC BROWSING (Lightweight prompts)
// ============================================================================

const agentTools: Anthropic.Tool[] = [
  {
    name: "browse_webpage",
    description: "Fetch webpage content including emails and phones found.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to fetch" }
      },
      required: ["url"]
    }
  },
  {
    name: "web_search",
    description: "Search internet for contact info. Use for OSINT verification.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    }
  },
  {
    name: "submit_contacts",
    description: "Submit discovered contacts with their source.",
    input_schema: {
      type: "object" as const,
      properties: {
        contacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
              phone: { type: ["string", "null"] },
              role: { type: "string" },
              found_method: { type: "string", enum: ["direct_website", "osint_search", "pattern_match"] },
              source: { type: "string" }
            },
            required: ["name", "email", "role", "found_method", "source"]
          }
        }
      },
      required: ["contacts"]
    }
  }
];

// ============================================================================
// MAIN RESEARCH FUNCTION
// ============================================================================

export async function researchContacts(params: ContactResearchParams): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;
  const pagesVisited: string[] = [];
  const searchesPerformed: string[] = [];
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

  const domain = params.companyDomain || extractCompanyDomain(companyResearch, companyName);
  console.log(`[Research] Company: ${companyName}, Domain: ${domain}`);

  if (!domain) {
    return {
      contacts: [],
      summary: `Could not determine website for ${companyName}`,
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  const anthropic = new Anthropic({ apiKey });

  // =========================================================================
  // PHASE 1: Extract key info (single API call with truncated doc)
  // =========================================================================
  const plan = await extractKeyInfo(anthropic, companyName, companyResearch, startTime);

  const keyPeopleList = plan?.keyPeople && plan.keyPeople.length > 0
    ? plan.keyPeople.map(p => `${p.name} (${p.role})`).join(", ")
    : "executives and key staff";

  // =========================================================================
  // PHASE 2: Agentic browsing with LIGHTWEIGHT prompts
  // =========================================================================

  // Compact system prompt - no research doc, just key info
  const systemPrompt = `You find contacts for ${companyName} (${domain}).

KEY PEOPLE TO FIND: ${keyPeopleList}

TOOLS: browse_webpage, web_search, submit_contacts

STRATEGY:
1. Browse https://${domain} and team/about/contact pages
2. Submit contacts AS YOU FIND THEM (don't wait)
3. For key people without emails, use web_search to find them
4. Departmental emails (info@, hr@) are valuable too

CONFIDENCE:
- direct_website = HIGH (found on company site)
- osint_search = MEDIUM (found via search)
- pattern_match = LOW (guessed)

NEVER invent emails. Only submit real ones you find.`;

  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `Find contacts for ${companyName}. Start with https://${domain}`
  }];

  let iteration = 0;
  let shouldContinue = true;
  let noToolCallCount = 0;

  while (shouldContinue) {
    iteration++;
    const elapsed = Date.now() - startTime;
    const remaining = INTERNAL_TIMEOUT_MS - elapsed;

    console.log(`[Agent] Iteration ${iteration}, elapsed: ${Math.round(elapsed/1000)}s, remaining: ${Math.round(remaining/1000)}s`);

    // Time check - need at least 8s for an iteration
    if (remaining < 8000) {
      console.log("[Agent] Time limit - stopping");
      break;
    }

    // Safety limit
    if (iteration > 12) {
      console.log("[Agent] Max iterations reached");
      break;
    }

    const response = await callAnthropicWithRetry(anthropic, {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: systemPrompt,
      tools: agentTools,
      messages
    }, startTime);

    if (!response) {
      console.log("[Agent] No response - stopping");
      break;
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      noToolCallCount++;
      if (noToolCallCount >= 2) {
        console.log("[Agent] Agent finished");
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: "Continue searching. Use browse_webpage or web_search to find more contacts." });
      continue;
    }

    noToolCallCount = 0;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      // Time check before each tool
      if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 5000) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Time limit. Submit any contacts found."
        });
        continue;
      }

      if (toolUse.name === "browse_webpage") {
        const input = toolUse.input as { url: string };
        let url = input.url;

        // Validate domain
        try {
          const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
          const urlDomain = urlObj.hostname.replace("www.", "");
          const targetDomain = domain.replace("www.", "");

          if (!urlDomain.includes(targetDomain) && !targetDomain.includes(urlDomain)) {
            console.log(`[Agent] Blocked: ${url}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Can only browse ${domain}. Use web_search for external lookups.`
            });
            continue;
          }
        } catch {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Invalid URL"
          });
          continue;
        }

        pagesVisited.push(url);
        console.log(`[Agent] Browse: ${url}`);
        const result = await fetchWebpage(url);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.success ? result.content : `Error: ${result.error}`
        });

      } else if (toolUse.name === "web_search") {
        const input = toolUse.input as { query: string };
        searchesPerformed.push(input.query);
        console.log(`[Agent] Search: ${input.query}`);

        const result = await webSearch(input.query);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.success ? result.results : `Error: ${result.error}`
        });

      } else if (toolUse.name === "submit_contacts") {
        const input = toolUse.input as {
          contacts: Array<{
            name: string;
            email: string;
            phone?: string | null;
            role: string;
            found_method: "direct_website" | "osint_search" | "pattern_match";
            source: string;
          }>
        };

        let addedCount = 0;
        const seenEmails = new Set(finalContacts.map(c => c.email.toLowerCase()));

        for (const contact of input.contacts || []) {
          if (seenEmails.has(contact.email.toLowerCase())) continue;
          seenEmails.add(contact.email.toLowerCase());

          const mxVerified = await verifyEmailDomain(contact.email);

          let confidence: "high" | "medium" | "low";
          if (contact.found_method === "direct_website" && mxVerified) {
            confidence = "high";
          } else if (contact.found_method === "osint_search") {
            confidence = "medium";
          } else {
            confidence = "low";
          }

          finalContacts.push({
            name: contact.name,
            email: contact.email,
            phone: contact.phone || null,
            role: contact.role,
            confidence,
            source: contact.source,
            verified: mxVerified
          });
          addedCount++;

          console.log(`[Agent] Added: ${contact.name} <${contact.email}> (${confidence})`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Added ${addedCount} contact(s). Total: ${finalContacts.length}. Continue searching if time permits.`
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // =========================================================================
  // RESULTS
  // =========================================================================
  const durationMs = Date.now() - startTime;
  const phonesFound = finalContacts.filter(c => c.phone).length;
  const emailsVerified = finalContacts.filter(c => c.verified).length;
  const highConfidence = finalContacts.filter(c => c.confidence === "high").length;
  const mediumConfidence = finalContacts.filter(c => c.confidence === "medium").length;
  const lowConfidence = finalContacts.filter(c => c.confidence === "low").length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Browsed ${pagesVisited.length} page(s), ${searchesPerformed.length} search(es). `;
  summary += `Confidence: ${highConfidence} high, ${mediumConfidence} medium, ${lowConfidence} low.`;
  if (phonesFound > 0) summary += ` ${phonesFound} phone(s).`;

  console.log(`[Research] Complete in ${Math.round(durationMs/1000)}s - ${finalContacts.length} contacts`);

  return {
    contacts: finalContacts.slice(0, 20),
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
