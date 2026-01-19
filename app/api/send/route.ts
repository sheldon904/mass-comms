import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resend } from "@/lib/resend";

const MAX_BATCH_SIZE = 100;
const CUID_REGEX = /^c[a-z0-9]{24}$/;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { emailIds } = body;

    // Validate emailIds array
    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
      return NextResponse.json(
        { error: "No email IDs provided" },
        { status: 400 }
      );
    }

    // Validate array size to prevent DoS
    if (emailIds.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Cannot send more than ${MAX_BATCH_SIZE} emails at once` },
        { status: 400 }
      );
    }

    // Validate each ID is a valid string format
    const invalidIds = emailIds.filter(
      (id) => typeof id !== "string" || !CUID_REGEX.test(id)
    );
    if (invalidIds.length > 0) {
      return NextResponse.json(
        { error: "Invalid email ID format" },
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

    // Get all emails to send with optimistic locking via transaction
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
        // Use transaction to ensure atomic status updates
        const result = await prisma.$transaction(async (tx) => {
          // Re-check status inside transaction to prevent race conditions
          const currentEmail = await tx.email.findUnique({
            where: { id: email.id },
            select: { status: true },
          });

          if (currentEmail?.status !== "approved") {
            return {
              id: email.id,
              success: false,
              error: "Email status changed, skipping",
            };
          }

          // Send via Resend
          const { data, error } = await resend.emails.send({
            from: fromEmail,
            to: email.contact.email,
            subject: email.subject,
            text: email.body,
          });

          if (error) {
            await tx.email.update({
              where: { id: email.id },
              data: { status: "failed" },
            });
            return {
              id: email.id,
              success: false,
              error: error.message,
            };
          }

          await tx.email.update({
            where: { id: email.id },
            data: {
              status: "sent",
              sentAt: new Date(),
              resendId: data?.id,
            },
          });

          return {
            id: email.id,
            success: true,
            resendId: data?.id,
          };
        });

        results.push(result);
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
