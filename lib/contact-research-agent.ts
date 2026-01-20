import Anthropic from "@anthropic-ai/sdk";
import dns from "dns";
import net from "net";
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

export type ProgressEvent =
  | { type: "started"; companyName: string; domain: string }
  | { type: "phase"; phase: "extracting" | "browsing" | "searching" | "complete"; message: string }
  | { type: "iteration"; iteration: number; maxIterations: number; action: string }
  | { type: "contact"; contact: DiscoveredContact }
  | { type: "complete"; result: ResearchResult }
  | { type: "error"; message: string };

export type ProgressCallback = (event: ProgressEvent) => void;

// Key person extracted from research document
interface KeyPerson {
  name: string;
  role: string;
  firstName: string;
  lastName: string;
}

// Email candidate with corroboration data
interface EmailCandidate {
  email: string;
  personName: string;
  role: string;
  sources: string[];       // Where this email was found/generated
  corroborations: string[]; // Sources that confirmed this email
  smtpVerified: boolean;
  platformsFound: string[]; // Platforms where email exists
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const INTERNAL_TIMEOUT_MS = 170000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

// ============================================================================
// UTILITY: HTTP FETCH WITH TIMEOUT
// ============================================================================

async function fetchWithTimeout(
  url: string,
  timeoutMs: number = 8000,
  headers?: Record<string, string>
): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...headers
      },
    });

    clearTimeout(timeoutId);
    return response;
  } catch {
    return null;
  }
}

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
  ]);

  // Look for website/domain patterns
  const patterns = [
    /(?:website|web site|homepage|visit)[:\s]+(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi,
    /(?:www\.)([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi,
    /@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi,
    /https?:\/\/(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/gi,
  ];

  const domainMatches: { domain: string; score: number }[] = [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(research)) !== null) {
      const domain = match[1].toLowerCase();
      if (!skipDomains.has(domain)) {
        const containsCompanyName = domain.replace(/[^a-z0-9]/g, "").includes(cleanCompanyName);
        domainMatches.push({ domain, score: containsCompanyName ? 100 : 30 });
      }
    }
  }

  domainMatches.sort((a, b) => b.score - a.score);
  return domainMatches.length > 0 ? domainMatches[0].domain : `${cleanCompanyName}.com`;
}

// ============================================================================
// TEXT EXTRACTION UTILITIES
// ============================================================================

function extractEmailsFromText(text: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  return Array.from(new Set(matches.map(e => e.toLowerCase()))).filter(
    e => !e.includes("example.com") && !e.includes("sentry.io") && !e.includes("email.com")
  );
}

function extractPhonesFromText(text: string): string[] {
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  const matches = text.match(phoneRegex) || [];
  return Array.from(new Set(matches));
}

// ============================================================================
// EMAIL PREFIX TO NAME CONVERSION
// ============================================================================

/**
 * Converts an email prefix to a proper display name.
 * Examples:
 *   - sales → "Sales"
 *   - driverrecruitingdepartment → "Driver Recruiting Department"
 *   - info → "General Inquiries"
 *   - john.smith → "John Smith"
 */
function emailPrefixToName(email: string): string {
  const prefix = email.split("@")[0].toLowerCase();

  // Special cases for common generic emails
  const specialCases: Record<string, string> = {
    "info": "General Inquiries",
    "contact": "Contact",
    "support": "Support Team",
    "sales": "Sales",
    "help": "Help Desk",
    "admin": "Administration",
    "hr": "Human Resources",
    "jobs": "Careers",
    "careers": "Careers",
    "press": "Press Relations",
    "media": "Media Relations",
    "pr": "Public Relations",
    "marketing": "Marketing",
    "billing": "Billing",
    "accounts": "Accounts",
    "hello": "General Contact",
    "enquiries": "Enquiries",
    "enquiry": "Enquiries",
    "feedback": "Feedback",
    "webmaster": "Webmaster",
  };

  if (specialCases[prefix]) {
    return specialCases[prefix];
  }

  // Check if it looks like a person name (contains . or first.last pattern)
  if (prefix.includes(".")) {
    const parts = prefix.split(".");
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  }

  // Check for camelCase or concatenated words
  // Insert spaces before capital letters and numbers
  let spaced = prefix
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");

  // Try to split concatenated lowercase words using common patterns
  const departmentWords = [
    "department", "dept", "team", "group", "office", "center", "centre",
    "recruiting", "recruitment", "driver", "drivers", "customer", "service",
    "services", "inquiries", "inquiry", "relations", "resources", "management",
    "operations", "accounting", "finance", "legal", "compliance", "safety"
  ];

  for (const word of departmentWords) {
    const regex = new RegExp(`(${word})`, "gi");
    spaced = spaced.replace(regex, " $1 ");
  }

  // Clean up and capitalize
  const words = spaced
    .split(/[\s_-]+/)
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  if (words.length === 0) {
    return "Contact";
  }

  return words.join(" ");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// MX / DNS VERIFICATION
// ============================================================================

const mxCache = new Map<string, boolean>();

async function verifyEmailMX(email: string): Promise<boolean> {
  const domain = email.split("@")[1];
  if (!domain) return false;

  if (mxCache.has(domain)) return mxCache.get(domain)!;

  try {
    const records = await resolveMx(domain);
    const valid = records && records.length > 0;
    mxCache.set(domain, valid);
    return valid;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

// ============================================================================
// SMTP VERIFICATION (holehe-style)
// ============================================================================

async function verifyEmailSMTP(email: string): Promise<{ exists: "yes" | "no" | "unknown"; reason: string }> {
  const domain = email.split("@")[1];
  if (!domain) return { exists: "no", reason: "Invalid format" };

  try {
    const mxRecords = await resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { exists: "no", reason: "No MX records" };
    }

    mxRecords.sort((a, b) => a.priority - b.priority);
    const mxHost = mxRecords[0].exchange;

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let step = 0;

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve({ exists: "unknown", reason: "Timeout - MX valid" });
      }, 6000);

      socket.connect(25, mxHost, () => {});

      socket.on("data", (data) => {
        const code = parseInt(data.toString().substring(0, 3), 10);

        if (step === 0 && code === 220) {
          socket.write("HELO research.local\r\n");
          step = 1;
        } else if (step === 1 && code === 250) {
          socket.write("MAIL FROM:<verify@research.local>\r\n");
          step = 2;
        } else if (step === 2 && code === 250) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          step = 3;
        } else if (step === 3) {
          clearTimeout(timeout);
          socket.write("QUIT\r\n");
          socket.destroy();

          if (code === 250 || code === 251) {
            resolve({ exists: "yes", reason: "SMTP confirmed" });
          } else if (code >= 550 && code <= 553) {
            resolve({ exists: "no", reason: "Mailbox not found" });
          } else {
            resolve({ exists: "unknown", reason: `Code ${code}` });
          }
        } else {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ exists: "unknown", reason: "SMTP error" });
        }
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ exists: "unknown", reason: "Connection failed" });
      });
    });
  } catch {
    return { exists: "unknown", reason: "Error" };
  }
}

// ============================================================================
// POASTAL-STYLE: Platform Registration Checks
// ============================================================================

interface PlatformCheckResult {
  platform: string;
  exists: boolean | null;
  info?: string;
}

async function checkEmailPlatforms(email: string): Promise<PlatformCheckResult[]> {
  const results: PlatformCheckResult[] = [];

  // Gravatar check - if they have a gravatar, email is real
  try {
    const crypto = await import("crypto");
    const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
    const gravatarUrl = `https://www.gravatar.com/avatar/${hash}?d=404`;
    const response = await fetchWithTimeout(gravatarUrl, 5000);
    results.push({
      platform: "Gravatar",
      exists: response?.status === 200,
      info: response?.status === 200 ? "Has profile picture" : undefined
    });
  } catch {
    results.push({ platform: "Gravatar", exists: null });
  }

  // GitHub check - search for email in commits
  try {
    const ghUrl = `https://api.github.com/search/commits?q=author-email:${encodeURIComponent(email)}`;
    const response = await fetchWithTimeout(ghUrl, 5000, {
      "Accept": "application/vnd.github.v3+json"
    });
    if (response?.ok) {
      const data = await response.json();
      results.push({
        platform: "GitHub",
        exists: data.total_count > 0,
        info: data.total_count > 0 ? `${data.total_count} commits` : undefined
      });
    }
  } catch {
    results.push({ platform: "GitHub", exists: null });
  }

  return results;
}

// ============================================================================
// GITSOME-STYLE: GitHub Email Extraction
// ============================================================================

async function searchGitHubForDomain(domain: string): Promise<string[]> {
  const emails: string[] = [];

  try {
    // Search GitHub for commits from this domain
    const searchUrl = `https://api.github.com/search/commits?q=author-email:@${encodeURIComponent(domain)}&per_page=30`;
    const response = await fetchWithTimeout(searchUrl, 8000, {
      "Accept": "application/vnd.github.v3+json"
    });

    if (response?.ok) {
      const data = await response.json();
      for (const item of data.items || []) {
        const authorEmail = item.commit?.author?.email;
        if (authorEmail && authorEmail.includes(domain)) {
          emails.push(authorEmail.toLowerCase());
        }
      }
    }
  } catch {
    // GitHub API might be rate limited
  }

  return Array.from(new Set(emails));
}

async function searchGitHubForPerson(personName: string, companyName: string): Promise<string[]> {
  const emails: string[] = [];

  try {
    const query = `${personName} ${companyName}`;
    const searchUrl = `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=5`;
    const response = await fetchWithTimeout(searchUrl, 8000, {
      "Accept": "application/vnd.github.v3+json"
    });

    if (response?.ok) {
      const data = await response.json();
      for (const user of data.items || []) {
        // Fetch user details to get email
        const userUrl = `https://api.github.com/users/${user.login}`;
        const userResp = await fetchWithTimeout(userUrl, 5000, {
          "Accept": "application/vnd.github.v3+json"
        });
        if (userResp?.ok) {
          const userData = await userResp.json();
          if (userData.email) {
            emails.push(userData.email.toLowerCase());
          }
        }
      }
    }
  } catch {
    // Rate limited or error
  }

  return emails;
}

// ============================================================================
// CROSSLINKED-STYLE: LinkedIn Dorking for Person
// ============================================================================

async function searchLinkedInForPerson(
  personName: string,
  companyName: string
): Promise<{ emails: string[]; info: string[] }> {
  const emails: string[] = [];
  const info: string[] = [];

  // Extract name parts for variations
  const nameParts = personName.split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts[nameParts.length - 1] || "";

  const queries = [
    // Standard LinkedIn dorking
    `site:linkedin.com "${personName}" "${companyName}" email`,
    `site:linkedin.com/in "${personName}" "${companyName}"`,
    `site:linkedin.com "${firstName}" "${lastName}" "${companyName}"`,

    // Email contact searches
    `"${personName}" "${companyName}" email contact`,
    `"${personName}" "${companyName}" @`,
    `"${firstName} ${lastName}" email "${companyName}"`,

    // RocketReach/ZoomInfo style - public profile aggregators
    `"${personName}" "${companyName}" site:rocketreach.co`,
    `"${personName}" "${companyName}" site:zoominfo.com`,
    `"${personName}" "${companyName}" site:apollo.io`,
    `"${personName}" "${companyName}" site:lusha.com`,

    // SignalHire style - contact lookup
    `"${personName}" "${companyName}" site:signalhire.com`,

    // Public databases
    `"${personName}" "${companyName}" site:opencorporates.com`,
    `"${personName}" "${companyName}" site:dnb.com`,
  ];

  for (const query of queries) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const response = await fetchWithTimeout(url);
      if (response?.ok) {
        const html = await response.text();
        const text = stripHtml(html);

        // Extract any emails found
        const foundEmails = extractEmailsFromText(text);
        emails.push(...foundEmails);

        // Look for LinkedIn profile snippets
        if (text.toLowerCase().includes(personName.toLowerCase())) {
          info.push(`Found mention in search for: ${query.substring(0, 50)}`);
        }
      }
    } catch {
      // Continue
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 250));
  }

  return { emails: Array.from(new Set(emails)), info };
}

// ============================================================================
// THEHARVESTER-STYLE: Multi-Source Person Search
// ============================================================================

async function harvesterSearchForPerson(
  personName: string,
  companyName: string,
  domain: string
): Promise<{ emails: string[]; phones: string[]; sources: string[] }> {
  const emails: string[] = [];
  const phones: string[] = [];
  const sources: string[] = [];

  // Extract first/last name for more targeted queries
  const nameParts = personName.split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts[nameParts.length - 1] || "";

  const searches = [
    // Direct person + company email search
    { engine: "bing", query: `"${personName}" "${companyName}" email` },
    { engine: "bing", query: `"${personName}" @${domain}` },
    { engine: "ddg", query: `"${personName}" "${companyName}" contact email` },

    // Press releases often have contact info
    { engine: "bing", query: `site:prnewswire.com "${personName}" "${companyName}"` },
    { engine: "bing", query: `site:businesswire.com "${personName}" "${companyName}"` },
    { engine: "bing", query: `site:globenewswire.com "${personName}" "${companyName}"` },

    // News articles - more aggressive
    { engine: "bing", query: `"${personName}" "${companyName}" CEO OR President OR Director email` },
    { engine: "bing", query: `"${personName}" "${companyName}" contact OR email OR phone` },
    { engine: "ddg", query: `"${personName}" "${companyName}" announcement OR appointed` },

    // Social profiles - more thorough
    { engine: "ddg", query: `"${personName}" "${companyName}" twitter OR linkedin email` },
    { engine: "bing", query: `site:twitter.com "${personName}" "${companyName}"` },

    // SEC/regulatory filings
    { engine: "bing", query: `site:sec.gov "${personName}" "${companyName}"` },

    // Industry directories
    { engine: "bing", query: `"${personName}" "${companyName}" site:zoominfo.com OR site:apollo.io OR site:leadiq.com` },

    // Conference speakers/attendees often have contact info
    { engine: "ddg", query: `"${personName}" "${companyName}" speaker OR conference OR panel` },

    // Podcast/interview appearances
    { engine: "bing", query: `"${personName}" "${companyName}" podcast OR interview` },

    // Direct domain email patterns in search
    { engine: "bing", query: `"${firstName}.${lastName}@${domain}"` },
    { engine: "bing", query: `"${firstName[0]}${lastName}@${domain}"` },

    // Hunter.io style - look for existing email patterns
    { engine: "bing", query: `site:${domain} email OR contact OR "@${domain}"` },

    // Data breach/paste sites (public) - these often reveal real email patterns
    { engine: "ddg", query: `"@${domain}" "${lastName}" email` },
  ];

  for (const { engine, query } of searches) {
    try {
      const url = engine === "bing"
        ? `https://www.bing.com/search?q=${encodeURIComponent(query)}`
        : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      const response = await fetchWithTimeout(url);
      if (response?.ok) {
        const html = await response.text();
        const text = stripHtml(html);

        const foundEmails = extractEmailsFromText(text);
        const foundPhones = extractPhonesFromText(text);

        if (foundEmails.length > 0 || foundPhones.length > 0) {
          sources.push(`${engine}: ${query.substring(0, 40)}...`);
        }

        emails.push(...foundEmails);
        phones.push(...foundPhones);
      }
    } catch {
      // Continue
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return {
    emails: Array.from(new Set(emails)),
    phones: Array.from(new Set(phones)),
    sources
  };
}

// ============================================================================
// EMAIL GENERATION (Buster-style)
// ============================================================================

function generateEmailPermutations(firstName: string, lastName: string, domain: string): string[] {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, "");
  const l = lastName.toLowerCase().replace(/[^a-z]/g, "");

  if (!f || !l) return [];

  return [
    `${f}.${l}@${domain}`,           // john.smith
    `${f}${l}@${domain}`,            // johnsmith
    `${f[0]}${l}@${domain}`,         // jsmith
    `${f}@${domain}`,                // john
    `${f[0]}.${l}@${domain}`,        // j.smith
    `${l}.${f}@${domain}`,           // smith.john
    `${l}${f}@${domain}`,            // smithjohn
    `${f}_${l}@${domain}`,           // john_smith
    `${f[0]}${l[0]}@${domain}`,      // js (rare but possible)
    `${f}${l[0]}@${domain}`,         // johns
  ];
}

// ============================================================================
// CORROBORATION: Search for Email Online
// ============================================================================

async function corroborateEmail(
  email: string,
  personName: string,
  companyName: string
): Promise<string[]> {
  const corroborations: string[] = [];

  const queries = [
    `"${email}"`,
    `"${email}" "${personName}"`,
    `"${email}" "${companyName}"`,
  ];

  for (const query of queries) {
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const response = await fetchWithTimeout(url, 6000);
      if (response?.ok) {
        const text = stripHtml(await response.text());
        if (text.toLowerCase().includes(email.toLowerCase())) {
          corroborations.push(`Found "${email}" in web search`);
          break; // One corroboration is enough
        }
      }
    } catch {
      // Continue
    }
  }

  return corroborations;
}

// ============================================================================
// SEC EDGAR: Search for Company Officers
// ============================================================================

async function searchSECEdgar(companyName: string): Promise<KeyPerson[]> {
  const officers: KeyPerson[] = [];

  try {
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&forms=10-K,DEF%2014A`;
    const response = await fetchWithTimeout(searchUrl, 10000, {
      "User-Agent": "ContactResearch/1.0",
      "Accept": "application/json"
    });

    if (!response?.ok) return officers;

    const data = await response.json();
    const hits = data?.hits?.hits || [];
    if (hits.length === 0) return officers;

    const cik = hits[0]?._source?.ciks?.[0] || hits[0]?._source?.cik;
    if (!cik) return officers;

    const subUrl = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;
    const subResponse = await fetchWithTimeout(subUrl, 10000, {
      "User-Agent": "ContactResearch/1.0",
      "Accept": "application/json"
    });

    if (!subResponse?.ok) return officers;

    const subData = await subResponse.json();
    if (subData.officers && Array.isArray(subData.officers)) {
      for (const officer of subData.officers) {
        const name = officer.name || officer.officerName || "";
        const parts = name.split(/\s+/);
        if (parts.length >= 2) {
          officers.push({
            name,
            role: officer.title || officer.officerTitle || "Executive",
            firstName: parts[0],
            lastName: parts[parts.length - 1]
          });
        }
      }
    }
  } catch {
    // SEC search failed
  }

  return officers;
}

// ============================================================================
// PHASE 1: EXTRACT KEY PEOPLE FROM RESEARCH (RUNS ONCE)
// ============================================================================

async function extractKeyPeopleFromResearch(
  anthropic: Anthropic,
  companyName: string,
  companyResearch: string,
  startTime: number
): Promise<KeyPerson[]> {
  // Truncate research to avoid eating context
  const truncated = companyResearch.length > 8000
    ? companyResearch.substring(0, 8000) + "\n...[truncated]"
    : companyResearch;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 60000) break;

    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "Extract key people from company research. Return ONLY valid JSON array.",
        messages: [{
          role: "user",
          content: `Extract the key people (executives, owners, directors, managers) from this research about ${companyName}.

RESEARCH DOCUMENT:
${truncated}

Return a JSON array of people with their roles. Focus on:
- CEO, President, Owner, Founder
- CFO, COO, CTO
- Directors, VPs
- Key managers mentioned by name

Format: [{"name": "John Smith", "role": "CEO"}, ...]

IMPORTANT:
- Only include people with FULL NAMES (first and last)
- Only include people clearly associated with ${companyName}
- Maximum 10 people
- Return ONLY the JSON array, no other text`
        }]
      });

      const textBlock = response.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") continue;

      let jsonText = textBlock.text.trim();
      if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      }

      const people = JSON.parse(jsonText) as Array<{ name: string; role: string }>;

      return people.map(p => {
        const parts = p.name.trim().split(/\s+/);
        return {
          name: p.name,
          role: p.role,
          firstName: parts[0] || "",
          lastName: parts[parts.length - 1] || ""
        };
      }).filter(p => p.firstName && p.lastName);

    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, BASE_RETRY_DELAY_MS * Math.pow(2, attempt)));
      }
    }
  }

  return [];
}

// ============================================================================
// PHASE 2: RESEARCH EACH PERSON
// ============================================================================

async function researchPerson(
  person: KeyPerson,
  companyName: string,
  domain: string,
  onProgress?: ProgressCallback
): Promise<EmailCandidate[]> {
  const candidates: EmailCandidate[] = [];
  const allEmails = new Set<string>();

  onProgress?.({
    type: "iteration",
    iteration: 1,
    maxIterations: 6,
    action: `Researching ${person.name} (${person.role})...`
  });

  // 1. Generate email permutations - but DON'T add them yet
  //    We'll verify them FIRST before adding to candidates
  const permutations = generateEmailPermutations(person.firstName, person.lastName, domain);
  const permutationsToVerify = permutations.slice(0, 6); // Top 6 patterns to check

  // 2. Verify pattern-generated emails with SMTP BEFORE adding
  onProgress?.({
    type: "iteration",
    iteration: 2,
    maxIterations: 6,
    action: `Verifying email patterns for ${person.name}...`
  });

  // First check MX once for domain
  const domainMxValid = await verifyEmailMX(`test@${domain}`);
  if (domainMxValid) {
    for (const email of permutationsToVerify) {
      // SMTP verification - only add if verified or possibly valid
      const smtpResult = await verifyEmailSMTP(email);

      if (smtpResult.exists === "yes") {
        // VERIFIED! Add with high priority
        candidates.push({
          email,
          personName: person.name,
          role: person.role,
          sources: ["Pattern generated (SMTP verified)"],
          corroborations: [],
          smtpVerified: true,
          platformsFound: []
        });
        allEmails.add(email);
        console.log(`[SMTP] VERIFIED: ${email}`);
      } else if (smtpResult.exists === "unknown" && smtpResult.reason.includes("MX valid")) {
        // Server didn't reject but also didn't confirm - still worth adding
        candidates.push({
          email,
          personName: person.name,
          role: person.role,
          sources: ["Pattern generated (MX valid)"],
          corroborations: [],
          smtpVerified: false,
          platformsFound: []
        });
        allEmails.add(email);
      }
      // If "no" - email definitely doesn't exist, don't add it
    }
  }

  // 3. CrossLinked-style LinkedIn search
  onProgress?.({
    type: "iteration",
    iteration: 3,
    maxIterations: 6,
    action: `LinkedIn search for ${person.name}...`
  });

  const linkedInResults = await searchLinkedInForPerson(person.name, companyName);
  for (const email of linkedInResults.emails) {
    if (!allEmails.has(email)) {
      candidates.push({
        email,
        personName: person.name,
        role: person.role,
        sources: ["LinkedIn search"],
        corroborations: linkedInResults.info,
        smtpVerified: false,
        platformsFound: []
      });
      allEmails.add(email);
    }
  }

  // 4. theHarvester-style multi-source search
  onProgress?.({
    type: "iteration",
    iteration: 4,
    maxIterations: 6,
    action: `OSINT search for ${person.name}...`
  });

  const harvesterResults = await harvesterSearchForPerson(person.name, companyName, domain);
  for (const email of harvesterResults.emails) {
    if (!allEmails.has(email)) {
      candidates.push({
        email,
        personName: person.name,
        role: person.role,
        sources: harvesterResults.sources,
        corroborations: [],
        smtpVerified: false,
        platformsFound: []
      });
      allEmails.add(email);
    } else {
      // Add sources to existing candidate
      const existing = candidates.find(c => c.email === email);
      if (existing) {
        existing.sources.push(...harvesterResults.sources);
      }
    }
  }

  // 5. gitSome-style GitHub search
  onProgress?.({
    type: "iteration",
    iteration: 5,
    maxIterations: 6,
    action: `GitHub search for ${person.name}...`
  });

  const githubEmails = await searchGitHubForPerson(person.name, companyName);
  for (const email of githubEmails) {
    if (!allEmails.has(email)) {
      candidates.push({
        email,
        personName: person.name,
        role: person.role,
        sources: ["GitHub"],
        corroborations: [],
        smtpVerified: false,
        platformsFound: ["GitHub"]
      });
      allEmails.add(email);
    }
  }

  // 6. Verify and corroborate remaining candidates (non-pattern ones)
  onProgress?.({
    type: "iteration",
    iteration: 6,
    maxIterations: 6,
    action: `Verifying emails for ${person.name}...`
  });

  // Sort by number of sources (more sources = higher priority)
  candidates.sort((a, b) => b.sources.length - a.sources.length);

  // Verify top 5 candidates
  for (const candidate of candidates.slice(0, 5)) {
    // MX verification
    const mxValid = await verifyEmailMX(candidate.email);
    if (!mxValid) continue;

    // SMTP verification (holehe-style)
    const smtpResult = await verifyEmailSMTP(candidate.email);
    candidate.smtpVerified = smtpResult.exists === "yes";

    // Platform checks (Poastal-style)
    const platformResults = await checkEmailPlatforms(candidate.email);
    candidate.platformsFound = platformResults
      .filter(p => p.exists === true)
      .map(p => p.platform);

    // Corroboration search
    if (candidate.sources.length === 1 && candidate.sources[0] === "Pattern generated") {
      const corroborations = await corroborateEmail(candidate.email, person.name, companyName);
      candidate.corroborations.push(...corroborations);
    }
  }

  return candidates.filter(c => {
    // Keep if:
    // 1. SMTP verified (definite valid email)
    // 2. Found on platform (Gravatar, GitHub)
    // 3. Corroborated online
    // 4. Multiple independent sources
    // 5. Pattern generated with MX valid (give benefit of doubt)
    const hasEvidence = c.smtpVerified ||
                        c.platformsFound.length > 0 ||
                        c.corroborations.length > 0 ||
                        c.sources.length > 1 ||
                        c.sources.some(s => s.includes("MX valid"));
    return hasEvidence;
  });
}

// ============================================================================
// WEBPAGE SCRAPING
// ============================================================================

async function scrapeWebsite(
  domain: string,
  onProgress?: ProgressCallback
): Promise<{ emails: string[]; phones: string[]; names: string[] }> {
  const emails: string[] = [];
  const phones: string[] = [];
  const names: string[] = [];

  const pages = [
    `https://${domain}`,
    `https://${domain}/about`,
    `https://${domain}/about-us`,
    `https://${domain}/team`,
    `https://${domain}/leadership`,
    `https://${domain}/contact`,
    `https://www.${domain}`,
    `https://www.${domain}/about`,
    `https://www.${domain}/contact`,
  ];

  for (let i = 0; i < pages.length; i++) {
    const url = pages[i];
    onProgress?.({
      type: "iteration",
      iteration: i + 1,
      maxIterations: pages.length,
      action: `Scraping ${new URL(url).pathname || "/"}`
    });

    try {
      const response = await fetchWithTimeout(url, 8000);
      if (response?.ok) {
        const html = await response.text();
        emails.push(...extractEmailsFromText(html));
        phones.push(...extractPhonesFromText(html));

        // Extract names with titles
        const namePatterns = [
          /([A-Z][a-z]+ [A-Z][a-z]+)(?:\s*[-–,]\s*(?:CEO|CFO|COO|President|Owner|Founder|Director|VP))/g,
          /(?:CEO|CFO|COO|President|Owner|Director|VP)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/g,
        ];

        const text = stripHtml(html);
        for (const pattern of namePatterns) {
          let match;
          while ((match = pattern.exec(text)) !== null) {
            if (match[1]) names.push(match[1]);
          }
        }
      }
    } catch {
      // Continue
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return {
    emails: Array.from(new Set(emails)),
    phones: Array.from(new Set(phones)),
    names: Array.from(new Set(names))
  };
}

// ============================================================================
// MAIN RESEARCH FUNCTION
// ============================================================================

export async function researchContacts(
  params: ContactResearchParams,
  onProgress?: ProgressCallback
): Promise<ResearchResult> {
  const startTime = Date.now();
  const { companyName, companyResearch } = params;
  const finalContacts: DiscoveredContact[] = [];
  const pagesVisited: string[] = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    onProgress?.({ type: "error", message: "No API key configured" });
    return {
      contacts: [],
      summary: "No API key configured",
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  const domain = params.companyDomain || extractCompanyDomain(companyResearch, companyName);
  if (!domain) {
    onProgress?.({ type: "error", message: "Could not determine domain" });
    return {
      contacts: [],
      summary: "Could not determine domain",
      stages: { pagesVisited: [], contactsFound: 0, emailsVerified: 0, phonesFound: 0 },
      durationMs: Date.now() - startTime
    };
  }

  onProgress?.({ type: "started", companyName, domain });
  const anthropic = new Anthropic({ apiKey });

  // =========================================================================
  // PHASE 1: EXTRACT KEY PEOPLE FROM RESEARCH (ONCE)
  // =========================================================================

  onProgress?.({ type: "phase", phase: "extracting", message: "Phase 1: Extracting key people from research document..." });

  let keyPeople = await extractKeyPeopleFromResearch(anthropic, companyName, companyResearch, startTime);

  console.log(`[Phase 1] Extracted ${keyPeople.length} key people from research`);

  // If no people found in research, try SEC EDGAR
  if (keyPeople.length === 0) {
    onProgress?.({ type: "phase", phase: "searching", message: "No people in research - searching SEC EDGAR..." });
    const secPeople = await searchSECEdgar(companyName);
    keyPeople.push(...secPeople);
    console.log(`[Phase 1] Found ${secPeople.length} officers from SEC EDGAR`);
  }

  // Also scrape website for names if still low
  if (keyPeople.length < 3) {
    onProgress?.({ type: "phase", phase: "browsing", message: "Scraping website for additional names..." });
    const websiteData = await scrapeWebsite(domain, onProgress);

    for (const name of websiteData.names) {
      const parts = name.split(/\s+/);
      if (parts.length >= 2 && !keyPeople.some(p => p.name === name)) {
        keyPeople.push({
          name,
          role: "Employee",
          firstName: parts[0],
          lastName: parts[parts.length - 1]
        });
      }
    }

    // Also check if website emails can be attributed
    for (const email of websiteData.emails) {
      if (email.endsWith(`@${domain}`)) {
        // This is a company email - add as a contact directly
        const mxValid = await verifyEmailMX(email);
        if (mxValid && !finalContacts.some(c => c.email === email)) {
          // Derive proper name from email prefix instead of generic "Website Contact"
          const derivedName = emailPrefixToName(email);

          // SMTP verify the email to boost confidence
          const smtpResult = await verifyEmailSMTP(email);
          const smtpVerified = smtpResult.exists === "yes";
          const confidence = smtpVerified ? "high" : "medium";

          finalContacts.push({
            name: derivedName,
            email,
            phone: websiteData.phones[0] || null,
            role: derivedName.includes("Department") || derivedName.includes("Team") ? derivedName : "Contact",
            confidence,
            source: "Company website",
            verified: smtpVerified
          });
          onProgress?.({ type: "contact", contact: finalContacts[finalContacts.length - 1] });
        }
      }
    }
  }

  // =========================================================================
  // PHASE 2: RESEARCH EACH KEY PERSON
  // =========================================================================

  onProgress?.({ type: "phase", phase: "searching", message: `Phase 2: Researching ${keyPeople.length} key people...` });

  for (let i = 0; i < Math.min(keyPeople.length, 8); i++) {
    if (Date.now() - startTime > INTERNAL_TIMEOUT_MS - 30000) {
      onProgress?.({ type: "phase", phase: "complete", message: "Time limit approaching - finalizing results" });
      break;
    }

    const person = keyPeople[i];

    onProgress?.({ type: "phase", phase: "searching", message: `Researching ${person.name} (${i + 1}/${Math.min(keyPeople.length, 8)})...` });

    const candidates = await researchPerson(person, companyName, domain, onProgress);

    // Convert best candidates to contacts
    for (const candidate of candidates.slice(0, 2)) { // Top 2 per person
      if (!finalContacts.some(c => c.email === candidate.email)) {
        // Calculate confidence - prioritize SMTP verification
        let confidence: "high" | "medium" | "low" = "low";

        const isPatternGenerated = candidate.sources.some(s => s.includes("Pattern generated"));

        if (candidate.smtpVerified) {
          // SMTP verified = at minimum medium, or high if corroborated
          if (candidate.corroborations.length > 0 || candidate.platformsFound.length > 0) {
            confidence = "high";
          } else {
            confidence = "medium"; // SMTP verified pattern emails get medium
          }
        } else if (candidate.platformsFound.length > 0 || candidate.sources.length > 1) {
          confidence = "medium";
        } else if (isPatternGenerated && candidate.sources.some(s => s.includes("MX valid"))) {
          confidence = "low"; // MX valid but not SMTP verified = low
        }

        const source = candidate.sources.join(", ").substring(0, 100);

        const contact: DiscoveredContact = {
          name: candidate.personName,
          email: candidate.email,
          phone: null,
          role: candidate.role,
          confidence,
          source: source || "Pattern matched",
          verified: candidate.smtpVerified
        };

        finalContacts.push(contact);
        onProgress?.({ type: "contact", contact });
      }
    }
  }

  // =========================================================================
  // PHASE 3: ADDITIONAL DOMAIN OSINT (if low results)
  // =========================================================================

  if (finalContacts.length < 3 && Date.now() - startTime < INTERNAL_TIMEOUT_MS - 20000) {
    onProgress?.({ type: "phase", phase: "searching", message: "Phase 3: Additional domain OSINT..." });

    // gitSome-style: GitHub commits for domain
    const githubEmails = await searchGitHubForDomain(domain);
    for (const email of githubEmails.slice(0, 3)) {
      if (!finalContacts.some(c => c.email === email)) {
        const mxValid = await verifyEmailMX(email);
        if (mxValid) {
          finalContacts.push({
            name: "GitHub User",
            email,
            phone: null,
            role: "Developer",
            confidence: "medium",
            source: "GitHub commits",
            verified: true
          });
          onProgress?.({ type: "contact", contact: finalContacts[finalContacts.length - 1] });
        }
      }
    }
  }

  // =========================================================================
  // PHASE 4: FALLBACK - Generic Emails
  // =========================================================================

  if (finalContacts.length === 0) {
    onProgress?.({ type: "phase", phase: "complete", message: "Phase 4: Adding generic fallbacks..." });

    const genericPrefixes = ["info", "contact", "sales", "support"];
    for (const prefix of genericPrefixes) {
      const email = `${prefix}@${domain}`;
      const mxValid = await verifyEmailMX(email);
      if (mxValid) {
        finalContacts.push({
          name: prefix === "info" ? "General Inquiries" : `${prefix.charAt(0).toUpperCase() + prefix.slice(1)} Department`,
          email,
          phone: null,
          role: "General Contact",
          confidence: "low",
          source: "Generic fallback",
          verified: true
        });
        onProgress?.({ type: "contact", contact: finalContacts[finalContacts.length - 1] });
      }
    }

    // Last resort
    if (finalContacts.length === 0) {
      finalContacts.push({
        name: "General Inquiries",
        email: `info@${domain}`,
        phone: null,
        role: "General Contact",
        confidence: "low",
        source: "Unverified fallback",
        verified: false
      });
    }
  }

  // =========================================================================
  // BUILD RESULT
  // =========================================================================

  const durationMs = Date.now() - startTime;
  const verified = finalContacts.filter(c => c.verified).length;
  const highConf = finalContacts.filter(c => c.confidence === "high").length;

  let summary = `Found ${finalContacts.length} contact(s) for ${companyName}. `;
  summary += `Researched ${keyPeople.length} key people. `;
  summary += `${verified} verified, ${highConf} high confidence.`;

  const result: ResearchResult = {
    contacts: finalContacts.slice(0, 20),
    summary,
    stages: {
      pagesVisited,
      contactsFound: finalContacts.length,
      emailsVerified: verified,
      phonesFound: finalContacts.filter(c => c.phone).length
    },
    durationMs
  };

  onProgress?.({ type: "complete", result });

  return result;
}
