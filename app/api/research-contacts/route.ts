import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { researchContacts } from "@/lib/contact-research-agent";

// Vercel serverless timeout - keep well under 60s
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return NextResponse.json(
        { error: "Company ID is required" },
        { status: 400 }
      );
    }

    // Get company data
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      return NextResponse.json(
        { error: "Company not found" },
        { status: 404 }
      );
    }

    // Extract domain from research if possible
    const domainMatch = company.research.match(
      /(?:website|domain|url|@)[:\s]*(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/i
    );
    const companyDomain = domainMatch ? domainMatch[1] : undefined;

    // Run the efficient research (should complete in <30s)
    const result = await researchContacts({
      companyName: company.name,
      companyResearch: company.research,
      companyDomain,
    });

    const totalDuration = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      companyId,
      companyName: company.name,
      contacts: result.contacts,
      summary: result.summary,
      stages: result.stages,
      timing: {
        researchMs: result.durationMs,
        totalMs: totalDuration,
      },
    });
  } catch (error) {
    console.error("Error researching contacts:", error);

    // Return partial results if available
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to research contacts",
        contacts: [],
        summary: "Research failed - please try again",
      },
      { status: 500 }
    );
  }
}
