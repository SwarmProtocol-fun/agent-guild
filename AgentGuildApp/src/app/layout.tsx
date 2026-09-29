/** Root Layout — App-level providers (ThirdwebProvider, ThemeProvider, OrgProvider, SessionProvider), global fonts, and metadata. */
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Web3Provider } from "@/lib/dynamic";
import { OrgProvider } from "@/contexts/OrgContext";
import { SessionProvider } from "@/contexts/SessionContext";
import SparkleTrail from "@/components/SparkleTrail";
import { ThemeProvider } from "@/components/theme-provider";
import { SkinProvider } from "@/contexts/SkinContext";
import { CommandBar } from "@/components/command-bar";
import AutoSiwe from "@/components/AutoSiwe";
import { QueryProvider } from "@/components/query-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_BASE_URL || 'https://swarmprotocol.fun'),
  title: "Swarm | Enterprise AI Fleet Orchestration",
  description: "Deploy, orchestrate, and scale enterprise-grade AI agent fleets. The ultimate command center for autonomous business operations.",
  icons: {
    icon: "/Logo.jpg",
  },
  openGraph: {
    title: "Swarm | Enterprise AI Fleet Orchestration",
    description: "The ultimate command center for autonomous business operations.",
    images: ["/Logo.jpg"],
  }
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Preserve native constructors before MetaMask SES lockdown can strip them.
            SES (lockdown-install.js) from wallet extensions can corrupt Map/Set,
            breaking React Flow and other libraries that use them internally. */}
        <Script id="ses-guard" strategy="beforeInteractive">{`
          (function(){var g=typeof globalThis!=='undefined'?globalThis:window;if(typeof g.Map==='function')g.__nativeMap=g.Map;if(typeof g.Set==='function')g.__nativeSet=g.Set;if(typeof g.WeakMap==='function')g.__nativeWeakMap=g.WeakMap;})();
        `}</Script>
      </head>
      <body className={inter.className} suppressHydrationWarning>
        <QueryProvider>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <SkinProvider>
          <Web3Provider>
            <SessionProvider>
            <AutoSiwe />
            <OrgProvider>
              <SparkleTrail>
                <CommandBar />
                {children}
              </SparkleTrail>
            </OrgProvider>
            </SessionProvider>
          </Web3Provider>
          </SkinProvider>
        </ThemeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
