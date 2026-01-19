import { prisma } from "@/lib/db";
import { EmailPreview } from "@/components/email-preview";
import { BulkActions } from "@/components/bulk-actions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

async function getEmails() {
  const emails = await prisma.email.findMany({
    include: {
      contact: {
        select: {
          name: true,
          email: true,
          role: true,
        },
      },
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return emails;
}

export default async function EmailsPage() {
  const emails = await getEmails();

  const drafts = emails.filter((e) => e.status === "draft");
  const approved = emails.filter((e) => e.status === "approved");
  const sent = emails.filter((e) => e.status === "sent");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Email Queue</h1>
        <p className="text-muted-foreground">
          Review, approve, and send your drafted emails
        </p>
      </div>

      <Tabs defaultValue="drafts" className="space-y-6">
        <TabsList>
          <TabsTrigger value="drafts">
            Drafts ({drafts.length})
          </TabsTrigger>
          <TabsTrigger value="approved">
            Approved ({approved.length})
          </TabsTrigger>
          <TabsTrigger value="sent">
            Sent ({sent.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="drafts" className="space-y-4">
          {drafts.length > 0 ? (
            <>
              <BulkActions emails={drafts} action="approve" />
              <div className="space-y-4">
                {drafts.map((email) => (
                  <EmailPreview key={email.id} email={email} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>No draft emails. Generate drafts from a company page.</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="approved" className="space-y-4">
          {approved.length > 0 ? (
            <>
              <BulkActions emails={approved} action="send" />
              <div className="space-y-4">
                {approved.map((email) => (
                  <EmailPreview key={email.id} email={email} />
                ))}
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>No approved emails. Approve drafts to queue them for sending.</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="sent" className="space-y-4">
          {sent.length > 0 ? (
            <div className="space-y-4">
              {sent.map((email) => (
                <EmailPreview key={email.id} email={email} />
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              <p>No emails sent yet.</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
