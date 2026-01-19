import Link from "next/link";
import { Building2, Users, Mail, ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface CompanyCardProps {
  id: string;
  name: string;
  contactCount: number;
  emailCounts: {
    draft: number;
    approved: number;
    sent: number;
  };
}

export function CompanyCard({
  id,
  name,
  contactCount,
  emailCounts,
}: CompanyCardProps) {
  const totalEmails = emailCounts.draft + emailCounts.approved + emailCounts.sent;

  return (
    <Link href={`/companies/${id}`}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">{name}</CardTitle>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Users className="h-4 w-4" />
              <span>{contactCount} contacts</span>
            </div>
            <div className="flex items-center gap-1">
              <Mail className="h-4 w-4" />
              <span>{totalEmails} emails</span>
            </div>
          </div>
          {totalEmails > 0 && (
            <div className="mt-3 flex gap-2">
              {emailCounts.draft > 0 && (
                <Badge variant="warning">{emailCounts.draft} draft</Badge>
              )}
              {emailCounts.approved > 0 && (
                <Badge variant="secondary">{emailCounts.approved} approved</Badge>
              )}
              {emailCounts.sent > 0 && (
                <Badge variant="success">{emailCounts.sent} sent</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
