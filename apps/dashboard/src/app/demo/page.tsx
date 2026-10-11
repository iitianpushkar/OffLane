import type { Metadata } from "next";
import Script from "next/script";
import { demoMarkup } from "./demo-markup";

export const metadata: Metadata = { title: "OffLane — Agent Payment Network" };

export default function DemoPage() {
  return (
    <>
      <link rel="stylesheet" href="/demo/styles.css" />
      <div dangerouslySetInnerHTML={{ __html: demoMarkup }} />
      <Script src="/demo/app.js" strategy="afterInteractive" />
    </>
  );
}
