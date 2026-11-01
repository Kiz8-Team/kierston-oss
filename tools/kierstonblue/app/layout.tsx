import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { CommandMenu } from "@/components/CommandMenu";
import { Rail } from "@/components/Rail";
import { ScopeProvider } from "@/components/Scope";
import { StatusBar } from "@/components/StatusBar";
import "./globals.css";

/* One face for everything. The mono variable is bound to the same face so a
   stray `font-mono` further in cannot bring a second one back. */
const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KierstonBlue",
  description: "Analysis surface for the Kierston synthetic population and road network.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} antialiased`}>
      <body>
        <a
          className="skip fixed top-2 left-[-100vw] z-1000 border border-border bg-card px-2.5 py-1.5 text-[0.8rem] focus-visible:left-2"
          href="#content"
        >
          Skip to content
        </a>
        {/* The chassis: a status strip across the full width, and under it the
            nav bay and the screen. The rail sets its own width — 14rem open,
            an icon strip closed — so the column follows it rather than the
            other way round. */}
        <ScopeProvider>
          <div className="flex h-full flex-col">
            <StatusBar />
            <div className="shell grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] [&>*]:min-h-0 max-[51.25rem]:grid-cols-1 max-[51.25rem]:grid-rows-[auto_minmax(0,1fr)]">
              <Rail />
              {children}
            </div>
          </div>
          <CommandMenu />
        </ScopeProvider>
      </body>
    </html>
  );
}
