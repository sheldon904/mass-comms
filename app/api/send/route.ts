import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resend } from "@/lib/resend";

const MAX_BATCH_SIZE = 100;
// CUIDs are typically 25-28 chars, alphanumeric starting with 'c' (case-insensitive)
const CUID_REGEX = /^c[a-z0-9]{20,30}$/i;

export async function POST(request: NextRequest) {
  console.log("[SEND API] Request received");

  try {
    const body = await request.json();
    const { emailIds } = body;

    console.log(`[SEND API] Processing ${emailIds?.length || 0} email IDs`);

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
    console.log(`[SEND API] From email configured: ${!!fromEmail}`);

    if (!fromEmail) {
      console.error("[SEND API] RESEND_FROM_EMAIL not configured");
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
      console.log("[SEND API] No approved emails found for IDs:", emailIds);
      return NextResponse.json(
        { error: "No approved emails found" },
        { status: 400 }
      );
    }

    console.log(`[SEND API] Found ${emails.length} approved emails to send`);

    const results = [];

    for (const email of emails) {
      console.log(`[SEND API] Processing email ${email.id} to ${email.contact.email}`);

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

          // Send via Resend with deliverability optimizations
          console.log(`[SEND API] Sending via Resend: to=${email.contact.email}, subject=${email.subject}`);

          // Extract reply-to email from fromEmail (handles "Name <email>" format)
          const replyToMatch = fromEmail.match(/<(.+)>/) || [null, fromEmail];
          const replyToEmail = replyToMatch[1] || fromEmail;

          const { data, error } = await resend.emails.send({
            from: fromEmail,
            to: email.contact.email,
            subject: email.subject,
            text: email.body,
            // Deliverability headers to avoid Promotions tab
            replyTo: replyToEmail,
            headers: {
              // List-Unsubscribe helps with deliverability (Gmail looks for this)
              "List-Unsubscribe": `<mailto:${replyToEmail}?subject=Unsubscribe>`,
              // Precedence: bulk can sometimes help, but removing it may be better
              // Using "normal" to indicate this is regular correspondence
              "X-Priority": "3",
              "X-Mailer": "Mass Comms",
            },
          });

          if (error) {
            console.error(`[SEND API] Resend error for ${email.id}:`, error);
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

          console.log(`[SEND API] Email sent successfully: ${email.id}, resendId: ${data?.id}`);

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

    console.log(`[SEND API] Complete: ${successCount} sent, ${failCount} failed`);

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
