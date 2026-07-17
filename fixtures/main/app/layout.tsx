export const metadata = {
  title: "adapter-k8s e2e",
  description: "Minimal Next.js app for adapter-k8s e2e validation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
