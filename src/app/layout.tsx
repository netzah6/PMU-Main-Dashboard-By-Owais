import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Master Dashboard — PMU Bookings On Demand",
  description: "PMU Bookings On Demand Master Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: "#ffffff",
              border: "1px solid #e4ebf2",
              color: "#1e2a3a",
            },
          }}
        />
      </body>
    </html>
  );
}
