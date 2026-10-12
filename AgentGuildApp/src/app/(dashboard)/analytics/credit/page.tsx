/**
 * Agent credit now lives in the Credit tab of /lending (Credit & Lending).
 *
 * Route: /analytics/credit
 */
import { redirect } from "next/navigation";

export default function OrgCreditDashboardPage() {
  redirect("/lending?tab=credit");
}
