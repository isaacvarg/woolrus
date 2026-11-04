import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentActor, resolveStationDevice } from "@/server/actor";

// Print-ready report pages (SPEC-rate-lab "Exports", decision 10): no app nav, the light theme and
// a page no wider than A4 or Letter, so the browser's "Save as PDF" prints what's on screen. Each
// page checks its own permission; the API checks every call again.
export default async function ReportLayout({ children }: { children: React.ReactNode }) {
  // Signed out, like the app: the sign-in page, or a station's lock screen.
  if (!(await currentActor())) {
    const device = await resolveStationDevice(await headers());
    redirect(device.kind === "none" ? "/sign-in" : "/station");
  }
  return (
    <div data-theme="light" className="lab-report min-h-dvh bg-base-100 text-base-content">
      <main className="mx-auto max-w-[180mm] space-y-6 p-4 print:p-0">{children}</main>
    </div>
  );
}
