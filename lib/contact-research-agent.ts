import Anthropic from "@anthropic-ai/sdk";

interface ContactResearchParams {
  companyName: string;
  companyResearch: string;
  companyDomain?: string;
}

interface DiscoveredContact {
  name: string;
  email: string;
  role: string;
  confidence: "high" | "medium" | "low";
  source: string;
}

interface ResearchResult {
  contacts: DiscoveredContact[];
  summary: string;
  searchesPerformed: string[];
}

// Tool definitions for the research agent
const tools: Anthropic.Tool[] = [
  {
    name: "analyze_company_research",
    description:
      "Analyze the company research document to extract key information like company domain, leadership structure, and target departments",
    input_schema: {
      type: "object" as const,
      properties: {
        research_text: {
          type: "string",
          description: "The company research text to analyze",
        },
      },
      required: ["research_text"],
    },
  },
  {
    name: "identify_key_roles",
    description:
      "Identify the key roles/positions at a company that would be valuable to contact based on the outreach purpose",
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: {
          type: "string",
          description: "Name of the company",
        },
        industry: {
          type: "string",
          description: "Industry the company operates in",
        },
        target_departments: {
          type: "array",
          items: { type: "string" },
          description:
            "Departments to target (e.g., Engineering, Marketing, Sales)",
        },
      },
      required: ["company_name"],
    },
  },
  {
    name: "generate_email_patterns",
    description:
      "Generate likely email address patterns for a company based on its domain",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Company email domain (e.g., company.com)",
        },
        person_name: {
          type: "string",
          description: "Full name of the person (e.g., John Smith)",
        },
      },
      required: ["domain", "person_name"],
    },
  },
  {
    name: "search_web",
    description:
      "Search the web for information about company contacts, leadership, or email addresses",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query to find contact information",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "compile_contacts",
    description:
      "Compile the final list of discovered contacts with their details",
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
              role: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              source: { type: "string" },
            },
            required: ["name", "email", "role", "confidence", "source"],
          },
          description: "List of discovered contacts",
        },
        summary: {
          type: "string",
          description: "Summary of the research performed",
        },
      },
      required: ["contacts", "summary"],
    },
  },
];

// Simulated tool implementations
function executeAnalyzeCompanyResearch(researchText: string): string {
  // Extract domain from research if present
  const domainMatch = researchText.match(
    /(?:website|domain|url)[:\s]+(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/i
  );
  const domain = domainMatch ? domainMatch[1] : null;

  // Look for mentioned people
  const namePatterns = researchText.match(
    /(?:CEO|CTO|CFO|VP|Director|Manager|Head of|Chief)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/gi
  );
  const mentionedPeople = namePatterns
    ? Array.from(new Set(namePatterns))
    : [];

  // Look for email patterns already in the research
  const emailMatches = researchText.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi
  );
  const existingEmails = emailMatches ? Array.from(new Set(emailMatches)) : [];

  return JSON.stringify({
    extractedDomain: domain,
    mentionedPeople,
    existingEmails,
    companySize: researchText.includes("enterprise")
      ? "enterprise"
      : researchText.includes("startup")
        ? "startup"
        : "mid-market",
    keyTopics: extractKeyTopics(researchText),
  });
}

function extractKeyTopics(text: string): string[] {
  const topics: string[] = [];
  const keywords = [
    "AI",
    "machine learning",
    "SaaS",
    "fintech",
    "healthcare",
    "e-commerce",
    "B2B",
    "B2C",
    "enterprise",
    "startup",
    "cloud",
    "security",
    "data",
    "analytics",
  ];
  for (const keyword of keywords) {
    if (text.toLowerCase().includes(keyword.toLowerCase())) {
      topics.push(keyword);
    }
  }
  return topics;
}

function executeIdentifyKeyRoles(
  companyName: string,
  industry?: string,
  targetDepartments?: string[]
): string {
  const defaultRoles = [
    { title: "CEO", department: "Executive", priority: "high" },
    { title: "CTO", department: "Technology", priority: "high" },
    { title: "VP of Engineering", department: "Engineering", priority: "medium" },
    { title: "VP of Sales", department: "Sales", priority: "medium" },
    { title: "VP of Marketing", department: "Marketing", priority: "medium" },
    { title: "Head of Product", department: "Product", priority: "medium" },
    { title: "Director of Business Development", department: "Sales", priority: "medium" },
  ];

  // Filter by target departments if specified
  let roles = defaultRoles;
  if (targetDepartments && targetDepartments.length > 0) {
    roles = defaultRoles.filter((r) =>
      targetDepartments.some(
        (d) => r.department.toLowerCase().includes(d.toLowerCase())
      )
    );
  }

  return JSON.stringify({
    companyName,
    industry: industry || "Technology",
    recommendedRoles: roles,
    searchSuggestions: roles.map((r) => `${companyName} ${r.title}`),
  });
}

function executeGenerateEmailPatterns(domain: string, personName: string): string {
  const [firstName, ...lastNameParts] = personName.trim().split(" ");
  const lastName = lastNameParts.join(" ");

  if (!firstName || !lastName) {
    return JSON.stringify({
      patterns: [`${firstName.toLowerCase()}@${domain}`],
      note: "Only first name available, limited patterns generated",
    });
  }

  const f = firstName.toLowerCase();
  const l = lastName.toLowerCase().replace(/\s+/g, "");
  const fi = f[0];
  const li = l[0];

  const patterns = [
    `${f}.${l}@${domain}`,
    `${f}${l}@${domain}`,
    `${fi}${l}@${domain}`,
    `${f}_${l}@${domain}`,
    `${f}@${domain}`,
    `${l}.${f}@${domain}`,
    `${fi}.${l}@${domain}`,
  ];

  return JSON.stringify({
    personName,
    domain,
    patterns,
    mostLikely: patterns.slice(0, 3),
  });
}

function executeSearchWeb(query: string): string {
  // In a real implementation, this would call a search API
  // For now, return simulated search guidance
  return JSON.stringify({
    query,
    note: "Web search simulated - in production, integrate with search API",
    suggestions: [
      `Search LinkedIn for "${query}"`,
      `Check company website's About/Team page`,
      `Look for press releases mentioning key personnel`,
    ],
    simulatedFindings: [],
  });
}

function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case "analyze_company_research":
      return executeAnalyzeCompanyResearch(toolInput.research_text as string);
    case "identify_key_roles":
      return executeIdentifyKeyRoles(
        toolInput.company_name as string,
        toolInput.industry as string | undefined,
        toolInput.target_departments as string[] | undefined
      );
    case "generate_email_patterns":
      return executeGenerateEmailPatterns(
        toolInput.domain as string,
        toolInput.person_name as string
      );
    case "search_web":
      return executeSearchWeb(toolInput.query as string);
    case "compile_contacts":
      // This is the final tool - just return the input as-is
      return JSON.stringify(toolInput);
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

export async function researchContacts(
  params: ContactResearchParams
): Promise<ResearchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  }

  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = `You are a B2B contact research specialist. Your job is to analyze company information and identify the best contacts to reach out to for business purposes.

Your task:
1. First, analyze the company research document to understand the company
2. Identify key roles that would be valuable to contact
3. Generate likely email patterns for the company's domain
4. Compile a final list of suggested contacts

Be thorough but practical. Focus on finding 3-5 high-quality contacts rather than many low-quality ones.

When you have gathered enough information, use the compile_contacts tool to return your final results.`;

  const userPrompt = `Please research contacts for the following company:

Company Name: ${params.companyName}
${params.companyDomain ? `Company Domain: ${params.companyDomain}` : ""}

Company Research Document:
${params.companyResearch}

Find the best contacts to reach out to at this company. Start by analyzing the research document, then identify key roles, and finally compile a list of suggested contacts with likely email addresses.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  const searchesPerformed: string[] = [];
  let finalResult: ResearchResult | null = null;
  let iterations = 0;
  const maxIterations = 10;

  // Agentic loop - keep processing until we get a final result or hit max iterations
  while (!finalResult && iterations < maxIterations) {
    iterations++;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Check if we're done
    if (response.stop_reason === "end_turn") {
      // Model finished without calling compile_contacts - extract any text response
      const textContent = response.content.find((c) => c.type === "text");
      finalResult = {
        contacts: [],
        summary: textContent
          ? (textContent as Anthropic.TextBlock).text
          : "Research completed but no contacts found",
        searchesPerformed,
      };
      break;
    }

    // Process tool calls
    if (response.stop_reason === "tool_use") {
      const assistantMessage: Anthropic.MessageParam = {
        role: "assistant",
        content: response.content,
      };
      messages.push(assistantMessage);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          searchesPerformed.push(`${block.name}: ${JSON.stringify(block.input)}`);

          const result = executeTool(
            block.name,
            block.input as Record<string, unknown>
          );

          // Check if this is the final compile_contacts call
          if (block.name === "compile_contacts") {
            const parsed = JSON.parse(result);
            finalResult = {
              contacts: parsed.contacts || [],
              summary: parsed.summary || "Research completed",
              searchesPerformed,
            };
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  if (!finalResult) {
    return {
      contacts: [],
      summary: "Research timed out after maximum iterations",
      searchesPerformed,
    };
  }

  return finalResult;
}
