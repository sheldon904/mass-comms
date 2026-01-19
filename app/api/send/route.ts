import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resend } from "@/lib/resend";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { emailIds } = body;

    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
      return NextResponse.json(
        { error: "No email IDs provided" },
        { status: 400 }
      );
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL;
    if (!fromEmail) {
      return NextResponse.json(
        { error: "RESEND_FROM_EMAIL not configured" },
        { status: 500 }
      );
    }

    // Get all emails to send
    const emails = await prisma.email.findMany({
      where: {
        id: { in: emailIds },
        status: "approved",
      },
      include: {
        contact: true,
        company: true,
      },
    });

    if (emails.length === 0) {
      return NextResponse.json(
        { error: "No approved emails found" },
        { status: 400 }
      );
    }

    const results = [];

    for (const email of emails) {
      try {
        // Send via Resend
        const { data, error } = await resend.emails.send({
          from: fromEmail,
          to: email.contact.email,
          subject: email.subject,
          text: email.body,
        });

        if (error) {
          // Mark as failed
          await prisma.email.update({
            where: { id: email.id },
            data: { status: "failed" },
          });
          results.push({
            id: email.id,
            success: false,
            error: error.message,
          });
        } else {
          // Mark as sent with Resend ID
          await prisma.email.update({
            where: { id: email.id },
            data: {
              status: "sent",
              sentAt: new Date(),
              resendId: data?.id,
            },
          });
          results.push({
            id: email.id,
            success: true,
            resendId: data?.id,
          });
        }
      } catch (sendError) {
        console.error(`Error sending email ${email.id}:`, sendError);
        await prisma.email.update({
          where: { id: email.id },
          data: { status: "failed" },
        });
        results.push({
          id: email.id,
          success: false,
          error: sendError instanceof Error ? sendError.message : "Send failed",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return NextResponse.json({
      results,
      summary: {
        total: results.length,
        sent: successCount,
        failed: failCount,
      },
    });
  } catch (error) {
    console.error("Error in bulk send:", error);
    return NextResponse.json(
      { error: "Failed to send emails" },
      { status: 500 }
    );
  }
}
