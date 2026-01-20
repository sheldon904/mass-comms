import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { researchContacts, ProgressEvent } from "@/lib/contact-research-agent";

// Vercel Pro allows up to 300s - give agent plenty of time
export const maxDuration = 300;

// Disable static optimization for streaming
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();

  // Helper to format SSE message
  const formatSSE = (event: ProgressEvent): string => {
    return `data: ${JSON.stringify(event)}\n\n`;
  };

  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return new Response(
        formatSSE({ type: "error", message: "Company ID is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }
      );
    }

    // Get company data
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      return new Response(
        formatSSE({ type: "error", message: "Company not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }
      );
    }

    // Extract domain from research if possible
    const domainMatch = company.research.match(
      /(?:website|domain|url|@)[:\s]*(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/i
    );
    const companyDomain = domainMatch ? domainMatch[1] : undefined;

    // Create a readable stream for SSE
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Progress callback that streams events
          const onProgress = (event: ProgressEvent) => {
            try {
              controller.enqueue(encoder.encode(formatSSE(event)));
            } catch (e) {
              // Stream may have been closed by client
              console.log("[SSE] Stream closed, cannot send event:", e);
            }
          };

          // Run research with progress streaming
          const result = await researchContacts(
            {
              companyName: company.name,
              companyResearch: company.research,
              companyDomain,
            },
            onProgress
          );

          // Send final complete event (also sent by agent, but ensures we have it)
          controller.enqueue(
            encoder.encode(formatSSE({ type: "complete", result }))
          );
        } catch (error) {
          console.error("[SSE] Research error:", error);
          controller.enqueue(
            encoder.encode(
              formatSSE({
                type: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Research failed unexpectedly",
              })
            )
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Prevent buffering
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[SSE] Request error:", error);
    return new Response(
      formatSSE({
        type: "error",
        message: error instanceof Error ? error.message : "Request failed",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }
    );
  }
}
